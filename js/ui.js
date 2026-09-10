/* Balance Spire — ui module: DOM shell, screens, focus, input routing,
 * settings binding, HUD, accessibility mirror. UI state is separate from
 * simulation state; closing a panel never touches the round.
 * UMD: window.BSUI.
 */
window.BSUI = (function (root) {
  'use strict';

  var S = null; // BSSession, injected via init
  var R = null; // BSRender
  var A = null; // BSAudio
  var P = null; // BSPlatform
  var Content = null, Rules = null;

  var el = {};
  var screenStack = [];
  var currentScreen = 'title';
  var lastFocus = null;
  var pendingSetup = null;   // {mode, cfg, lesson}
  var setupListMode = null;
  var setupItems = [];       // full list for the open setup screen
  var setupPage = 0;
  var SETUP_PAGE_SIZE = 8;   // fits both desktop and mobile viewports without overflow
  var prevPhase = null;

  function $(id) { return document.getElementById(id); }

  function init(deps) {
    S = deps.session; R = deps.render; A = deps.audio; P = deps.platform;
    Content = deps.content; Rules = deps.rules;

    ['hud', 'tray', 'countdown', 'countdown-num', 'caption', 'toast', 'live', 'live-assertive',
     'board-mirror', 'hud-objective', 'hud-progress', 'hud-height', 'hud-score', 'hud-streak',
     'hud-drops', 'hud-time', 'hud-lives', 'hud-drops-wrap', 'hud-time-wrap', 'hud-lives-wrap',
     'hud-streak-wrap', 'setup-info', 'setup-list', 'setup-h', 'btn-start', 'results-h',
     'setup-pager', 'setup-prev', 'setup-next', 'setup-page',
     'results-headline', 'results-progress', 'results-board', 'results-achievements',
     'score-total', 'score-table', 'btn-next', 'title-progress', 'title-net', 'daily-status',
     'journey-status', 'learn-status', 'score-status', 'board-body', 'board-h', 'help-cards',
     'gl-fallback']
      .forEach(function (id) { el[id.replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); })] = $(id); });

    bindButtons();
    bindInput();
    bindSettings();
    applySettingsToDom();
    refreshTitleMeta();
    showScreen('title');

    S.on('phase', onPhase);
    S.on('state', onState);
    S.on('countdown', onCountdown);
    S.on('results', onResults);
    S.on('invalid', function (reason) { announce('Not allowed: ' + reason); A.event('ack'); });
    S.on('lesson-done', function (lesson) {
      toast('Lesson complete: ' + lesson.title);
      announce('Lesson complete. ' + lesson.title);
      A.event('lesson');
      S.progress.tutorialDone = true;
      S.saveProgress();
    });
    S.on('achievement', function (key) {
      var def = Content.ACHIEVEMENTS.find(function (a) { return a.key === key; });
      if (def) { toast('Achievement: ' + def.name); A.event('achievement', def.name); }
      P.unlockAchievement(key);
    });
    A.onCaption(showCaption);
  }

  // ---------- screens ----------
  var SCREENS = ['title', 'mode-select', 'setup', 'paused', 'results', 'settings', 'help', 'board'];
  function showScreen(name, push) {
    if (push !== false && currentScreen && currentScreen !== name && SCREENS.indexOf(currentScreen) >= 0
        && document.querySelector('.screen[data-screen="' + currentScreen + '"]') &&
        !document.querySelector('.screen[data-screen="' + currentScreen + '"]').hidden) {
      screenStack.push(currentScreen);
    }
    lastFocus = document.activeElement;
    SCREENS.forEach(function (s) {
      var node = document.querySelector('.screen[data-screen="' + s + '"]');
      if (node) node.hidden = s !== name;
    });
    currentScreen = name;
    var inGame = name === null;
    el.hud.hidden = !inGame && !(S.round && (S.round.phase === 'paused'));
    el.tray.hidden = !inGame;
    if (name) {
      var node = document.querySelector('.screen[data-screen="' + name + '"]');
      var f = node && node.querySelector('button, [href], input, select');
      if (f) f.focus();
    }
    document.getElementById('app').dataset.screen = name || 'play';
  }
  function back() {
    var prev = screenStack.pop() || 'title';
    var cur = currentScreen;
    SCREENS.forEach(function (s) {
      var node = document.querySelector('.screen[data-screen="' + s + '"]');
      if (node) node.hidden = s !== prev;
    });
    currentScreen = prev;
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.toast.hidden = true; }, 2600);
  }
  function announce(msg) { el.live.textContent = ''; el.live.textContent = msg; }
  function announceAssertive(msg) { el.liveAssertive.textContent = ''; el.liveAssertive.textContent = msg; }
  function showCaption(text) {
    if (!S.settings.captions || !text) return;
    el.caption.textContent = text;
    el.caption.hidden = false;
    clearTimeout(showCaption._t);
    showCaption._t = setTimeout(function () { el.caption.hidden = true; }, 1800);
  }

  // ---------- buttons ----------
  function bindButtons() {
    $('btn-play').addEventListener('click', function () { A.unlock(); showScreen('mode-select'); refreshModeCards(); });
    $('btn-daily').addEventListener('click', function () { A.unlock(); openSetup('daily'); });
    $('btn-journey').addEventListener('click', function () { A.unlock(); openSetup('journey'); });
    $('btn-learn').addEventListener('click', function () { A.unlock(); openSetup('learn'); });
    $('btn-help').addEventListener('click', function () { openHelp(); });
    $('btn-boards').addEventListener('click', function () {
      var today = Content.utcDateString(P.hosted ? P.now() : Date.now());
      openBoard('Score chase — global', P.scoreBoard(), function (r) { return r.score; });
      // daily board appended after global rows load
      P.dailyBoard(today).then(function (r) {
        if (!r || r.error || !r.rows) return;
        var h = document.createElement('h3');
        h.textContent = 'Daily ' + today;
        var ol = document.createElement('ol');
        r.rows.slice(0, 20).forEach(function (row) {
          var li = document.createElement('li');
          li.textContent = row.playerId + ' ';
          var b = document.createElement('strong'); b.textContent = row.score;
          li.appendChild(b); ol.appendChild(li);
        });
        el.boardBody.appendChild(h); el.boardBody.appendChild(ol);
      });
    });
    $('btn-settings').addEventListener('click', function () { showScreen('settings'); });

    document.querySelectorAll('#mode-cards .card').forEach(function (card) {
      card.addEventListener('click', function () { openSetup(card.dataset.mode); });
    });
    document.querySelectorAll('[data-back]').forEach(function (b) {
      b.addEventListener('click', back);
    });

    el.btnStart.addEventListener('click', function () {
      if (pendingSetup && pendingSetup.cfg) commitStart(pendingSetup);
    });
    el.setupPrev.addEventListener('click', function () { setupPage--; renderSetupList(); });
    el.setupNext.addEventListener('click', function () { setupPage++; renderSetupList(); });
    $('btn-drop').addEventListener('click', function () { doDrop(); });
    $('btn-hint').addEventListener('click', function () { doHint(); });
    $('btn-undo').addEventListener('click', function () { if (S.undo()) A.event('undo'); });
    $('btn-pause').addEventListener('click', function () { pauseGame(); });

    $('btn-resume').addEventListener('click', function () { resumeGame(); });
    $('btn-pause-settings').addEventListener('click', function () { showScreen('settings'); });
    $('btn-pause-help').addEventListener('click', function () { openHelp(); });
    $('btn-restart').addEventListener('click', function () {
      S.restart(); S.startCountdown();
      showScreen(null); showHud();
    });
    $('btn-leave').addEventListener('click', function () {
      S.resign();
      // results screen opens via onResults
    });

    $('btn-retry').addEventListener('click', function () {
      S.restart(); S.startCountdown();
      showScreen(null); showHud();
    });
    el.btnNext.addEventListener('click', function () {
      var next = nextJourneyLevel();
      if (next) commitStart({ mode: 'journey', cfg: next });
    });
    $('btn-results-modes').addEventListener('click', function () { showScreen('mode-select'); refreshModeCards(); });
    $('btn-replay-tutorial').addEventListener('click', function () {
      S.progress.tutorialDone = false; S.saveProgress();
      openSetup('learn');
    });
  }

  // ---------- setup flow ----------
  function refreshModeCards() {
    var p = S.progress;
    var journeyDone = Object.keys(p.journeyStars).filter(function (k) { return p.journeyStars[k] > 0; }).length;
    el.journeyStatus.textContent = journeyDone + '/40 stages · ' + p.stars + ' stars';
    var today = Content.utcDateString(P.hosted ? P.now() : Date.now());
    el.dailyStatus.textContent = p.dailies[today] ? 'Best today: ' + p.dailies[today] : 'Not played today';
    el.learnStatus.textContent = p.tutorialDone ? 'Completed' : '5 lessons';
    el.scoreStatus.textContent = p.bestScore ? 'Best: ' + p.bestScore : '';
  }

  function refreshTitleMeta() {
    var p = S.progress;
    el.titleProgress.textContent =
      p.stars > 0 || p.bestScore > 0
        ? 'Journey ' + Object.keys(p.journeyStars).filter(function (k) { return p.journeyStars[k] > 0; }).length +
          '/40 · ' + p.stars + '★ · best score ' + p.bestScore
        : '';
  }

  function openSetup(mode) {
    pendingSetup = null;
    setupListMode = mode;
    var info = '', list = [];
    if (mode === 'journey') {
      el.setupH.textContent = 'Journey';
      info = 'Ranked: no · Expected: 1–3 min per stage · 1 player · Assists: undo + hints allowed. Finish stages to earn up to 3 stars each.';
      list = Content.JOURNEY.map(function (cfg, i) {
        var unlocked = i === 0 || (S.progress.journeyStars[Content.JOURNEY[i - 1].id] || 0) > 0;
        var stars = S.progress.journeyStars[cfg.id] || 0;
        return { cfg: cfg, unlocked: unlocked, label: (i + 1) + '. ' + cfg.name,
          right: '★'.repeat(stars) + '☆'.repeat(3 - stars), current: unlocked && !stars };
      });
    } else if (mode === 'daily') {
      el.setupH.textContent = 'Daily challenge';
      var date = Content.utcDateString(P.hosted ? P.now() : Date.now());
      var cfg = Content.dailyConfig(date);
      pendingSetup = { mode: 'daily', cfg: cfg };
      info = 'Ranked: YES · Seed ' + cfg.seed + ' · Goal ' + cfg.goalHeight + ' slabs' +
        (cfg.dropLimit ? ' · ' + cfg.dropLimit + ' drops max' : '') +
        (cfg.timeLimitSec ? ' · ' + cfg.timeLimitSec + 's clock' : '') +
        ' · No undo. One shared seed for everyone on ' + date + ' (UTC).';
    } else if (mode === 'practice') {
      el.setupH.textContent = 'Practice';
      info = 'Ranked: no · Assists: undo + hints · No effect on rating.';
      list = Content.PRACTICE.map(function (cfg) {
        return { cfg: cfg, unlocked: true, label: cfg.name,
          right: cfg.endless ? 'endless' : 'goal ' + cfg.goalHeight };
      });
    } else if (mode === 'challenge') {
      el.setupH.textContent = 'Challenge';
      info = 'Ranked: no · Constrained goals · Assists vary per challenge.';
      list = Content.CHALLENGES.map(function (cfg) {
        return { cfg: cfg, unlocked: true, label: cfg.name,
          right: (cfg.dropLimit ? cfg.dropLimit + ' drops ' : '') + (cfg.timeLimitSec ? cfg.timeLimitSec + 's' : '') };
      });
    } else if (mode === 'score') {
      el.setupH.textContent = 'Score chase';
      var sc = Content.SCORE_CHASE;
      pendingSetup = { mode: 'score', cfg: sc };
      info = 'Ranked: YES · Endless — one life, rising speed · No undo, no hints. Submit to global and friends boards.';
    } else if (mode === 'learn') {
      el.setupH.textContent = 'Learn';
      info = 'Five interactive lessons. Each introduces one rule and asks you to perform it.';
      list = Content.tutorialLessons().map(function (lesson) {
        return { cfg: lesson.cfg, lesson: lesson, unlocked: true, label: lesson.title, right: '' };
      });
    }
    el.setupInfo.textContent = info;
    setupItems = list;
    var currentIdx = list.findIndex(function (item) { return item.current; });
    setupPage = currentIdx > 0 ? Math.floor(currentIdx / SETUP_PAGE_SIZE) : 0;
    renderSetupList();
    el.btnStart.hidden = !pendingSetup;
    showScreen('setup');
  }

  function renderSetupList() {
    var pages = Math.max(1, Math.ceil(setupItems.length / SETUP_PAGE_SIZE));
    setupPage = Math.min(Math.max(setupPage, 0), pages - 1);
    el.setupList.innerHTML = '';
    setupItems.slice(setupPage * SETUP_PAGE_SIZE, (setupPage + 1) * SETUP_PAGE_SIZE)
      .forEach(function (item) {
        var b = document.createElement('button');
        b.type = 'button';
        if (!item.unlocked) b.className = 'locked';
        if (item.current) b.classList.add('current');
        var l = document.createElement('span'); l.textContent = item.label;
        var r = document.createElement('span'); r.className = 'stars'; r.textContent = item.right || '';
        b.appendChild(l); b.appendChild(r);
        b.disabled = !item.unlocked;
        b.addEventListener('click', function () {
          commitStart({ mode: setupListMode, cfg: item.cfg, lesson: item.lesson || null });
        });
        el.setupList.appendChild(b);
      });
    el.setupPager.hidden = pages <= 1;
    el.setupPage.textContent = (setupPage + 1) + ' / ' + pages;
    el.setupPrev.disabled = setupPage === 0;
    el.setupNext.disabled = setupPage === pages - 1;
  }

  function commitStart(setup) {
    A.unlock();
    A.setSeed(setup.cfg.seed);
    var round = S.startRound(setup.cfg, { mode: setup.mode, lesson: setup.lesson });
    R.setTheme(themeFor(setup.cfg).palette, BSRNG.derive(setup.cfg.seed, BSRNG.STREAM_DECOR));
    S.startCountdown();
    showScreen(null);
    showHud(round);
    P.activityStart();
    if (setup.mode === 'learn' || setup.cfg.intro) announceAssertive(setup.lesson ? setup.lesson.text : setup.cfg.intro);
    if (setup.lesson) toast(setup.lesson.title + ' — ' + setup.lesson.text);
    else if (setup.cfg.intro) toast(setup.cfg.intro);
  }

  function themeFor(cfg) {
    return Content.THEMES.find(function (t) { return t.id === (cfg.theme || 'dawn'); }) || Content.THEMES[0];
  }

  function nextJourneyLevel() {
    if (!S.round || S.round.mode !== 'journey') return null;
    var idx = Content.JOURNEY.findIndex(function (c) { return c.id === S.round.cfg.id; });
    return idx >= 0 && idx < Content.JOURNEY.length - 1 ? Content.JOURNEY[idx + 1] : null;
  }

  // ---------- play phase ----------
  function showHud(round) {
    round = round || S.round;
    if (!round) return;
    el.hud.hidden = false;
    el.tray.hidden = false;
    var cfg = round.cfg;
    el.hudObjective.textContent = cfg.endless ? 'Build as high as you can'
      : 'Reach ' + cfg.goalHeight + ' slabs';
    el.hudProgress.textContent = round.lesson ? round.lesson.title : cfg.name || '';
    el.hudDropsWrap.hidden = !cfg.dropLimit;
    el.hudTimeWrap.hidden = !cfg.timeLimitSec;
    el.hudLivesWrap.hidden = cfg.lives <= 1;
    $('btn-hint').disabled = !cfg.mechanics.hint;
    $('btn-undo').disabled = !cfg.mechanics.undo || S.isRanked();
    updateHud(round.state);
  }

  function updateHud(state) {
    el.hudHeight.textContent = Rules.height(state);
    el.hudScore.textContent = state.score.total;
    el.hudStreak.textContent = state.streak;
    if (state.cfg.dropLimit) el.hudDrops.textContent = Math.max(0, state.cfg.dropLimit - state.drops);
    if (state.cfg.lives > 1) el.hudLives.textContent = state.livesLeft;
    if (state.cfg.timeLimitSec) {
      var left = Math.max(0, state.cfg.timeLimitSec - Math.floor(S.tickNow() / 60));
      el.hudTime.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
    }
  }

  function onPhase(phase) {
    if (phase === 'active') {
      el.countdown.hidden = true;
      A.event('go');
      announce('Go. Drop the slab when it lines up.');
      $('btn-drop').focus({ preventScroll: true });
    } else if (phase === 'countdown') {
      el.countdown.hidden = false;
      el.countdown.setAttribute('aria-hidden', 'false');
    }
  }

  function onCountdown(left) {
    el.countdownNum.textContent = left > 0 ? left : 'Go';
    A.event('count', left);
  }

  function onState(state, events) {
    updateHud(state);
    R.syncState(state, 0);
    R.playEvents(events);
    A.setMusicIntensity(state.streak);
    events.forEach(function (e) {
      if (e.type === 'place') {
        A.event(e.perfect ? 'perfect' : 'place');
        if (navigator.vibrate && S.settings.haptics) navigator.vibrate(e.perfect ? 30 : 12);
        announce(e.perfect ? 'Perfect! Streak ' + state.streak : 'Placed. Height ' + Rules.height(state));
      } else if (e.type === 'trim') {
        A.event('trim');
      } else if (e.type === 'miss') {
        A.event('miss');
        announceAssertive('Missed!' + (e.livesLeft > 0 ? ' ' + e.livesLeft + ' spare slab left.' : ''));
        if (navigator.vibrate && S.settings.haptics) navigator.vibrate([60, 40, 60]);
      } else if (e.type === 'undo') {
        announce('Drop undone.');
      }
    });
    mirrorBoard(state);
  }

  // Concise navigable model of the board for screen readers.
  function mirrorBoard(state) {
    var top = Rules.topSlab(state);
    el.boardMirror.textContent =
      'Tower height ' + Rules.height(state) + ' of ' + (state.cfg.goalHeight || 'unlimited') +
      '. Next slab slides on the ' + state.pending.axis.toUpperCase() + ' axis' +
      ', width ' + (Math.max(top.w, top.d) / 1000).toFixed(1) + ' units.' +
      ' Score ' + state.score.total + '.';
  }

  // ---------- results ----------
  function onResults(res) {
    var s = res.state;
    el.resultsH.textContent = res.won ? 'Stage complete!' : 'Round over';
    el.resultsHeadline.textContent =
      (res.won ? 'The spire stands. ' : 'The spire fell — ' + terminalText(s.terminal.reason) + '. ') +
      'Height ' + Rules.height(s) + (s.cfg.goalHeight ? ' / ' + s.cfg.goalHeight : '') +
      (res.stars ? ' · ' + '★'.repeat(res.stars) : '');
    var rows = [
      ['Height (' + s.placed + ' slabs)', s.score.heightPoints],
      ['Perfect placements (' + s.perfects + ')', s.score.perfectPoints],
      ['Streak bonus (best ' + s.bestStreak + ')', s.score.streakPoints],
      ['Goal bonus', s.score.goalBonus],
      ['Under-par drops', s.score.dropBonus],
      ['Under-par time', s.score.timeBonus]
    ];
    var tbody = el.scoreTable.querySelector('tbody');
    tbody.innerHTML = '';
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      var th = document.createElement('th'); th.scope = 'row'; th.textContent = r[0];
      var td = document.createElement('td'); td.textContent = r[1];
      tr.appendChild(th); tr.appendChild(td); tbody.appendChild(tr);
    });
    el.scoreTotal.textContent = s.score.total;
    el.resultsAchievements.innerHTML = '';
    res.achievements.forEach(function (key) {
      var def = Content.ACHIEVEMENTS.find(function (a) { return a.key === key; });
      var li = document.createElement('li');
      li.textContent = def ? def.name : key;
      el.resultsAchievements.appendChild(li);
    });
    var next = nextJourneyLevel();
    el.btnNext.hidden = !(res.won && next);
    el.resultsProgress.textContent = 'Journey stars: ' + S.progress.stars + ' · best score ' + S.progress.bestScore;
    refreshTitleMeta();
    A.event(res.won ? 'win' : 'lose');
    announceAssertive(el.resultsHeadline.textContent + ' Total score ' + s.score.total);
    showScreen('results');
    P.activityEnd();

    if (S.isRanked() && P.hosted) {
      el.resultsBoard.textContent = 'Submitting for validation…';
      var submit = S.round.mode === 'daily'
        ? P.submitDaily(s.cfg.date, envelopePayload(res.replay))
        : P.submitScore(envelopePayload(res.replay));
      submit.then(function (r) {
        if (r && r.rank != null) {
          el.resultsBoard.textContent = 'Validated. Rank #' + r.rank + ' of ' + r.total + '.';
        } else if (r && r.error) {
          el.resultsBoard.textContent = 'Board unavailable (' + r.error + '). Score kept locally.';
        } else {
          el.resultsBoard.textContent = 'Submitted.';
        }
      });
    } else if (S.isRanked()) {
      el.resultsBoard.textContent = 'Offline — score kept locally; connect to a host to submit.';
    } else {
      el.resultsBoard.textContent = '';
    }
  }

  function envelopePayload(env) {
    return {
      cfgId: env.cfgId, date: env.date, seed: env.seed,
      contentVersion: env.contentVersion,
      commands: env.commands, result: env.result,
      assists: { undo: false, hint: !!S.round.cfg.mechanics.hint },
      durationSec: env.result.durationSec
    };
  }

  function terminalText(reason) {
    return { 'missed': 'a slab sailed past', 'move-limit': 'out of drops',
      'time-up': 'the clock ran out', 'resigned': 'you left the round' }[reason] || reason;
  }

  // ---------- input ----------
  var holdTimer = null;
  function doDrop() {
    if (!S.round || S.round.phase !== 'active') return;
    A.unlock();
    if (S.settings.holdToDrop) {
      if (holdTimer) return;
      holdTimer = setTimeout(function () {
        holdTimer = null;
        S.drop(); A.event('ack');
      }, 180);
      return;
    }
    S.drop();
    A.event('ack');
  }
  var hintFlashUntil = 0;
  function doHint() {
    var h = S.hint();
    if (h) {
      A.event('hint');
      hintFlashUntil = performance.now() + 1600;
      updateAssist();
      announce('Perfect window marked on the playfield.');
    }
  }

  // Perfect-window band visibility: the timing-assist setting shows it
  // continuously where the ruleset allows hints; a manual hint flashes it.
  function updateAssist() {
    var round = S.round;
    var show = !!(round && round.phase === 'active' && !round.state.terminal &&
      round.cfg.mechanics.hint &&
      (S.settings.timingAssist || performance.now() < hintFlashUntil));
    R.setHintVisible(show);
  }

  function pauseGame() {
    if (!S.round || S.round.phase !== 'active') return;
    S.pause();
    A.event('pause');
    showScreen('paused');
  }
  function resumeGame() {
    S.resume();
    showScreen(null);
    el.hud.hidden = false; el.tray.hidden = false;
    $('btn-drop').focus({ preventScroll: true });
  }

  function bindInput() {
    // Pointer: tap the playfield to drop (tap/drag distinguished by distance/time).
    var pf = document.getElementById('playfield');
    var downAt = 0, downX = 0, downY = 0;
    pf.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.tray, .hud, .screen, .toast, .caption')) return;
      downAt = performance.now(); downX = e.clientX; downY = e.clientY;
      try { pf.setPointerCapture(e.pointerId); } catch (err) {}
    });
    pf.addEventListener('pointerup', function (e) {
      if (e.target.closest('.tray, .hud, .screen, .toast, .caption')) return;
      var dt = performance.now() - downAt;
      var dist = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (dt < 500 && dist < 24) doDrop(); // tap, not a camera drag
    });
    pf.addEventListener('pointercancel', function () { downAt = 0; });

    document.addEventListener('keydown', function (e) {
      if (e.repeat) return;
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      var round = S.round;
      switch (e.key) {
        case ' ':
        case 'Enter':
          if (round && round.phase === 'active' && !currentScreen) { e.preventDefault(); doDrop(); }
          break;
        case 'p': case 'P':
          if (round && round.phase === 'active') pauseGame();
          else if (round && round.phase === 'paused') resumeGame();
          break;
        case 'Escape':
          if (round && round.phase === 'active') pauseGame();
          else if (round && round.phase === 'paused' && currentScreen === 'paused') resumeGame();
          else if (currentScreen === 'settings' || currentScreen === 'help' || currentScreen === 'board') back();
          break;
        case 'u': case 'U':
          if (round && round.phase === 'active') { if (S.undo()) A.event('undo'); }
          break;
        case 'h': case 'H':
          if (round && round.phase === 'active') doHint();
          break;
        case 'c': case 'C':
          // camera reset: snap framing to tower top
          if (round) { R.syncState(round.state, 0); announce('Camera refocused on the tower.'); }
          break;
      }
    });

    // Gamepad: poll in the main loop; A=drop, B=cancel, Start=pause, Y=hint, X=undo.
    var padPrev = {};
    setInterval(function () {
      if (!navigator.getGamepads) return;
      var pads = navigator.getGamepads();
      for (var i = 0; i < pads.length; i++) {
        var gp = pads[i];
        if (!gp) continue;
        var prev = padPrev[i] || {};
        function pressed(b) { return gp.buttons[b] && gp.buttons[b].pressed && !prev[b]; }
        var round = S.round;
        if (round && round.phase === 'active') {
          if (pressed(0)) doDrop();
          if (pressed(3)) doHint();
          if (pressed(2)) { if (S.undo()) A.event('undo'); }
          if (pressed(9)) pauseGame();
        } else if (round && round.phase === 'paused' && pressed(9)) resumeGame();
        var snap = {};
        gp.buttons.forEach(function (b, j) { snap[j] = b.pressed; });
        padPrev[i] = snap;
      }
    }, 50);
  }

  // ---------- help ----------
  function openHelp() {
    el.helpCards.innerHTML = '';
    var cards = [
      ['Drop', 'The slab slides side to side. Tap the playfield, click, press Space, Enter, or gamepad A to drop it.'],
      ['Trim', 'Any overhang is shaved off — the tower keeps only the overlap, and the next slab travels the other axis.'],
      ['Perfect', 'Drop dead center (within the glowing margin) to keep full width, earn bonus points, and grow a streak.'],
      ['Hints & undo', 'Where allowed, press H to mark the perfect window and U to take back a drop. Ranked modes disable both.'],
      ['Limits', 'Some stages limit drops or time. Misses spend drops too. The clock only runs while you play.'],
      ['Keyboard', 'Space/Enter drop · P pause · U undo · H hint · C camera · Esc back. Full game is keyboard-operable.']
    ];
    cards.forEach(function (c) {
      var div = document.createElement('div');
      div.className = 'card';
      var s = document.createElement('strong'); s.textContent = c[0];
      var p = document.createElement('span'); p.textContent = c[1];
      div.appendChild(s); div.appendChild(p);
      el.helpCards.appendChild(div);
    });
    showScreen('help');
  }

  // ---------- boards ----------
  function openBoard(title, promise, scoreOf) {
    el.boardH.textContent = title;
    el.boardBody.textContent = 'Loading…';
    showScreen('board');
    promise.then(function (r) {
      if (!r || r.error || !r.rows) {
        el.boardBody.textContent = 'Board unavailable (' + (r && r.error || 'offline') + ').';
        return;
      }
      if (!r.rows.length) { el.boardBody.textContent = 'No scores yet — be the first.'; return; }
      var ol = document.createElement('ol');
      r.rows.forEach(function (row) {
        var li = document.createElement('li');
        li.textContent = row.name || row.playerId || 'player';
        var b = document.createElement('strong'); b.textContent = ' ' + scoreOf(row);
        li.appendChild(b);
        ol.appendChild(li);
      });
      el.boardBody.textContent = '';
      el.boardBody.appendChild(ol);
    });
  }

  // ---------- settings ----------
  function bindSettings() {
    var form = document.getElementById('settings-form');
    Array.prototype.forEach.call(form.elements, function (input) {
      if (!input.name) return;
      var v = S.settings[input.name];
      if (input.type === 'checkbox') input.checked = !!v;
      else input.value = v;
      input.addEventListener('change', function () {
        var val = input.type === 'checkbox' ? input.checked
          : input.type === 'range' ? Number(input.value) : input.value;
        S.settings[input.name] = val;
        S.saveSettings();
        applySettingsToDom();
      });
    });
  }

  function applySettingsToDom() {
    var st = S.settings;
    document.documentElement.classList.toggle('reduced-motion', st.reducedMotion);
    document.documentElement.classList.toggle('high-contrast', st.highContrast);
    document.documentElement.classList.toggle('large-text', st.largeText);
    document.documentElement.classList.toggle('left-handed', st.leftHanded);
    A.setVolume('music', st.volMusic / 100);
    A.setVolume('effects', st.volEffects / 100);
    A.setVolume('ambience', st.volAmbience / 100);
    A.setVolume('voice', st.volVoice / 100);
    A.setCaptions(st.captions);
    R.setReducedMotion(st.reducedMotion);
    R.setHintVisible(false);
    if (st.quality !== 'auto') R.setQuality(st.quality);
  }

  var api = {
    init: init,
    showScreen: showScreen,
    back: back,
    toast: toast,
    announce: announce,
    pauseGame: pauseGame,
    resumeGame: resumeGame,
    showHud: showHud,
    updateHud: updateHud,
    refreshTitleMeta: refreshTitleMeta,
    openBoard: openBoard,
    applySettingsToDom: applySettingsToDom,
    openHelp: openHelp,
    updateAssist: updateAssist,
    get currentScreen() { return currentScreen; }
  };
  return api;
})(typeof self !== 'undefined' ? self : this);
