// The whole quiz room, held in the Redis store Vercel provisions
// (Storage -> Upstash for Redis). Two keys, both on a TTL so an abandoned
// room disappears by itself:
//   room:state    JSON  — phase, current question, round start stamp
//   room:players  hash  — player id -> JSON
//
// GET  /api/room            -> { now, state, players }
// POST /api/room  { op: 'join' | 'answer' | 'state' | 'reset', ... }

const TTL_SECONDS = 6 * 60 * 60;
const STATE_KEY = 'room:state';
const PLAYERS_KEY = 'room:players';

const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(commands) {
  const res = await fetch(REST_URL.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + REST_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error('Redis returned ' + res.status + ': ' + (await res.text()));
  const rows = await res.json();
  const failed = rows.find((r) => r && r.error);
  if (failed) throw new Error(failed.error);
  return rows.map((r) => r.result);
}

function freshState() {
  return { phase: 'lobby', index: 0, startedAt: null, revealed: false, session: newId() };
}

function newId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// HGETALL comes back as a flat [field, value, ...] array on the REST API,
// but tolerate an object shape too.
function toPlayers(hash) {
  const out = [];
  const push = (id, raw) => {
    try { out.push(Object.assign({ id: id }, JSON.parse(raw))); } catch (e) { /* skip corrupt row */ }
  };
  if (Array.isArray(hash)) {
    for (let i = 0; i < hash.length; i += 2) push(hash[i], hash[i + 1]);
  } else if (hash && typeof hash === 'object') {
    Object.keys(hash).forEach((k) => push(k, hash[k]));
  }
  out.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
  return out;
}

async function readRoom() {
  const [stateRaw, hash] = await redis([
    ['GET', STATE_KEY],
    ['HGETALL', PLAYERS_KEY],
  ]);
  return {
    state: stateRaw ? JSON.parse(stateRaw) : null,
    players: toPlayers(hash),
  };
}

function saveState(state) {
  return ['SET', STATE_KEY, JSON.stringify(state), 'EX', String(TTL_SECONDS)];
}

async function handle(method, body) {
  if (method !== 'POST') {
    const room = await readRoom();
    return { state: room.state || freshState(), players: room.players };
  }

  const op = body.op;

  if (op === 'reset') {
    const state = freshState();
    await redis([['DEL', PLAYERS_KEY], saveState(state)]);
    return { state: state, players: [] };
  }

  if (op === 'state') {
    const room = await readRoom();
    const state = Object.assign(room.state || freshState(), body.patch || {});
    // The round clock is stamped here so every device measures against one clock.
    if (state.startedAt === 'now') state.startedAt = Date.now();
    await redis([saveState(state)]);
    return { state: state, players: room.players };
  }

  if (op === 'join') {
    const name = String(body.name || '').trim().slice(0, 24);
    if (!name) throw new Error('A name is required to join');
    const room = await readRoom();
    const state = room.state || freshState();
    const id = newId();
    const player = {
      name: name,
      score: 0,
      correct: 0,
      streak: 0,
      bestStreak: 0,
      answers: {},
      joinedAt: Date.now(),
      session: state.session,
    };
    await redis([
      saveState(state),
      ['HSET', PLAYERS_KEY, id, JSON.stringify(player)],
      ['EXPIRE', PLAYERS_KEY, String(TTL_SECONDS)],
    ]);
    return { id: id, state: state, players: room.players.concat([Object.assign({ id: id }, player)]) };
  }

  if (op === 'answer') {
    if (!body.id) throw new Error('Missing player id');
    const [raw] = await redis([['HGET', PLAYERS_KEY, body.id]]);
    if (!raw) throw new Error('You are not in this room any more — rejoin');
    const player = JSON.parse(raw);
    const patch = body.patch || {};
    const next = Object.assign({}, player, patch, {
      answers: Object.assign({}, player.answers, patch.answers),
    });
    await redis([
      ['HSET', PLAYERS_KEY, body.id, JSON.stringify(next)],
      ['EXPIRE', PLAYERS_KEY, String(TTL_SECONDS)],
    ]);
    return await readRoom();
  }

  throw new Error('Unknown op: ' + op);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (!REST_URL || !REST_TOKEN) {
    res.status(503).json({
      error: 'No Redis store connected. Add Upstash for Redis under Storage in the Vercel project, then redeploy.',
    });
    return;
  }

  try {
    let body = {};
    if (req.method === 'POST') {
      body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    }
    const out = await handle(req.method, body);
    res.status(200).json(Object.assign({ now: Date.now() }, out));
  } catch (e) {
    res.status(400).json({ error: String((e && e.message) || e) });
  }
};
