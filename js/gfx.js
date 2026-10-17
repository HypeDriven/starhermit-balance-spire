/* Balance Spire — graphics quality model (pure; no three.js).
 * Presets, per-category overrides, GPU detection and a cost summary, so the
 * Graphics settings panel and the renderer agree on what a setting means.
 * UMD: window.BSGfx / Node (tests/gfx.test.js).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BSGfx = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PRESETS = ['low', 'balanced', 'high', 'ultra'];

  // Category → allowed tiers, cheapest first. Only effects this game has.
  var CATEGORIES = {
    shadows: ['off', 'low', 'medium', 'high'],   // key-light shadow map
    ao: ['off', 'on', 'high'],                   // GTAO contact darkening between slabs
    bloom: ['off', 'on'],                        // glow on the moving slab, perfect slabs, rim
    grade: ['off', 'on'],                        // colour grade + vignette
    antialias: ['fxaa', 'smaa', 'msaa'],         // canvas MSAA is always on without post
    particles: ['off', 'low', 'high'],           // stars, trim debris, drifting motes
    reflections: ['off', 'on'],                  // image-based lighting (RoomEnvironment)
    detail: ['plain', 'detailed'],               // gradient sky, bevelled glossy slabs, lit skyline
    background: ['static', 'animated']           // drifting sky bands, twinkling stars, slab pulse
  };

  // Each preset: a row of tiers, a render scale and a device-pixel-ratio cap.
  var TABLE = {
    low: { scale: 1, dprCap: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'msaa',
      particles: 'off', reflections: 'off', detail: 'plain', background: 'static' },
    balanced: { scale: 1, dprCap: 1.5, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa',
      particles: 'low', reflections: 'on', detail: 'detailed', background: 'animated' },
    high: { scale: 1, dprCap: 2, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa',
      particles: 'high', reflections: 'on', detail: 'detailed', background: 'animated' },
    ultra: { scale: 1.25, dprCap: 2, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa',
      particles: 'high', reflections: 'on', detail: 'detailed', background: 'animated' }
  };

  var SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };

  // StarHermit hardware level (0–20, gpu-level.js) at which Auto starts choosing each preset.
  var LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };

  // Per-preset asset and effect budgets, each tuned to hold 60 FPS on the weakest GPU Auto gives the
  // preset (Low: level 0 phones / Intel UHD; Balanced: level 4 Iris Xe; High: level 10 GTX 1070;
  // Ultra: level 17 RTX 4080). Gameplay is identical on every preset.
  //   stone     — slab material: 'lambert' (per-vertex light), 'standard' (PBR) or 'physical' (clearcoat)
  //   bevel     — rounded-slab bevel segments with Surface detail on (0 = plain boxes)
  //   skyline   — instanced skyline buildings (lit windows with detail on)
  //   stars     — star points (Particles: high; low uses 40 %), scaled by the hardware level
  //   motes     — rising motes around the tower top (Particles: high)
  //   debris    — pooled falling trim pieces
  //   bloomRes  — bloom pass resolution as a fraction of the canvas
  var BUDGETS = {
    low: { stone: 'lambert', bevel: 0, skyline: 16, stars: 250, motes: 0, debris: 4, bloomRes: 0.5 },
    balanced: { stone: 'standard', bevel: 2, skyline: 40, stars: 400, motes: 30, debris: 8, bloomRes: 0.5 },
    high: { stone: 'physical', bevel: 2, skyline: 56, stars: 600, motes: 70, debris: 12, bloomRes: 0.75 },
    ultra: { stone: 'physical', bevel: 4, skyline: 96, stars: 1200, motes: 140, debris: 16, bloomRes: 1 }
  };

  function gpuApi() {
    if (typeof StarHermitGpu !== 'undefined') return StarHermitGpu;
    if (typeof require === 'function') { try { return require('../gpu-level.js'); } catch (e) { /* not bundled */ } }
    return null;
  }

  /** Hardware level 0–20 for a renderer string (system: optional detectSystem() fields, e.g. mobile). */
  function detectLevel(gpu, system) {
    var G = gpuApi();
    if (!G) return 0;
    return G.detectLevel(Object.assign({ webgl: true, webgl2: true }, system || {}, { gpu: String(gpu || '') }));
  }

  /** Auto preset for a hardware level: Low 0, Balanced 4, High 10, Ultra 17. */
  function presetForLevel(level) {
    var G = gpuApi();
    if (G) return G.presetForLevel(level, LEVELS);
    return PRESETS.filter(function (p) { return LEVELS[p] <= level; }).pop() || 'low';
  }

  /** Best preset for this GPU (hardware level → preset). */
  function detectPreset(gpu, system) {
    return presetForLevel(detectLevel(gpu, system));
  }

  /** The preset's budget, with star and mote counts scaled by the level within the preset. */
  function budget(preset, level) {
    var b = BUDGETS[preset] || BUDGETS.balanced;
    var G = gpuApi(), floor = LEVELS[preset] || 0;
    var lv = level == null || !isFinite(level) ? floor : level;
    var sc = function (n) { return Math.round(G ? G.scaleBudget(n, lv, floor) : n); };
    return Object.assign({}, b, { stars: sc(b.stars), motes: sc(b.motes) });
  }

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  /**
   * Resolve saved settings into concrete tiers.
   * saved: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }
   */
  function resolve(saved, detected, level) {
    var s = saved || {};
    var isPreset = PRESETS.indexOf(s.preset) >= 0;
    var preset = isPreset ? s.preset : (PRESETS.indexOf(detected) >= 0 ? detected : 'balanced');
    var row = TABLE[preset];
    var out = {
      preset: preset,
      auto: !isPreset,
      renderScale: clamp(Number(s.render_scale) || 1, 0.5, 2),
      dprCap: row.dprCap
    };
    out.scale = row.scale * out.renderScale;
    Object.keys(CATEGORIES).forEach(function (cat) {
      out[cat] = CATEGORIES[cat].indexOf(s[cat]) >= 0 ? s[cat] : row[cat];
    });
    out.budget = budget(preset, level);
    out.adaptive = s.adaptive !== false;
    out.showFps = !!s.show_fps;
    // Post-processing runs only when something needs it; otherwise canvas MSAA is used.
    out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' ||
      out.antialias === 'fxaa' || out.antialias === 'smaa';
    return out;
  }

  /** The preset's own tier for a category (for "From preset (…)" labels). */
  function presetTier(preset, cat) {
    return TABLE[preset] ? TABLE[preset][cat] : undefined;
  }

  /** Choosing a preset clears every override but keeps scale/adaptive/fps. */
  function choosePreset(saved, preset) {
    var s = saved || {};
    var out = {};
    if (PRESETS.indexOf(preset) >= 0) out.preset = preset;
    ['render_scale', 'adaptive', 'show_fps'].forEach(function (k) { if (k in s) out[k] = s[k]; });
    return out;
  }

  // Cost-summary phrases; the Graphics panel passes localized ones.
  var DESCRIBE_EN = {
    noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion',
    aoFull: 'full ambient occlusion', bloom: 'bloom', reflections: 'reflections',
    particles: '{tier} particles', tiers: { low: 'low', high: 'high' }
  };

  function describe(r, pixels, labels) {
    var L = labels || DESCRIBE_EN;
    var parts = [
      r.shadows === 'off' ? L.noShadows : L.shadows.replace('{n}', SHADOW_MAP[r.shadows]),
      r.ao === 'off' ? null : r.ao === 'high' ? L.aoFull : L.ao,
      r.bloom === 'on' ? L.bloom : null,
      r.reflections === 'on' ? L.reflections : null,
      r.particles === 'off' ? null : L.particles.replace('{tier}', (L.tiers && L.tiers[r.particles]) || r.particles),
      r.antialias.toUpperCase(),
      pixels ? pixels[0] + '×' + pixels[1] + ' px' : null
    ];
    return parts.filter(Boolean).join(' · ');
  }

  return {
    PRESETS: PRESETS, CATEGORIES: CATEGORIES, SHADOW_MAP: SHADOW_MAP,
    LEVELS: LEVELS, BUDGETS: BUDGETS, detectLevel: detectLevel, presetForLevel: presetForLevel, budget: budget,
    detectPreset: detectPreset, resolve: resolve, presetTier: presetTier,
    choosePreset: choosePreset, describe: describe
  };
});
