/* ============================================================
   CHAIN — a minimalist combo roguelite
   One self-contained file. No build step, no dependencies.
   ============================================================ */

const App = document.getElementById('app');

// ---- Card archetypes (the "feel": build a combo that explodes) ----
// add  : adds to base score
// mult : multiplies the running multiplier
// wild : adds AND small mult (flexible)
// risk : big payoff but a catch
const CARD_POOL = [
  {type:'add',  op:'+', tag:'value',  min:4, max:12},
  {type:'add',  op:'+', tag:'value',  min:4, max:12},
  {type:'add',  op:'+', tag:'value',  min:6, max:16},
  {type:'mult', op:'×', tag:'boost',  min:2, max:3},
  {type:'mult', op:'×', tag:'boost',  min:2, max:4},
  {type:'wild', op:'±', tag:'hybrid', min:3, max:7},
  {type:'risk', op:'!', tag:'gamble', min:8, max:20},
];

// Game state
let S = {};

function newRun(mode, resume){
  mode = mode || 'free';
  const key = mode==='blitz' ? BLITZ_KEY : SAVE_KEY;
  const saved = ((mode==='free'||mode==='blitz') && resume) ? load(key) : null;
  S = {
    mode: mode,
    stage: saved ? saved.stage : 1,
    target: saved ? saved.target : targetForStage(1),
    runScore: 0,
    coins: saved ? saved.coins : 0,
    handsLeft: 4,
    discardsLeft: 3,
    deck: [],
    hand: [],
    chain: [],
    upgrades: saved ? saved.upgrades : {},
    runStats: saved ? saved.stats : {stagesCleared:0, bestChain:0},
    best: loadBest(),
    // blitz timer state
    timeLeft: 0,
    timeBuys: 0,        // times bought more time this stage (cost rises)
  };
  if(mode==='daily') setDailySeed(); else setFreePlay();
  ensureAudioStarted();
  startStage();
}

/* ---- Blitz timer config ---- */
function timeForStage(s){ return 45 + Math.min(30, (s-1)*3); }  // 45s, +3s/stage up to 75s
function isBlitz(){ return S.mode==='blitz'; }

/* ---- Balance curves: endless but fair ---- */
function targetForStage(s){ return Math.round(50 + s*s*14); }
function coinsForStage(s, runScore, target){
  // base reward scales with stage; small bonus for overshooting the target
  const over = Math.max(0, Math.floor((runScore-target)/Math.max(1,target) * 4));
  return 6 + s*3 + over;
}
// how many times a repeatable upgrade has been bought
function lvl(id){ return (S.upgrades && S.upgrades[id]) || 0; }

/* Set up a fresh attempt at the CURRENT stage (used on start AND on retry) */
function startStage(){
  S.runScore = 0;
  S.handsLeft = 4 + lvl('reserve');
  S.discardsLeft = 3 + lvl('sift');
  S.chain = [];
  S.hand = [];
  buildDeck();
  draw();
  if(isBlitz()){
    S.timeLeft = timeForStage(S.stage) + lvl('clock')*10; // Clock upgrade adds 10s
    S.timeBuys = 0;
    startTimer();
  } else {
    stopTimer();
  }
  persistRun();
}

/* ---- Blitz timer engine ---- */
let _timer = null;
function startTimer(){
  stopTimer();
  _timer = setInterval(()=>{
    if(!isBlitz()) { stopTimer(); return; }
    S.timeLeft -= 1;
    if(S.timeLeft <= 0){
      S.timeLeft = 0;
      stopTimer();
      timeUp();
    } else {
      updateTimerUI();
    }
  }, 1000);
}
function stopTimer(){ if(_timer){ clearInterval(_timer); _timer = null; } }
function pauseTimer(){ stopTimer(); }   // used when entering shop/overlays

function updateTimerUI(){
  const el = document.getElementById('timerVal');
  if(el){
    el.textContent = S.timeLeft + 's';
    const wrap = document.getElementById('timerWrap');
    if(wrap){ wrap.classList.toggle('low', S.timeLeft<=10); }
  }
}

function buildDeck(){
  S.deck = [];
  let id = 0;
  // base deck: weighted spread
  const spread = ['add','add','add','add','add','mult','mult','wild','wild','risk',
                  'add','add','mult','wild','add','mult'];
  spread.forEach(t=>{
    const proto = CARD_POOL.filter(c=>c.type===t)[
      Math.floor(RNG()*CARD_POOL.filter(c=>c.type===t).length)
    ];
    S.deck.push(makeCard(proto, id++));
  });
  shuffle(S.deck);
}

function makeCard(proto, id){
  const val = rand(proto.min, proto.max);
  return {id, type:proto.type, op:proto.op, tag:proto.tag, val};
}

function rand(a,b){return Math.floor(RNG()*(b-a+1))+a}
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(RNG()*(i+1));[a[i],a[j]]=[a[j],a[i]]}}

/* ---- RNG: swappable between random play and deterministic daily seed ---- */
let _seed = 0;
function mulberry32(seed){
  return function(){
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
let RNG = Math.random;          // free-play uses true random
function setDailySeed(){
  const d = new Date();
  _seed = d.getFullYear()*10000 + (d.getMonth()+1)*100 + d.getDate();
  RNG = mulberry32(_seed);
}
function setFreePlay(){ RNG = Math.random; }
function todayLabel(){
  const d = new Date();
  return d.toLocaleDateString(undefined,{month:'short',day:'numeric'});
}

function handSize(){ return 8 + lvl('wide'); }

function draw(){
  const hs = handSize();
  while(S.hand.length < hs && S.deck.length){
    S.hand.push(S.deck.pop());
  }
  if(S.deck.length===0 && S.hand.length<hs){
    // reshuffle discard implicitly: rebuild from pool to keep runs going
    refillDeck();
    while(S.hand.length < hs && S.deck.length){
      S.hand.push(S.deck.pop());
    }
  }
}

function refillDeck(){
  let id = Date.now()%100000;
  const spread = ['add','add','add','mult','wild','add','mult','risk','add','wild'];
  spread.forEach(t=>{
    const opts = CARD_POOL.filter(c=>c.type===t);
    S.deck.push(makeCard(opts[Math.floor(RNG()*opts.length)], id++));
  });
  shuffle(S.deck);
}

/* ============================================================
   PERSISTENCE — on-device saving (no login)
   Uses localStorage when available (real file / hosted), with an
   in-memory fallback so it still runs inside restricted previews.
   ============================================================ */
const SAVE_KEY = 'chain_save_v1';
const BLITZ_KEY = 'chain_blitz_v1';
const STATS_KEY = 'chain_stats_v1';
const SETTINGS_KEY = 'chain_settings_v1';
let _mem = {};   // fallback store when localStorage is blocked

function hasLS(){
  try{ const k='__t'; localStorage.setItem(k,'1'); localStorage.removeItem(k); return true; }
  catch(e){ return false; }
}
const LS_OK = hasLS();

function store(key, obj){
  const s = JSON.stringify(obj);
  if(LS_OK){ try{ localStorage.setItem(key, s); return; }catch(e){} }
  _mem[key] = s;
}
function load(key){
  let s = null;
  if(LS_OK){ try{ s = localStorage.getItem(key); }catch(e){} }
  if(s==null) s = _mem[key]||null;
  if(s==null) return null;
  try{ return JSON.parse(s); }catch(e){ return null; }
}
function clearSave(key){
  key = key || SAVE_KEY;
  if(LS_OK){ try{ localStorage.removeItem(key); }catch(e){} }
  delete _mem[key];
}

/* ---- stats (lifetime, separate from a single in-progress run) ---- */
function loadStats(){
  return load(STATS_KEY) || {best:0, bestChain:0, runs:0, stagesCleared:0, dailyBest:{}};
}
function saveStats(st){ store(STATS_KEY, st); }

/* ---- settings (sound / music / vibration) ---- */
let _settings = null;
function settings(){
  if(_settings) return _settings;
  _settings = load(SETTINGS_KEY) || {sound:true, music:true, vibration:true};
  // backfill any missing keys for older saves
  if(_settings.sound===undefined) _settings.sound = true;
  if(_settings.music===undefined) _settings.music = true;
  if(_settings.vibration===undefined) _settings.vibration = true;
  return _settings;
}
function setSetting(key, val){
  const s = settings();
  s[key] = val;
  store(SETTINGS_KEY, s);
  // react immediately
  if(key==='music'){ val ? startMusic() : stopMusic(); }
}

function loadBest(){ return loadStats().best || 0; }
function saveBest(v){
  const st = loadStats();
  if(v > (st.best||0)){ st.best = v; saveStats(st); }
}

/* ---- in-progress resumable run (free & blitz each have their own slot) ---- */
function persistRun(){
  if(!S) return;
  if(S.mode!=='free' && S.mode!=='blitz') return;  // daily is fresh each day
  const key = S.mode==='blitz' ? BLITZ_KEY : SAVE_KEY;
  store(key, {
    mode:S.mode, stage:S.stage, target:S.target, coins:S.coins,
    upgrades:S.upgrades, stats:S.runStats
  });
}
function hasSavedRun(mode){
  const s = load(mode==='blitz' ? BLITZ_KEY : SAVE_KEY);
  return !!(s && s.stage);
}

/* ============================================================
   SCORING — the heart of the "combo explosion" feel
   When you play a set of cards, they resolve left-to-right:
   - add  cards push the base up
   - mult cards ramp the multiplier
   - wild cards do a bit of both
   - risk cards are huge but only pay if at least one mult is in play
   Final = base * mult, applied with a satisfying count-up.
   ============================================================ */

function evaluatePlay(cards){
  // RUNNING TOTAL model: each card acts on the accumulated score so far.
  // +8 then ×2 = 16.  ×2 then +8 = 8.  Order matters on EVERY hand.
  const amp = lvl('amplify')*2;      // +2 per level to each add/wild value
  const over = lvl('overcharge')*0.5; // +0.5 per level to each mult value
  const compound = lvl('compound')>0; // first mult counts twice
  let total = 0, lastMult = 1, baseSum = 0, steps = [];
  let multSeen = 0;
  for(const c of cards){
    if(c.type==='add'){
      const v = c.val + amp;
      total += v; baseSum += v;
      steps.push({c, kind:'base', amt:v});
    }
    else if(c.type==='wild'){
      const v = c.val + amp;
      total = (total + v) * 1.5;
      baseSum += v; lastMult *= 1.5;
      steps.push({c, kind:'wild', amt:v});
    }
    else if(c.type==='mult'){
      let m = c.val + over;
      multSeen++;
      if(compound && multSeen===1) m = m*2;  // Compound: first mult doubled
      total *= m; lastMult *= m;
      steps.push({c, kind:'mult', amt:m});
    }
    else if(c.type==='risk'){
      const boosted = lastMult > 1;
      const gain = boosted ? c.val*2 : Math.floor(c.val/2);
      total += gain; baseSum += gain;
      steps.push({c, kind:boosted?'risk-hit':'risk-miss', amt:gain});
    }
  }
  if(lvl('adept')){ total *= 1.5; lastMult *= 1.5; }
  if(lvl('engine')){ const e = cards.length*3; total += e; baseSum += e; }
  return {
    base: Math.round(baseSum),
    mult:Math.round(lastMult*10)/10,
    total: Math.round(total),
    steps
  };
}


/* ============================================================
   RENDER
   ============================================================ */

function render(){
  const pct = Math.min(100, Math.round(S.runScore / S.target * 100));
  App.innerHTML = `
    <div id="hud">
      <div class="hud-row">
        <button id="homeBtn" class="home-btn">‹ Home</button>
        <span class="round-tag">${isBlitz()?'Blitz · ':''}Stage <b>${S.stage}</b></span>
        ${isBlitz()
          ? `<span id="timerWrap" class="timer ${S.timeLeft<=10?'low':''}"><span id="timerVal">${S.timeLeft}s</span></span>`
          : `<span class="round-tag">Best <b>${S.best}</b></span>`}
      </div>
      <div class="goal-wrap">
        <div class="goal-line">
          <span class="goal-label">Reach the target</span>
          <span class="goal-num"><span class="cur">${S.runScore}</span><span class="sep">/</span><span class="tgt">${S.target}</span></span>
        </div>
        <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="stat-pills">
        <div class="pill"><span class="k">Hands</span><span class="v hand">${S.handsLeft}</span></div>
        <div class="pill"><span class="k">Discards</span><span class="v disc">${S.discardsLeft}</span></div>
        <div class="pill"><span class="k">Coins</span><span class="v coin">${S.coins}</span></div>
      </div>
    </div>

    <div id="scoreboard">
      <div class="run-score-label">${S.mode==='daily'?'Daily · '+todayLabel():(isBlitz()?'Blitz · beat the clock':'Chain total')}</div>
      <div id="runScore">${previewTotal()}</div>
      <div class="combo-readout">
        <div class="chip base ${S.chain.length?'live':''}">
          <span class="ck">Added</span><span class="cv">${previewBase()}</span>
        </div>
        <span class="times">×</span>
        <div class="chip mult ${hasMultSelected()?'live':''}">
          <span class="ck">Mult</span><span class="cv">${previewMult()}</span>
        </div>
      </div>
    </div>

    <div id="playzone">
      <div id="floaters"></div>
      ${chainTrackHTML()}
    </div>

    <div id="handArea">
      <div class="hand-label">${S.chain.length?'Tap to add to the end of your chain':'Your hand'}</div>
      <div id="hand">${S.hand.map(cardHTML).join('')}</div>
    </div>

    <div id="actions">
      <button class="btn btn-disc" id="discardBtn" ${S.discardsLeft<=0||S.chain.length===0?'disabled':''}>
        Discard <small>${S.discardsLeft} left</small>
      </button>
      <button class="btn btn-play" id="playBtn" ${S.chain.length===0?'disabled':''}>
        Play chain <small>${S.handsLeft} hands</small>
      </button>
    </div>

    <div id="toast"></div>
    <div class="overlay" id="overlay"></div>
  `;
  bindHand();
  bindChain();
  document.getElementById('playBtn').onclick = playChain;
  document.getElementById('discardBtn').onclick = discardSelected;
  document.getElementById('homeBtn').onclick = goHome;
}

function goHome(){
  const msg = S.mode==='free'
      ? 'Your progress is saved at <b>Stage '+S.stage+'</b>. You can pick up right here from the home screen.'
      : (S.mode==='blitz'
          ? 'Blitz progress is saved at <b>Stage '+S.stage+'</b>. The timer resets when you come back.'
          : 'This is the daily challenge — leaving will end this attempt.');
  showOverlay(`
    <div class="ov-eyebrow">Leave game</div>
    <div class="ov-title" style="font-size:26px">Back to home?</div>
    <div class="ov-sub">${msg}</div>
    <button class="big-btn" id="goHomeYes">Home</button>
    <button class="big-btn ghost" id="goHomeNo">Keep playing</button>
  `);
  document.getElementById('goHomeYes').onclick = ()=>{ stopTimer(); persistRun(); startScreen(); };
  document.getElementById('goHomeNo').onclick = ()=>{ hideOverlay(); if(isBlitz()) startTimer(); render(); };
}

/* The chain track: ordered slots resolving left -> right. Reorder = the puzzle. */
/* effective displayed value after stacking upgrades */
function effDisp(c){
  const amp = lvl('amplify')*2, over = lvl('overcharge')*0.5;
  if(c.type==='mult'){ const m = c.val+over; return '×'+(Math.round(m*10)/10); }
  if(c.type==='risk'){ return '!'+c.val; }
  return '+'+(c.val+amp);   // add & wild
}

function chainTrackHTML(){
  if(S.chain.length===0){
    return `<div class="zone-hint">Tap cards below to build a chain.<br>It scores <b>left to right</b> — order changes everything.<br><br><b>+</b> base · <b>×</b> multiply · <b>±</b> both · <b>!</b> gamble</div>`;
  }
  const cards = chainCards();
  const slots = cards.map((c,i)=>{
    return `<div class="slot t-${c.type}" data-idx="${i}">
        <div class="slot-pos">${i+1}</div>
        <div class="slot-val">${effDisp(c)}</div>
        <div class="slot-arrows">
          <button class="arr" data-move="${i}:-1" ${i===0?'disabled':''}>‹</button>
          <button class="arr" data-move="${i}:1" ${i===cards.length-1?'disabled':''}>›</button>
        </div>
        <button class="slot-x" data-rm="${i}">remove</button>
      </div>`;
  }).join('<div class="slot-link">→</div>');
  return `<div class="chain-track-wrap"><div class="chain-track">${slots}</div></div>`;
}

function cardHTML(c){
  const inChain = S.chain.includes(c.id) ? 'inchain' : '';
  const label = ({add:'add',mult:'mult',wild:'wild',risk:'risk'})[c.type];
  return `<div class="card t-${c.type} ${inChain}" data-id="${c.id}">
      <div class="corner"></div>
      <div><div class="cval">${effDisp(c)}</div><div class="cop">${c.op}</div></div>
      <div class="ctag">${label}</div>
    </div>`;
}

function bindHand(){
  document.querySelectorAll('#hand .card').forEach(el=>{
    el.onclick = ()=>{
      const id = +el.dataset.id;
      if(S.chain.includes(id)){ S.chain = S.chain.filter(x=>x!==id); }
      else { if(S.chain.length>=5){toast('Max 5 cards per chain');return;} S.chain.push(id); }
      render();
    };
  });
}

function bindChain(){
  // reorder arrows
  document.querySelectorAll('.arr').forEach(b=>{
    b.onclick = (e)=>{
      e.stopPropagation();
      const [idx,dir] = b.dataset.move.split(':').map(Number);
      const j = idx+dir;
      if(j<0 || j>=S.chain.length) return;
      [S.chain[idx], S.chain[j]] = [S.chain[j], S.chain[idx]];
      render();
    };
  });
  // remove from chain
  document.querySelectorAll('.slot-x').forEach(b=>{
    b.onclick = (e)=>{
      e.stopPropagation();
      const idx = +b.dataset.rm;
      S.chain.splice(idx,1);
      render();
    };
  });
}


/* ---- preview helpers (live readout follows the player's order) ---- */
function chainCards(){ return S.chain.map(id=>S.hand.find(c=>c.id===id)).filter(Boolean); }
function selectedCards(){ return chainCards(); }
function previewBase(){ return S.chain.length? evaluatePlay(chainCards()).base : 0; }
function previewMult(){ return S.chain.length? evaluatePlay(chainCards()).mult : 1; }
function previewTotal(){ return S.chain.length? evaluatePlay(chainCards()).total : 0; }
function hasMultSelected(){ return chainCards().some(c=>c.type==='mult'||c.type==='wild') || lvl('adept'); }

/* ============================================================
   CORE ACTIONS
   ============================================================ */

function playChain(){
  if(S.chain.length===0) return;
  const cards = selectedCards();
  const res = evaluatePlay(cards);

  // animate floaters for each step
  let delay = 0;
  res.steps.forEach(st=>{
    setTimeout(()=>{
      const color = st.kind.startsWith('risk-miss') ? 'var(--rose)' :
                    st.kind==='mult' ? 'var(--gold)' :
                    st.kind==='wild' ? 'var(--violet)' :
                    st.kind==='risk-hit' ? 'var(--gold)' : 'var(--volt)';
      const txt = st.kind==='mult' ? '×'+st.amt :
                  st.kind.startsWith('risk') ? (st.kind==='risk-hit'?'+'+st.amt+'!':'+'+st.amt) :
                  '+'+st.amt;
      spawnFloat(txt, color);
    }, delay);
    delay += 180;
  });

  // bank score after the step animation
  setTimeout(()=>{
    spawnFloat('= '+res.total, 'var(--white)', true);
    S.runScore += res.total;
    S.handsLeft--;
    S.chain = [];
    // track best single chain for stats
    if(res.total > (S.runStats.bestChain||0)) S.runStats.bestChain = res.total;
    // remove played cards, draw back up
    S.hand = S.hand.filter(c=>!cards.includes(c));
    draw();
    countUp(res.total);
    saveBest(Math.max(S.runScore, S.best));
    S.best = loadBest();

    setTimeout(()=>{
      if(S.runScore >= S.target){ stageWin(); }
      else if(S.handsLeft<=0){ stageLose(); }
      else { render(); }
    }, 650);
  }, delay+150);

  // immediately reflect spent hand visually
  document.getElementById('playBtn').disabled = true;
  document.getElementById('scoreboard').classList.add('pop');
}

function discardSelected(){
  if(S.discardsLeft<=0 || S.chain.length===0) return;
  const cards = selectedCards();
  S.hand = S.hand.filter(c=>!cards.includes(c));
  S.discardsLeft--;
  S.chain = [];
  draw();
  toast('Discarded '+cards.length+' card'+(cards.length>1?'s':''));
  render();
}


/* ============================================================
   FX
   ============================================================ */
function spawnFloat(txt, color, big){
  const layer = document.getElementById('floaters');
  if(!layer) return;
  const f = document.createElement('div');
  f.className='float';
  f.textContent = txt;
  f.style.color = color;
  if(big){ f.style.fontSize='40px'; f.style.fontWeight='700'; }
  f.style.left = (38 + Math.random()*24) + '%';
  f.style.top = (38 + Math.random()*14) + '%';
  layer.appendChild(f);
  setTimeout(()=>f.remove(), 1000);
}

function countUp(add){
  const el = document.getElementById('runScore');
  if(!el) return;
  el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
}

function toast(msg){
  const t = document.getElementById('toast');
  if(!t) return;
  t.textContent = msg; t.classList.add('show');
  clearTimeout(window.__tt);
  window.__tt = setTimeout(()=>t.classList.remove('show'), 1400);
}

/* ============================================================
   CELEBRATION — confetti + minimalist chime + haptic buzz
   Fires when a stage target is cleared. Degrades gracefully:
   confetti always works; sound/vibration fire when allowed.
   ============================================================ */
function celebrate(){
  confettiBurst();
  chime();
  buzz([0,40,30,60]);  // light double-tap haptic
}

function confettiBurst(){
  const layer = document.getElementById('floaters') || document.body;
  const colors = ['#5eead4','#fbbf24','#a78bfa','#fb7185','#f2f2fa'];
  const N = 36;
  for(let i=0;i<N;i++){
    const p = document.createElement('div');
    p.className = 'confetti';
    const c = colors[i%colors.length];
    p.style.background = c;
    p.style.left = (40 + Math.random()*20) + '%';
    p.style.top = '46%';
    const ang = Math.random()*Math.PI*2;
    const dist = 90 + Math.random()*160;
    const dx = Math.cos(ang)*dist;
    const dy = Math.sin(ang)*dist - 80; // bias upward
    const rot = (Math.random()*720-360)+'deg';
    p.style.setProperty('--dx', dx+'px');
    p.style.setProperty('--dy', dy+'px');
    p.style.setProperty('--rot', rot);
    p.style.animationDelay = (Math.random()*0.08)+'s';
    layer.appendChild(p);
    setTimeout(()=>p.remove(), 1300);
  }
}

let _audioCtx = null;
function audioCtx(){
  try{
    _audioCtx = _audioCtx || new (window.AudioContext||window.webkitAudioContext)();
    if(_audioCtx.state==='suspended') _audioCtx.resume();
    return _audioCtx;
  }catch(e){ return null; }
}
function chime(){
  if(!settings().sound) return;
  const ctx = audioCtx(); if(!ctx) return;
  try{
    const notes = [523.25, 659.25, 783.99]; // C5 E5 G5
    notes.forEach((f,i)=>{
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t0 = ctx.currentTime + i*0.09;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.18, t0+0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t0+0.35);
      o.connect(g); g.connect(ctx.destination);
      o.start(t0); o.stop(t0+0.4);
    });
  }catch(e){}
}

function buzz(pattern){
  if(!settings().vibration) return;
  try{ if(navigator.vibrate) navigator.vibrate(pattern); }catch(e){}
}

/* ============================================================
   SOUNDTRACK — real audio track, looped.
   Uses an <audio> element so it's a genuine produced track
   (not synthesized). Loops seamlessly, respects the Music
   setting, and fades in/out. Starts on first user gesture.
   ============================================================ */
let _music = { on:false, el:null, fadeTimer:null };
const MUSIC_VOLUME = 0.55;   // comfortable background level

function startMusic(){
  if(!settings().music) return;
  if(_music.on && _music.el) return;
  try{
    if(!_music.el){
      const el = new Audio('soundtrack.mp3');
      el.loop = true;
      el.preload = 'auto';
      el.volume = 0;
      _music.el = el;
    }
    _music.on = true;
    const el = _music.el;
    const p = el.play();
    if(p && p.catch) p.catch(()=>{ /* autoplay blocked until a gesture; ignore */ });
    fadeTo(MUSIC_VOLUME, 1500);
  }catch(e){}
}

function stopMusic(){
  _music.on = false;
  if(!_music.el) return;
  fadeTo(0, 500, ()=>{ try{ _music.el.pause(); }catch(e){} });
}

function fadeTo(target, ms, done){
  const el = _music.el; if(!el) return;
  if(_music.fadeTimer){ clearInterval(_music.fadeTimer); _music.fadeTimer=null; }
  const steps = Math.max(1, Math.round(ms/40));
  const start = el.volume;
  let i = 0;
  _music.fadeTimer = setInterval(()=>{
    i++;
    const v = start + (target-start)*(i/steps);
    try{ el.volume = Math.min(1, Math.max(0, v)); }catch(e){}
    if(i>=steps){
      clearInterval(_music.fadeTimer); _music.fadeTimer=null;
      if(done) done();
    }
  }, 40);
}

// call on first user gesture so audio is unlocked, then start music if enabled
function ensureAudioStarted(){
  audioCtx();
  if(settings().music && !_music.on) startMusic();
}

/* ============================================================
   STAGE FLOW + SHOP  (level-based: fail = retry this stage)
   ============================================================ */
function stageWin(){
  stopTimer();
  const reward = coinsForStage(S.stage, S.runScore, S.target);
  S.coins += reward;
  S.runStats.stagesCleared++;
  // lifetime stats
  const st = loadStats();
  st.runs = st.runs || 0;
  st.stagesCleared = Math.max(st.stagesCleared||0, (st.stagesCleared||0)+1);
  if(S.runStats.bestChain > (st.bestChain||0)) st.bestChain = S.runStats.bestChain;
  if(S.mode==='daily'){
    const key = ''+_seed;
    st.dailyBest = st.dailyBest||{};
    st.dailyBest[key] = Math.max(st.dailyBest[key]||0, S.runScore);
  }
  saveStats(st);
  persistRun();
  celebrate();                 // confetti + chime + haptic on the play screen
  const reward2 = reward;
  setTimeout(()=>{
    showOverlay(`
      <div class="ov-eyebrow">Stage ${S.stage} cleared</div>
      <div class="ov-title">Target smashed</div>
      <div class="stat-line">
        <div class="s"><div class="n" style="color:var(--volt)">${S.runScore}</div><div class="l">Scored</div></div>
        <div class="s"><div class="n" style="color:var(--gold)">+${reward2}</div><div class="l">Coins</div></div>
        <div class="s"><div class="n">${S.handsLeft}</div><div class="l">Hands left</div></div>
      </div>
      <button class="big-btn" id="toNext">Next stage →</button>
      <button class="big-btn ghost" id="toShop">Visit shop · ${S.coins}c</button>
    `);
    document.getElementById('toNext').onclick = ()=>{ nextStage(); hideOverlay(); render(); };
    document.getElementById('toShop').onclick = ()=>openShop(false);
  }, 550);
}

/* Blitz: the clock ran out before reaching the target */
function timeUp(){
  stopTimer();
  const buyCost = 5 + S.timeBuys*4;   // 5, 9, 13... rises each buy this stage
  const canBuy = S.coins >= buyCost;
  showOverlay(`
    <div class="ov-eyebrow">Stage ${S.stage} · time's up</div>
    <div class="ov-title">Clock beat you</div>
    <div class="ov-sub">You reached <b>${S.runScore}</b> of ${S.target} before time ran out.<br>Buy more time to keep this attempt going, or retry the stage fresh.</div>
    <div class="stat-line">
      <div class="s"><div class="n" style="color:var(--gold)">${S.coins}</div><div class="l">Coins</div></div>
      <div class="s"><div class="n" style="color:var(--volt)">${S.runScore}</div><div class="l">Scored</div></div>
      <div class="s"><div class="n">${S.target}</div><div class="l">Target</div></div>
    </div>
    <button class="big-btn" id="buyTime" ${canBuy?'':'disabled'}>+30 seconds · ${buyCost}c</button>
    <button class="big-btn ghost" id="retryTime">Retry stage ${S.stage}</button>
  `);
  const bt = document.getElementById('buyTime');
  if(bt) bt.onclick = ()=>{
    if(S.coins < buyCost){ toast('Not enough coins'); return; }
    S.coins -= buyCost;
    S.timeBuys++;
    S.timeLeft += 30;
    hideOverlay();
    startTimer();
    render();
  };
  document.getElementById('retryTime').onclick = ()=>{ startStage(); hideOverlay(); render(); };
}

function stageLose(){
  // LEVEL-BASED: you don't lose the run — you retry THIS stage.
  showOverlay(`
    <div class="ov-eyebrow">Stage ${S.stage}</div>
    <div class="ov-title">So close</div>
    <div class="ov-sub">You reached <b>${S.runScore}</b> of ${S.target}.<br>No progress lost — your coins and upgrades stay. Try this stage again.</div>
    <div class="stat-line">
      <div class="s"><div class="n" style="color:var(--gold)">${S.coins}</div><div class="l">Coins</div></div>
      <div class="s"><div class="n">${totalUpgrades()}</div><div class="l">Upgrades</div></div>
      <div class="s"><div class="n" style="color:var(--volt)">${S.stage}</div><div class="l">Stage</div></div>
    </div>
    <button class="big-btn" id="retry">Retry stage ${S.stage}</button>
    ${S.coins>0?'<button class="big-btn ghost" id="shopFirst">Shop first</button>':''}
  `);
  document.getElementById('retry').onclick = ()=>{ startStage(); hideOverlay(); render(); };
  const sf = document.getElementById('shopFirst');
  if(sf) sf.onclick = ()=>openShop(true);
}

/* Upgrades: 'repeat' = buy many times (cost rises); 'once' = single milestone buy */
const SHOP_ITEMS = [
  {id:'amplify',  name:'Amplify',  icon:'+', kind:'repeat', base:6, desc:'+2 to every + card you play. Stacks.'},
  {id:'overcharge',name:'Overcharge',icon:'×',kind:'repeat', base:9, desc:'+0.5 to every × card. Stacks.'},
  {id:'reserve',  name:'Reserve',  icon:'✋', kind:'repeat', base:7, max:4, desc:'+1 hand each stage.'},
  {id:'wide',     name:'Wide draw', icon:'▦', kind:'repeat', base:8, max:4, desc:'+1 card drawn each turn.'},
  {id:'sift',     name:'Sift',     icon:'♻', kind:'repeat', base:5, max:5, desc:'+2 discards each stage.'},
  {id:'clock',    name:'Clock',    icon:'⏱', kind:'repeat', base:8, max:5, blitzOnly:true, desc:'+10s starting time each stage.'},
  {id:'adept',    name:'Adept',    icon:'⚡', kind:'once', base:14, desc:'×1.5 to your whole chain, every hand.'},
  {id:'engine',   name:'Engine',   icon:'⚙', kind:'once', base:12, desc:'+3 to your total per card played.'},
  {id:'compound', name:'Compound', icon:'◆', kind:'once', base:18, desc:'Your first × card each hand counts twice.'},
];

function totalUpgrades(){
  return Object.values(S.upgrades||{}).reduce((a,b)=>a+(b||0),0);
}
// cost of the NEXT purchase: repeatables rise ~50% per level
function itemCost(it){
  const n = lvl(it.id);
  if(it.kind==='once') return it.base;
  return Math.round(it.base * Math.pow(1.5, n));
}
function itemMaxed(it){
  if(it.kind==='once') return lvl(it.id)>=1;
  return it.max ? lvl(it.id)>=it.max : false;
}

// retryAfter = true when entering shop from a failed stage (button returns to retry)
function openShop(retryAfter){
  retryAfter = retryAfter === true;
  showOverlay(`
    <div class="ov-eyebrow">Shop · <b style="color:var(--gold)">${S.coins}</b> coins</div>
    <div class="ov-title" style="font-size:22px;margin-bottom:14px">${retryAfter?'Gear up, then retry':'Spend before stage '+(S.stage+1)}</div>
    <div class="shop-grid">
      ${SHOP_ITEMS.filter(it=>!it.blitzOnly || isBlitz()).map(it=>{
        const n = lvl(it.id);
        const maxed = itemMaxed(it);
        const cost = itemCost(it);
        const afford = S.coins>=cost;
        const cls = maxed?'bought':(afford?'':'cant');
        const badge = it.kind==='repeat' && n>0 ? `<span class="lvl-badge">Lv ${n}</span>` : (it.kind==='once'&&n>0?'<span class="lvl-badge">owned</span>':'');
        return `<div class="shop-card ${cls}" data-id="${it.id}">
          <div class="shop-ico">${it.icon}</div>
          <div class="shop-meta">
            <div class="shop-name">${it.name} ${badge}</div>
            <div class="shop-desc">${it.desc}</div>
          </div>
          <div class="shop-cost">${maxed?'✓':cost+'c'}</div>
        </div>`;
      }).join('')}
    </div>
    <button class="big-btn" id="shopNext">${retryAfter?'Retry stage '+S.stage+' →':'Start stage '+(S.stage+1)+' →'}</button>
  `);
  document.querySelectorAll('.shop-card').forEach(el=>{
    el.onclick = ()=>{
      const it = SHOP_ITEMS.find(i=>i.id===el.dataset.id);
      if(itemMaxed(it)){ toast(it.kind==='once'?'Already owned':'Maxed out'); return; }
      const cost = itemCost(it);
      if(S.coins < cost){ toast('Not enough coins'); return; }
      S.coins -= cost;
      S.upgrades[it.id] = lvl(it.id) + 1;
      persistRun();
      openShop(retryAfter);
    };
  });
  document.getElementById('shopNext').onclick = ()=>{
    if(retryAfter){ startStage(); }
    else { nextStage(); }
    hideOverlay(); render();
  };
}

function nextStage(){
  S.stage++;
  S.target = targetForStage(S.stage);
  startStage();
}

function showOverlay(html){
  pauseTimer();   // blitz: never let the clock run under a menu
  let ov = document.getElementById('overlay');
  ov.innerHTML = html; ov.classList.add('show');
  // if content is taller than the viewport, switch to scrollable top-aligned layout
  requestAnimationFrame(()=>{
    if(!ov) return;
    const tooTall = ov.scrollHeight > ov.clientHeight - 20;
    ov.classList.toggle('scrolly', tooTall);
    ov.scrollTop = 0;
  });
}
function hideOverlay(){
  const ov = document.getElementById('overlay');
  if(ov){ ov.classList.remove('show','scrolly'); ov.innerHTML=''; }
}

/* ============================================================
   START SCREEN
   ============================================================ */
function startScreen(){
  stopTimer();   // ensure no blitz clock keeps ticking on the home screen
  const resumeFree = hasSavedRun('free');
  const savedFree = resumeFree ? load(SAVE_KEY) : null;
  const resumeBlitz = hasSavedRun('blitz');
  const savedBlitz = resumeBlitz ? load(BLITZ_KEY) : null;
  App.innerHTML = `<div class="overlay show" id="overlay" style="background:var(--ink)">
    <div class="ov-eyebrow">a combo roguelite</div>
    <div class="ov-title" style="font-size:54px;letter-spacing:-.03em">CHAIN</div>
    <div class="ov-sub">Arrange cards into a sequence. It scores <b>left to right</b>, so the order is the whole puzzle.</div>
    <div class="menu-btns">
      ${resumeFree ? `<button class="menu-btn primary" id="resume"><span class="mb-title">Continue</span><span class="mb-sub">Free play · Stage ${savedFree.stage}</span></button>` : ''}
      <button class="menu-btn ${resumeFree?'':'primary'}" id="daily"><span class="mb-title">Daily challenge</span><span class="mb-sub">${todayLabel()} · same shuffle for everyone</span></button>
      <button class="menu-btn" id="play"><span class="mb-title">${resumeFree?'New free run':'Free play'}</span><span class="mb-sub">Endless · think it through</span></button>
      <button class="menu-btn" id="blitz"><span class="mb-title">⏱ Blitz mode</span><span class="mb-sub">${resumeBlitz?'Continue · Stage '+savedBlitz.stage:'Race the clock each stage'}</span></button>
    </div>
    <div class="icon-links">
      <button class="icon-link" id="stats" aria-label="Stats">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="20" x2="6" y2="13"/><line x1="12" y1="20" x2="12" y2="6"/><line x1="18" y1="20" x2="18" y2="10"/></svg>
        <span>Stats</span>
      </button>
      <button class="icon-link" id="settings" aria-label="Settings">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        <span>Settings</span>
      </button>
      <button class="icon-link" id="how" aria-label="How to play">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <span>How to play</span>
      </button>
    </div>
  </div>`;
  if(resumeFree){
    document.getElementById('resume').onclick = ()=>{ newRun('free', true); render(); };
  }
  document.getElementById('daily').onclick = ()=>{ newRun('daily'); render(); };
  document.getElementById('play').onclick = ()=>{
    if(resumeFree){
      showOverlay(`
        <div class="ov-eyebrow">Start over</div>
        <div class="ov-title" style="font-size:26px">New free run?</div>
        <div class="ov-sub">This replaces your saved run at <b>Stage ${savedFree.stage}</b> with a fresh one.</div>
        <button class="big-btn" id="newYes">Start new run</button>
        <button class="big-btn ghost" id="newNo">Keep my run</button>
      `);
      document.getElementById('newYes').onclick = ()=>{ clearSave(SAVE_KEY); newRun('free'); render(); };
      document.getElementById('newNo').onclick = startScreen;
    } else { newRun('free'); render(); }
  };
  document.getElementById('blitz').onclick = ()=>{
    if(resumeBlitz){ newRun('blitz', true); render(); }
    else { newRun('blitz'); render(); }
  };
  document.getElementById('stats').onclick = statsScreen;
  document.getElementById('settings').onclick = settingsScreen;
  document.getElementById('how').onclick = howScreen;
}

function settingsScreen(){
  const s = settings();
  const row = (key, label, desc)=>`
    <div class="set-row" data-key="${key}">
      <div class="set-meta">
        <div class="set-name">${label}</div>
        <div class="set-desc">${desc}</div>
      </div>
      <button class="toggle ${s[key]?'on':''}" data-toggle="${key}" role="switch" aria-checked="${s[key]}">
        <span class="knob"></span>
      </button>
    </div>`;
  showOverlay(`
    <div class="ov-eyebrow">Preferences</div>
    <div class="ov-title" style="font-size:28px;margin-bottom:20px">Settings</div>
    <div class="set-list">
      ${row('music','Music','Subtle background soundtrack')}
      ${row('sound','Sound effects','Chimes and feedback tones')}
      ${row('vibration','Vibration','Haptic buzz on milestones')}
    </div>
    ${!LS_OK ? `<div class="ov-sub" style="font-size:12px;color:var(--fog);margin-top:6px">Settings save fully when the game runs as its own file.</div>`:''}
    <button class="big-btn" id="setBack">Back</button>
  `);
  document.querySelectorAll('.toggle').forEach(btn=>{
    btn.onclick = ()=>{
      const key = btn.dataset.toggle;
      const next = !settings()[key];
      setSetting(key, next);
      btn.classList.toggle('on', next);
      btn.setAttribute('aria-checked', next);
      // a soft tick when enabling sound, so the effect is audible immediately
      if(key==='sound' && next) chime();
      if(key==='music' && next) ensureAudioStarted();
    };
  });
  document.getElementById('setBack').onclick = startScreen;
}

function statsScreen(){
  const st = loadStats();
  const dailyCount = Object.keys(st.dailyBest||{}).length;
  const todayKey = (()=>{ const d=new Date(); return ''+(d.getFullYear()*10000+(d.getMonth()+1)*100+d.getDate()); })();
  const todayScore = (st.dailyBest||{})[todayKey];
  showOverlay(`
    <div class="ov-eyebrow">Your numbers</div>
    <div class="ov-title" style="font-size:28px;margin-bottom:20px">Stats</div>
    <div class="stats-grid">
      <div class="stat-box"><div class="sb-n" style="color:var(--volt)">${st.best||0}</div><div class="sb-l">Best stage score</div></div>
      <div class="stat-box"><div class="sb-n" style="color:var(--gold)">${st.bestChain||0}</div><div class="sb-l">Best single chain</div></div>
      <div class="stat-box"><div class="sb-n">${st.stagesCleared||0}</div><div class="sb-l">Stages cleared</div></div>
      <div class="stat-box"><div class="sb-n" style="color:var(--violet)">${dailyCount}</div><div class="sb-l">Dailies played</div></div>
    </div>
    ${todayScore!=null ? `<div class="ov-sub" style="margin-top:18px">Today's daily best: <b>${todayScore}</b></div>`:''}
    ${!LS_OK ? `<div class="ov-sub" style="font-size:12px;color:var(--fog);margin-top:14px">Saving is limited in this preview. Run the game as its own file for stats that stick.</div>`:''}
    <button class="big-btn" id="statsBack">Back</button>
  `);
  document.getElementById('statsBack').onclick = startScreen;
}

function howScreen(){
  showOverlay(`
    <div class="ov-eyebrow">How scoring works</div>
    <div class="ov-title" style="font-size:26px">Order matters</div>
    <div class="ov-sub" style="text-align:left">
      Your chain resolves <b>left to right</b>, building a running total. Each card acts on the score so far.<br><br>
      <b style="color:var(--volt)">+ add</b> — adds its value to the total.<br><br>
      <b style="color:var(--gold)">× mult</b> — multiplies the total so far. Do your adds <i>first</i>, then multiply.<br><br>
      <b style="color:var(--violet)">± wild</b> — adds, then gives a small ×1.5.<br><br>
      <b style="color:var(--rose)">! risk</b> — pays double, but only if you've already multiplied <i>before</i> it. Place it after a ×, not before.<br><br>
      Hit the target before you run out of hands. Fail and you just retry the stage — your progress stays.
    </div>
    <button class="big-btn" id="back">Got it</button>
  `);
  document.getElementById('back').onclick = startScreen;
}

startScreen();
