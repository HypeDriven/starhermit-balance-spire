// progress.test.js — the progress merge (BSSession.mergeProgress, run on a
// cloud-save conflict and when the browser build's save is taken over) and
// js/migrate.js: the browser build's cloud save ({ v: 1, progress } as its
// save.json text) and per-player settings keys as the engine client takes them.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Migrate = require('../js/migrate.js');

const ROOT = path.join(__dirname, '..');
const plain = (o) => JSON.parse(JSON.stringify(o));
function session() {
  const store = new Map();
  const ctx = { console, performance, localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) } };
  ctx.self = ctx;
  vm.createContext(ctx);
  for (const f of ['js/rng.js', 'js/rules.js', 'js/content.js', 'js/session.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  return { S: ctx.BSSession, store };
}

test('mergeProgress keeps the better value of every record', () => {
  const { S } = session();
  const m = plain(S.mergeProgress(
    { stars: 4, journeyStars: { j01: 1, j02: 3 }, dailies: { '2026-10-01': 50 }, bestScore: 900, perfectsTotal: 10, achievements: { a: 5 }, tutorialDone: true },
    { stars: 3, journeyStars: { j01: 3 }, dailies: { '2026-10-01': 70, '2026-10-02': 10 }, bestScore: 400, perfectsTotal: 40, achievements: { a: 9, b: 1 } }));
  assert.deepEqual(m.journeyStars, { j01: 3, j02: 3 });
  assert.equal(m.stars, 6);
  assert.deepEqual(m.dailies, { '2026-10-01': 70, '2026-10-02': 10 });
  assert.equal(m.bestScore, 900);
  assert.equal(m.perfectsTotal, 40);
  assert.deepEqual(m.achievements, { a: 5, b: 1 });
  assert.equal(m.tutorialDone, true);
});

test('a browser-build cloud save converts; damaged or other documents do not', () => {
  const progress = { v: 1, stars: 5, journeyStars: { j01: 3, j02: 2 }, tutorialDone: true, dailies: {}, bestScore: 610, bestHeight: 9, perfectsTotal: 12, achievements: { 'first-place': 1 }, themeUnlocksSeen: [] };
  assert.deepEqual(Migrate.progressFromBrowserSave(JSON.stringify({ v: 1, progress })), progress);
  assert.equal(Migrate.progressFromBrowserSave(JSON.stringify({ v: 2, progress })), null);
  assert.equal(Migrate.progressFromBrowserSave(JSON.stringify({ v: 1, progress: { stars: 1 } })), null);
  assert.equal(Migrate.progressFromBrowserSave('{not json'), null);
  assert.equal(Migrate.progressFromBrowserSave(null), null);
  // The engine save keeps the same document.
  assert.deepEqual(Migrate.progressFromSave(Migrate.saveDoc(progress)), progress);
  assert.equal(Migrate.progressFromSave(null), null);
});

test('taking over the browser save merges it with the device progress', () => {
  const { S } = session();
  S.progress.journeyStars.j03 = 2; S.progress.stars = 2; S.progress.bestScore = 100;
  const old = Migrate.progressFromBrowserSave(JSON.stringify({ v: 1, progress: { journeyStars: { j01: 3 }, bestScore: 610, achievements: { 'first-perfect': 7 } } }));
  assert.ok(S.adoptProgress(S.mergeProgress(old, S.progress)));
  assert.deepEqual(plain(S.progress.journeyStars), { j01: 3, j03: 2 });
  assert.equal(S.progress.stars, 5);
  assert.equal(S.progress.bestScore, 610);
  assert.deepEqual(plain(S.progress.achievements), { 'first-perfect': 7 });
});

test('browser settings: the game\'s toggles carry over, the runtime-owned ones are dropped', () => {
  for (const k of Migrate.GAME_SETTING_KEYS) {
    assert.equal(Migrate.migrateSetting(k, true), true, k);
    assert.equal(Migrate.migrateSetting(k, false), false, k);
    assert.equal(Migrate.migrateSetting(k, 'yes'), undefined, k);
    assert.ok(Migrate.BROWSER_SETTING_KEYS.includes(k), k);
  }
  for (const k of ['volMusic', 'volEffects', 'volAmbience', 'volVoice', 'graphics', 'reducedMotion', 'highContrast', 'largeText', 'ui.language']) {
    assert.equal(Migrate.migrateSetting(k, true), undefined, k);
    assert.ok(Migrate.BROWSER_SETTING_KEYS.includes(k), k);
  }
  const { S } = session();
  for (const k of Object.keys(S.DEFAULT_SETTINGS)) assert.ok(Migrate.BROWSER_SETTING_KEYS.includes(k), k);
});

test('the session runs on an injected clock', () => {
  const { S } = session();
  let ms = 0;
  S.setClock(() => ms);
  S.startRound(require('../js/content.js').JOURNEY[0], { mode: 'journey' });
  S.startCountdown();
  ms = 2249; S.update();
  assert.equal(S.round.phase, 'countdown');
  ms = 2250; S.update();
  assert.equal(S.round.phase, 'active');
  ms += 1000;
  assert.equal(S.tickNow(), 60);
});
