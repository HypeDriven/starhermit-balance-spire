/* Balance Spire — what the browser build (starhermit-sdk.js) left in the
 * player's account, as the engine client takes it over (pure: no storage).
 *  - The cloud save (slot game:<slug>): the SDK's zipped save.json holding
 *    { v: 1, progress }. The engine shows it as a foreign save; its text
 *    converts with progressFromBrowserSave and is merged into this device's
 *    progress (BSSession.mergeProgress), then replaces the slot once. The
 *    engine save keeps the same document: { v: 1, progress }.
 *  - The per-player settings keys (the SDK's patchSettings of bs.settings.v1):
 *    the game's own toggles carry over as game settings; volumes, graphics,
 *    reduced motion, contrast, text size and the language are the runtime's
 *    Options now and are dropped.
 * UMD: globalThis.BSMigrate (loadClassic) / Node (require).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BSMigrate = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Settings the game still owns (game.<key> in the runtime's settings). */
  var GAME_SETTING_KEYS = ['captions', 'leftHanded', 'holdToDrop', 'timingAssist', 'haptics'];
  /** Every key the browser build kept in the account's per-player settings. */
  var BROWSER_SETTING_KEYS = ['volMusic', 'volEffects', 'volAmbience', 'volVoice', 'captions', 'graphics',
    'reducedMotion', 'highContrast', 'largeText', 'leftHanded', 'holdToDrop', 'timingAssist', 'haptics',
    'tutorialDone', 'quality', 'ui.language'];

  function isProgress(p) {
    return !!(p && typeof p === 'object' && !Array.isArray(p) && p.achievements && typeof p.achievements === 'object');
  }

  /** The progress in a save document ({ v: 1, progress }), or null. */
  function progressFromSave(doc) {
    if (!doc || typeof doc !== 'object' || doc.v !== 1) return null;
    return isProgress(doc.progress) ? doc.progress : null;
  }

  /** The progress in the browser build's cloud save (its save.json text), or null. */
  function progressFromBrowserSave(text) {
    if (typeof text !== 'string') return null;
    var doc;
    try { doc = JSON.parse(text); } catch (e) { return null; }
    return progressFromSave(doc);
  }

  /** The save document for a progress object. */
  function saveDoc(progress) { return { v: 1, progress: progress }; }

  /** A browser-build setting's value as the engine client keeps it, or undefined (dropped). */
  function migrateSetting(key, value) {
    if (GAME_SETTING_KEYS.indexOf(key) < 0) return undefined;
    return typeof value === 'boolean' ? value : undefined;
  }

  return {
    GAME_SETTING_KEYS: GAME_SETTING_KEYS, BROWSER_SETTING_KEYS: BROWSER_SETTING_KEYS,
    progressFromSave: progressFromSave, progressFromBrowserSave: progressFromBrowserSave,
    saveDoc: saveDoc, migrateSetting: migrateSetting
  };
});
