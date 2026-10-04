/* Balance Spire — bootstrap: capability detection, module wiring,
 * lifecycle (visibility, resize, orientation, DPR), the fixed-step
 * simulation pump.
 * Load order: after all plain scripts; render.js is an ES module that
 * dispatches 'bs-render-ready' when window.BSRender is available.
 */
(function () {
  'use strict';

  function webglAvailable() {
    try {
      var c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext &&
        (c.getContext('webgl2') || c.getContext('webgl')));
    } catch (e) { return false; }
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
      // Graphics preset/overrides (js/gfx.js); Auto picks a preset from the GPU.
      render.setGraphics(BSSession.settings.graphics || {});
    }

    BSUI.init({
      session: BSSession, render: render || stubRender(), audio: BSAudio,
      platform: BSPlatform, content: BSContent, rules: BSRules
    });
    if (render) BSUI.applySettingsToDom();

    // ---------- StarHermit: cloud save, settings KV, bindings, auth ----------
    var cloudReady = false, settingsReady = false;
    BSSession.on('progress', function (p) { if (cloudReady) BSPlatform.saveCloud({ v: 1, progress: p }); });
    BSSession.on('settings', function (st) { if (settingsReady) BSPlatform.mirrorSettings(st); });
    BSPlatform.onAuth(function (a) {
      BSUI.refreshAccount();
      if (!a.signedIn) {
        cloudReady = settingsReady = false;
        var T = window.BSGraphicsPanel && window.BSGraphicsPanel.accountStrings();
        if (T) document.getElementById('title-net').textContent = T.signedOut;
      }
    });
    if (BSPlatform.tokenHosted) {
      Promise.all([
        BSPlatform.loadCloud(), BSPlatform.getSettings(), BSPlatform.loadBindings(BSUI.DEFAULT_BINDINGS)
      ]).then(function (r) {
        // Remote progress wins over the local copy; localStorage stays the cache.
        var doc = r[0];
        if (doc && doc.progress && BSSession.adoptProgress(doc.progress)) BSUI.refreshTitleMeta();
        cloudReady = true;
        if (!doc) BSPlatform.saveCloud({ v: 1, progress: BSSession.progress });
        // Platform settings win over local defaults.
        var ps = r[1] || {};
        settingsReady = true;
        var st = BSSession.settings;
        Object.keys(BSSession.DEFAULT_SETTINGS).forEach(function (k) { if (k in ps) st[k] = ps[k]; });
        BSSession.saveSettings(); // also seeds the KV with local-only keys
        BSUI.syncSettingsForm();
        BSUI.applySettingsToDom();
        BSUI.setBindings(r[2]);
      });
    }
    window.addEventListener('pagehide', function () { BSPlatform.flushCloud(); });

    // Signed in: server time + nickname. Standalone: local clock, no request.
    BSPlatform.syncTime().then(function () {
      var net = document.getElementById('title-net');
      net.textContent = 'Local play — boards are kept on this device.';
      var T = window.BSGraphicsPanel && window.BSGraphicsPanel.accountStrings();
      if (T) BSPlatform.displayName().then(function (name) {
        if (name && BSPlatform.tokenHosted) net.textContent = T.playingAs.replace('{name}', name) + ' · ' + T.synced;
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
        // Adaptive resolution lives in the renderer (see js/render.js adapt()).
        render.frame(document.hidden ? 0 : dt);
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
        BSPlatform.flushCloud();
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

    document.getElementById('app').dataset.screen = 'title';
  }

  // No-3D stub so UI stays fully operable (progress preserved).
  function stubRender() {
    return {
      setTheme: function () {}, setQuality: function () {}, setGraphics: function () {},
      graphicsInfo: function () { return null; }, setReducedMotion: function () {},
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
