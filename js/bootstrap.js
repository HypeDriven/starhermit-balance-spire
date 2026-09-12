/* Balance Spire — bootstrap: capability detection, module wiring,
 * lifecycle (visibility, resize, orientation, DPR), the fixed-step
 * simulation pump, and anonymous funnel telemetry (consent-gated).
 * Load order: after all plain scripts; render.js is an ES module that
 * dispatches 'bs-render-ready' when window.BSRender is available.
 */
(function () {
  'use strict';

  function funnel(name, data) {
    if (!BSSession.settings.analytics) return;
    // Anonymous, aggregate-only funnel events: start, tutorial step,
    // round end, retry, settings change, error category. Never raw text.
    try {
      if (navigator.sendBeacon && BSPlatform.hosted) {
        navigator.sendBeacon('/api/v1/funnel', JSON.stringify({
          e: name, d: data || {}, t: Date.now()
        }));
      }
    } catch (e) { /* telemetry must never break play */ }
  }

  function webglAvailable() {
    try {
      var c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext &&
        (c.getContext('webgl2') || c.getContext('webgl')));
    } catch (e) { return false; }
  }

  function autoQuality() {
    // Mechanism-backed default: coarse pointer or low memory → medium/low.
    var coarse = matchMedia('(pointer: coarse)').matches;
    var mem = navigator.deviceMemory || 4;
    var tier = 'high';
    if (coarse || mem <= 4) tier = 'medium';
    if (mem <= 2) tier = 'low';
    return tier;
  }

  function start(renderReady) {
    BSPlatform.init();

    var render = null;
    if (renderReady && webglAvailable()) {
      render = window.BSRender;
      if (!render.init(document.getElementById('gl-host'))) render = null;
    }
    if (!render) {
      document.getElementById('gl-fallback').hidden = false;
      document.getElementById('live-assertive').textContent =
        '3D graphics are unavailable in this browser.';
    } else {
      var tier = BSSession.settings.quality === 'auto' ? autoQuality() : BSSession.settings.quality;
      render.setQuality(tier);
    }

    BSUI.init({
      session: BSSession, render: render || stubRender(), audio: BSAudio,
      platform: BSPlatform, content: BSContent, rules: BSRules
    });
    if (render) BSUI.applySettingsToDom();

    BSPlatform.syncTime().then(function (hosted) {
      var net = document.getElementById('title-net');
      if (!hosted) {
        net.textContent = 'Offline mode — daily and boards will sync when hosted.';
        return;
      }
      net.textContent = 'Connected — daily and boards are live.';
      // With a launch token the signed-in player's nickname is shown here.
      BSPlatform.displayName().then(function (name) {
        if (name) net.textContent = 'Connected as ' + name + ' — daily and boards are live.';
      });
    });

    // Resume an interrupted round (last safe local snapshot).
    var resumed = BSSession.loadSnapshot();
    if (resumed) {
      BSUI.toast('Round restored — paused. Press P or Resume to continue.');
      BSSession.pause();
      BSUI.showScreen('paused');
      BSUI.showHud(resumed);
    }

    // ---------- main loop: fixed simulation pump + render ----------
    var lastT = performance.now(), alpha = 0;
    var fpsAccum = 0, fpsN = 0, lowFpsSince = 0;
    function loop(now) {
      requestAnimationFrame(loop);
      var dt = Math.min(0.1, (now - lastT) / 1000);
      lastT = now;
      BSSession.update(); // countdown + time-limit watchdog
      var round = BSSession.round;
      if (round && round.state) {
        var tickFloat = round.phase === 'active'
          ? BSSession.tickNow() - round.state.tick : 0;
        // Uncapped: the slab keeps sweeping until the next command lands.
        alpha = Math.max(0, tickFloat);
        if (render) render.syncState(round.state, alpha);
        BSUI.updateAssist();
        if (round.phase === 'active' && round.state.cfg.timeLimitSec) {
          BSUI.updateHud(round.state);
        }
      }
      if (render) {
        render.frame(document.hidden ? 0 : dt);
        // Adaptive render scale: sustained < 45 fps drops one tier before
        // ever touching the simulation rate.
        if (!document.hidden && BSSession.settings.quality === 'auto') {
          fpsAccum += dt; fpsN++;
          if (fpsAccum >= 2) {
            var fps = fpsN / fpsAccum;
            fpsAccum = 0; fpsN = 0;
            if (fps < 45 && !lowFpsSince) lowFpsSince = now;
            if (lowFpsSince && now - lowFpsSince > 4000) {
              var cur = render.stats ? autoQuality() : 'medium';
              render.setQuality(cur === 'high' ? 'medium' : 'low');
              lowFpsSince = 0;
            }
          }
        }
      }
    }
    requestAnimationFrame(loop);

    // ---------- lifecycle ----------
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        BSAudio.duck(true);
        if (BSSession.round && BSSession.round.phase === 'active') {
          BSSession.pause(); // backgrounding pauses solo simulation
          BSUI.showScreen('paused');
        }
        BSSession.saveSnapshot();
      } else {
        BSAudio.duck(false);
      }
    });
    window.addEventListener('resize', function () { if (render) render.applySize(); });
    window.addEventListener('orientationchange', function () {
      setTimeout(function () { if (render) render.applySize(); }, 60);
    });
    window.addEventListener('pagehide', function () { BSSession.saveSnapshot(); });

    window.addEventListener('bs-gl-lost', function () {
      document.getElementById('gl-fallback').hidden = false;
      BSSession.saveSnapshot();
    });
    window.addEventListener('bs-gl-restored', function () {
      document.getElementById('gl-fallback').hidden = true;
    });

    // Funnel hooks (consent-gated inside funnel()).
    BSSession.on('phase', function (p) { if (p === 'active') funnel('round-start'); });
    BSSession.on('results', function () { funnel('round-end'); });
    BSSession.on('lesson-done', function (l) { funnel('tutorial-step', { id: l.id }); });
    BSSession.on('settings', function () { funnel('settings-change'); });
    window.addEventListener('error', function () { funnel('error', { kind: 'js' }); });

    document.getElementById('app').dataset.screen = 'title';
  }

  // No-3D stub so UI stays fully operable (progress preserved).
  function stubRender() {
    return {
      setTheme: function () {}, setQuality: function () {}, setReducedMotion: function () {},
      syncState: function () {}, playEvents: function () {}, setHintVisible: function () {},
      frame: function () {}, applySize: function () {}, setVisible: function () {},
      stats: function () { return null; }, dispose: function () {}
    };
  }

  // Wait for the render module (type=module executes after plain scripts).
  var waited = 0;
  function boot() {
    if (window.BSRender) { start(true); return; }
    if (waited++ > 100) { start(false); return; } // module failed → fallback
    setTimeout(boot, 50);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
