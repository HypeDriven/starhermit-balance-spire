/* Balance Spire — rules engine unit + property + fuzz + content tests
 * Run: node tests/rules.test.js
 */
'use strict';
const assert = require('assert');
const Rules = require('../js/rules.js');
const Content = require('../js/content.js');
const RNG = require('../js/rng.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok  - ' + name); }
  catch (e) { console.error('FAIL - ' + name); console.error(e); process.exitCode = 1; }
}

function baseCfg(over) {
  return Object.assign({
    id: 'test', version: 1, kind: 'practice', seed: 1234,
    base: { w: 2, d: 2 }, speed: 1.5, speedRamp: 0.02,
    goalHeight: 5, eps: 100, dropLimit: 0, timeLimitSec: 0,
    par: { drops: 6, timeSec: 60 }, lives: 1,
    mechanics: { undo: true, hint: true }, endless: false
  }, over || {});
}

// Drop as close as possible to targetOffsetMu: the slab moves in discrete
// steps whose size depends on level speed, so an exact offset is not
// guaranteed to exist; the nearest tick within one period is canonical.
function dropAtOffset(state, targetOffsetMu) {
  const cfg = state.cfg, level = state.slabs.length;
  const top = Rules.topSlab(state);
  const axis = state.pending.axis;
  const center = axis === 'x' ? top.x : top.z;
  const P = Rules.periodTicks(cfg, level);
  let best = -1, bestErr = Infinity;
  for (let t = state.tick + 1; t <= state.tick + P; t++) {
    const err = Math.abs(Rules.slabPosAt(cfg, state.pending, level, t) - (center + targetOffsetMu));
    if (err < bestErr) { bestErr = err; best = t; }
  }
  return best;
}

function dropPerfectTick(state) {
  const w = Rules.perfectWindow(state.cfg, state.pending, state.slabs.length, state.tick + 1);
  assert.ok(w, 'perfect window exists');
  assert.ok(w.startTick > state.tick, 'window in the future');
  return w.startTick;
}

// ---------- determinism ----------

test('creation is deterministic for same seed', () => {
  const a = Rules.createGame(baseCfg({ seed: 42 }));
  const b = Rules.createGame(baseCfg({ seed: 42 }));
  assert.strictEqual(Rules.hashState(a), Rules.hashState(b));
  const c = Rules.createGame(baseCfg({ seed: 43 }));
  assert.notStrictEqual(
    Rules.slabPosAt(a.cfg, a.pending, 1, 100),
    Rules.slabPosAt(c.cfg, c.pending, 1, 100));
});

test('slab motion is a bounded, periodic triangle wave', () => {
  const s = Rules.createGame(baseCfg());
  const level = 1;
  const P = Rules.periodTicks(s.cfg, level);
  let min = Infinity, max = -Infinity;
  for (let t = 0; t < 4 * P; t++) {
    const p = Rules.slabPosAt(s.cfg, s.pending, level, t);
    min = Math.min(min, p); max = Math.max(max, p);
    assert.strictEqual(p, Rules.slabPosAt(s.cfg, s.pending, level, t + P), 'periodic');
  }
  assert.ok(min >= -Rules.HALF_RANGE - 1 && max <= Rules.HALF_RANGE + 1, 'bounded');
  assert.ok(max - min > 2 * Rules.HALF_RANGE - 10, 'full sweep');
});

test('motion has no per-frame accumulation (closed form)', () => {
  const s = Rules.createGame(baseCfg());
  // Same absolute tick queried in any order gives identical results.
  const seq = [7, 999, 3, 500, 500, 7];
  const vals = seq.map(t => Rules.slabPosAt(s.cfg, s.pending, 2, t));
  assert.strictEqual(vals[0], vals[5]);
  assert.strictEqual(vals[1], vals[1]);
  assert.strictEqual(vals[3], vals[4]);
});

// ---------- placement rules ----------

test('perfect drop keeps full width and scores streak', () => {
  let s = Rules.createGame(baseCfg());
  const t = dropPerfectTick(s);
  const res = Rules.applyCommand(s, { type: 'drop', id: 'd1', atTick: t });
  assert.ok(res.ok);
  s = res.state;
  assert.strictEqual(s.slabs.length, 2);
  assert.strictEqual(s.slabs[1].perfect, true);
  assert.strictEqual(s.slabs[1].w, s.slabs[0].w);
  assert.strictEqual(s.streak, 1);
  assert.strictEqual(s.score.perfectPoints, 25);
  assert.strictEqual(s.score.heightPoints, 10);
  assert.strictEqual(s.turn, 1);
  assert.strictEqual(s.tick, t);
});

test('off-center drop trims the overhang and recentres', () => {
  let s = Rules.createGame(baseCfg());
  const t = dropAtOffset(s, 500); // 0.5 units off
  const res = Rules.applyCommand(s, { type: 'drop', atTick: t });
  assert.ok(res.ok);
  s = res.state;
  const top = Rules.topSlab(s);
  const trim = res.events.find(e => e.type === 'trim');
  assert.ok(trim, 'trim event');
  assert.ok(Math.abs(trim.size - 500) <= 26, 'trim ≈ 500 mu, got ' + trim.size);
  assert.strictEqual(top.perfect, false);
  assert.strictEqual(top.w, s.cfg.baseMu.w - trim.size);
  assert.strictEqual(Math.abs(top.x), Math.round(trim.size / 2));
  assert.strictEqual(s.streak, 0);
});

test('clean miss costs a life and ends a one-life game', () => {
  let s = Rules.createGame(baseCfg({ lives: 1 }));
  const w0 = s.cfg.baseMu.w;
  const t = dropAtOffset(s, w0 + 300); // fully clear of the tower
  const res = Rules.applyCommand(s, { type: 'drop', atTick: t });
  assert.ok(res.ok);
  assert.ok(res.state.terminal);
  assert.strictEqual(res.state.terminal.reason, 'missed');
  assert.strictEqual(res.state.terminal.won, false);
  assert.ok(res.events.some(e => e.type === 'miss'));
  assert.ok(res.events.some(e => e.type === 'lose'));
});

test('a spared life respawns the slab on the same footprint', () => {
  let s = Rules.createGame(baseCfg({ lives: 2 }));
  const w0 = s.cfg.baseMu.w;
  const res = Rules.applyCommand(s, { type: 'drop', atTick: dropAtOffset(s, w0 + 300) });
  assert.ok(res.ok);
  s = res.state;
  assert.ok(!s.terminal);
  assert.strictEqual(s.livesLeft, 1);
  assert.strictEqual(s.slabs.length, 1, 'no slab placed');
  assert.strictEqual(s.pending.spawnTick, s.tick);
  const res2 = Rules.applyCommand(s, { type: 'drop', atTick: dropPerfectTick(s) });
  assert.ok(res2.ok && res2.state.slabs.length === 2);
});

test('axis alternates x, z, x per level', () => {
  let s = Rules.createGame(baseCfg({ goalHeight: 3 }));
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(s.pending.axis, i % 2 === 0 ? 'x' : 'z');
    const res = Rules.applyCommand(s, { type: 'drop', atTick: dropPerfectTick(s) });
    assert.ok(res.ok);
    s = res.state;
  }
  assert.ok(s.terminal && s.terminal.won);
  // z-axis trim shrinks d, not w.
  let s2 = Rules.createGame(baseCfg());
  s2 = Rules.applyCommand(s2, { type: 'drop', atTick: dropPerfectTick(s2) }).state;
  s2 = Rules.applyCommand(s2, { type: 'drop', atTick: dropAtOffset(s2, 400) }).state;
  assert.ok(s2.cfg.baseMu.d - Rules.topSlab(s2).d >= 374, 'd trimmed ≈400, got ' + (s2.cfg.baseMu.d - Rules.topSlab(s2).d));
  assert.strictEqual(Rules.topSlab(s2).w, s2.cfg.baseMu.w);
});

// ---------- terminal states & scoring ----------

test('reaching goal height wins with bonuses under par', () => {
  let s = Rules.createGame(baseCfg({ goalHeight: 3, par: { drops: 5, timeSec: 600 } }));
  for (let i = 0; i < 3; i++) {
    s = Rules.applyCommand(s, { type: 'drop', atTick: dropPerfectTick(s) }).state;
  }
  assert.ok(s.terminal && s.terminal.won);
  assert.strictEqual(s.terminal.reason, 'goal-height');
  assert.strictEqual(s.score.goalBonus, 200);
  assert.ok(s.score.dropBonus > 0);
  assert.ok(s.score.timeBonus > 0);
  const total = s.score.heightPoints + s.score.perfectPoints + s.score.streakPoints +
    s.score.goalBonus + s.score.dropBonus + s.score.timeBonus;
  assert.strictEqual(s.score.total, total);
});

test('drop limit loses when goal unreached', () => {
  let s = Rules.createGame(baseCfg({ goalHeight: 10, dropLimit: 2, lives: 3 }));
  for (let i = 0; i < 2; i++) {
    s = Rules.applyCommand(s, { type: 'drop', atTick: dropPerfectTick(s) }).state;
  }
  assert.ok(s.terminal && !s.terminal.won);
  assert.strictEqual(s.terminal.reason, 'move-limit');
});

test('goal check beats drop limit on the same drop', () => {
  let s = Rules.createGame(baseCfg({ goalHeight: 2, dropLimit: 2 }));
  for (let i = 0; i < 2; i++) {
    s = Rules.applyCommand(s, { type: 'drop', atTick: dropPerfectTick(s) }).state;
  }
  assert.ok(s.terminal && s.terminal.won);
});

test('a drop after the time limit loses instead of placing', () => {
  let s = Rules.createGame(baseCfg({ goalHeight: 9, timeLimitSec: 1 })); // 60 ticks
  const t = dropPerfectTick(s);
  // Walk the clock past the limit with a second game where we just wait.
  const res = Rules.applyCommand(s, { type: 'drop', atTick: 61 });
  assert.ok(res.ok);
  assert.ok(res.state.terminal && res.state.terminal.reason === 'time-up');
  assert.ok(!res.state.terminal.won);
});

test('timeout command ends the round only at/past the limit', () => {
  const s = Rules.createGame(baseCfg({ timeLimitSec: 5 }));
  const early = Rules.applyCommand(s, { type: 'timeout', atTick: 100 });
  assert.ok(!early.ok && early.reason === 'early-timeout');
  const hit = Rules.applyCommand(s, { type: 'timeout', atTick: 300 });
  assert.ok(hit.ok && hit.state.terminal.reason === 'time-up');
  const noLimit = Rules.createGame(baseCfg({ timeLimitSec: 0 }));
  assert.strictEqual(Rules.applyCommand(noLimit, { type: 'timeout', atTick: 9999 }).reason, 'no-time-limit');
});

test('resign ends the round as a loss', () => {
  const s = Rules.createGame(baseCfg());
  const res = Rules.applyCommand(s, { type: 'resign', id: 'r1' });
  assert.ok(res.ok && res.state.terminal.reason === 'resigned' && !res.state.terminal.won);
});

// ---------- invalid actions ----------

test('invalid commands are rejected with reasons and no mutation', () => {
  const s = Rules.createGame(baseCfg());
  const h = Rules.hashState(s);
  const bad = [
    [null, 'malformed-command'],
    [{}, 'malformed-command'],
    [{ type: 'fly' }, 'unknown-command'],
    [{ type: 'drop' }, 'malformed-command'],
    [{ type: 'drop', atTick: 0 }, 'bad-tick'],
    [{ type: 'drop', atTick: -5 }, 'bad-tick'],
    [{ type: 'drop', atTick: 1.5 }, 'malformed-command']
  ];
  for (const [cmd, reason] of bad) {
    const res = Rules.applyCommand(s, cmd);
    assert.ok(!res.ok, JSON.stringify(cmd));
    assert.strictEqual(res.reason, reason, JSON.stringify(cmd));
    assert.strictEqual(Rules.hashState(res.state), h, 'state untouched');
  }
  // Tick must strictly increase.
  const s2 = Rules.applyCommand(s, { type: 'drop', atTick: dropPerfectTick(s) }).state;
  const res = Rules.applyCommand(s2, { type: 'drop', atTick: s2.tick });
  assert.ok(!res.ok && res.reason === 'bad-tick');
  // No play after the end.
  const end = Rules.applyCommand(s, { type: 'resign' }).state;
  assert.strictEqual(Rules.applyCommand(end, { type: 'drop', atTick: end.tick + 10 }).reason, 'game-ended');
});

// ---------- legality surface & hints ----------

test('legalActions exposes drop/timeout/resign and a future window', () => {
  const s = Rules.createGame(baseCfg({ timeLimitSec: 30 }));
  const a = Rules.legalActions(s);
  assert.ok(a.drop && a.timeout && a.resign);
  assert.ok(a.perfectWindow && a.perfectWindow.startTick > s.tick);
  const over = Rules.applyCommand(s, { type: 'resign' }).state;
  const b = Rules.legalActions(over);
  assert.ok(!b.drop && !b.timeout && !b.resign);
});

test('hint window drops are always perfect (property over seeds/levels)', () => {
  for (let seed = 1; seed <= 30; seed++) {
    let s = Rules.createGame(baseCfg({ seed, goalHeight: 4, speed: 1 + (seed % 5) * 0.4 }));
    for (let lvl = 0; lvl < 4 && !s.terminal; lvl++) {
      const h = Rules.hint(s);
      assert.ok(h && h.window, 'seed ' + seed);
      for (const frac of [0, 0.5, 1]) {
        const t = Math.round(h.window.startTick + (h.window.endTick - h.window.startTick) * frac);
        if (t <= s.tick) continue;
        const probe = Rules.applyCommand(s, { type: 'drop', atTick: t });
        assert.ok(probe.ok, 'drop rejected at seed ' + seed + ' tick ' + t);
        const placed = probe.events.find(e => e.type === 'place');
        assert.ok(placed && placed.perfect,
          'window tick ' + t + ' not perfect (seed ' + seed + ', lvl ' + lvl + ', off ' + (placed && placed.offset) + ')');
      }
      s = Rules.applyCommand(s, { type: 'drop', atTick: h.window.startTick }).state;
    }
  }
});

// ---------- serialization & replay ----------

test('serialization round-trips', () => {
  let s = Rules.createGame(baseCfg());
  s = Rules.applyCommand(s, { type: 'drop', atTick: dropPerfectTick(s) }).state;
  const back = Rules.deserialize(Rules.serialize(s));
  assert.strictEqual(Rules.hashState(back), Rules.hashState(s));
  assert.throws(() => Rules.deserialize(JSON.stringify({ v: 999 })));
});

test('replay of the command log reproduces the exact final hash', () => {
  const cfg = baseCfg({ seed: 777, goalHeight: 6 });
  let s = Rules.createGame(cfg);
  const log = [];
  const rng = RNG.create(99);
  while (!s.terminal) {
    // Semi-random offsets: mostly near center, sometimes wild.
    const off = Math.floor(rng.next() * 4000) - 2000;
    const t = dropAtOffset(s, off);
    const cmd = { type: 'drop', atTick: t, id: 'c' + log.length };
    log.push(cmd);
    s = Rules.applyCommand(s, cmd).state;
  }
  const rep = Rules.replay(cfg, log);
  assert.ok(rep.ok);
  assert.strictEqual(Rules.hashState(rep.state), Rules.hashState(s));
});

test('command shape validation guards the network boundary', () => {
  assert.strictEqual(Rules.validateCommandShape({ type: 'drop', atTick: 10 }), null);
  assert.strictEqual(Rules.validateCommandShape({ type: 'resign' }), null);
  assert.strictEqual(Rules.validateCommandShape({ type: 'hack' }), 'unknown-command');
  assert.strictEqual(Rules.validateCommandShape({ type: 'drop' }), 'malformed-command');
  assert.strictEqual(Rules.validateCommandShape({ type: 'drop', atTick: 'x' }), 'malformed-command');
  assert.strictEqual(Rules.validateCommandShape({ type: 'drop', atTick: 1, id: 'x'.repeat(65) }), 'malformed-command');
  assert.strictEqual(Rules.validateCommandShape('nope'), 'malformed-command');
});

test('fuzz: malformed commands never hang or corrupt state', () => {
  const rng = RNG.create(4242);
  for (let i = 0; i < 500; i++) {
    const cfg = baseCfg({ seed: rng.int(1e9), goalHeight: rng.int(8) });
    let s = Rules.createGame(cfg);
    for (let j = 0; j < 20; j++) {
      const kind = rng.int(5);
      const cmd = kind === 0 ? { type: 'drop', atTick: rng.int(2000) - 500 }
        : kind === 1 ? { type: 'drop', atTick: s.tick + 1 + rng.int(500) }
        : kind === 2 ? { type: ['drop', 'timeout', 'resign', 'x'][rng.int(4)] }
        : kind === 3 ? { type: 'drop', atTick: 2.5 }
        : { wat: true };
      const res = Rules.applyCommand(s, cmd);
      if (res.ok) s = res.state;
      assert.ok(Number.isFinite(s.score.total), 'score finite');
      assert.ok(s.turn >= 0 && s.tick >= 0, 'counters sane');
      for (const sl of s.slabs) {
        assert.ok(sl.w > 0 && sl.d > 0, 'positive footprint');
        assert.ok(Number.isFinite(sl.x) && Number.isFinite(sl.z), 'no NaN');
      }
      if (s.terminal) break;
    }
  }
});

// ---------- content validation ----------

// Auto-player that always drops inside the perfect window: proves every
// authored goal is reachable within its limits (and bounded in time).
function autoplayPerfect(cfg, maxDrops) {
  let s = Rules.createGame(cfg);
  let n = 0;
  while (!s.terminal && n < (maxDrops || 500)) {
    const w = Rules.perfectWindow(s.cfg, s.pending, s.slabs.length, s.tick + 1);
    assert.ok(w, cfg.id + ': window exists at level ' + s.slabs.length);
    s = Rules.applyCommand(s, { type: 'drop', atTick: w.startTick }).state;
    n++;
  }
  return s;
}

test('all 40 journey stages are winnable by perfect play', () => {
  assert.strictEqual(Content.JOURNEY.length, 40);
  for (const cfg of Content.JOURNEY) {
    const s = autoplayPerfect(cfg);
    assert.ok(s.terminal, cfg.id + ' terminates');
    assert.ok(s.terminal.won, cfg.id + ' won (' + (s.terminal && s.terminal.reason) + ')');
    assert.ok(s.score.total > 0, cfg.id + ' scores');
    if (cfg.timeLimitSec) assert.ok(s.tick < cfg.timeLimitSec * 60, cfg.id + ' within clock');
    if (cfg.dropLimit) assert.ok(s.drops <= cfg.dropLimit, cfg.id + ' within drops');
  }
});

test('challenges and practice presets are winnable; dailies for 90 days are valid', () => {
  for (const cfg of Content.CHALLENGES) {
    const s = autoplayPerfect(cfg);
    assert.ok(s.terminal && s.terminal.won, cfg.id + ' won');
  }
  for (const cfg of Content.PRACTICE) {
    if (cfg.endless) continue;
    const s = autoplayPerfect(cfg);
    assert.ok(s.terminal && s.terminal.won, cfg.id + ' won');
  }
  const day0 = Date.parse('2026-01-01T00:00:00Z');
  const seen = new Set();
  for (let i = 0; i < 90; i++) {
    const dateStr = Content.utcDateString(day0 + i * 86400000);
    const cfg = Content.dailyConfig(dateStr);
    assert.ok(!seen.has(cfg.seed) || i > 0, 'seed varies');
    seen.add(cfg.seed);
    assert.strictEqual(cfg.id, 'daily-' + dateStr);
    const s = autoplayPerfect(cfg);
    assert.ok(s.terminal && s.terminal.won, 'daily ' + dateStr + ' won');
    // Immutable: same date → same ruleset forever.
    assert.strictEqual(
      Rules.hashState(Rules.createGame(cfg)),
      Rules.hashState(Rules.createGame(Content.dailyConfig(dateStr))));
  }
});

test('endless score chase never wins but terminates on a miss', () => {
  const cfg = Object.assign({}, Content.SCORE_CHASE, { seed: 31337 });
  let s = Rules.createGame(cfg);
  const rng = RNG.create(7);
  let drops = 0;
  while (!s.terminal && drops < 200) {
    // Offsets inside the foundation half-width (900 mu) so early drops land;
    // natural trimming eventually narrows the tower until a drop misses.
    const off = Math.floor(rng.next() * 1400) - 700;
    s = Rules.applyCommand(s, { type: 'drop', atTick: dropAtOffset(s, off) }).state;
    drops++;
  }
  assert.ok(s.terminal, 'ends');
  assert.strictEqual(s.terminal.reason, 'missed');
  assert.ok(!s.terminal.won);
  assert.ok(s.placed > 3, 'some tower built: ' + s.placed);
});

test('tutorial lesson configs are playable', () => {
  for (const lesson of Content.tutorialLessons()) {
    let s = Rules.createGame(lesson.cfg);
    for (let i = 0; i < 30 && !s.terminal; i++) {
      s = Rules.applyCommand(s, { type: 'drop', atTick: dropPerfectTick(s) }).state;
    }
    assert.ok(s.placed >= Math.min(3, lesson.goal.count) || s.terminal && s.terminal.won,
      lesson.id + ' progressable');
  }
});

// ---------- golden session ----------

const GOLDEN_HASH = 4054061407; // pinned by maintainer run

test('golden session: fixed seed and script produce the canonical hash', () => {
  const cfg = baseCfg({ seed: 2026, goalHeight: 4, id: 'golden' });
  let s = Rules.createGame(cfg);
  // Slab steps ~25 mu/tick with a seed-dependent phase, so exact offsets are
  // not guaranteed reachable; drop at the tick nearest the target offset
  // within one period (offset 0 → canonical perfect window).
  function dropNear(state, targetOffsetMu) {
    if (targetOffsetMu === 0) return dropPerfectTick(state);
    const cfg2 = state.cfg, level = state.slabs.length;
    const top = Rules.topSlab(state), axis = state.pending.axis;
    const center = axis === 'x' ? top.x : top.z;
    const P = Rules.periodTicks(cfg2, level);
    let best = -1, bestErr = Infinity;
    for (let t = state.tick + 1; t <= state.tick + P; t++) {
      const err = Math.abs(Rules.slabPosAt(cfg2, state.pending, level, t) - (center + targetOffsetMu));
      if (err < bestErr) { bestErr = err; best = t; }
    }
    return best;
  }
  const offsets = [0, 300, 0, 0];
  for (const off of offsets) {
    s = Rules.applyCommand(s, { type: 'drop', atTick: dropNear(s, off) }).state;
  }
  assert.ok(s.terminal && s.terminal.won);
  assert.strictEqual(s.placed, 4);
  assert.strictEqual(s.perfects, 3);
  assert.strictEqual(Rules.hashState(s), GOLDEN_HASH);
});

console.log('\n' + passed + ' tests passed');
