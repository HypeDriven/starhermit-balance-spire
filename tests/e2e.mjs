/**
 * Balance Spire — end-to-end playthrough test (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome against a self-contained
 * static server (the repo's server.js is the StarHermit authoritative host
 * script, so this test embeds its own minimal node:http server on an
 * ephemeral port). The game is fully playable offline: journey, practice,
 * settings, help all work without the platform backend; boards are local.
 * A standalone load must make zero same-origin /api or /ws requests.
 *
 * Flow (desktop 1280x800, then a fresh mobile 390x844 touch context):
 *   title → help open/close → mode select → journey stage 1 → countdown →
 *   perfect-timed drops through the real Drop button until the stage is won →
 *   results breakdown → progression persisted → next stage → pause →
 *   settings toggle → resume → resign → practice (hint + undo via UI) →
 *   leave. Mobile: title → journey stage 1 → pause/resume → full win →
 *   results, with tap targets size-checked.
 *
 * Game state (window.BSSession / window.BSRules) is read ONLY to time drops;
 * every action goes through buttons/keys a player sees.
 *
 * Run: npm run test:e2e
 */
import { chromium, firefox } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.opus': 'audio/ogg', '.ico': 'image/x-icon', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2', '.ts': 'text/typescript', '.txt': 'text/plain',
};

const ownServerHits = [];
const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    // Plain static host: standalone play must never call own-server routes.
    if (p.startsWith('/api') || p.startsWith('/ws')) {
      ownServerHits.push(p);
      res.writeHead(404); res.end();
      return;
    }
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const SHOT = (stage, pass) => `/tmp/balance-spire-e2e-${stage}-${pass}.png`;
const TPS = 60; // rules ticks per second

// E2E_BROWSER=firefox runs the same flow in Playwright's Firefox (software
// WebGL via llvmpipe) on hosts where headless Chrome cannot create a context.
const USE_FIREFOX = process.env.E2E_BROWSER === 'firefox';
const browser = USE_FIREFOX
  ? await firefox.launch({ firefoxUserPrefs: { 'webgl.force-enabled': true, 'media.volume_scale': '0.0' } })
  : await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
  });

let failures = 0;

async function runPass(passName, contextOpts) {
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !browserNoise.test(m.text())) {
      errors.push(`console ${m.type()}: ${m.text()}`);
    }
  });

  const step = async (name, fn) => {
    await fn();
    console.log(`ok - [${passName}] ${name}`);
  };

  // Read the rules engine for the next perfect-drop window, wait for it,
  // then perform the drop through the visible UI control.
  const dropAtPerfect = async () => {
    const wait = await page.evaluate(() => {
      const S = window.BSSession, R = window.BSRules;
      if (!S.round || S.round.phase !== 'active' || S.round.state.terminal) return null;
      const s = S.round.state;
      const w = R.perfectWindow(s.cfg, s.pending, s.slabs.length, s.tick + 1);
      if (!w) return 0;
      return Math.max(0, w.startTick - S.tickNow());
    });
    if (wait === null) return false;
    if (wait > 1) await page.waitForTimeout(((wait - 1) / TPS) * 1000);
    if (contextOpts.hasTouch) await page.tap('#btn-drop');
    else await page.click('#btn-drop');
    return true;
  };

  const roundStatus = () => page.evaluate(() => {
    const S = window.BSSession;
    if (!S.round) return null;
    return {
      phase: S.round.phase,
      done: !!S.round.state.terminal,
      won: !!(S.round.state.terminal && S.round.state.terminal.won),
      height: window.BSRules.height(S.round.state),
    };
  });

  const playUntilEnd = async (maxDrops) => {
    for (let i = 0; i < maxDrops; i++) {
      const st = await roundStatus();
      if (!st || st.phase !== 'active' || st.done) return;
      await dropAtPerfect();
      await page.waitForTimeout(120);
    }
    throw new Error('round did not terminate within ' + maxDrops + ' drops');
  };

  const waitActive = () => page.waitForFunction(
    () => window.BSSession && window.BSSession.round && window.BSSession.round.phase === 'active',
    null, { timeout: 12000 });

  try {
    await step('load + title screen', async () => {
      await page.goto(BASE, { waitUntil: 'load' });
      await page.waitForSelector('#screen-title:not([hidden])', { timeout: 15000 });
      await page.waitForFunction(() => !!window.BSSession && !!window.BSRules);
      await page.screenshot({ path: SHOT('title', passName) });
    });

    await step('settings → Graphics: presets, override, persistence', async () => {
      const tap = (sel) => (contextOpts.hasTouch ? page.tap(sel) : page.click(sel));
      const gfxState = () => page.evaluate(() => ({
        body: document.body.dataset.gfxPreset,
        canvas: (document.querySelector('#gl-host canvas') || {}).dataset?.gfxPreset,
        summary: document.getElementById('gfx-summary').textContent,
        bloom: document.getElementById('gfx-bloom').value,
        preset: document.getElementById('gfx-preset').value,
      }));
      await tap('#btn-settings');
      await page.waitForSelector('#screen-settings:not([hidden])');
      const autoLabel = await page.locator('#gfx-preset option[value="auto"]').textContent();
      if (!/Auto \(detected: (Low|Balanced|High)\)/.test(autoLabel)) throw new Error('auto label: ' + autoLabel);
      await page.selectOption('#gfx-preset', 'low');
      let g = await gfxState();
      if (g.body !== 'low' || g.canvas !== 'low') throw new Error('Low not applied: ' + JSON.stringify(g));
      if (!/no shadows/.test(g.summary)) throw new Error('Low summary: ' + g.summary);
      await page.selectOption('#gfx-preset', 'ultra');
      await page.waitForTimeout(600); // render a few Ultra frames (console must stay clean)
      await page.selectOption('#gfx-preset', 'high');
      g = await gfxState();
      if (g.body !== 'high' || !/bloom/.test(g.summary)) throw new Error('High not applied: ' + JSON.stringify(g));
      await page.selectOption('#gfx-bloom', 'off');
      g = await gfxState();
      if (/· bloom/.test(g.summary)) throw new Error('bloom override not applied: ' + g.summary);
      // The Graphics section fits the viewport width (panel scrolls vertically).
      const vw = page.viewportSize().width;
      const box = await page.locator('#gfx-settings').boundingBox();
      if (!box || box.x < 0 || box.x + box.width > vw + 1) throw new Error('graphics panel overflows: ' + JSON.stringify(box));
      await page.screenshot({ path: SHOT('graphics', passName) });
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('#screen-title:not([hidden])', { timeout: 15000 });
      await tap('#btn-settings');
      await page.waitForSelector('#screen-settings:not([hidden])');
      g = await gfxState();
      if (g.preset !== 'high' || g.bloom !== 'off' || g.body !== 'high') throw new Error('graphics not persisted: ' + JSON.stringify(g));
      // Choosing a preset clears overrides; back to Auto keeps the rest of the run cheap.
      await page.selectOption('#gfx-preset', 'auto');
      g = await gfxState();
      if (g.bloom !== 'preset' || g.preset !== 'auto') throw new Error('preset did not clear overrides: ' + JSON.stringify(g));
      await page.locator('#screen-settings [data-back]').click();
      await page.waitForSelector('#screen-title:not([hidden])');
    });

    await step('help opens and closes', async () => {
      await page.click('#btn-help');
      await page.waitForSelector('#screen-help:not([hidden])');
      const cards = await page.locator('#help-cards .card').count();
      if (cards !== 6) throw new Error(`expected 6 help cards, got ${cards}`);
      await page.locator('#screen-help [data-back]').click();
      await page.waitForSelector('#screen-title:not([hidden])');
    });

    await step('mode select → journey setup', async () => {
      await page.click('#btn-play');
      await page.waitForSelector('#screen-modes:not([hidden])');
      await page.locator('#mode-cards .card[data-mode="journey"]').click();
      await page.waitForSelector('#screen-setup:not([hidden])');
      const items = await page.locator('#setup-list button').count();
      if (items < 1) throw new Error('journey setup list is empty');
      const locked = await page.locator('#setup-list button.locked').count();
      if (locked !== items - 1) throw new Error(`expected only stage 1 unlocked, ${items - locked} unlocked`);
      await page.screenshot({ path: SHOT('setup', passName) });
    });

    await step('start stage 1 → countdown → active', async () => {
      await page.locator('#setup-list button').first().click();
      await page.waitForFunction(() => window.BSSession.round && window.BSSession.round.phase === 'countdown');
      await page.screenshot({ path: SHOT('countdown', passName) });
      await waitActive();
      if (await page.locator('#hud').isHidden()) throw new Error('HUD not visible in play');
      if (await page.locator('#tray').isHidden()) throw new Error('tray not visible in play');
      if (contextOpts.hasTouch) {
        const box = await page.locator('#btn-drop').boundingBox();
        if (!box || box.width < 44 || box.height < 44) {
          throw new Error('drop target too small on mobile: ' + JSON.stringify(box));
        }
      }
    });

    if (contextOpts.hasTouch) {
      await step('pause + resume via tray buttons', async () => {
        await page.tap('#btn-pause');
        await page.waitForSelector('#screen-pause:not([hidden])');
        await page.screenshot({ path: SHOT('pause', passName) });
        await page.tap('#btn-resume');
        await waitActive();
      });
    }

    await step('play stage 1 to victory via Drop button', async () => {
      await dropAtPerfect();
      await page.waitForTimeout(250);
      await page.screenshot({ path: SHOT('play', passName) });
      await playUntilEnd(30);
      const st = await roundStatus();
      if (!st.done || !st.won) throw new Error('stage 1 did not end in a win: ' + JSON.stringify(st));
      if (st.height < 8) throw new Error('expected height >= 8, got ' + st.height);
    });

    await step('results screen with score breakdown', async () => {
      await page.waitForSelector('#screen-results:not([hidden])', { timeout: 8000 });
      const heading = await page.textContent('#results-h');
      if (!/Stage complete/.test(heading)) throw new Error('unexpected results heading: ' + heading);
      const rows = await page.locator('#score-table tbody tr').count();
      if (rows !== 6) throw new Error(`expected 6 breakdown rows, got ${rows}`);
      const total = await page.textContent('#score-total');
      if (!(Number(total) > 0)) throw new Error('score total not positive: ' + total);
      console.log(`  [${passName}] headline:`, (await page.textContent('#results-headline')).trim());
      await page.screenshot({ path: SHOT('results', passName) });
    });

    await step('progression persisted (stage 1 star)', async () => {
      const prog = await page.evaluate(() => {
        const raw = localStorage.getItem('bs.progress.v1');
        return raw ? JSON.parse(raw).data : null;
      });
      if (!prog || !(prog.journeyStars.j01 > 0)) {
        throw new Error('journey stage 1 star not persisted: ' + JSON.stringify(prog));
      }
    });

    if (!contextOpts.hasTouch) {
      await step('next stage → pause → settings → resume', async () => {
        if (await page.locator('#btn-next').isHidden()) throw new Error('next-stage button hidden after win');
        await page.click('#btn-next');
        await waitActive();
        await page.keyboard.press('p');
        await page.waitForSelector('#screen-pause:not([hidden])');
        // Escape on the pause screen resumes play.
        await page.keyboard.press('Escape');
        await waitActive();
        if (await page.locator('#screen-pause').isVisible()) throw new Error('Escape did not dismiss pause');
        await page.keyboard.press('p');
        await page.waitForSelector('#screen-pause:not([hidden])');
        await page.screenshot({ path: SHOT('pause', passName) });
        await page.click('#btn-pause-settings');
        await page.waitForSelector('#screen-settings:not([hidden])');
        await page.locator('input[name="reducedMotion"]').check();
        const applied = await page.evaluate(() => document.documentElement.classList.contains('reduced-motion'));
        if (!applied) throw new Error('reduced-motion setting not applied to DOM');
        await page.screenshot({ path: SHOT('settings', passName) });
        await page.locator('#screen-settings [data-back]').click();
        await page.waitForSelector('#screen-pause:not([hidden])');
        await page.click('#btn-resume');
        await waitActive();
      });

      await step('drop twice, then resign via leave', async () => {
        for (let i = 0; i < 2; i++) {
          await dropAtPerfect();
          await page.waitForTimeout(120);
        }
        const st = await roundStatus();
        if (st.height < 2) throw new Error('expected height >= 2 in stage 2, got ' + st.height);
        await page.keyboard.press('p');
        await page.waitForSelector('#screen-pause:not([hidden])');
        await page.click('#btn-leave');
        await page.waitForSelector('#screen-results:not([hidden])', { timeout: 8000 });
        const heading = await page.textContent('#results-h');
        if (!/Round over/.test(heading)) throw new Error('expected resigned results, got: ' + heading);
        await page.screenshot({ path: SHOT('resign', passName) });
      });

      await step('practice: hint + drop + undo through the UI', async () => {
        await page.click('#btn-results-modes');
        await page.waitForSelector('#screen-modes:not([hidden])');
        await page.locator('#mode-cards .card[data-mode="practice"]').click();
        await page.waitForSelector('#screen-setup:not([hidden])');
        await page.locator('#setup-list button').first().click(); // Practice — Calm
        await waitActive();
        if (await page.locator('#btn-hint').isDisabled()) throw new Error('hint disabled in practice');
        if (await page.locator('#btn-undo').isDisabled()) throw new Error('undo disabled in practice');
        await page.keyboard.press('h'); // marks the perfect window
        // Timing assist on: the perfect-window band stays visible during play.
        await page.evaluate(() => {
          window.BSSession.settings.timingAssist = true;
          window.BSSession.saveSettings();
          window.BSUI.applySettingsToDom();
          window.BSUI.updateAssist();
        });
        await page.waitForTimeout(150);
        await dropAtPerfect();
        await page.waitForTimeout(150);
        let st = await roundStatus();
        if (st.height !== 1) throw new Error('expected height 1 after drop, got ' + st.height);
        await page.click('#btn-undo');
        await page.waitForTimeout(150);
        st = await roundStatus();
        if (st.height !== 0) throw new Error('undo did not restore height 0, got ' + st.height);
        await page.screenshot({ path: SHOT('practice', passName) });
        await page.keyboard.press('p');
        await page.waitForSelector('#screen-pause:not([hidden])');
        await page.click('#btn-leave');
        await page.waitForSelector('#screen-results:not([hidden])', { timeout: 8000 });
      });
    }

    if (ownServerHits.length) errors.push('own-server requests while standalone: ' + ownServerHits.join(', '));
    const bad = errors.slice();
    if (bad.length) throw new Error(`page errors in ${passName} pass:\n` + bad.join('\n'));
    console.log(`ok - [${passName}] no page errors`);
  } finally {
    await context.close();
  }
}

try {
  await runPass('desktop', { viewport: { width: 1280, height: 800 } });
  await runPass('mobile', USE_FIREFOX
    ? { viewport: { width: 390, height: 844 }, hasTouch: true }
    : { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  console.log('\nE2E PASS — both viewport passes clean');
} catch (e) {
  failures++;
  console.error('\nE2E FAIL:', e.message || e);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
if (failures) process.exit(1);
