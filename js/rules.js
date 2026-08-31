/* Balance Spire — pure deterministic rules engine.
 * No rendering, no DOM, no Date.now(): every transition derives from
 * (state, command) only. Usable from browser (window.BSRules) and Node.
 *
 * Core loop: a slab slides back and forth above the tower; the player
 * drops it; the overhang is trimmed; the next slab travels on the other
 * axis across the reduced footprint. All geometry is integer milli-units
 * (1 unit = 1000 mu) and time is integer ticks (60 ticks/second), so a
 * drop command carrying its tick replays identically everywhere.
 *
 * Slab motion is a closed-form triangle wave of (spawnTick, phase,
 * period) — plain double arithmetic, no accumulation, no transcendentals.
 */
(function (root, factory) {
  var RNG = (typeof module === 'object' && module.exports) ? require('./rng.js') : root.BSRNG;
  var api = factory(RNG);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BSRules = api;
})(typeof self !== 'undefined' ? self : this, function (RNG) {
  'use strict';

  var STATE_VERSION = 1;
  var TICKS_PER_SEC = 60;
  var MU = 1000;               // milli-units per world unit
  var HALF_RANGE = 2500;       // slab travel half-amplitude (mu), constant

  var HEIGHT_PT = 10;          // per slab placed
  var PERFECT_PT = 25;         // per perfect placement
  var STREAK_PT = 5;           // extra per consecutive perfect (streak-1)
  var GOAL_BONUS = 200;        // reaching the goal height
  var PAR_DROP_PT = 15;        // win bonus per drop under par
  var TIME_PT_PER_SEC = 5;     // win bonus per second under par

  var TERMINAL = {
    GOAL: 'goal-height',
    MISSED: 'missed',
    MOVES: 'move-limit',
    TIME: 'time-up',
    RESIGN: 'resigned'
  };

  var INVALID = {
    ENDED: 'game-ended',
    BAD_CMD: 'unknown-command',
    BAD_SHAPE: 'malformed-command',
    BAD_TICK: 'bad-tick',
    EARLY_TIMEOUT: 'early-timeout',
    NO_LIMIT: 'no-time-limit'
  };

  // ---------- helpers ----------

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // Stable stringify: object keys sorted recursively → canonical hashing.
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) {
      var out = '[';
      for (var i = 0; i < v.length; i++) out += (i ? ',' : '') + stableStringify(v[i]);
      return out + ']';
    }
    var keys = Object.keys(v).sort(), s = '{';
    for (var k = 0; k < keys.length; k++) {
      s += (k ? ',' : '') + JSON.stringify(keys[k]) + ':' + stableStringify(v[keys[k]]);
    }
    return s + '}';
  }

  function hashState(state) {
    var copy = clone(state);
    delete copy.events;
    return RNG.hashString(stableStringify(copy));
  }

  // ---------- config normalization ----------

  // cfg: { id, version, kind, seed, name?, base:{w,d} (world units),
  //        speed (units/s), speedRamp (per level), goalHeight (0=endless),
  //        eps (perfect window, mu), dropLimit, timeLimitSec, lives,
  //        par:{drops,timeSec} | null, mechanics:{undo,hint}, endless,
  //        theme?, intro? }
  function normalizeCfg(cfg) {
    if (!cfg || typeof cfg !== 'object') throw new Error('missing config');
    if (!Number.isFinite(cfg.seed)) throw new Error('config seed required');
    var c = clone(cfg);
    c.baseMu = {
      w: Math.max(400, Math.round(((c.base && c.base.w) || 2) * MU) & ~1),
      d: Math.max(400, Math.round(((c.base && c.base.d) || 2) * MU) & ~1)
    };
    c.speed = Number(c.speed) > 0 ? Number(c.speed) : 1.5;
    c.speedRamp = Number(c.speedRamp) >= 0 ? Number(c.speedRamp) : 0;
    c.goalHeight = Math.max(0, Math.floor(c.goalHeight || 0));
    c.eps = Math.max(10, Math.floor(c.eps == null ? 90 : c.eps));
    c.dropLimit = Math.max(0, Math.floor(c.dropLimit || 0));
    c.timeLimitSec = Math.max(0, Math.floor(c.timeLimitSec || 0));
    c.lives = Math.max(1, Math.floor(c.lives || 1));
    c.mechanics = Object.assign({ undo: false, hint: false }, c.mechanics || {});
    c.endless = !!c.endless;
    if (c.endless) c.goalHeight = 0;
    return c;
  }

  // ---------- slab motion (closed form, deterministic) ----------

  function speedAt(cfg, level) { // world units per second
    return cfg.speed + cfg.speedRamp * level;
  }

  // Round-trip period in ticks for a level (1 = first placed slab).
  // Rounded UP TO AN EVEN number so the triangle wave's apex is an integer
  // tick and positions sweep the full ±HALF_RANGE lattice at exact steps of
  // 2*HALF_RANGE/(P/2) mu per tick — the center (and every lattice offset)
  // is always reachable, so a perfect drop is possible at every level.
  function periodTicks(cfg, level) {
    var muPerTick = speedAt(cfg, level) * MU / TICKS_PER_SEC;
    var P0 = 4 * HALF_RANGE / muPerTick;
    var P = Math.max(4, Math.ceil(P0));
    return P + (P % 2);
  }

  function axisForLevel(level) { // foundation is level 0; slab 1 moves on x
    return level % 2 === 1 ? 'x' : 'z';
  }

  // Effective perfect window (mu) at a level. The slab moves up to
  // 2*HALF_RANGE/P mu per tick; eps is floored at one tick of travel so a
  // perfect drop is always physically possible at every level.
  function epsAt(cfg, level) {
    return Math.max(cfg.eps, Math.ceil(2 * HALF_RANGE / periodTicks(cfg, level)));
  }

  // Center position (mu) of the moving slab at an absolute tick.
  // pending: {axis, phase (0..1), spawnTick}; pure function of integers.
  function slabPosAt(cfg, pending, level, atTick) {
    var P = periodTicks(cfg, level);
    var t = atTick - pending.spawnTick;
    if (t < 0) t = 0;
    var u = (t + Math.floor(pending.phase * P)) % P;
    var half = P / 2;
    var k = u < half ? u / half : (P - u) / half; // 0..1 triangle
    return Math.round(-HALF_RANGE + k * 2 * HALF_RANGE);
  }

  // Next absolute-tick window [start,end] (inclusive) where the moving
  // slab is within eps of the tower center: the perfect-drop window.
  function perfectWindow(cfg, pending, level, fromTick) {
    var P = periodTicks(cfg, level);
    var half = P / 2;
    var eps = epsAt(cfg, level);
    var k0 = (HALF_RANGE - eps) / (2 * HALF_RANGE);
    var k1 = (HALF_RANGE + eps) / (2 * HALF_RANGE);
    // Window in phase-u space, rising edge [a,b], falling edge [c,d].
    var a = Math.ceil(k0 * half), b = Math.floor(k1 * half);
    var c = Math.ceil(P - k1 * half), d = Math.floor(P - k0 * half);
    if (b < a) { a = 0; b = -1; }           // degenerate: no rising window
    if (d < c) { c = 0; d = -1; }
    var ph = Math.floor(pending.phase * P);
    var t0 = Math.max(0, fromTick - pending.spawnTick);
    var u0 = ((t0 + ph) % P + P) % P;
    var best = null;
    function consider(uStart, uEnd) {
      if (uEnd < uStart) return;
      var start, end;
      if (uStart <= u0 && u0 <= uEnd) { // window is active right now
        start = fromTick;
        end = fromTick + (uEnd - u0);
      } else {
        var delta = (uStart - u0 + P) % P;
        start = fromTick + delta;
        end = start + (uEnd - uStart);
      }
      if (best === null || start < best.start) best = { start: start, end: end };
    }
    consider(a, b);
    consider(c, d);
    if (!best) return null;
    if (best.start < fromTick) best.start = fromTick;
    return { startTick: best.start, endTick: best.end };
  }

  // ---------- game creation ----------

  function createGame(rawCfg) {
    var cfg = normalizeCfg(rawCfg);
    var seed = cfg.seed >>> 0;
    var rng = RNG.derive(seed, RNG.STREAM_RULES);

    var foundation = { x: 0, z: 0, w: cfg.baseMu.w, d: cfg.baseMu.d, perfect: false };
    var state = {
      v: STATE_VERSION,
      cfg: cfg,
      seed: seed,
      rngState: 0,
      tick: 0,                 // tick of the last resolved command
      turn: 0,                 // drops resolved (monotonic)
      slabs: [foundation],     // slabs[0] is the foundation
      pending: null,           // moving slab descriptor
      drops: 0,
      placed: 0,
      perfects: 0,
      streak: 0,
      bestStreak: 0,
      misses: 0,
      livesLeft: cfg.lives,
      score: { heightPoints: 0, perfectPoints: 0, streakPoints: 0,
               goalBonus: 0, dropBonus: 0, timeBonus: 0, total: 0 },
      terminal: null,
      events: []
    };
    spawnPending(state, rng, 0);
    state.rngState = rng.state;
    return state;
  }

  function spawnPending(state, rng, atTick) {
    var level = state.slabs.length; // next slab's 1-based level
    state.pending = {
      axis: state.cfg.axisPattern === 'x-only' ? 'x'
          : state.cfg.axisPattern === 'z-only' ? 'z'
          : axisForLevel(level),
      phase: rng.next(),
      spawnTick: atTick
    };
  }

  function topSlab(state) { return state.slabs[state.slabs.length - 1]; }
  function height(state) { return state.slabs.length - 1; }

  // ---------- legality ----------

  function checkDrop(state, atTick) {
    if (state.terminal) return INVALID.ENDED;
    if (!Number.isInteger(atTick)) return INVALID.BAD_SHAPE;
    if (atTick <= state.tick) return INVALID.BAD_TICK;
    return null;
  }

  function legalActions(state) {
    if (state.terminal) return { drop: false, timeout: false, resign: false };
    return {
      drop: true,
      timeout: !!state.cfg.timeLimitSec,
      resign: true,
      perfectWindow: perfectWindow(state.cfg, state.pending, state.slabs.length, state.tick + 1)
    };
  }

  // Hint = the same legality surface: the next perfect-drop window.
  function hint(state) {
    if (state.terminal) return null;
    var w = perfectWindow(state.cfg, state.pending, state.slabs.length, state.tick + 1);
    if (!w) return null;
    return { window: w, axis: state.pending.axis, why: 'perfect-window' };
  }

  // ---------- resolution ----------

  function applyCommand(state, cmd) {
    if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') {
      return { ok: false, reason: INVALID.BAD_SHAPE, state: state, events: [] };
    }
    if (cmd.type === 'resign') {
      if (state.terminal) return { ok: false, reason: INVALID.ENDED, state: state, events: [] };
      var rs = clone(state);
      rs.tick = Number.isInteger(cmd.atTick) && cmd.atTick > rs.tick ? cmd.atTick : rs.tick;
      rs.turn++;
      rs.terminal = { reason: TERMINAL.RESIGN, won: false };
      rs.events = [{ type: 'lose', reason: TERMINAL.RESIGN }];
      finalizeScore(rs);
      return { ok: true, state: rs, events: rs.events };
    }
    if (cmd.type === 'timeout') {
      if (state.terminal) return { ok: false, reason: INVALID.ENDED, state: state, events: [] };
      if (!state.cfg.timeLimitSec) return { ok: false, reason: INVALID.NO_LIMIT, state: state, events: [] };
      if (!Number.isInteger(cmd.atTick)) return { ok: false, reason: INVALID.BAD_SHAPE, state: state, events: [] };
      if (cmd.atTick < state.cfg.timeLimitSec * TICKS_PER_SEC) {
        return { ok: false, reason: INVALID.EARLY_TIMEOUT, state: state, events: [] };
      }
      var ts = clone(state);
      ts.tick = cmd.atTick;
      ts.turn++;
      ts.terminal = { reason: TERMINAL.TIME, won: false };
      ts.events = [{ type: 'lose', reason: TERMINAL.TIME }];
      finalizeScore(ts);
      return { ok: true, state: ts, events: ts.events };
    }
    if (cmd.type !== 'drop') {
      return { ok: false, reason: INVALID.BAD_CMD, state: state, events: [] };
    }

    var reason = checkDrop(state, cmd.atTick);
    if (reason) return { ok: false, reason: reason, state: state, events: [] };

    var s = clone(state);
    s.events = [];
    var atTick = cmd.atTick;
    var rng = RNG.create(s.rngState);

    // A drop that lands after the clock ran out is a loss, not a placement.
    if (s.cfg.timeLimitSec && atTick >= s.cfg.timeLimitSec * TICKS_PER_SEC) {
      s.tick = atTick;
      s.turn++;
      s.terminal = { reason: TERMINAL.TIME, won: false };
      s.events = [{ type: 'lose', reason: TERMINAL.TIME }];
      finalizeScore(s);
      return { ok: true, state: s, events: s.events };
    }

    s.tick = atTick;
    s.turn++;
    s.drops++;

    var level = s.slabs.length;
    var top = topSlab(s);
    var axis = s.pending.axis;
    var pos = slabPosAt(s.cfg, s.pending, level, atTick);
    var topC = axis === 'x' ? top.x : top.z;
    var w = axis === 'x' ? top.w : top.d;
    var left = Math.max(pos - w / 2, topC - w / 2);
    var right = Math.min(pos + w / 2, topC + w / 2);
    var overlap = right - left;
    var offset = pos - topC;

    if (Math.abs(offset) <= s.cfg.eps) {
      // Perfect: no trim, streak grows.
      s.streak++;
      s.perfects++;
      s.bestStreak = Math.max(s.bestStreak, s.streak);
      s.score.perfectPoints += PERFECT_PT;
      s.score.streakPoints += STREAK_PT * (s.streak - 1);
      placeSlab(s, axis, topC, w, true, offset, rng, atTick);
    } else if (overlap <= 0) {
      // Clean miss: the slab sails past and the tower keeps nothing.
      s.misses++;
      s.streak = 0;
      s.livesLeft--;
      s.events.push({ type: 'miss', level: level, axis: axis, pos: pos, size: w,
                      offset: offset, livesLeft: s.livesLeft });
      if (s.livesLeft <= 0) {
        s.terminal = { reason: TERMINAL.MISSED, won: false };
        s.events.push({ type: 'lose', reason: TERMINAL.MISSED });
      } else {
        spawnPending(s, rng, atTick); // a fresh slab slides in for the retry
      }
    } else {
      // Trim: keep the overlap, shed the overhang.
      var newC = Math.round((left + right) / 2);
      var overhang = w - overlap;
      s.streak = 0;
      s.events.push({ type: 'trim', level: level, axis: axis,
                      side: offset > 0 ? 1 : -1, size: Math.round(overhang),
                      center: Math.round(offset > 0 ? right + overhang / 2 : left - overhang / 2) });
      placeSlab(s, axis, newC, Math.round(overlap), false, offset, rng, atTick);
    }

    // Win / move-limit checks after resolution.
    if (!s.terminal && s.cfg.goalHeight && height(s) >= s.cfg.goalHeight) {
      s.terminal = { reason: TERMINAL.GOAL, won: true };
      s.score.goalBonus = GOAL_BONUS;
      if (s.cfg.par && s.cfg.par.drops && s.drops < s.cfg.par.drops) {
        s.score.dropBonus = (s.cfg.par.drops - s.drops) * PAR_DROP_PT;
      }
      if (s.cfg.par && s.cfg.par.timeSec && s.tick < s.cfg.par.timeSec * TICKS_PER_SEC) {
        s.score.timeBonus = Math.floor((s.cfg.par.timeSec * TICKS_PER_SEC - s.tick) / TICKS_PER_SEC) * TIME_PT_PER_SEC;
      }
      s.events.push({ type: 'win', reason: TERMINAL.GOAL });
    }
    if (!s.terminal && s.cfg.dropLimit && s.drops >= s.cfg.dropLimit) {
      s.terminal = { reason: TERMINAL.MOVES, won: false };
      s.events.push({ type: 'lose', reason: TERMINAL.MOVES });
    }

    s.rngState = rng.state;
    finalizeScore(s); // total is live during play, not just at the end
    return { ok: true, state: s, events: s.events };

    function placeSlab(st, ax, center, size, perfect, off, r, t) {
      var prev = topSlab(st);
      var slab = ax === 'x'
        ? { x: center, z: prev.z, w: size, d: prev.d, perfect: perfect }
        : { x: prev.x, z: center, w: prev.w, d: size, perfect: perfect };
      st.slabs.push(slab);
      st.placed++;
      st.score.heightPoints += HEIGHT_PT;
      st.events.push({ type: 'place', level: st.slabs.length - 1, axis: ax,
                       perfect: perfect, offset: off, width: size, streak: st.streak });
      spawnPending(st, r, t);
    }
  }

  function finalizeScore(s) {
    s.score.total = s.score.heightPoints + s.score.perfectPoints + s.score.streakPoints +
      s.score.goalBonus + s.score.dropBonus + s.score.timeBonus;
  }

  // ---------- validation (network / replay boundary) ----------

  function validateCommandShape(cmd, maxLen) {
    if (!cmd || typeof cmd !== 'object') return INVALID.BAD_SHAPE;
    if (JSON.stringify(cmd).length > (maxLen || 512)) return INVALID.BAD_SHAPE;
    if (cmd.type !== 'drop' && cmd.type !== 'resign' && cmd.type !== 'timeout') return INVALID.BAD_CMD;
    if (cmd.id != null && (typeof cmd.id !== 'string' || cmd.id.length > 64)) return INVALID.BAD_SHAPE;
    if (cmd.atTick != null && !Number.isInteger(cmd.atTick)) return INVALID.BAD_SHAPE;
    if (cmd.type === 'drop' && cmd.atTick == null) return INVALID.BAD_SHAPE;
    return null;
  }

  // Replay an ordered command log from a config; returns terminal state.
  function replay(cfg, commands) {
    var s = createGame(cfg);
    for (var i = 0; i < commands.length; i++) {
      var err = validateCommandShape(commands[i]);
      if (err) return { ok: false, reason: err, at: i, state: s };
      var res = applyCommand(s, commands[i]);
      if (!res.ok) return { ok: false, reason: res.reason, at: i, state: s };
      s = res.state;
    }
    return { ok: true, state: s };
  }

  // ---------- serialization ----------

  function serialize(state) { return JSON.stringify(state); }
  function deserialize(json) {
    var s = JSON.parse(json);
    if (s.v !== STATE_VERSION) throw new Error('unsupported state version ' + s.v);
    return s;
  }

  return {
    STATE_VERSION: STATE_VERSION,
    TICKS_PER_SEC: TICKS_PER_SEC,
    MU: MU,
    HALF_RANGE: HALF_RANGE,
    TERMINAL: TERMINAL,
    INVALID: INVALID,
    normalizeCfg: normalizeCfg,
    createGame: createGame,
    applyCommand: applyCommand,
    checkDrop: checkDrop,
    legalActions: legalActions,
    hint: hint,
    replay: replay,
    speedAt: speedAt,
    periodTicks: periodTicks,
    axisForLevel: axisForLevel,
    slabPosAt: slabPosAt,
    perfectWindow: perfectWindow,
    topSlab: topSlab,
    height: height,
    hashState: hashState,
    stableStringify: stableStringify,
    serialize: serialize,
    deserialize: deserialize,
    clone: clone,
    validateCommandShape: validateCommandShape
  };
});
