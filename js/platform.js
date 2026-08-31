/* Balance Spire — platform adapter: host handshake, server time sync,
 * daily/score submission, achievements, presence, activity lifecycle.
 * Same-origin /api only. No tokens in local storage; the launch token is
 * read from the URL and kept in memory. Everything degrades gracefully to
 * offline local play when the host is absent.
 * UMD: window.BSPlatform / Node.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BSPlatform = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var launchToken = null, gameSlug = null;
  var hosted = false;
  var timeOffsetMs = 0; // serverNow - clientNow, RTT-adjusted
  var playerId = null;
  var heartbeatTimer = null, activityOpen = false;

  function init() {
    try {
      var q = new URLSearchParams(location.search);
      launchToken = q.get('launch_token') || q.get('token') || null;
      gameSlug = q.get('game') || null;
    } catch (e) { /* no URL API — standalone */ }
    // Stable anonymous player id (not a credential; ok to persist).
    try {
      playerId = localStorage.getItem('bs.playerId');
      if (!playerId) {
        playerId = 'p-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem('bs.playerId', playerId);
      }
    } catch (e) { playerId = 'p-anon'; }
  }

  function headers() {
    var h = { 'Content-Type': 'application/json', 'X-Player-Id': playerId };
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
    submitDaily: submitDaily,
    dailyBoard: dailyBoard,
    submitScore: submitScore,
    scoreBoard: scoreBoard,
    unlockAchievement: unlockAchievement,
    activityStart: activityStart,
    activityEnd: activityEnd,
    get hosted() { return hosted; },
    get playerId() { return playerId; },
    get gameSlug() { return gameSlug; }
  };
});
