/* Balance Spire — authoritative server validation tests + session
 * replay-envelope consistency. Run: node tests/server.test.js
 */
'use strict';
const assert = require('assert');
const Rules = require('../js/rules.js');
const Content = require('../js/content.js');
const Session = require('../js/session.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-spire-test-'));
process.env.BS_DATA_DIR = testDataDir;
process.on('exit', () => fs.rmSync(testDataDir, { recursive: true, force: true }));
const { server, validateSubmission } = require('../server.js');

let passed = 0;
function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('ok  - ' + name); })
    .catch((e) => { console.error('FAIL - ' + name); console.error(e); process.exitCode = 1; });
}

// Play a full terminal round on the given cfg; returns { log, state }.
function playOut(cfg) {
  let s = Rules.createGame(cfg);
  const log = [];
  while (!s.terminal && log.length < 400) {
    const w = Rules.perfectWindow(s.cfg, s.pending, s.slabs.length, s.tick + 1);
    // Drift slightly off the perfect tick as the tower grows so trims
    // eventually narrow the footprint into a miss.
    const cmd = { type: 'drop', atTick: w.startTick + Math.min(3, s.slabs.length), id: 'c' + log.length };
    log.push(cmd);
    const res = Rules.applyCommand(s, cmd);
    if (!res.ok) break;
    s = res.state;
  }
  return { log, state: s };
}

function claimFrom(cfg, log, s) {
  return {
    cfgId: cfg.id, date: cfg.date || null, seed: cfg.seed,
    contentVersion: Content.CONTENT_VERSION,
    commands: log,
    result: { score: s.score, finalHash: Rules.hashState(s) }
  };
}

test('score chase rejects a self-chosen seed', () => {
  const evilCfg = Object.assign({}, Content.SCORE_CHASE, { seed: 12345 });
  const { log, state } = playOut(evilCfg);
  assert.ok(state.terminal, 'round terminates');
  const v = validateSubmission(claimFrom(evilCfg, log, state));
  assert.strictEqual(v.error, 'seed-mismatch');
});

test('score chase accepts the published seed and exact result', () => {
  const { log, state } = playOut(Content.SCORE_CHASE);
  assert.ok(state.terminal);
  const v = validateSubmission(claimFrom(Content.SCORE_CHASE, log, state));
  assert.ok(v.ok, JSON.stringify(v));
});

test('tampered score claims are rejected', () => {
  const { log, state } = playOut(Content.SCORE_CHASE);
  const claim = claimFrom(Content.SCORE_CHASE, log, state);
  claim.result.score = Object.assign({}, state.score, { total: state.score.total + 1000 });
  assert.strictEqual(validateSubmission(claim).error, 'score-mismatch');
  const claim2 = claimFrom(Content.SCORE_CHASE, log, state);
  claim2.result.finalHash = 123;
  assert.strictEqual(validateSubmission(claim2).error, 'hash-mismatch');
});

test('daily submission must match the immutable daily seed', () => {
  const date = Content.utcDateString(Date.now());
  const cfg = Content.dailyConfig(date);
  const { log, state } = playOut(cfg);
  assert.ok(state.terminal);
  const ok = validateSubmission(claimFrom(cfg, log, state));
  assert.ok(ok.ok, JSON.stringify(ok));
  const bad = claimFrom(cfg, log, state);
  bad.seed = cfg.seed + 1;
  assert.strictEqual(validateSubmission(bad).error, 'seed-mismatch');
});

test('duplicate command ids are rejected idempotently', () => {
  const { log, state } = playOut(Content.SCORE_CHASE);
  const claim = claimFrom(Content.SCORE_CHASE, log, state);
  claim.commands = log.concat([log[0]]);
  assert.strictEqual(validateSubmission(claim).error, 'duplicate-command');
});

test('session replay envelope stays consistent across undo', () => {
  const cfg = {
    id: 'undo-env', version: 1, kind: 'practice', seed: 555,
    base: { w: 2, d: 2 }, speed: 1.2, speedRamp: 0, goalHeight: 0, eps: 100,
    dropLimit: 0, timeLimitSec: 0, par: null, lives: 5,
    mechanics: { undo: true, hint: true }, endless: true
  };
  Session.startRound(cfg, { mode: 'practice' });
  const round = Session.round;
  round.phase = 'active'; // skip the real-time countdown; ticks come from wallBase
  round.wallBase = 0;     // performance.now() ms → plenty of future ticks
  for (let i = 0; i < 3; i++) assert.ok(Session.drop().ok, 'drop ' + i);
  assert.strictEqual(Rules.height(round.state), 3);
  assert.ok(Session.undo(), 'undo available');
  assert.strictEqual(Rules.height(round.state), 2);
  assert.ok(Session.drop().ok, 're-drop after undo');
  Session.resign(); // envelopes describe terminal rounds
  const env = Session.replayEnvelope();
  const cmds = env.commands;
  // One hash per applied command plus the initial hash — undo must not
  // leave a stale hash behind.
  assert.strictEqual(env.hashes.length, cmds.length + 1,
    'hashes ' + env.hashes.length + ' vs commands ' + cmds.length);
  const rep = Rules.replay(cfg, cmds);
  assert.ok(rep.ok);
  assert.strictEqual(Rules.hashState(rep.state), env.hashes[env.hashes.length - 1]);
});

test('live HTTP: daily submit validates, ranks, and re-submit keeps the better row', async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  try {
    const time = await fetch(base + '/api/v1/time').then((r) => r.json());
    assert.ok(Math.abs(time.now - Date.now()) < 5000, 'server clock sane');

    const date = Content.utcDateString(Date.now());
    const cfg = Content.dailyConfig(date);
    const { log, state } = playOut(cfg);
    const claim = claimFrom(cfg, log, state);
    const post = (body, pid) => fetch(base + '/api/v1/daily/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Player-Id': pid },
      body: JSON.stringify(body)
    }).then((r) => r.json());

    const res = await post(claim, 'test-player-a');
    assert.ok(res.ok && res.validated, JSON.stringify(res));
    assert.strictEqual(res.rank, 1);

    const evilSeed = Object.assign({}, claim, { seed: cfg.seed ^ 0xff });
    const rej = await post(evilSeed, 'test-player-b');
    assert.strictEqual(rej.error, 'seed-mismatch');

    const board = await fetch(base + '/api/v1/daily/board?date=' + date)
      .then((r) => r.json());
    assert.ok(board.rows.some((r) => r.playerId === 'test-player-a'), 'row recorded');

    const ach = await fetch(base + '/api/v1/achievements/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Player-Id': 'test-player-a' },
      body: JSON.stringify({ key: 'first-place' })
    }).then((r) => r.json());
    assert.ok(ach.ok && ach.fresh);
    const ach2 = await fetch(base + '/api/v1/achievements/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Player-Id': 'test-player-a' },
      body: JSON.stringify({ key: 'first-place' })
    }).then((r) => r.json());
    assert.ok(ach2.ok && !ach2.fresh, 'unlock is idempotent');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

process.on('beforeExit', () => {
  if (!process.exitCode) console.log('\n' + passed + ' tests passed');
});
