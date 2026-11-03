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
const MAIL_FILE  = path.join(DATA_DIR, 'mail.json');

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

/* ---- the mailbox: gifts waiting for a pilot to log in ---- */
let mail = {};

function loadMail(){
  try{
    const parsed = JSON.parse(fs.readFileSync(MAIL_FILE,'utf8'));
    if(parsed && typeof parsed==='object'){
      mail = parsed;
      const n = Object.values(mail).reduce((a,b)=>a+b.length,0);
      console.log(`Loaded ${n} pending gift(s).`);
      return;
    }
  }catch(err){
    if(err.code !== 'ENOENT') console.warn('Could not read mail.json:', err.message);
  }
  mail = {};
}

let mailTimer = null;
function scheduleMailSave(){
  if(mailTimer) return;
  mailTimer = setTimeout(()=>{ mailTimer=null; saveMail(); }, 500);
}
function saveMail(){
  const tmp = MAIL_FILE + '.tmp';
  fs.writeFile(tmp, JSON.stringify(mail,null,2), 'utf8', err=>{
    if(err){ console.error('Mail save failed:', err.message); return; }
    fs.rename(tmp, MAIL_FILE, e2=>{ if(e2) console.error('Mail rename failed:', e2.message); });
  });
}

loadScores();
loadEvents();
loadMail();

/* Last-chance save if Render shuts the server down. */
function shutdown() {
  try { fs.writeFileSync(SCORE_FILE, JSON.stringify(scores, null, 2), 'utf8'); } catch (e) {}
  try { fs.writeFileSync(EVENT_FILE, JSON.stringify(events, null, 2), 'utf8'); } catch (e) {}
  try { fs.writeFileSync(MAIL_FILE,  JSON.stringify(mail,   null, 2), 'utf8'); } catch (e) {}
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
   ADMIN COMMANDS: gifts and removals
   ============================================================ */

/* ---- queue a gift for a pilot ---- */
app.post('/api/admin/gift', rateLimit, (req, res) => {
  const b = req.body || {};
  if(b.key !== ADMIN_KEY) return res.status(403).json({ error:'Wrong phrase.' });

  const name = cleanName(b.username);
  if(!name) return res.status(400).json({ error:'Bad callsign.' });

  const g = b.gift || {};
  const gift = { id: 'g_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,7),
                 at: Date.now() };

  if(g.type === 'money'){
    gift.type = 'money';
    gift.amount = Math.max(1, Math.min(10000000, Math.floor(Number(g.amount)||0)));
    if(!gift.amount) return res.status(400).json({ error:'Amount must be at least 1.' });
  } else if(g.type === 'card'){
    if(typeof g.cardId!=='string' || !/^[a-z]+_[a-z]+$/.test(g.cardId))
      return res.status(400).json({ error:'Bad card id.' });
    gift.type = 'card';
    gift.cardId = g.cardId;
    gift.count = Math.max(1, Math.min(99, Math.floor(Number(g.count)||1)));
  } else if(g.type === 'randomCard'){
    gift.type = 'randomCard';
    gift.rarity = Math.max(0, Math.min(5, Math.floor(Number(g.rarity)||0)));
    gift.count = Math.max(1, Math.min(99, Math.floor(Number(g.count)||1)));
  } else {
    return res.status(400).json({ error:'Unknown gift type.' });
  }

  const key = name.toLowerCase();
  mail[key] = mail[key] || [];
  if(mail[key].length >= 50)
    return res.status(400).json({ error:'That pilot already has 50 gifts waiting.' });
  mail[key].push(gift);
  scheduleMailSave();

  /* tell the admin whether this callsign has ever actually played */
  const known = !!scores[key];
  res.json({ ok:true, gift, known, pending: mail[key].length, username: name });
});

/* ---- what is waiting for a pilot (admin view, does not collect) ---- */
app.post('/api/admin/mail', rateLimit, (req, res) => {
  const b = req.body || {};
  if(b.key !== ADMIN_KEY) return res.status(403).json({ error:'Wrong phrase.' });
  const name = cleanName(b.username);
  if(!name) return res.status(400).json({ error:'Bad callsign.' });
  const key = name.toLowerCase();
  res.json({ ok:true, username:name, known: !!scores[key], gifts: mail[key] || [] });
});

/* ---- cancel everything waiting for a pilot ---- */
app.post('/api/admin/unmail', rateLimit, (req, res) => {
  const b = req.body || {};
  if(b.key !== ADMIN_KEY) return res.status(403).json({ error:'Wrong phrase.' });
  const name = cleanName(b.username);
  if(!name) return res.status(400).json({ error:'Bad callsign.' });
  const key = name.toLowerCase();
  const n = (mail[key]||[]).length;
  delete mail[key];
  scheduleMailSave();
  res.json({ ok:true, removed:n, username:name });
});

/* ---- remove a pilot from the leaderboard ----
   This clears their score row and any event claims they hold. It cannot
   touch their account, which lives in their own browser. */
app.post('/api/admin/removePlayer', rateLimit, (req, res) => {
  const b = req.body || {};
  if(b.key !== ADMIN_KEY) return res.status(403).json({ error:'Wrong phrase.' });
  const name = cleanName(b.username);
  if(!name) return res.status(400).json({ error:'Bad callsign.' });

  const key = name.toLowerCase();
  const had = !!scores[key];
  delete scores[key];
  scheduleSave();

  let claimsCleared = 0;
  for(const ev of Object.values(events)){
    const before = ev.claims.length;
    ev.claims = ev.claims.filter(c => c.user.toLowerCase() !== key);
    claimsCleared += before - ev.claims.length;
  }
  if(claimsCleared) scheduleEventSave();

  res.json({ ok:true, username:name, removed:had, claimsCleared });
});

/* ---- a pilot collects their post ----
   Gifts are handed over once. The server marks them collected as it
   sends them, so a refresh cannot claim the same gift twice. */
app.post('/api/mail/collect', rateLimit, (req, res) => {
  const name = cleanName((req.body||{}).username);
  if(!name) return res.status(400).json({ error:'Bad callsign.' });
  const key = name.toLowerCase();
  const waiting = mail[key] || [];
  if(!waiting.length) return res.json({ ok:true, gifts:[] });

  delete mail[key];
  scheduleMailSave();
  res.json({ ok:true, gifts: waiting });
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
