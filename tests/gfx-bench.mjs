// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts Practice (Calm) from the visible menus and keeps stacking with the Drop button at the perfect
// window, so the moving slab, trims, debris, stars and the growing spire are all on screen.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForSelector('#screen-title:not([hidden])', { timeout: 15000 });
  await page.click('#btn-settings');
  await page.waitForSelector('#screen-settings:not([hidden])');
  await page.selectOption('#gfx-preset', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.locator('#screen-settings [data-back]').click();
  await page.waitForSelector('#screen-title:not([hidden])');
}

export async function start(page, { mobile }) {
  const tap = (sel) => (mobile ? page.tap(sel) : page.click(sel));
  await tap('#btn-play');
  await page.waitForSelector('#screen-modes:not([hidden])');
  await page.locator('#mode-cards .card[data-mode="practice"]').click();
  await page.waitForSelector('#screen-setup:not([hidden])');
  await page.locator('#setup-list button').first().click();
  await page.waitForFunction(() => window.BSSession.round && window.BSSession.round.phase === 'active', null, { timeout: 15000 });
  let stopped = false;
  page.once('close', () => { stopped = true; });
  (async () => {
    while (!stopped) {
      try {
        const wait = await page.evaluate(() => {
          const S = window.BSSession, R = window.BSRules;
          if (!S.round || S.round.phase !== 'active' || S.round.state.terminal) return null;
          const s = S.round.state, w = R.perfectWindow(s.cfg, s.pending, s.slabs.length, s.tick + 1);
          return w ? Math.max(0, w.startTick - S.tickNow()) : 0;
        });
        if (wait !== null) {
          if (wait > 1) await new Promise((r) => setTimeout(r, Math.min(1500, ((wait - 1) / 60) * 1000)));
          await tap('#btn-drop');
        }
      } catch { /* closing */ }
      await new Promise((r) => setTimeout(r, 300));
    }
  })();
  await page.waitForTimeout(500);
}
