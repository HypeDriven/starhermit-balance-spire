/* Balance Spire — platform adapter over window.StarHermit (starhermit-sdk.js,
 * loaded first). Two surfaces:
 *  - StarHermit (via the SDK): launch token + renewal, sign-in, profile
 *    nicknames, cloud save (progress), settings KV, invite link, control
 *    bindings. All of these are no-ops without a token — no request is made.
 *  - Server time: GET /api/v1/time, only when signed in (launch token);
 *    standalone uses the local clock and makes no own-server request.
 *  - Boards (daily + score chase) are local to this device (localStorage
 *    bs.boards.v1); achievements live in the progress document.
 *
 * Identity: board rows carry the account id (JWT sub) when signed in so they
 * resolve to nicknames; otherwise the persistent anonymous bs.playerId.
 * No tokens in local storage; the launch token is kept in memory by the SDK.
 * UMD: window.BSPlatform / Node.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BSPlatform = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var SH = root.StarHermit || null;
  // Read the launch fragment as early as possible (before any other script).
  if (SH && !SH.__bsInit) { SH.init(); SH.__bsInit = true; }

  var gameSlug = null;
  var hosted = false;
  var timeOffsetMs = 0; // serverNow - clientNow, RTT-adjusted
  var anonPlayerId = null;
  var pushedSettings = null;

  function signedIn() { return !!(SH && SH.signedIn); }
  function userId() { return signedIn() ? SH.userId : null; }

  function init() {
    gameSlug = SH && SH.slug || null;
    try {
      var q = new URLSearchParams(window.location.search);
      if (!gameSlug) gameSlug = q.get('game') || null; // local-dev fallback only
    } catch (e) { /* no URL API — standalone */ }
    // Stable anonymous player id (not a credential; ok to persist). Used as
    // the server identity only when no launch token identifies the account.
    try {
      anonPlayerId = localStorage.getItem('bs.playerId');
      if (!anonPlayerId) {
        anonPlayerId = 'p-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem('bs.playerId', anonPlayerId);
      }
    } catch (e) { anonPlayerId = 'p-anon'; }
  }

  // The account id when signed in, the anonymous id offline.
  function playerId() { return userId() || anonPlayerId; }

  // Round-trip-adjusted sync with GET /api/v1/time — signed in only.
  function syncTime() {
    if (!signedIn() || !SH.token) { hosted = false; return Promise.resolve(false); }
    var t0 = Date.now();
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl && setTimeout(function () { ctrl.abort(); }, 8000);
    return fetch('/api/v1/time', { headers: { 'Authorization': 'Bearer ' + SH.token }, signal: ctrl && ctrl.signal })
      .then(function (r) { return r.json(); })
      .catch(function () { return null; })
      .then(function (r) {
        if (timer) clearTimeout(timer);
        var serverNow = r && (Number(r.serverTime) || Number(r.now));
        if (serverNow) {
          var rtt = Date.now() - t0;
          timeOffsetMs = serverNow - (t0 + rtt / 2);
          hosted = true;
        } else {
          hosted = false;
        }
        return hosted;
      });
  }

  function now() { return Date.now() + timeOffsetMs; }

  // ---------- identity (StarHermit profile; nickname, never /api/v1/me) ----------
  function profileFor(pid) {
    if (!pid || typeof pid !== 'string') return Promise.resolve('player');
    var fallback = 'Player ' + pid.slice(0, 8);
    if (!SH || !signedIn()) return Promise.resolve(fallback);
    return SH.profile(pid).then(function (p) { return p && p.nickname || fallback; }, function () { return fallback; });
  }
  // The signed-in player's display name, or null when anonymous.
  function displayName() {
    if (!signedIn()) return Promise.resolve(null);
    return SH.profile().then(function (p) { return p ? p.displayName : null; });
  }

  // ---------- StarHermit: cloud save, settings, sign-in, invite, controls ----------
  /** Remote save document ({ v, progress }) or null. */
  function loadCloud() { return signedIn() ? SH.loadJSON() : Promise.resolve(null); }
  /** Debounced cloud save of the progress document. */
  function saveCloud(doc) { if (signedIn()) SH.saveJSON(doc); }
  function flushCloud() { return signedIn() ? SH.flushSave(true) : Promise.resolve(false); }
  /** Platform settings ({} when none / signed out). */
  function getSettings() {
    if (!signedIn()) return Promise.resolve({});
    return SH.getSettings().then(function (s) { pushedSettings = JSON.parse(JSON.stringify(s || {})); return s || {}; });
  }
  /** Mirror changed keys of the settings object to the platform KV. */
  function mirrorSettings(settings) {
    if (!signedIn() || !settings) return Promise.resolve(null);
    var base = pushedSettings || {};
    var patch = {}, any = false;
    Object.keys(settings).forEach(function (k) {
      if (JSON.stringify(settings[k]) !== JSON.stringify(base[k])) { patch[k] = settings[k]; any = true; }
    });
    pushedSettings = JSON.parse(JSON.stringify(settings));
    return any ? SH.patchSettings(patch) : Promise.resolve(null);
  }
  function canSignIn() { return !!(SH && SH.canSignIn()); }
  function signIn() { return !!(SH && SH.signIn()); }
  function inviteLink() { return signedIn() ? SH.inviteLink() : null; }
  function loadBindings(defaults) {
    var copy = JSON.parse(JSON.stringify(defaults));
    if (!signedIn()) return Promise.resolve(copy);
    return SH.loadBindings(defaults).catch(function () { return copy; });
  }
  /** fn({ signedIn, reason }) on StarHermit sign-in state changes. */
  function onAuth(fn) { return SH ? SH.on('auth', fn) : function () {}; }

  // ---------- local boards (this device only) ----------
  var BOARD_KEY = 'bs.boards.v1', BOARD_MAX = 100;
  function readBoards() {
    try { var b = JSON.parse(localStorage.getItem(BOARD_KEY)); if (b && b.score && b.daily) return b; } catch (e) { /* fresh */ }
    return { score: [], daily: {} };
  }
  function writeBoards(b) { try { localStorage.setItem(BOARD_KEY, JSON.stringify(b)); } catch (e) { /* full / blocked */ } }
  function boardSort(a, b) {
    return b.score - a.score || (a.drops || 0) - (b.drops || 0) || (a.durationSec || 0) - (b.durationSec || 0) || a.at - b.at;
  }
  function record(rows, payload, onePerPlayer) {
    var r = payload.result || {};
    var row = { playerId: playerId(), score: Number(r.score && r.score.total != null ? r.score.total : r.score) || 0,
      drops: r.drops || 0, durationSec: payload.durationSec || 0, at: Date.now() };
    if (onePerPlayer) {
      var i = rows.findIndex(function (x) { return x.playerId === row.playerId; });
      if (i >= 0) { if (boardSort(row, rows[i]) < 0) rows[i] = row; else row = rows[i]; }
      else rows.push(row);
    } else rows.push(row);
    rows.sort(boardSort);
    rows.length = Math.min(rows.length, BOARD_MAX);
    var rank = rows.indexOf(row) + 1;
    return { rank: rank > 0 ? rank : null, total: rows.length };
  }
  function submitDaily(date, payload) {
    var b = readBoards();
    var rows = b.daily[date] = b.daily[date] || [];
    var out = record(rows, payload, true);
    writeBoards(b);
    return Promise.resolve(out);
  }
  function dailyBoard(date) { return Promise.resolve({ rows: (readBoards().daily[date] || []).slice() }); }
  function submitScore(payload) {
    var b = readBoards();
    var out = record(b.score, payload, false);
    writeBoards(b);
    return Promise.resolve(out);
  }
  // Post a finished ranked round to the StarHermit leaderboards (score-script.js);
  // resolves { posted, rank } — rank on the high-score board, or null. Signed in only.
  function postLeaderboard(total) {
    if (!signedIn() || !SH.submitScores) return Promise.resolve({ posted: false, rank: null });
    return SH.submitScores({ 'high-score': total }).then(function (keys) {
      if ((keys || []).indexOf('high-score') < 0) return { posted: false, rank: null };
      return SH.leaderboard('high-score', { pageSize: 100 }).then(function (r) {
        var me = (r.items || []).filter(function (i) { return i.userId === SH.userId; })[0];
        return { posted: true, rank: me ? me.rank : null };
      }, function () { return { posted: true, rank: null }; });
    }, function () { return { posted: false, rank: null }; });
  }
  function scoreBoard() { return Promise.resolve({ rows: readBoards().score.slice() }); }

  return {
    init: init,
    syncTime: syncTime,
    now: now,
    profileFor: profileFor,
    displayName: displayName,
    submitDaily: submitDaily,
    dailyBoard: dailyBoard,
    submitScore: submitScore,
    scoreBoard: scoreBoard,
    postLeaderboard: postLeaderboard,
    loadCloud: loadCloud,
    saveCloud: saveCloud,
    flushCloud: flushCloud,
    getSettings: getSettings,
    mirrorSettings: mirrorSettings,
    canSignIn: canSignIn,
    signIn: signIn,
    inviteLink: inviteLink,
    loadBindings: loadBindings,
    onAuth: onAuth,
    get hosted() { return hosted; },
    get tokenHosted() { return signedIn(); },
    get playerId() { return playerId(); },
    get userId() { return userId(); },
    get gameSlug() { return SH && SH.slug || gameSlug; }
  };
});
