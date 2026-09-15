// Self-check for the room handler: node api/room.test.js
// Stubs Redis with an in-memory pipeline so no store is needed.
const assert = require('assert');

process.env.KV_REST_API_URL = 'http://stub';
process.env.KV_REST_API_TOKEN = 'stub';

const store = new Map();

global.fetch = async (_url, init) => {
  const commands = JSON.parse(init.body);
  const results = commands.map(([cmd, key, ...args]) => {
    if (cmd === 'GET') return store.get(key) || null;
    if (cmd === 'SET') { store.set(key, args[0]); return 'OK'; }
    if (cmd === 'DEL') { store.delete(key); return 1; }
    if (cmd === 'EXPIRE') return 1;
    if (cmd === 'HSET') {
      const h = store.get(key) || {};
      h[args[0]] = args[1];
      store.set(key, h);
      return 1;
    }
    if (cmd === 'HGET') return (store.get(key) || {})[args[0]] || null;
    if (cmd === 'HGETALL') {
      const h = store.get(key) || {};
      return Object.keys(h).flatMap((k) => [k, h[k]]); // REST returns a flat array
    }
    throw new Error('unstubbed command ' + cmd);
  });
  return { ok: true, json: async () => results.map((result) => ({ result })) };
};

const handler = require('./room.js');

function call(method, body) {
  return new Promise((resolve) => {
    const req = { method, body };
    const res = {
      statusCode: 0,
      setHeader() {},
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
    };
    handler(req, res);
  });
}

(async () => {
  let r = await call('GET');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.state.phase, 'lobby');
  assert.deepStrictEqual(r.body.players, []);

  r = await call('POST', { op: 'join', name: 'Priya' });
  const priya = r.body.id;
  assert.ok(priya, 'join returns an id');
  assert.strictEqual(r.body.players.length, 1);

  r = await call('POST', { op: 'join', name: 'Team Falcon' });
  const falcon = r.body.id;
  assert.strictEqual(r.body.players.length, 2, 'both players visible to everyone');

  // Host stages question 3 and starts the clock; the server stamps it.
  r = await call('POST', { op: 'state', patch: { phase: 'question', index: 2, startedAt: null, revealed: false } });
  assert.strictEqual(r.body.state.startedAt, null);
  r = await call('POST', { op: 'state', patch: { startedAt: 'now' } });
  assert.ok(typeof r.body.state.startedAt === 'number', 'server stamps the round start');

  // Two players answer concurrently — neither write clobbers the other.
  const a = call('POST', { op: 'answer', id: priya, patch: { score: 90, correct: 1, streak: 1, bestStreak: 1, answers: { '2': { choice: 1, correct: true } } } });
  const b = call('POST', { op: 'answer', id: falcon, patch: { score: 0, correct: 0, streak: 0, bestStreak: 0, answers: { '2': { choice: -1, correct: false } } } });
  await Promise.all([a, b]);

  r = await call('GET');
  const byId = Object.fromEntries(r.body.players.map((p) => [p.id, p]));
  assert.strictEqual(byId[priya].score, 90);
  assert.strictEqual(byId[falcon].score, 0);
  assert.strictEqual(byId[priya].answers['2'].choice, 1);

  // A later question merges into answers rather than replacing them.
  await call('POST', { op: 'answer', id: priya, patch: { score: 175, answers: { '3': { choice: 0, correct: true } } } });
  r = await call('GET');
  const after = r.body.players.find((p) => p.id === priya);
  assert.deepStrictEqual(Object.keys(after.answers).sort(), ['2', '3']);
  assert.strictEqual(after.score, 175);

  // Reset clears players and issues a new session so devices re-register.
  const oldSession = r.body.state.session;
  r = await call('POST', { op: 'reset' });
  assert.deepStrictEqual(r.body.players, []);
  assert.strictEqual(r.body.state.phase, 'lobby');
  assert.notStrictEqual(r.body.state.session, oldSession);

  r = await call('POST', { op: 'answer', id: priya, patch: { score: 1 } });
  assert.strictEqual(r.status, 400, 'a cleared player cannot write');

  console.log('room handler: all checks passed');
})();
