/* ============================================================
   ATTRITION — game server + shared leaderboard
   ============================================================

   What this file does, in plain English:

     1. It serves your game. Anything inside the "public" folder
        gets sent to the browser, so public/index.html IS the game.

     2. It remembers everyone's scores in one shared place, so every
        player sees the same leaderboard.

   The two doors ("routes") the game knocks on:

     POST /api/score        "Here is my score, please save it."
     GET  /api/leaderboard  "Who are the best pilots right now?"

   Scores live in a file called scores.json. Simple and no database
   needed. See README.md for how to keep that file safe on Render.
   ============================================================ */

const express = require('express');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

/* Where to keep scores.json.
   On Render you can attach a Persistent Disk and set DATA_DIR to its
   mount path (e.g. /var/data) so scores survive redeploys. */
const DATA_DIR   = process.env.DATA_DIR || __dirname;
const SCORE_FILE = path.join(DATA_DIR, 'scores.json');
const EVENT_FILE = path.join(DATA_DIR, 'events.json');
const TRADE_FILE = path.join(DATA_DIR, 'trades.json');
const PEND_FILE  = path.join(DATA_DIR, 'pending.json');

/* The phrase
/* The phrase that unlocks the admin panel. Anyone who knows it is an
   admin — it is not tied to any account. You can change it here, or set
   an ADMIN_KEY environment variable on Render to override it.
   NOTE: the game page has to know this too, so a determined player can
   find it by reading the page source. It keeps casual players out, not
   someone who goes looking. */
const ADMIN_KEY = process.env.ADMIN_KEY || 'IM BACK';

/* How many pilots the leaderboard shows at most. */
const TOP_N = 50;

/* ============================================================
   READING AND WRITING THE SCORE FILE
   ============================================================ */

/* scores lives in memory while the server runs. The file on disk is
   just the backup copy so nothing is lost when the server restarts. */
let scores = {};

function loadScores() {
  try {
    const raw = fs.readFileSync(SCORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      scores = parsed;
      console.log(`Loaded ${Object.keys(scores).length} pilot record(s).`);
      return;
    }
  } catch (err) {
    // No file yet (first ever run), or it got corrupted. Start fresh.
    if (err.code !== 'ENOENT') console.warn('Could not read scores.json:', err.message);
  }
  scores = {};
}

/* Writing to disk on EVERY single score would be slow, so we wait a
   moment and batch the writes together. */
let saveTimer = null;
let saving    = false;

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveScores(); }, 800);
}

function saveScores() {
  if (saving) { scheduleSave(); return; }
  saving = true;

  /* Write to a temporary file first, then rename it over the real one.
     Renaming is instant, so the real file is never left half-written
     if the server dies mid-save. */
  const tmp = SCORE_FILE + '.tmp';
  const data = JSON.stringify(scores, null, 2);

  fs.writeFile(tmp, data, 'utf8', (err) => {
    if (err) { saving = false; console.error('Save failed:', err.message); return; }
    fs.rename(tmp, SCORE_FILE, (err2) => {
      saving = false;
      if (err2) console.error('Save rename failed:', err2.message);
    });
  });
}

/* ---- events live in their own file, same pattern as scores ---- */
let events = {};

function loadEvents(){
  try{
    const parsed = JSON.parse(fs.readFileSync(EVENT_FILE,'utf8'));
    if(parsed && typeof parsed==='object'){
      events = parsed;
      console.log(`Loaded ${Object.keys(events).length} event(s).`);
      return;
    }
  }catch(err){
    if(err.code !== 'ENOENT') console.warn('Could not read events.json:', err.message);
  }
  events = {};
}

let evTimer = null;
function scheduleEventSave(){
  if(evTimer) return;
  evTimer = setTimeout(()=>{ evTimer=null; saveEvents(); }, 500);
}
function saveEvents(){
  const tmp = EVENT_FILE + '.tmp';
  fs.writeFile(tmp, JSON.stringify(events,null,2), 'utf8', err=>{
    if(err){ console.error('Event save failed:', err.message); return; }
    fs.rename(tmp, EVENT_FILE, e2=>{ if(e2) console.error('Event rename failed:', e2.message); });
  });
}

/* ---- trade listings, and the deliveries waiting for sellers ---- */
let trades = {}, pending = {};

function loadJson(file, label){
  try{
    const parsed = JSON.parse(fs.readFileSync(file,'utf8'));
    if(parsed && typeof parsed==='object'){
      console.log(`Loaded ${Object.keys(parsed).length} ${label}.`);
      return parsed;
    }
  }catch(err){
    if(err.code !== 'ENOENT') console.warn(`Could not read ${file}:`, err.message);
  }
  return {};
}
function writeJson(file, data, label){
  const tmp = file + '.tmp';
  fs.writeFile(tmp, JSON.stringify(data,null,2), 'utf8', err=>{
    if(err){ console.error(label+' save failed:', err.message); return; }
    fs.rename(tmp, file, e2=>{ if(e2) console.error(label+' rename failed:', e2.message); });
  });
}

let trTimer=null, peTimer=null;
function scheduleTradeSave(){
  if(trTimer) return;
  trTimer=setTimeout(()=>{ trTimer=null; writeJson(TRADE_FILE,trades,'Trades'); },500);
}
function schedulePendingSave(){
  if(peTimer) return;
  peTimer=setTimeout(()=>{ peTimer=null; writeJson(PEND_FILE,pending,'Pending'); },500);
}

loadScores();
loadEvents();
trades  = loadJson(TRADE_FILE,'trade listing(s)');
pending = loadJson(PEND_FILE, 'pending delivery queue(s)');

/* Last-chance save if Render shuts the server down. */
function shutdown() {
  try { fs.writeFileSync(SCORE_FILE, JSON.stringify(scores, null, 2), 'utf8'); } catch (e) {}
  try { fs.writeFileSync(EVENT_FILE, JSON.stringify(events, null, 2), 'utf8'); } catch (e) {}
  try { fs.writeFileSync(TRADE_FILE, JSON.stringify(trades, null, 2), 'utf8'); } catch (e) {}
  try { fs.writeFileSync(PEND_FILE,  JSON.stringify(pending,null, 2), 'utf8'); } catch (e) {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

/* ============================================================
   MIDDLEWARE (stuff that runs on every request)
   ============================================================ */

/* Understand JSON that the game sends us. The limit stops anyone
   trying to flood us with a giant message. */
app.use(express.json({ limit: '8kb' }));

/* CORS: lets the game talk to this server even when the page itself is
   opened from somewhere else (like a Render Static Site, or a file on
   your own computer while you are testing). */
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* A very simple rate limit so one person cannot spam a thousand scores
   a second. Each IP address gets 30 writes per minute. */
const hits = new Map();
function rateLimit(req, res, next) {
  const ip  = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || 'unknown';
  const now = Date.now();
  const rec = hits.get(ip);

  if (!rec || now > rec.reset) {
    hits.set(ip, { count: 1, reset: now + 60_000 });
    return next();
  }
  if (rec.count >= 30) {
    return res.status(429).json({ error: 'Slow down a moment — too many requests.' });
  }
  rec.count++;
  next();
}

/* Throw away old rate-limit records now and then so memory stays small. */
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of hits) if (now > rec.reset) hits.delete(ip);
}, 120_000).unref();

/* ============================================================
   CHECKING WHAT THE GAME SENDS US
   Never trust data from a browser — anyone can edit it.
   ============================================================ */

function cleanName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 24) return null;
  /* Letters, numbers, spaces, dash, underscore and dot only.
     This blocks anyone putting HTML or weird characters in. */
  if (!/^[A-Za-z0-9 ._-]+$/.test(trimmed)) return null;
  return trimmed;
}

function cleanNumber(value, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(max, Math.floor(n)));
}

/* ============================================================
   ROUTE 1 — SAVE A SCORE
   The game calls this after every sortie.
   ============================================================ */
app.post('/api/score', rateLimit, (req, res) => {
  const body = req.body || {};

  const name = cleanName(body.username);
  if (!name) {
    return res.status(400).json({ error: 'Callsign must be 2-24 letters, numbers, spaces, . _ or -' });
  }

  const incoming = {
    username:   name,
    best:       cleanNumber(body.best,       100000),  // best kills in one sortie
    totalKills: cleanNumber(body.totalKills, 10000000),
    sorties:    cleanNumber(body.sorties,    1000000),
    wave:       cleanNumber(body.wave,       100000),
    updated:    Date.now(),
  };

  /* Keep one record per callsign, and only ever move the numbers UP.
     That way an old save or a weaker run can never wipe out a
     pilot's real best score. */
  const key      = name.toLowerCase();
  const existing = scores[key];

  if (existing) {
    scores[key] = {
      username:   incoming.username,
      best:       Math.max(existing.best       || 0, incoming.best),
      totalKills: Math.max(existing.totalKills || 0, incoming.totalKills),
      sorties:    Math.max(existing.sorties    || 0, incoming.sorties),
      wave:       Math.max(existing.wave       || 0, incoming.wave),
      updated:    incoming.updated,
    };
  } else {
    scores[key] = incoming;
  }

  scheduleSave();

  /* Tell the game what rank that pilot now sits at. */
  const board = rankedBoard();
  const rank  = board.findIndex(e => e.username.toLowerCase() === key) + 1;

  res.json({ ok: true, rank, total: board.length, entry: scores[key] });
});

/* ============================================================
   ROUTE 2 — READ THE LEADERBOARD
   ============================================================ */

function rankedBoard() {
  return Object.values(scores).sort((a, b) =>
    (b.best       || 0) - (a.best       || 0) ||   // best single sortie first
    (b.wave       || 0) - (a.wave       || 0) ||   // then furthest sortie reached
    (b.totalKills || 0) - (a.totalKills || 0) ||   // then career kills
    (a.updated    || 0) - (b.updated    || 0)      // ties: whoever got there first
  );
}

app.get('/api/leaderboard', (req, res) => {
  const limit = Math.max(1, Math.min(TOP_N, Number(req.query.limit) || 20));
  const board = rankedBoard();

  const top = board.slice(0, limit).map((e, i) => ({
    rank:       i + 1,
    username:   e.username,
    best:       e.best       || 0,
    wave:       e.wave       || 0,
    totalKills: e.totalKills || 0,
    sorties:    e.sorties    || 0,
  }));

  /* If the game tells us who is asking, include their row too —
     handy when they are ranked below the cut-off. */
  const me = cleanName(req.query.me);
  let you = null;
  if (me) {
    const key = me.toLowerCase();
    const idx = board.findIndex(e => e.username.toLowerCase() === key);
    if (idx >= 0) {
      you = {
        rank:       idx + 1,
        username:   board[idx].username,
        best:       board[idx].best       || 0,
        wave:       board[idx].wave       || 0,
        totalKills: board[idx].totalKills || 0,
        sorties:    board[idx].sorties    || 0,
      };
    }
  }

  res.json({ ok: true, total: board.length, top, you });
});

/* ============================================================
   EVENTS
   An admin sets a target ("reach 500 career kills") and a reward.
   The first N pilots to hit it get paid, then the event closes.
   ============================================================ */

/* The stats an event can be built on. Each one must match a number the
   game actually tracks, or nobody could ever qualify. */
const EVENT_STATS = {
  totalKills: 'Career kills',
  best:       'Best single sortie',
  sorties:    'Sorties flown',
  wave:       'Furthest sortie reached',
  warWins:    'Wars won',
  legendWins: 'Legend wars won',
};
const REWARD_TYPES = ['money','card','randomCard'];

function eventIsOpen(ev){
  if(ev.expires && Date.now() > ev.expires) return false;
  if((ev.claims||[]).length >= ev.limit) return false;
  return true;
}
function publicEvent(ev){
  return {
    id: ev.id, title: ev.title, desc: ev.desc,
    stat: ev.stat, statLabel: EVENT_STATS[ev.stat] || ev.stat,
    target: ev.target, reward: ev.reward, limit: ev.limit,
    taken: (ev.claims||[]).length,
    claimedBy: (ev.claims||[]).map(c=>c.user),
    expires: ev.expires || null,
    open: eventIsOpen(ev),
  };
}

/* ---- what everyone sees on the notice board ---- */
app.get('/api/events', (req, res) => {
  const all = Object.values(events)
    .sort((a,b)=>(b.created||0)-(a.created||0))
    .map(publicEvent);
  const me = cleanName(req.query.me);
  res.json({
    ok:true,
    events: all.filter(e=>e.open),
    mine: me ? all.filter(e=>e.claimedBy.some(u=>u.toLowerCase()===me.toLowerCase())) : [],
  });
});

/* ---- admin: every event, open or closed ---- */
app.post('/api/admin/list', rateLimit, (req, res) => {
  if((req.body||{}).key !== ADMIN_KEY) return res.status(403).json({ error:'Wrong phrase.' });
  res.json({ ok:true, events: Object.values(events)
    .sort((a,b)=>(b.created||0)-(a.created||0)).map(publicEvent) });
});

/* ---- admin: create one ---- */
app.post('/api/admin/create', rateLimit, (req, res) => {
  const b = req.body || {};
  if(b.key !== ADMIN_KEY) return res.status(403).json({ error:'Wrong phrase.' });

  const title = typeof b.title==='string' ? b.title.trim().slice(0,60) : '';
  const desc  = typeof b.desc ==='string' ? b.desc.trim().slice(0,160) : '';
  if(title.length < 2) return res.status(400).json({ error:'Give the event a title.' });
  if(!EVENT_STATS[b.stat]) return res.status(400).json({ error:'Unknown condition.' });

  const target = Math.max(1, Math.min(10000000, Math.floor(Number(b.target)||0)));
  const limit  = Math.max(1, Math.min(1000, Math.floor(Number(b.limit)||1)));
  if(!target) return res.status(400).json({ error:'Target must be at least 1.' });

  const r = b.reward || {};
  if(!REWARD_TYPES.includes(r.type)) return res.status(400).json({ error:'Unknown reward type.' });
  const reward = { type: r.type };
  if(r.type==='money'){
    reward.amount = Math.max(1, Math.min(10000000, Math.floor(Number(r.amount)||0)));
  } else if(r.type==='card'){
    if(typeof r.cardId!=='string' || !/^[a-z]+_[a-z]+$/.test(r.cardId))
      return res.status(400).json({ error:'Bad card id.' });
    reward.cardId = r.cardId;
  } else {
    reward.rarity = Math.max(0, Math.min(5, Math.floor(Number(r.rarity)||0)));
  }

  let expires = null;
  if(b.expires){
    const t = Number(b.expires);
    if(Number.isFinite(t) && t > Date.now()) expires = Math.floor(t);
  }

  const id = 'ev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,7);
  events[id] = { id, title, desc, stat:b.stat, target, reward, limit,
                 claims:[], expires, created: Date.now() };
  scheduleEventSave();
  res.json({ ok:true, event: publicEvent(events[id]) });
});

/* ---- admin: delete one ---- */
app.post('/api/admin/delete', rateLimit, (req, res) => {
  const b = req.body || {};
  if(b.key !== ADMIN_KEY) return res.status(403).json({ error:'Wrong phrase.' });
  if(!events[b.id]) return res.status(404).json({ error:'No such event.' });
  delete events[b.id];
  scheduleEventSave();
  res.json({ ok:true });
});

/* ---- a pilot claims a reward ----
   The game sends its own numbers, so a determined player could lie about
   them. That is the same trade-off the leaderboard already makes. The
   server still enforces the things that actually matter: the target, the
   number of spots left, the expiry, and one claim per pilot. */
app.post('/api/claim', rateLimit, (req, res) => {
  const b = req.body || {};
  const name = cleanName(b.username);
  if(!name) return res.status(400).json({ error:'Bad callsign.' });

  const ev = events[b.id];
  if(!ev) return res.status(404).json({ error:'No such event.' });
  if(ev.expires && Date.now() > ev.expires) return res.json({ ok:false, reason:'expired' });
  if((ev.claims||[]).length >= ev.limit)     return res.json({ ok:false, reason:'full' });

  const key = name.toLowerCase();
  if(ev.claims.some(c=>c.user.toLowerCase()===key))
    return res.json({ ok:false, reason:'already' });

  const have = cleanNumber(b.value, 10000000);
  if(have < ev.target) return res.json({ ok:false, reason:'short', need: ev.target, have });

  ev.claims.push({ user:name, at:Date.now(), value:have });
  scheduleEventSave();
  res.json({ ok:true, reward: ev.reward, title: ev.title,
             place: ev.claims.length, limit: ev.limit });
});

/* ============================================================
   TRADE CENTRE
   A pilot lists something they own and names what they will take
   for it. The listed item leaves their game the moment they post it
   and the server holds it, so nothing can be sold twice or used
   while it sits on the board.
   ============================================================ */

/* ---- what counts as a tradeable item ---- */
function cleanItem(raw){
  if(!raw || typeof raw!=='object') return null;
  const k = raw.kind;

  if(k==='money'){
    const a = Math.floor(Number(raw.amount)||0);
    if(a<1 || a>10000000) return null;
    return { kind:'money', amount:a };
  }
  if(k==='card'){
    if(typeof raw.cardId!=='string' || !/^[a-z]+_[a-z]+$/.test(raw.cardId)) return null;
    const n = Math.max(1, Math.min(99, Math.floor(Number(raw.count)||1)));
    return { kind:'card', cardId:raw.cardId, count:n };
  }
  if(k==='plane'){
    if(typeof raw.planeId!=='string' || !/^[a-z0-9_-]{1,24}$/.test(raw.planeId)) return null;
    const n = Math.max(1, Math.min(20, Math.floor(Number(raw.count)||1)));
    return { kind:'plane', planeId:raw.planeId, count:n };
  }
  if(k==='weapon'){
    if(typeof raw.weaponId!=='string' || !/^[a-z0-9_-]{1,24}$/.test(raw.weaponId)) return null;
    return { kind:'weapon', weaponId:raw.weaponId };
  }
  if(k==='ammo'){
    if(typeof raw.weaponId!=='string' || !/^[a-z0-9_-]{1,24}$/.test(raw.weaponId)) return null;
    const n = Math.max(1, Math.min(100000, Math.floor(Number(raw.count)||0)));
    if(n<1) return null;
    return { kind:'ammo', weaponId:raw.weaponId, count:n };
  }
  return null;
}

function sameItem(a,b){
  if(!a||!b||a.kind!==b.kind) return false;
  if(a.kind==='money')  return a.amount===b.amount;
  if(a.kind==='card')   return a.cardId===b.cardId && a.count===b.count;
  if(a.kind==='plane')  return a.planeId===b.planeId && a.count===b.count;
  if(a.kind==='weapon') return a.weaponId===b.weaponId;
  if(a.kind==='ammo')   return a.weaponId===b.weaponId && a.count===b.count;
  return false;
}

/* how many listings one pilot may have open at once */
const MAX_LISTINGS = 12;

/* ---- post a listing ---- */
app.post('/api/trade/create', rateLimit, (req,res)=>{
  const b = req.body||{};
  const name = cleanName(b.username);
  if(!name) return res.status(400).json({ error:'Bad callsign.' });

  const offer = cleanItem(b.offer);
  if(!offer) return res.status(400).json({ error:'Nothing valid to trade.' });

  const wantsRaw = Array.isArray(b.wants) ? b.wants.slice(0,5) : [];
  const wants = wantsRaw.map(cleanItem).filter(Boolean);
  if(!wants.length) return res.status(400).json({ error:'Say what you want for it.' });

  const key = name.toLowerCase();
  const mine = Object.values(trades).filter(t=>t.status==='open' && t.sellerKey===key);
  if(mine.length >= MAX_LISTINGS)
    return res.status(400).json({ error:'You already have '+MAX_LISTINGS+' listings open.' });

  const id = 't_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,7);
  trades[id] = { id, seller:name, sellerKey:key, offer, wants,
                 status:'open', created:Date.now() };
  scheduleTradeSave();
  res.json({ ok:true, trade: trades[id] });
});

/* ---- the board ---- */
app.get('/api/trade/open', (req,res)=>{
  const list = Object.values(trades)
    .filter(t=>t.status==='open')
    .sort((a,b)=>b.created-a.created)
    .slice(0,200);
  res.json({ ok:true, trades:list });
});

/* ---- take a listing down; the item comes straight back ---- */
app.post('/api/trade/cancel', rateLimit, (req,res)=>{
  const b = req.body||{};
  const name = cleanName(b.username);
  if(!name) return res.status(400).json({ error:'Bad callsign.' });
  const t = trades[b.id];
  if(!t) return res.status(404).json({ error:'No such listing.' });
  if(t.sellerKey !== name.toLowerCase())
    return res.status(403).json({ error:'That is not your listing.' });
  if(t.status!=='open') return res.json({ ok:false, reason:'gone' });

  t.status='cancelled'; t.closed=Date.now();
  scheduleTradeSave();
  res.json({ ok:true, refund:t.offer });     // the client puts it back
});

/* ---- accept a listing ----
   The buyer has already taken the payment out of their own game before
   calling this. If the listing turns out to be gone we say so and they
   put it back. */
app.post('/api/trade/accept', rateLimit, (req,res)=>{
  const b = req.body||{};
  const name = cleanName(b.username);
  if(!name) return res.status(400).json({ error:'Bad callsign.' });

  const t = trades[b.id];
  if(!t) return res.status(404).json({ error:'No such listing.' });
  if(t.status!=='open') return res.json({ ok:false, reason:'gone' });
  if(t.sellerKey === name.toLowerCase())
    return res.json({ ok:false, reason:'own' });

  const idx = Math.floor(Number(b.wantIndex));
  if(!(idx>=0 && idx < t.wants.length)) return res.status(400).json({ error:'Bad choice.' });

  /* the payment the buyer says they sent must match what was asked for */
  const paid = cleanItem(b.payment);
  if(!paid || !sameItem(paid, t.wants[idx]))
    return res.status(400).json({ error:'That is not what the listing asked for.' });

  t.status='done';
  t.buyer=name; t.paid=paid; t.closed=Date.now();

  /* the seller is probably offline, so their payment waits for them */
  pending[t.sellerKey] = pending[t.sellerKey] || [];
  pending[t.sellerKey].push({
    id:'p_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,7),
    item:paid, why:'sold', from:name, at:Date.now(),
  });

  scheduleTradeSave();
  schedulePendingSave();
  res.json({ ok:true, got:t.offer, seller:t.seller });
});

/* ---- collect what is waiting: payments, and anything refunded ----
   This hands the items over but KEEPS them. They are only deleted once
   the game confirms it received them, through /api/trade/ack below.
   If the reply never arrives — a slow wake-up, a closed laptop, a
   dropped connection — the payment is still here next time.
   The game skips anything it has already applied, so holding them does
   not pay anyone twice. */
app.post('/api/trade/pending', rateLimit, (req,res)=>{
  const name = cleanName((req.body||{}).username);
  if(!name) return res.status(400).json({ error:'Bad callsign.' });
  const key = name.toLowerCase();
  res.json({ ok:true, items: pending[key] || [] });
});

/* ---- the game confirms what it actually banked ---- */
app.post('/api/trade/ack', rateLimit, (req,res)=>{
  const b = req.body || {};
  const name = cleanName(b.username);
  if(!name) return res.status(400).json({ error:'Bad callsign.' });
  const ids = Array.isArray(b.ids) ? b.ids.filter(i=>typeof i==='string').slice(0,200) : [];
  if(!ids.length) return res.json({ ok:true, left: (pending[name.toLowerCase()]||[]).length });

  const key = name.toLowerCase();
  const before = (pending[key]||[]).length;
  pending[key] = (pending[key]||[]).filter(p=>!ids.includes(p.id));
  if(!pending[key].length) delete pending[key];
  if(before !== (pending[key]||[]).length) schedulePendingSave();
  res.json({ ok:true, cleared: before-(pending[key]||[]).length, left:(pending[key]||[]).length });
});

/* ---- my own open listings ---- */
app.post('/api/trade/mine', rateLimit, (req,res)=>{
  const name = cleanName((req.body||{}).username);
  if(!name) return res.status(400).json({ error:'Bad callsign.' });
  const key = name.toLowerCase();
  res.json({ ok:true, trades: Object.values(trades)
    .filter(t=>t.sellerKey===key && t.status==='open')
    .sort((a,b)=>b.created-a.created) });
});

/* ---- admin: the full log, so you can see every trade that happened ---- */
app.post('/api/admin/trades', rateLimit, (req,res)=>{
  if((req.body||{}).key !== ADMIN_KEY) return res.status(403).json({ error:'Wrong phrase.' });
  res.json({ ok:true, trades: Object.values(trades)
    .sort((a,b)=>(b.closed||b.created)-(a.closed||a.created)).slice(0,200) });
});

/* A tiny "are you awake?" endpoint. The game pings this first so it can
   warn you while a sleeping free Render server wakes up. */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, pilots: Object.keys(scores).length, uptime: Math.round(process.uptime()) });
});

/* ============================================================
   SERVE THE GAME ITSELF
   ============================================================ */
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

/* Anything we do not recognise just gets the game page. */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`ATTRITION server flying on port ${PORT}`);
  console.log(`Scores file: ${SCORE_FILE}`);
});
