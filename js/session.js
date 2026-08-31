/* Balance Spire — session module.
 * Owns the game-state machine and the round runner. Rendering consumes
 * immutable snapshots; all rules mutation goes through validated commands.
 *
 * Phases: boot → title → profile-ready → mode-select → preparing →
 * countdown → active ↔ paused → resolving → results → progression.
 * Solo rounds are local and offline-capable; daily/score sessions record a
 * replay envelope (schema, versions, seed, command log, hashes, result)
 * that the authoritative server re-validates.
 * UMD: window.BSSession / Node.
 */
(function (root, factory) {
  var deps = (typeof module === 'object' && module.exports)
    ? { Rules: require('./rules.js'), Content: require('./content.js'), RNG: require('./rng.js') }
    : { Rules: root.BSRules, Content: root.BSContent, RNG: root.BSRNG };
  var api = factory(deps.Rules, deps.Content, deps.RNG);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BSSession = api;
})(typeof self !== 'undefined' ? self : this, function (Rules, Content, RNG) {
  'use strict';

  var TPS = Rules.TICKS_PER_SEC;
  var SETTINGS_KEY = 'bs.settings.v1';
  var PROGRESS_KEY = 'bs.progress.v1';
  var SNAPSHOT_KEY = 'bs.snapshot.v1';

  var DEFAULT_SETTINGS = {
    volMusic: 40, volEffects: 80, volAmbience: 35, volVoice: 60,
    captions: true, quality: 'auto', reducedMotion: false, highContrast: false,
    largeText: false, leftHanded: false, holdToDrop: false,
    timingAssist: true, haptics: true, analytics: false, tutorialDone: false
  };

  function defaultProgress() {
    return {
      v: 1, stars: 0, journeyStars: {}, tutorialDone: false,
      dailies: {}, bestScore: 0, bestHeight: 0, perfectsTotal: 0,
      achievements: {}, themeUnlocksSeen: []
    };
  }

  // ---------- persistence (versioned, checksummed) ----------
  function checksum(obj) {
    return RNG.hashString(Rules.stableStringify(obj)) >>> 0;
  }
  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback();
      var doc = JSON.parse(raw);
      if (doc.v !== 1 || checksum(doc.data) !== doc.sum) return fallback();
      return doc.data;
    } catch (e) { return fallback(); }
  }
  function save(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify({ v: 1, data: data, sum: checksum(data) }));
    } catch (e) { /* storage full/blocked: play on without persistence */ }
  }

  var listeners = {};
  function on(evt, cb) { (listeners[evt] = listeners[evt] || []).push(cb); }
  function emit(evt, a, b) {
    (listeners[evt] || []).forEach(function (cb) { cb(a, b); });
  }

  var settings = Object.assign({}, DEFAULT_SETTINGS, load(SETTINGS_KEY, function () { return {}; }));
  var progress = load(PROGRESS_KEY, defaultProgress);
  if (!progress.achievements) progress = defaultProgress();

  function saveSettings() { save(SETTINGS_KEY, settings); emit('settings', settings); }
  function saveProgress() { save(PROGRESS_KEY, progress); }

  // ---------- round runner ----------
  var round = null;

  function startRound(cfg, opts) {
    opts = opts || {};
    var state = Rules.createGame(cfg);
    round = {
      cfg: state.cfg,
      mode: opts.mode || cfg.kind || 'practice',
      lesson: opts.lesson || null,
      state: state,
      phase: 'countdown',
      log: [],                 // ordered validated commands (replay envelope)
      undoStack: [],
      hashes: [Rules.hashState(state)],
      startedAt: Date.now(),
      wallBase: 0,             // performance.now() base for tick conversion
      pauseBase: 0,
      countdownLeft: 3,
      lessonProgress: 0,
      lessonDone: false,
      cmdSeq: 0,
      pendingEvents: []
    };
    return round;
  }

  // Convert wall time → rules ticks. Ticks only advance while active.
  // wallBase is chosen so that tick = floor((now - wallBase) * 60 / 1000)
  // is an absolute clock since the round went active — never state.tick
  // plus elapsed (that would double-count after every command).
  function tickNow() {
    if (!round) return 0;
    if (round.phase === 'active') {
      return Math.max(Math.floor((performance.now() - round.wallBase) / 1000 * TPS), round.state.tick);
    }
    return round.state.tick;
  }

  function beginActive() {
    round.phase = 'active';
    round.wallBase = performance.now() - round.state.tick * 1000 / TPS;
    emit('phase', 'active');
  }

  function applyCmd(cmd) {
    if (!round || round.phase === 'ended') return null;
    var err = Rules.validateCommandShape(cmd);
    if (err) { emit('invalid', err); return { ok: false, reason: err }; }
    if (cmd.type === 'drop' && round.cfg.mechanics.undo && !isRanked()) {
      round.undoStack.push(Rules.clone(round.state));
      if (round.undoStack.length > 32) round.undoStack.shift();
    }
    var res = Rules.applyCommand(round.state, cmd);
    if (!res.ok) { emit('invalid', res.reason); return res; }
    round.state = res.state;
    round.log.push(cmd);
    round.hashes.push(Rules.hashState(res.state));
    round.pendingEvents = res.events;
    trackLesson(res.events);
    checkAchievements(res.events, res.state);
    emit('state', res.state, res.events);
    if (res.state.terminal) endRound();
    else if (res.state.cfg.timeLimitSec == null || true) {
      // time limit enforced by tick watchdog below
    }
    return res;
  }

  function drop() {
    if (!round || round.phase !== 'active') return null;
    var atTick = tickNow();
    if (atTick <= round.state.tick) atTick = round.state.tick + 1;
    return applyCmd({ type: 'drop', id: round.cfg.id + '-' + (round.cmdSeq++), atTick: atTick });
  }

  function undo() {
    if (!round || round.phase !== 'active') return false;
    if (!round.cfg.mechanics.undo || isRanked() || !round.undoStack.length) {
      emit('invalid', 'undo-unavailable');
      return false;
    }
    round.state = round.undoStack.pop();
    round.log.push({ type: 'undo-local' }); // client-side marker; stripped for ranked replay
    trackLesson([{ type: 'undo' }]);
    emit('state', round.state, [{ type: 'undo' }]);
    return true;
  }

  function hint() {
    if (!round || round.phase !== 'active') return null;
    if (!round.cfg.mechanics.hint) { emit('invalid', 'hint-unavailable'); return null; }
    return Rules.hint(round.state);
  }

  function pause() {
    if (!round || round.phase !== 'active') return;
    round.pausedTick = tickNow();
    round.phase = 'paused';
    emit('phase', 'paused');
  }
  function resume() {
    if (!round || round.phase !== 'paused') return;
    var at = Number.isFinite(round.pausedTick) ? round.pausedTick : round.state.tick;
    round.wallBase = performance.now() - at * 1000 / TPS;
    round.phase = 'active';
    emit('phase', 'active');
  }
  function resign() {
    if (!round || round.phase === 'ended') return;
    applyCmd({ type: 'resign', id: round.cfg.id + '-resign' });
  }
  function restart() {
    var cfg = round.cfg, mode = round.mode, lesson = round.lesson;
    return startRound(cfg, { mode: mode, lesson: lesson });
  }

  function isRanked() {
    return round && (round.mode === 'daily' || round.mode === 'score');
  }

  // Called every frame by the UI loop: countdown, time-limit watchdog.
  function update() {
    if (!round) return;
    if (round.phase === 'countdown') {
      var left = Math.ceil(3 - (performance.now() - round.countdownStart) / 750);
      if (left !== round.countdownLeft) {
        round.countdownLeft = left;
        emit('countdown', left);
      }
      if (left <= 0) beginActive();
      return;
    }
    if (round.phase !== 'active') return;
    var cfg = round.state.cfg;
    if (cfg.timeLimitSec) {
      var limit = cfg.timeLimitSec * TPS;
      var t = tickNow();
      if (t >= limit) {
        applyCmd({ type: 'timeout', id: round.cfg.id + '-to', atTick: Math.max(t, limit) });
      }
    }
  }

  function startCountdown() {
    round.countdownStart = performance.now();
    round.countdownLeft = 3;
    round.phase = 'countdown';
    emit('phase', 'countdown');
  }

  function trackLesson(events) {
    if (!round.lesson || round.lessonDone) return;
    var g = round.lesson.goal;
    events.forEach(function (e) {
      if (g.event === 'perfect' && e.type === 'place' && e.perfect) round.lessonProgress++;
      else if (e.type === g.event) round.lessonProgress++;
    });
    if (round.lessonProgress >= g.count) {
      round.lessonDone = true;
      emit('lesson-done', round.lesson);
    }
  }

  // ---------- results, progression, achievements ----------
  function endRound() {
    round.phase = 'ended';
    var s = round.state, cfg = round.cfg;
    var stars = 0;
    if (s.terminal.won) {
      stars = 1;
      if (cfg.par && s.drops <= cfg.par.drops) stars++;
      if (cfg.par && cfg.par.timeSec && s.tick <= cfg.par.timeSec * TPS) stars++;
    }
    var newly = [];
    if (round.mode === 'journey') {
      var prev = progress.journeyStars[cfg.id] || 0;
      if (stars > prev) {
        progress.stars += stars - prev;
        progress.journeyStars[cfg.id] = stars;
      }
    }
    if (round.mode === 'daily' && s.terminal.won && cfg.date) {
      progress.dailies[cfg.date] = Math.max(s.score.total, progress.dailies[cfg.date] || 0);
    }
    progress.perfectsTotal += s.perfects;
    if (s.score.total > progress.bestScore) progress.bestScore = s.score.total;
    if (Rules.height(s) > progress.bestHeight) progress.bestHeight = Rules.height(s);
    newly = newly.concat(grantLateAchievements(s));
    saveProgress();
    emit('results', {
      state: s, stars: stars, won: !!s.terminal.won,
      achievements: newly, replay: replayEnvelope()
    });
  }

  function unlock(key) {
    if (progress.achievements[key]) return false;
    progress.achievements[key] = Date.now();
    saveProgress();
    emit('achievement', key);
    return true;
  }

  function checkAchievements(events, s) {
    events.forEach(function (e) {
      if (e.type === 'place' && s.placed >= 1) unlock('first-place');
      if (e.type === 'place' && e.perfect) unlock('first-perfect');
      if (e.type === 'place' && e.streak >= 5) unlock('streak-5');
    });
    if (Rules.height(s) >= 30) unlock('height-30');
    if (s.score.total >= 1500) unlock('score-1500');
  }

  function grantLateAchievements(s) {
    var newly = [];
    var done = Object.keys(progress.journeyStars).filter(function (k) { return progress.journeyStars[k] > 0; }).length;
    if (done >= 20 && unlock('journey-half')) newly.push('journey-half');
    if (done >= 40 && unlock('journey-done')) newly.push('journey-done');
    if (Object.keys(progress.dailies).length >= 7 && unlock('daily-7')) newly.push('daily-7');
    if (progress.perfectsTotal >= 100 && unlock('perfects-100')) newly.push('perfects-100');
    return newly;
  }

  function replayEnvelope() {
    if (!round) return null;
    return {
      schema: 1,
      contentVersion: Content.CONTENT_VERSION,
      stateVersion: Rules.STATE_VERSION,
      cfgId: round.cfg.id,
      date: round.cfg.date || null,
      seed: round.cfg.seed,
      initialHash: round.hashes[0],
      tsOffset: round.startedAt,
      commands: round.log.filter(function (c) { return c.type !== 'undo-local'; }),
      hashes: round.hashes,
      result: {
        won: !!round.state.terminal.won, reason: round.state.terminal.reason,
        score: round.state.score, drops: round.state.drops,
        placed: round.state.placed, perfects: round.state.perfects,
        finalHash: round.hashes[round.hashes.length - 1],
        durationSec: Math.round(round.state.tick / TPS)
      }
    };
  }

  // ---------- crash-safe snapshot ----------
  function saveSnapshot() {
    if (!round || round.phase === 'ended') { try { localStorage.removeItem(SNAPSHOT_KEY); } catch (e) {} return; }
    save(SNAPSHOT_KEY, { cfg: round.cfg, mode: round.mode, state: Rules.serialize(round.state), log: round.log });
  }
  function loadSnapshot() {
    var doc = load(SNAPSHOT_KEY, function () { return null; });
    if (!doc) return null;
    try {
      var state = Rules.deserialize(doc.state);
      round = {
        cfg: state.cfg, mode: doc.mode, lesson: null, state: state,
        phase: 'paused', log: doc.log || [], undoStack: [],
        hashes: [Rules.hashState(state)], startedAt: Date.now(),
        wallBase: 0, pauseBase: 0, pausedTick: state.tick, countdownLeft: 0, cmdSeq: 999,
        lessonProgress: 0, lessonDone: false, pendingEvents: []
      };
      return round;
    } catch (e) { return null; }
  }

  return {
    on: on,
    get settings() { return settings; },
    saveSettings: saveSettings,
    get progress() { return progress; },
    saveProgress: saveProgress,
    get round() { return round; },
    startRound: startRound,
    startCountdown: startCountdown,
    tickNow: tickNow,
    update: update,
    drop: drop,
    undo: undo,
    hint: hint,
    pause: pause,
    resume: resume,
    resign: resign,
    restart: restart,
    isRanked: isRanked,
    unlock: unlock,
    replayEnvelope: replayEnvelope,
    saveSnapshot: saveSnapshot,
    loadSnapshot: loadSnapshot
  };
});
