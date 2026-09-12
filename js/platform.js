/* Balance Spire — platform adapter: host handshake, server time sync,
 * daily/score submission, achievements, presence, activity lifecycle,
 * launch-token lifecycle (fragment read + refresh) and profile nickname
 * resolution for board rows.
 *
 * The platform opens the game as index.html#game_token=<jwt> (optional
 * &session_id=), stripped from the URL after the read. The JWT carries
 * sub = user id and game_scope = this game's slug — never hard-coded.
 * Same-origin /api only: the game's own host script serves the daily/score
 * boards, achievements, activity and funnel routes below, so they work on
 * the platform and in local dev alike; the profile route is a platform
 * endpoint (GET /api/v1/users/{id}/profile) and degrades to a neutral
 * "Player <id8>" fallback off-platform. Every call degrades gracefully to
 * offline local play when the host is absent.
 *
 * Identity: when a launch token is present the account id (JWT sub) is sent
 * as X-Player-Id so board rows attach to the account and resolve to
 * nicknames; offline keeps the persistent anonymous bs.playerId.
 * No tokens in local storage; the launch token is kept in memory.
 * UMD: window.BSPlatform / Node.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BSPlatform = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var REFRESH_MS = 45 * 60 * 1000;  // token lives 60 min; re-mint at 45
  var RETRY_MS = 60 * 1000;         // failed refresh retry

  var launchToken = null, gameSlug = null, userId = null;
  var hosted = false;
  var timeOffsetMs = 0; // serverNow - clientNow, RTT-adjusted
  var anonPlayerId = null;
  var refreshTimer = null, retryTimer = null;
  var heartbeatTimer = null, activityOpen = false;
  var profileCache = {}; // userId -> Promise<string> display name

  function decodeJwt(t) {
    try {
      var seg = String(t).split('.')[1];
      if (!seg) return null;
      var b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
      b64 += '='.repeat((4 - (b64.length % 4)) % 4);
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) { return null; }
  }

  // Fragment first (the platform contract); query forms are local-dev only.
  function readLaunchToken() {
    try {
      var h = new URLSearchParams(String(window.location.hash || '').replace(/^#/, ''));
      var t = h.get('game_token');
      if (t) {
        h.delete('game_token');
        h.delete('session_id');
        var rest = h.toString();
        if (window.history && window.history.replaceState)
          window.history.replaceState(null, '',
            window.location.pathname + window.location.search + (rest ? '#' + rest : ''));
        return t;
      }
      var q = new URLSearchParams(window.location.search);
      return q.get('launch_token') || q.get('token') || null;
    } catch (e) { return null; }
  }

  function init() {
    launchToken = readLaunchToken();
    if (launchToken) {
      var claims = decodeJwt(launchToken);
      if (!claims) launchToken = null; // malformed: treat as standalone
      else {
        if (typeof claims.sub === 'string' && claims.sub) userId = claims.sub;
        if (typeof claims.game_scope === 'string' && claims.game_scope) gameSlug = claims.game_scope;
        if (!userId || !gameSlug) launchToken = null; // not a usable launch token
      }
    }
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
    if (launchToken) startRefresh();
  }

  // The account id when hosted, the anonymous id offline.
  function playerId() { return userId || anonPlayerId; }

  function headers() {
    var h = { 'Content-Type': 'application/json', 'X-Player-Id': playerId() };
    if (launchToken) h['Authorization'] = 'Bearer ' + launchToken;
    return h;
  }

  function req(path, opts, timeoutMs) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl && setTimeout(function () { ctrl.abort(); }, timeoutMs || 8000);
    return fetch(path, Object.assign({ headers: headers(), signal: ctrl && ctrl.signal }, opts))
      .then(function (r) {
        if (timer) clearTimeout(timer);
        if (r.status === 429) return { error: 'rate-limited' };
        return r.json().catch(function () { return { error: 'bad-response' }; });
      })
      .catch(function () { return { error: 'offline' }; });
  }

  // Round-trip-adjusted sync with GET /api/v1/time.
  function syncTime() {
    var t0 = Date.now();
    return req('/api/v1/time').then(function (r) {
      if (r && r.now) {
        var rtt = Date.now() - t0;
        timeOffsetMs = r.now - (t0 + rtt / 2);
        hosted = true;
      } else {
        hosted = false;
      }
      return hosted;
    });
  }

  function now() { return Date.now() + timeOffsetMs; }

  // ---------- token refresh (scoped tokens may re-mint) ----------
  function refreshToken() {
    if (!launchToken || !gameSlug) return;
    req('/api/v1/games/' + encodeURIComponent(gameSlug) + '/launch-token',
        { method: 'POST', body: '{}' }).then(function (r) {
      if (r && typeof r.token === 'string' && r.token) {
        launchToken = r.token;
        var claims = decodeJwt(launchToken);
        if (claims && claims.sub) userId = claims.sub;
        if (claims && claims.game_scope) gameSlug = claims.game_scope;
      } else {
        retryRefresh();
      }
    }).catch(retryRefresh);
  }
  function retryRefresh() {
    if (retryTimer || !launchToken) return;
    retryTimer = setTimeout(function () { retryTimer = null; refreshToken(); }, RETRY_MS);
  }
  function startRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(refreshToken, REFRESH_MS);
  }

  // ---------- identity ----------
  // Board/display names come from GET /api/v1/users/{id}/profile (nickname
  // only — never the raw username, never /api/v1/me). Off-platform the call
  // fails and the neutral "Player <id8>" fallback is used. Cached per id.
  function profileFor(pid) {
    if (!pid || typeof pid !== 'string') return Promise.resolve('player');
    if (profileCache[pid]) return profileCache[pid];
    var p = req('/api/v1/users/' + encodeURIComponent(pid) + '/profile')
      .then(function (r) {
        var name = (r && typeof r.nickname === 'string' && r.nickname) ? r.nickname : null;
        return name || ('Player ' + pid.slice(0, 8));
      })
      .catch(function () { return 'Player ' + pid.slice(0, 8); });
    profileCache[pid] = p;
    return p;
  }
  // The signed-in player's display name, or null when anonymous.
  function displayName() {
    if (!userId) return Promise.resolve(null);
    return profileFor(userId);
  }

  // ---------- game-server routes (own host script; local dev + platform) ----------
  function submitDaily(date, payload) {
    return req('/api/v1/daily/submit', { method: 'POST', body: JSON.stringify(payload) });
  }
  function dailyBoard(date) {
    return req('/api/v1/daily/board?date=' + encodeURIComponent(date));
  }
  function submitScore(payload) {
    return req('/api/v1/score/submit', { method: 'POST', body: JSON.stringify(payload) });
  }
  function scoreBoard() { return req('/api/v1/score/board'); }

  function unlockAchievement(key) {
    if (!hosted) return Promise.resolve({ error: 'offline' });
    return req('/api/v1/achievements/unlock', { method: 'POST', body: JSON.stringify({ key: key }) });
  }

  function activityStart() {
    if (!hosted || activityOpen) return;
    activityOpen = true;
    req('/api/v1/activity/start', { method: 'POST', body: '{}' });
    heartbeatTimer = setInterval(function () {
      req('/api/v1/presence/heartbeat', { method: 'POST', body: '{}' });
    }, 30000);
  }
  function activityEnd() {
    if (!hosted || !activityOpen) return;
    activityOpen = false;
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    req('/api/v1/activity/end', { method: 'POST', body: '{}' });
  }

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
    unlockAchievement: unlockAchievement,
    activityStart: activityStart,
    activityEnd: activityEnd,
    get hosted() { return hosted; },
    get tokenHosted() { return !!launchToken; },
    get playerId() { return playerId(); },
    get userId() { return userId; },
    get gameSlug() { return gameSlug; }
  };
});
