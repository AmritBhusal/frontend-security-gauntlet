(function(){

let QUESTIONS = [];


const ROUND_SECONDS = 20;
const LETTERS = ['A','B','C','D'];
const API = '/api/room';
const POLL_MS = 1000;

const $ = (id) => document.getElementById(id);
const isAdmin = location.hash.toLowerCase().indexOf('admin') !== -1;
const joinLink = location.origin + location.pathname + location.search + '#join';

let S = null;                 // shared room state
let players = [];             // [{id, ...}]
let me = null;                // my player record
let pid = null;               // my player id
let quizKey = '';             // question currently built into the DOM
let myChoice = null;          // my answer for the current question (-1 = timed out)
let writing = false;          // one answer write at a time
let clockSkew = 0;            // server clock minus this device's clock

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, (c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function zoneLabel(z){
  return z==='client' ? 'CLIENT / BROWSER' : z==='server' ? 'API / SERVER' : 'BOTH SIDES';
}
function showScreen(id){
  document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('active', s.id===id));
}
/* ---------- room API ---------- */
// The round clock is the server's, so compare against its stamp, not this device's.
function serverNow(){ return Date.now() + clockSkew; }

// Answering never reveals anything — the whole room flips together, either when
// the host hits Reveal or when the 20s clock runs out for everyone.
function roundRevealed(){
  if(!S) return false;
  if(S.revealed || S.phase === 'results') return true;
  return !!S.startedAt && (serverNow() - S.startedAt) >= ROUND_SECONDS*1000;
}

function showErr(msg){
  ['qrErr','joinErr','admErr'].forEach((id)=>{
    const el = $(id);
    el.hidden = !msg;
    el.textContent = msg || '';
  });
}

async function room(body){
  const res = await fetch(API, body ? {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
  } : { cache:'no-store' });
  const data = await res.json().catch(()=>null);
  if(!res.ok) throw new Error((data && data.error) || ('Room error ' + res.status));
  if(typeof data.now === 'number') clockSkew = data.now - Date.now();
  if(data.state) S = data.state;
  if(data.players) players = data.players;
  me = pid ? (players.find(p=>p.id===pid) || null) : null;
  render();
  return data;
}

async function refresh(){
  if(document.hidden) return;
  try{ await room(null); showErr(''); }
  catch(e){ showErr(e.message); }
}

/* ---------- QR ---------- */
function renderQR(boxId, urlId){
  $(urlId).textContent = joinLink;
  const box = $(boxId);
  box.textContent = '';
  if(typeof QRCode === 'undefined'){
    // ponytail: CDN blocked — the typed-in link still works.
    box.innerHTML = '<span style="font-family:var(--mono);font-size:.72rem;color:#333;padding:1rem;text-align:center;">QR unavailable — use the link below</span>';
    return;
  }
  new QRCode(box, { text: joinLink, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M });
}

/* ---------- boot ---------- */
async function boot(){
  QUESTIONS = await fetch('questions.json').then(r=>r.json());
  pid = localStorage.getItem('gauntlet:pid');
  renderQR('qrBox','joinUrl');
  $('qrRounds').textContent = QUESTIONS.length;
  if(isAdmin){
    document.getElementById('app').classList.add('wide');
    buildPicker();
    renderQR('qrBoxAdm','joinUrlAdm');
    showScreen('screen-admin');
  } else if(location.hash.toLowerCase().indexOf('join') !== -1){
    showScreen('screen-join');
    $('nameInput').focus();
  }

  await refresh();
  setInterval(refresh, POLL_MS);
  setInterval(tick, 100);
}

async function writeState(patch){
  try{ await room({ op:'state', patch: patch }); showErr(''); }
  catch(e){ showErr(e.message); }
}

/* ---------- render dispatch ---------- */
function render(){
  if(isAdmin) return renderAdmin();
  if(!S) return;
  // Session changed (host reset) — everyone re-registers.
  if(me && me.session !== S.session){ me = null; pid = null; localStorage.removeItem('gauntlet:pid'); }
  if(!me){
    if(!document.getElementById('screen-join').classList.contains('active')) renderLanding();
    return;
  }
  if(S.phase === 'results') return renderEnd();
  if(S.phase === 'question') return renderQuiz();
  return renderLobby();
}

function renderLanding(){
  $('qrPlayers').textContent = players.length;
  if(!document.getElementById('screen-qr').classList.contains('active')) showScreen('screen-qr');
}

function renderLobby(){
  showScreen('screen-wait');
  $('waitName').textContent = me.name;
  $('waitPlayers').textContent = players.length;
  const list = $('waitList');
  list.innerHTML = players.length
    ? players.map(p=>`<div class="lb-row${p.id===pid?' me':''}"><span class="nm">${escapeHtml(p.name)}</span><span class="sc">${p.score||0}</span></div>`).join('')
    : '<div class="lb-empty">Nobody else yet.</div>';
}

/* ---------- quiz ---------- */
function myAnswerFor(i){
  const a = me && me.answers ? me.answers[String(i)] : null;
  return a ? a.choice : null;
}

function renderQuiz(){
  showScreen('screen-quiz');
  const q = QUESTIONS[S.index];
  if(!q) return;
  const key = S.session + ':' + S.index;
  if(quizKey !== key){
    quizKey = key;
    myChoice = myAnswerFor(S.index);
    buildQuestion(q);
  }
  paintQuiz(q);
}

function buildQuestion(q){
  $('roundLabel').textContent = 'ROUND ' + String(S.index+1).padStart(2,'0') + ' / ' + QUESTIONS.length;
  $('zoneTag').innerHTML = `<span class="zone zone-${q.zone}">${zoneLabel(q.zone)} · ${q.tag}</span>`;
  $('qTitle').textContent = q.q;
  $('qCodeWrap').innerHTML = q.code ? `<pre class="q-code">${escapeHtml(q.code)}</pre>` : '';
  const wrap = $('optionsWrap');
  wrap.innerHTML = '';
  q.options.forEach((opt, i)=>{
    const btn = document.createElement('button');
    btn.className = 'opt';
    btn.innerHTML = `<span class="k">${LETTERS[i]}</span><span>${escapeHtml(opt)}</span>`;
    btn.addEventListener('click', ()=>answer(i));
    wrap.appendChild(btn);
  });
}

function paintQuiz(q){
  const live = !!S.startedAt;
  const answered = myChoice !== null && myChoice !== undefined;
  const reveal = roundRevealed();

  $('scoreVal').textContent = (me && me.score) || 0;
  const streak = (me && me.streak) || 0;
  $('streakPill').hidden = streak < 2;
  $('streakVal').textContent = streak;

  Array.from(document.querySelectorAll('.opt')).forEach((b,i)=>{
    b.disabled = !live || answered || reveal;
    b.classList.toggle('picked', !reveal && i === myChoice);
    b.classList.toggle('correct', reveal && i === q.correct);
    b.classList.toggle('wrong', reveal && i === myChoice && myChoice !== q.correct);
    b.classList.toggle('dim', reveal && i !== q.correct && i !== myChoice);
  });

  const fb = $('feedback');
  fb.classList.toggle('show', reveal);
  if(reveal){
    const v = $('verdict');
    if(myChoice === -1 || myChoice === null){ v.textContent = 'Time’s up.'; v.className = 'verdict bad'; }
    else if(myChoice === q.correct){ v.textContent = 'Patched.'; v.className = 'verdict good'; }
    else { v.textContent = 'Exploited.'; v.className = 'verdict bad'; }
    $('explain').textContent = q.explain;
  }

  const sb = $('standby');
  sb.hidden = false;
  if(!live){ sb.textContent = 'Waiting for the host to start this round…'; sb.className = 'standby live'; }
  else if(reveal){ sb.textContent = 'Round over. Waiting for the host to move on…'; sb.className = 'standby'; }
  else if(answered){ sb.textContent = 'Locked in. Waiting for the rest of the room…'; sb.className = 'standby live'; }
  else { sb.hidden = true; }
}

function setBar(ratio, label){
  $('timerFill').style.width = (Math.max(0, Math.min(1, ratio)) * 100) + '%';
  $('clockPill').textContent = label;
}

function tick(){
  if(!S) return;
  const live = S.phase === 'question' && S.startedAt;
  const remaining = live ? ROUND_SECONDS - (serverNow() - S.startedAt)/1000 : ROUND_SECONDS;
  if(isAdmin){
    $('admClock').textContent = live ? Math.max(0, Math.ceil(remaining)) + 's' : '—';
    return;
  }
  if(!me || S.phase !== 'question') return;
  setBar(live ? remaining/ROUND_SECONDS : 1, live ? Math.max(0, Math.ceil(remaining)) + 's' : String(ROUND_SECONDS) + 's');
  if(live && remaining <= 0 && (myChoice === null || myChoice === undefined)) answer(-1);
}

async function answer(choice){
  if(!S || S.phase !== 'question' || !S.startedAt) return;
  if(myChoice !== null && myChoice !== undefined) return;
  if(writing) return;
  myChoice = choice;

  const q = QUESTIONS[S.index];
  const correct = choice === q.correct;
  const remainingRatio = Math.max(0, Math.min(1, (ROUND_SECONDS*1000 - (serverNow() - S.startedAt)) / (ROUND_SECONDS*1000)));

  const streak = correct ? ((me.streak||0) + 1) : 0;
  const gained = correct ? Math.round(60 + 40*remainingRatio) + Math.min(50, Math.max(0, streak - 1) * 10) : 0;

  const patch = {
    score: (me.score||0) + gained,
    correct: (me.correct||0) + (correct ? 1 : 0),
    streak: streak,
    bestStreak: Math.max(me.bestStreak||0, streak),
    answers: { [String(S.index)]: { choice: choice, correct: correct, points: gained } }
  };
  me = Object.assign({}, me, patch, { answers: Object.assign({}, me.answers, patch.answers) });
  paintQuiz(q);

  writing = true;
  try{ await room({ op:'answer', id: pid, patch: patch }); showErr(''); }
  catch(e){ showErr(e.message); }
  writing = false;
}

/* ---------- results ---------- */
function computeBadge(p){
  const pct = (p.correct||0) / QUESTIONS.length;
  if(pct >= 0.9) return 'SECURITY SENTINEL';
  if(pct >= 0.7) return 'DEFENSE IN DEPTH';
  if(pct >= 0.5) return 'PATCH PENDING';
  return 'PRIME ATTACK SURFACE';
}

function ranked(){
  return players.slice().sort((a,b)=> (b.score||0) - (a.score||0) || (a.joinedAt||0) - (b.joinedAt||0));
}

function leaderboardHtml(highlightId){
  const rows = ranked();
  if(!rows.length) return '<div class="lb-empty">No players yet.</div>';
  return rows.map((p,i)=>`<div class="lb-row${p.id===highlightId?' me':''}">`
    + `<span class="rank">#${i+1}</span>`
    + `<span class="nm">${escapeHtml(p.name)}</span>`
    + `<span class="tick">${p.correct||0}/${QUESTIONS.length}</span>`
    + `<span class="sc">${p.score||0}</span></div>`).join('');
}

function renderEnd(){
  showScreen('screen-end');
  $('badgeText').textContent = computeBadge(me);
  $('finalScore').textContent = me.score || 0;
  $('finalName').textContent = me.name + ' · points';
  $('statCorrect').textContent = (me.correct||0) + '/' + QUESTIONS.length;
  $('statStreak').textContent = me.bestStreak || 0;
  $('lbList').innerHTML = leaderboardHtml(pid);
}

/* ---------- join ---------- */
$('joinHereBtn').addEventListener('click', ()=>{ showScreen('screen-join'); $('nameInput').focus(); });
$('nameInput').addEventListener('keydown', (e)=>{ if(e.key === 'Enter') $('joinBtn').click(); });
$('joinBtn').addEventListener('click', async ()=>{
  const name = $('nameInput').value.trim();
  const err = $('joinErr');
  if(!name){ err.hidden = false; err.textContent = 'Enter a name so the leaderboard can find you.'; return; }
  err.hidden = true;
  $('joinBtn').disabled = true;
  try{
    const res = await room({ op:'join', name: name });
    pid = res.id;
    localStorage.setItem('gauntlet:pid', pid);
    me = players.find(p=>p.id===pid) || null;
    showErr('');
    render();
  }catch(e){
    err.hidden = false; err.textContent = 'Could not join: ' + e.message;
  }
  $('joinBtn').disabled = false;
});

/* ---------- admin ---------- */
function buildPicker(){
  $('qPicker').innerHTML = QUESTIONS.map((q,i)=>
    `<option value="${i}">${String(i+1).padStart(2,'0')} — ${escapeHtml(q.tag.replace(/^\d+ · /,''))}</option>`).join('');
}

function renderAdmin(){
  if(!S) return;
  const q = QUESTIONS[S.index];
  const live = !!S.startedAt;
  $('admPhase').textContent = S.phase === 'question' ? (live ? 'round live' : 'round staged') : S.phase;
  $('admRound').textContent = S.phase === 'question' ? (S.index+1) + ' / ' + QUESTIONS.length : '—';
  $('admPlayers').textContent = players.length;

  if(document.activeElement !== $('qPicker')) $('qPicker').value = String(S.index);
  // The host console gets projected, so the answer stays hidden until the reveal too.
  const shown = roundRevealed();
  $('admQ').textContent = q.q;
  $('admA').textContent = shown
    ? 'Answer: ' + LETTERS[q.correct] + ' — ' + q.options[q.correct]
    : 'Answer hidden until the round is revealed';

  const last = S.index >= QUESTIONS.length - 1;
  $('startBtn').textContent = S.phase !== 'question' ? 'Start round 1'
    : last ? 'Show final results' : 'Next question →';
  $('prevBtn').disabled = S.phase !== 'question' || S.index === 0;
  $('revealBtn').disabled = !live || !!S.revealed;

  const answers = players.map(p=> p.answers ? p.answers[String(S.index)] : null).filter(Boolean);
  $('admAnswered').textContent = answers.length + ' / ' + players.length;

  const counts = q.options.map((_, i)=> answers.filter(a=>a.choice === i).length);
  const max = Math.max(1, ...counts);
  $('admTally').innerHTML = q.options.map((opt,i)=>
    `<div class="tally-row${shown && i===q.correct?' is-correct':''}">`
    + `<span class="k">${LETTERS[i]}</span>`
    + `<span class="bar"><i style="width:${(counts[i]/max)*100}%"></i></span>`
    + `<span class="n">${counts[i]}</span></div>`).join('');

  $('admList').innerHTML = leaderboardHtml(null);
}

if(isAdmin){
  $('qPicker').addEventListener('change', (e)=> gotoIndex(parseInt(e.target.value, 10)));
  $('prevBtn').addEventListener('click', ()=> gotoIndex((S ? S.index : 0) - 1));
  // One button runs the whole game: start, then advance, then finish.
  $('startBtn').addEventListener('click', ()=>{
    if(!S || S.phase !== 'question') return gotoIndex(0);
    if(S.index >= QUESTIONS.length - 1) return writeState({ phase:'results', startedAt:null, revealed:true });
    gotoIndex(S.index + 1);
  });
  $('revealBtn').addEventListener('click', ()=> writeState({ revealed:true }));
  $('lobbyBtn').addEventListener('click', ()=> writeState({ phase:'lobby', startedAt:null, revealed:false }));
  $('resetBtn').addEventListener('click', async ()=>{
    if(!confirm('Clear every player and score, and send everyone back to check-in?')) return;
    $('resetBtn').disabled = true;
    try{
      await room({ op:'reset' });
      showErr('');
    }catch(e){
      showErr('Reset failed: ' + e.message);
    }
    $('resetBtn').disabled = false;
  });
}

// Moving to a question starts its clock — the host never starts a round twice.
function gotoIndex(i){
  const next = Math.max(0, Math.min(QUESTIONS.length - 1, i));
  writeState({ phase:'question', index: next, startedAt:'now', revealed:false });
}

boot();

})();
