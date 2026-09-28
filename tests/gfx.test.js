/* Balance Spire — graphics quality model + Graphics panel strings.
 * Run: node --test tests/gfx.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const G = require('../js/gfx.js');

test('detectPreset maps GPU strings to presets', () => {
  assert.strictEqual(G.detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.strictEqual(G.detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.strictEqual(G.detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.strictEqual(G.detectPreset('Apple M2'), 'high');
  assert.strictEqual(G.detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'balanced');
  assert.strictEqual(G.detectPreset('Adreno (TM) 650'), 'balanced');
  assert.strictEqual(G.detectPreset(''), 'balanced');
  // Touch/mobile devices cap Auto at balanced.
  assert.strictEqual(G.detectPreset('Apple M2', { mobile: true }), 'balanced');
  assert.strictEqual(G.detectPreset('SwiftShader', { mobile: true }), 'low');
});

test('resolve: auto uses the detected preset, explicit preset wins', () => {
  const a = G.resolve({}, 'low');
  assert.strictEqual(a.preset, 'low');
  assert.strictEqual(a.auto, true);
  assert.strictEqual(a.post, false, 'Low renders without a post chain');
  assert.strictEqual(a.shadows, 'off');
  const h = G.resolve({ preset: 'high' }, 'low');
  assert.strictEqual(h.preset, 'high');
  assert.strictEqual(h.auto, false);
  assert.strictEqual(h.shadows, G.presetTier('high', 'shadows'));
  assert.strictEqual(h.post, true);
  assert.strictEqual(G.resolve({ preset: 'bogus' }, 'nonsense').preset, 'balanced');
});

test('resolve: overrides apply per category; invalid tiers fall back to the preset', () => {
  const r = G.resolve({ preset: 'low', bloom: 'on', shadows: 'huge', particles: 'high' }, 'high');
  assert.strictEqual(r.bloom, 'on');
  assert.strictEqual(r.shadows, 'off');
  assert.strictEqual(r.particles, 'high');
  assert.strictEqual(r.post, true, 'bloom override turns the post chain on');
});

test('resolve: render scale clamps to 50–200% and multiplies the preset scale', () => {
  assert.strictEqual(G.resolve({ preset: 'high', render_scale: 5 }).renderScale, 2);
  assert.strictEqual(G.resolve({ preset: 'high', render_scale: 0.1 }).renderScale, 0.5);
  assert.strictEqual(G.resolve({ preset: 'ultra', render_scale: 1.2 }).scale, 1.25 * 1.2);
  const d = G.resolve({});
  assert.strictEqual(d.adaptive, true);
  assert.strictEqual(d.showFps, false);
  assert.strictEqual(G.resolve({ adaptive: false, show_fps: true }).adaptive, false);
});

test('choosePreset clears overrides but keeps scale/adaptive/fps', () => {
  const next = G.choosePreset({ preset: 'low', bloom: 'on', ao: 'high', render_scale: 1.5, adaptive: false, show_fps: true }, 'ultra');
  assert.deepStrictEqual(next, { preset: 'ultra', render_scale: 1.5, adaptive: false, show_fps: true });
  assert.deepStrictEqual(G.choosePreset({ preset: 'high', shadows: 'off' }, undefined), {});
});

test('describe summarises cost', () => {
  const s = G.describe(G.resolve({ preset: 'high' }), [1280, 800]);
  assert.match(s, /2048² shadows/);
  assert.match(s, /1280×800 px/);
  assert.match(G.describe(G.resolve({ preset: 'low' })), /no shadows/);
});

test('Graphics panel strings exist for every locale and category', () => {
  const panel = require('../js/graphics-panel.js').BSGraphicsPanel;
  const locales = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
  for (const loc of locales) {
    const T = panel.STRINGS[loc];
    assert.ok(T, loc);
    for (const k of ['graphics', 'quality', 'auto', 'renderScale', 'fromPreset', 'adaptive', 'showFps', 'postFailed']) {
      assert.ok(T[k], `${loc}.${k}`);
    }
    for (const p of G.PRESETS) assert.ok(T.presets[p], `${loc} preset ${p}`);
    for (const [cat, tiers] of Object.entries(G.CATEGORIES)) {
      assert.ok(T.cats[cat], `${loc} category ${cat}`);
      for (const t of tiers) assert.ok(T.tiers[t], `${loc} tier ${t}`);
    }
    assert.ok(T.describe && T.describe.noShadows, `${loc} describe`);
  }
});
