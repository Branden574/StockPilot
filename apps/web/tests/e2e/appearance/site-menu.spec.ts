import { expect, test } from '@playwright/test';

import {
  arriveWith,
  buildRollout,
  chooseLook,
  cookieFor,
  MARKETING_PATHS,
  skipLandingIntro,
  waitForTwin,
  type Rollout,
  type Theme,
} from './site-look';

/**
 * The glass marketing nav's phone menu, open, at 390 px (SiteNav.dc.html:
 * `div.s-navbar > nav.s-nav + div#site-menu`, the panel in flow below the
 * bar; stage 3 review, finding 4). On every twin, in Day and Night:
 *  - the panel is below the bar, not inside it: the bar keeps its 56 px and
 *    the panel starts at least 8 px under its bottom edge;
 *  - the panel stays inside the viewport (no sideways scroll), and every row
 *    in it, Contact the team, Sign in and the invite-only line are visible
 *    and not clipped;
 *  - the panel frosts the page (its own backdrop filter, not inside the
 *    blurred nav);
 *  - Escape closes it and puts focus back on the button.
 * A screenshot per page and theme is attached.
 *
 * Needs a running server: the integrator's lab run. Unit half:
 * components/marketing/glass/site-menu.test.tsx.
 */

test.use({ storageState: { cookies: [], origins: [] } });

let rollout: Rollout;
test.beforeAll(async ({ request }) => {
  rollout = await buildRollout(request);
});

for (const theme of ['light', 'dark'] as Theme[]) {
  for (const path of MARKETING_PATHS) {
    test(`${path}, ${theme === 'light' ? 'Day' : 'Night'}, 390 px: the open phone menu sits below the bar, inside the viewport, frosted`, async ({
      page,
      baseURL,
    }, testInfo) => {
      test.skip(rollout === 'off', 'off: no twin is served');
      await page.setViewportSize({ width: 390, height: 844 });
      await arriveWith(page.context(), baseURL!, cookieFor(rollout, 'liquid-glass'));
      await skipLandingIntro(page);
      await page.goto(path);
      await waitForTwin(page, 'liquid-glass');
      await chooseLook(page, { design: 'liquid-glass', theme });

      const nav = page.getByRole('navigation', { name: 'Primary' });
      const before = (await nav.boundingBox())!;
      const button = page.getByRole('button', { name: 'Open menu' });
      await button.click();
      const menu = page.locator('#lgs-site-menu');
      await expect(menu).toBeVisible();

      const bar = (await nav.boundingBox())!;
      const box = (await menu.boundingBox())!;
      expect(bar.height, 'the bar keeps its height').toBeCloseTo(before.height, 0);
      expect(bar.height).toBeLessThanOrEqual(57);
      expect(box.y, 'the panel starts below the bar').toBeGreaterThanOrEqual(
        bar.y + bar.height + 7,
      );
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, 'inside the viewport').toBeLessThanOrEqual(390);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
        'no sideways scroll',
      ).toBeLessThanOrEqual(1);

      expect(await menu.evaluate((el) => el.closest('nav') === null)).toBe(true);
      const filter = await menu.evaluate((el) => {
        const style = getComputedStyle(el);
        return style.backdropFilter || style.getPropertyValue('-webkit-backdrop-filter');
      });
      expect(filter, 'the panel frosts the page').toMatch(/blur/u);

      for (const item of [
        ...(await menu.getByRole('link').all()),
        menu.getByText('StockPilot is invite-only', { exact: false }),
      ]) {
        await expect(item).toBeVisible();
        const r = (await item.boundingBox())!;
        expect(r.x).toBeGreaterThanOrEqual(box.x - 0.5);
        expect(r.x + r.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
      }
      await expect(menu.getByRole('link', { name: 'Contact the team' })).toBeVisible();
      await expect(menu.getByRole('link', { name: 'Sign in' })).toBeVisible();

      await testInfo.attach(`menu-${path.replace(/\//gu, '_') || 'root'}-${theme}-390.png`, {
        body: await page.screenshot({ fullPage: false }),
        contentType: 'image/png',
      });

      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await expect(page.getByRole('button', { name: 'Open menu' })).toBeFocused();
    });
  }
}
