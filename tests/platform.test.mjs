/* StarHermit adapter tests: loads starhermit-sdk.js + js/platform.js in a
 * sandbox with a stubbed fetch and launch fragment. Run: node --test */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLUG = 'balance-spire';
const USER = 'a1b2c3d4-0000-4000-8000-000000000001';

const b64url = s => Buffer.from(s).toString('base64url');
const jwt = claims => b64url('{"alg":"none"}') + '.' + b64url(JSON.stringify(claims)) + '.sig';
const plain = v => JSON.parse(JSON.stringify(v));

function boot({ hash = '' } = {}) {
  const calls = [];
  const cloud = { bytes: null };
  const kv = { volMusic: 10 };
  const store = new Map();
  const ctx = {
    URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, Blob, Response, console, AbortController,
    setTimeout: (fn, ms) => (ms > 5000 ? 0 : setTimeout(fn, ms)),
    clearTimeout: id => { if (id) clearTimeout(id); },
    setInterval: () => 0, clearInterval: () => {},
    addEventListener() {},
    document: { hidden: false, addEventListener() {} },
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    location: { hash, search: '', pathname: '/', hostname: 'localhost', origin: 'http://localhost', href: 'http://localhost/' + hash },
    history: { state: null, replaceState(_s, _t, url) { ctx.location.hash = url.includes('#') ? url.slice(url.indexOf('#')) : ''; } },
  };
  ctx.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers && init.headers.Authorization });
    const u = decodeURIComponent(url);
    if (u.endsWith('/api/v1/users/' + USER + '/profile')) return Response.json({ nickname: 'Stacker' });
    if (u.endsWith('/cloud-saves/game:' + SLUG)) {
      if (method === 'PUT') { cloud.bytes = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return new Response(null, { status: 204 }); }
      return cloud.bytes ? new Response(cloud.bytes) : new Response('', { status: 404 });
    }
    if (u.endsWith('/games/' + SLUG + '/settings')) {
      if (method === 'PATCH') Object.assign(kv, JSON.parse(init.body).settings);
      return Response.json({ settings: kv });
    }
    if (u === '/api/v1/time') return Response.json({ serverTime: Date.now() + 60000 });
    if (u.endsWith('/games/' + SLUG + '/controls')) return Response.json({ actions: [{ action: 'hint', codes: ['KeyJ'] }] });
    return new Response('', { status: 404 });
  };
  ctx.self = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['starhermit-sdk.js', 'js/platform.js'])
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  ctx.BSPlatform.init();
  return { ctx, calls, cloud, kv, P: ctx.BSPlatform, SH: ctx.StarHermit };
}

test('standalone: no token, no StarHermit requests', async () => {
  const { P, calls } = boot();
  assert.equal(P.tokenHosted, false);
  assert.equal(await P.displayName(), null);
  assert.equal(await P.profileFor('p-anon-123456789'), 'Player p-anon-1');
  assert.equal(await P.loadCloud(), null);
  P.saveCloud({ v: 1, progress: {} });
  await P.flushCloud();
  assert.deepEqual(plain(await P.getSettings()), {});
  await P.mirrorSettings({ volMusic: 1 });
  assert.deepEqual(plain(await P.loadBindings({ hint: ['KeyH'] })), { hint: ['KeyH'] });
  assert.equal(P.inviteLink(), null);
  assert.equal(P.canSignIn(), false);
  assert.match(P.playerId, /^p-/);
  assert.equal(await P.syncTime(), false, 'no server time standalone');
  assert.equal(P.hosted, false);
  const env = (total) => ({ result: { score: { total }, drops: 5 }, durationSec: 30 });
  assert.deepEqual(plain(await P.submitScore(env(300))), { rank: 1, total: 1 });
  assert.deepEqual(plain(await P.submitScore(env(500))), { rank: 1, total: 2 });
  assert.deepEqual(plain((await P.scoreBoard()).rows.map(r => r.score)), [500, 300]);
  await P.submitDaily('2026-10-04', env(200));
  assert.deepEqual(plain(await P.submitDaily('2026-10-04', env(100))), { rank: 1, total: 1 }, 'one best row per player');
  assert.equal((await P.dailyBoard('2026-10-04')).rows[0].score, 200);
  assert.equal(calls.length, 0);
});

test('launch token: identity, cloud save game:<slug>, settings, bindings', async () => {
  const token = jwt({ sub: USER, game_scope: SLUG, exp: Math.floor(Date.now() / 1000) + 3600 });
  const { P, ctx, calls, cloud, kv } = boot({ hash: '#game_token=' + token + '&session_id=s1' });
  assert.equal(P.tokenHosted, true);
  assert.equal(P.gameSlug, SLUG);
  assert.equal(P.userId, USER);
  assert.equal(P.playerId, USER);
  assert.equal(ctx.location.hash, '', 'launch fragment stripped');
  assert.equal(await P.displayName(), 'Stacker');
  assert.equal(await P.profileFor(USER), 'Stacker');

  assert.deepEqual(plain(await P.getSettings()), { volMusic: 10 });
  await P.mirrorSettings({ volMusic: 10, captions: false });
  const patch = calls.find(c => c.method === 'PATCH');
  assert.ok(patch.url.endsWith('/api/v1/games/' + SLUG + '/settings'));
  assert.deepEqual(patch.body, { settings: { captions: false } });
  assert.equal(kv.captions, false);

  assert.equal(await P.loadCloud(), null);
  const doc = { v: 1, progress: { bestScore: 77, achievements: {} } };
  P.saveCloud(doc);
  assert.equal(await P.flushCloud(), true);
  const put = calls.find(c => c.method === 'PUT');
  assert.equal(decodeURIComponent(put.url), '/api/v1/me/cloud-saves/game:' + SLUG);
  assert.deepEqual(plain(await P.loadCloud()), doc);
  assert.ok(calls.every(c => c.auth === 'Bearer ' + token));
  assert.ok(!calls.some(c => /\/api\/v1\/me(\/|$)/.test(c.url) && !c.url.includes('cloud-saves')), 'never /api/v1/me');

  assert.deepEqual(plain(await P.loadBindings({ hint: ['KeyH'], undo: ['KeyU'] })), { hint: ['KeyJ'], undo: ['KeyU'] });
  assert.match(P.inviteLink(), new RegExp('/game-invite/' + USER + '/' + SLUG + '$'));

  assert.equal(await P.syncTime(), true, 'signed in: GET /api/v1/time');
  assert.ok(P.now() - Date.now() > 50000);
  assert.ok(calls.every(c => !/\/api\/v1\/(daily|score|achievements|activity|presence|funnel)/.test(c.url)));
});

test('sign-out on refused renewal returns to anonymous play', async () => {
  const token = jwt({ sub: USER, game_scope: SLUG, exp: Math.floor(Date.now() / 1000) + 3600 });
  const { P, SH } = boot({ hash: '#game_token=' + token });
  const seen = [];
  P.onAuth(a => seen.push(a.signedIn));
  SH.signOut('expired');
  assert.deepEqual(seen, [false]);
  assert.equal(P.tokenHosted, false);
  assert.match(P.playerId, /^p-/);
  assert.equal(P.inviteLink(), null);
});

test('account strings exist in every required locale', async () => {
  const ctx = { navigator: { languages: ['en-US'] } };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/graphics-panel.js'), 'utf8'), ctx);
  const A = ctx.BSGraphicsPanel.ACCOUNT;
  const keys = Object.keys(A['en-US']);
  for (const loc of ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'])
    for (const k of keys) assert.ok(A[loc] && A[loc][k], loc + '.' + k);
});
