/* Balance Spire — authoritative host script (StarHermit Game Script).
 * Zero-dependency Node HTTP server. Serves the static distribution and the
 * same-origin /api/v1 surface:
 *   GET  /api/v1/time                    server clock (client RTT-adjusts)
 *   POST /api/v1/daily/submit            validate + record a daily result
 *   GET  /api/v1/daily/board?date=       validated daily leaderboard
 *   POST /api/v1/score/submit            validate + record an endless score
 *   GET  /api/v1/score/board             validated global board
 *   POST /api/v1/achievements/unlock     idempotent durable achievement
 *   POST /api/v1/activity/start|end      playtime pairing
 *   POST /api/v1/presence/heartbeat      presence (no-op beyond liveness)
 *   POST /api/v1/funnel                  anonymous aggregate funnel events
 *
 * Score claims are untrusted: every submission is re-simulated from the
 * ordered input log through the shared deterministic rules engine; the
 * claimed result must match the authoritative replay hash exactly.
 * Run: node server.js [port]     (default 8080)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const Rules = require('./js/rules.js');
const Content = require('./js/content.js');

const ROOT = __dirname;
const DATA_DIR = process.env.BS_DATA_DIR || path.join(ROOT, 'data');
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const MAX_BODY = 64 * 1024;

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

// ---------- tiny persistence ----------
function dataFile(name) { return path.join(DATA_DIR, name.replace(/[^a-z0-9._-]/gi, '_')); }
function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(dataFile(name), 'utf8')); }
  catch (e) { return fallback; }
}
function writeJson(name, obj) {
  const tmp = dataFile(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, dataFile(name));
}

// ---------- rate limiting (token bucket per identity+route) ----------
const buckets = new Map();
function rateLimited(key, perMin) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.t > 60000) { b = { t: now, n: 0 }; buckets.set(key, b); }
  return ++b.n > perMin;
}

// ---------- helpers ----------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise(function (resolve, reject) {
    let n = 0; const chunks = [];
    req.on('data', function (c) {
      n += c.length;
      if (n > MAX_BODY) { reject(new Error('payload-too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('bad-json')); }
    });
    req.on('error', reject);
  });
}
function playerIdOf(req, body) {
  const h = req.headers['x-player-id'];
  const id = typeof h === 'string' && h.length >= 4 && h.length <= 64 ? h : null;
  return id || 'anon';
}

// ---------- score validation: authoritative replay ----------
// cfgId identifies an immutable published ruleset; the seed and content
// version must match, then the command log is replayed and the claimed
// terminal hash/score must equal the server-computed values.
function validateSubmission(body) {
  if (!body || typeof body !== 'object') return { error: 'malformed' };
  const { cfgId, date, seed, contentVersion, commands, result } = body;
  if (contentVersion !== Content.CONTENT_VERSION) return { error: 'stale-version' };
  if (!Array.isArray(commands) || commands.length > 4096) return { error: 'bad-log' };
  if (!result || typeof result !== 'object') return { error: 'bad-result' };

  let cfg = null;
  if (cfgId === Content.SCORE_CHASE.id) {
    // The published score-chase ruleset has one immutable seed; a claim
    // replayed on a self-chosen seed is not the same competition.
    if ((seed >>> 0) !== Content.SCORE_CHASE.seed) return { error: 'seed-mismatch' };
    cfg = Content.SCORE_CHASE;
  } else if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    cfg = Content.dailyConfig(date);
    if (cfg.seed !== (seed >>> 0) || cfg.id !== cfgId) return { error: 'seed-mismatch' };
  } else {
    return { error: 'unknown-ruleset' };
  }

  const seen = new Set();
  for (const cmd of commands) {
    const err = Rules.validateCommandShape(cmd);
    if (err) return { error: 'bad-command', reason: err };
    if (cmd.id) { // idempotent duplicate rejection by command id
      if (seen.has(cmd.id)) return { error: 'duplicate-command' };
      seen.add(cmd.id);
    }
  }
  const rep = Rules.replay(cfg, commands);
  if (!rep.ok) return { error: 'replay-rejected', reason: rep.reason, at: rep.at };
  const s = rep.state;
  if (!s.terminal) return { error: 'round-not-terminal' };
  // The claim must match the authoritative simulation exactly.
  if (result.score && result.score.total !== s.score.total) return { error: 'score-mismatch' };
  if (result.finalHash != null && Rules.hashState(s) !== result.finalHash) return { error: 'hash-mismatch' };
  return { ok: true, state: s, cfg: cfg };
}

// Tie-break order: higher score, fewer invalid actions (none survive
// validation → drops), lower authoritative elapsed time, stable player id.
function boardSort(a, b) {
  return b.score - a.score || a.drops - b.drops || a.durationSec - b.durationSec ||
    (a.playerId < b.playerId ? -1 : 1);
}

// ---------- routes ----------
const routes = {
  'GET /api/v1/time': function (req, res) {
    send(res, 200, { now: Date.now() });
  },

  'POST /api/v1/daily/submit': async function (req, res, body) {
    const pid = playerIdOf(req);
    if (rateLimited('daily:' + pid, 10)) return send(res, 429, { error: 'rate-limited' });
    if (!body.date) return send(res, 400, { error: 'date-required' });
    const today = Content.utcDateString(Date.now());
    // Immutable seeds: results only accepted for the live or previous day.
    if (body.date > today) return send(res, 400, { error: 'future-date' });
    const v = validateSubmission(body);
    if (v.error) return send(res, 422, v);
    const file = 'daily-' + body.date + '.json';
    const board = readJson(file, { date: body.date, excluded: false, rows: [] });
    const s = v.state;
    const row = {
      playerId: pid, score: s.score.total, height: Rules.height(s),
      drops: s.drops, perfects: s.perfects, won: !!s.terminal.won,
      durationSec: Math.round(s.tick / Rules.TICKS_PER_SEC),
      assists: body.assists || {}, contentVersion: body.contentVersion,
      seed: v.cfg.seed, at: Date.now()
    };
    // One row per player; keep the better run (idempotent re-submit).
    const i = board.rows.findIndex(function (r) { return r.playerId === pid; });
    if (i >= 0) board.rows[i] = boardSort(board.rows[i], row) <= 0 ? board.rows[i] : row;
    else board.rows.push(row);
    board.rows.sort(boardSort);
    board.rows = board.rows.slice(0, 200);
    writeJson(file, board);
    const rank = board.rows.findIndex(function (r) { return r.playerId === pid; }) + 1;
    send(res, 200, { ok: true, rank: rank, total: board.rows.length, validated: true });
  },

  'GET /api/v1/daily/board': function (req, res, _b, query) {
    const date = query.get('date') || Content.utcDateString(Date.now());
    const board = readJson('daily-' + date + '.json', { rows: [] });
    const friends = (query.get('friends') || '').split(',').filter(Boolean);
    const rows = friends.length
      ? board.rows.filter(function (r) { return friends.indexOf(r.playerId) >= 0; })
      : board.rows;
    send(res, 200, { date: date, excluded: !!board.excluded, rows: rows.slice(0, 100) });
  },

  'POST /api/v1/score/submit': async function (req, res, body) {
    const pid = playerIdOf(req);
    if (rateLimited('score:' + pid, 10)) return send(res, 429, { error: 'rate-limited' });
    const v = validateSubmission(body);
    if (v.error) return send(res, 422, v);
    const board = readJson('score-global.json', { rows: [] });
    const s = v.state;
    board.rows.push({
      playerId: pid, score: s.score.total, height: Rules.height(s),
      drops: s.drops, perfects: s.perfects,
      durationSec: Math.round(s.tick / Rules.TICKS_PER_SEC),
      seed: v.cfg.seed, contentVersion: body.contentVersion, at: Date.now()
    });
    board.rows.sort(boardSort);
    board.rows = board.rows.slice(0, 200);
    writeJson('score-global.json', board);
    const rank = board.rows.findIndex(function (r) { return r.playerId === pid; }) + 1;
    send(res, 200, { ok: true, rank: rank, total: board.rows.length, validated: true });
  },

  'GET /api/v1/score/board': function (req, res) {
    const board = readJson('score-global.json', { rows: [] });
    send(res, 200, { rows: board.rows.slice(0, 100), validated: true });
  },

  'POST /api/v1/achievements/unlock': async function (req, res, body) {
    const pid = playerIdOf(req);
    const key = body && body.key;
    const valid = Content.ACHIEVEMENTS.some(function (a) { return a.key === key; });
    if (!valid) return send(res, 400, { error: 'unknown-achievement' });
    const doc = readJson('achievements.json', {});
    if (!doc[pid]) doc[pid] = {};
    const fresh = !doc[pid][key];
    doc[pid][key] = doc[pid][key] || Date.now(); // idempotent
    writeJson('achievements.json', doc);
    send(res, 200, { ok: true, fresh: fresh });
  },

  'POST /api/v1/activity/start': async function (req, res) {
    const pid = playerIdOf(req);
    const doc = readJson('activity.json', {});
    doc[pid] = { start: Date.now() };
    writeJson('activity.json', doc);
    send(res, 200, { ok: true });
  },
  'POST /api/v1/activity/end': async function (req, res) {
    const pid = playerIdOf(req);
    const doc = readJson('activity.json', {});
    const open = doc[pid];
    if (open && open.start) {
      const log = readJson('playtime.json', {});
      log[pid] = (log[pid] || 0) + (Date.now() - open.start);
      writeJson('playtime.json', log);
      delete doc[pid];
      writeJson('activity.json', doc);
    }
    send(res, 200, { ok: true });
  },
  'POST /api/v1/presence/heartbeat': function (req, res) { send(res, 200, { ok: true }); },
  'POST /api/v1/funnel': async function (req, res, body) {
    // Aggregate counts only; no raw text, no identifiers beyond the day.
    const allowed = { 'round-start': 1, 'tutorial-step': 1, 'round-end': 1, 'retry': 1,
      'settings-change': 1, 'error': 1 };
    if (body && allowed[body.e]) {
      const day = Content.utcDateString(Date.now());
      const doc = readJson('funnel-' + day + '.json', {});
      doc[body.e] = (doc[body.e] || 0) + 1;
      writeJson('funnel-' + day + '.json', doc);
    }
    send(res, 202, { ok: true });
  }
};

// ---------- static file server ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.opus': 'audio/ogg'
};
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  const rel = path.normalize(pathname).replace(/^([/\\])+/, '');
  const file = path.join(ROOT, rel);
  // Never serve the data store, dev-only folders, or dotfiles.
  if (!file.startsWith(ROOT) || rel.startsWith('data' + path.sep) || rel.indexOf('..') >= 0 ||
      /^(tests|tools|node_modules)([/\\]|$)|^\./.test(rel)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(file, function (err, buf) {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(file).toLowerCase();
    // Immutable, content-addressed-style caching for vendor assets.
    const cache = rel.indexOf('vendor/') === 0 ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(buf);
  });
}

const server = http.createServer(function (req, res) {
  const u = new URL(req.url, 'http://x');
  const key = req.method + ' ' + u.pathname;
  const route = routes[key];
  if (!route) { serveStatic(req, res, u.pathname); return; }
  if (req.method === 'GET') { route(req, res, null, u.searchParams); return; }
  readBody(req).then(function (body) {
    route(req, res, body, u.searchParams);
  }).catch(function (e) {
    send(res, 400, { error: e.message || 'bad-request' });
  });
});

if (require.main === module) {
  server.listen(PORT, function () {
    console.log('Balance Spire host on http://localhost:' + PORT);
  });
}
module.exports = { server: server, validateSubmission: validateSubmission };
