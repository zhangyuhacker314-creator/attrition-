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

loadScores();

/* Last-chance save if Render shuts the server down. */
function shutdown() {
  try { fs.writeFileSync(SCORE_FILE, JSON.stringify(scores, null, 2), 'utf8'); } catch (e) {}
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
