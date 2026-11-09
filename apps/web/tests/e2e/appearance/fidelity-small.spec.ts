import { expect, test, type Page } from '@playwright/test';

import { chooseLook, glassBuild, settleIntroNotice, type Look } from './look';

/**
 * THE STAGE 3 FIDELITY CHECK'S FIVE SMALL FINDINGS, MEASURED ON THE LAB
 * (stockpilot-work/liquid-glass/stage3/app-fidelity.md; fixed on
 * lg/s3-fid-small, rows in stage3/fidelity-rows.md):
 *  1. Night glass: no missing-photo thumbnail is a white tile (Manage order
 *     items, the Overview's low-stock list);
 *  2. the phone bar (390 px): the page title, the round search, the
 *     warehouse picker as an icon, the account menu (What's New inside it),
 *     and nothing past the bar's edge; on a touch phone (375 and 390 px,
 *     every control 44 px) the title "Overview" reads whole;
 *  3. the Books cover view: about six 2:3 cover cards to a row at 1440;
 *  4. the Books table: the board's columns (classic's others one tick away
 *     in the Columns chooser), one-line rows, the header actions on the
 *     right;
 *  5. Settings > Appearance: the chosen option in the accent, Theme as a
 *     segmented control.
 *
 * Needs a running server and a signed-in lab user (storageState from
 * auth.setup.ts) whose organisation has items, books and orders: the
 * integrator's lab run. A build without Liquid Glass skips every test.
 */

const DAY: Look = { design: 'liquid-glass', theme: 'light' };
const NIGHT: Look = { design: 'liquid-glass', theme: 'dark' };
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function open(page: Page, url: string, look: Look): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await page.goto(url);
  if (!(await glassBuild(page))) test.skip(true, 'This build does not offer Liquid Glass.');
  await settleIntroNotice(page);
  await chooseLook(page, look);
}

/** Every Thumb frame's computed background on the page (rgb or rgba text). */
async function thumbBackgrounds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="thumb"]')].map(
      (el) => getComputedStyle(el).backgroundColor,
    ),
  );
}

const WHITE = /^rgba?\(255, 255, 255(, 1)?\)$/u;

test('1. Night glass: no Thumb is a white tile on Manage order items or the Overview', async ({
  page,
}) => {
  for (const url of ['/dashboard/orders/manage-items', '/dashboard']) {
    await open(page, url, NIGHT);
    await page.waitForLoadState('networkidle');
    const backgrounds = await thumbBackgrounds(page);
    if (backgrounds.length === 0) continue;
    expect(
      backgrounds.filter((b) => WHITE.test(b)),
      url,
    ).toEqual([]);
  }
});

test('2. The phone bar: title, round search, picker as an icon, and What’s New in the account menu', async ({
  page,
}) => {
  await open(page, '/dashboard/inventory', DAY);
  await page.setViewportSize(PHONE);
  const bar = page.locator('header[data-glass="topbar"]');
  const title = bar.locator('[data-glass="tb-title"]');
  await expect(title).toBeVisible();
  await expect(title).toHaveText(/\S/u);
  const search = bar.locator('[data-glass="tb-icon"][data-glass-variant="search"]');
  await expect(search).toBeVisible();
  await expect(search).toHaveAccessibleName('Open command palette');
  const picker = bar.getByRole('button', { name: /^Filter by / });
  if (await picker.count()) {
    await expect(picker).toBeVisible();
    const box = (await picker.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(44.5);
    const titleBox = (await title.boundingBox())!;
    expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(box.x);
  }
  // What's New is in the account menu at a phone width (round 2, finding 1),
  // not in the bar.
  await expect(bar.getByRole('button', { name: /^What’s new/u })).toBeHidden();
  await bar.getByRole('button', { name: /^Account menu/u }).click();
  await expect(page.getByRole('menuitem', { name: /^What’s new/u })).toBeVisible();
  await page.keyboard.press('Escape');
  const overflow = await bar.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // Every control in the bar ends inside the window.
  const outside = await bar.evaluate((el) =>
    [...el.querySelectorAll('a, button')]
      .filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && (r.right > window.innerWidth + 0.5 || r.left < -0.5);
      })
      .map((b) => b.getAttribute('aria-label') ?? b.textContent),
  );
  expect(outside).toEqual([]);
});

// Round 2, finding 1: on a touch phone every bar control is 44 px; the
// title must still read whole. /dashboard is "Overview" (about 72 px at
// 16 / 600). A touch context of its own (hasTouch, isMobile), so
// (pointer: coarse) holds.
test.describe('2b. The phone bar on a touch phone', () => {
  test.use({ hasTouch: true, isMobile: true });
  for (const width of [375, 390]) {
    test(`at ${width} px the page title "Overview" is not cut`, async ({ page }) => {
      // The look is chosen from the header menu, drawn from a 680 px bar.
      await open(page, '/dashboard', DAY);
      await page.setViewportSize({ width, height: 812 });
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
      const bar = page.locator('header[data-glass="topbar"]');
      const title = bar.locator('[data-glass="tb-title"]');
      await expect(title).toBeVisible();
      await expect(title).toHaveText('Overview');
      const fit = await title.evaluate((el) => ({
        scroll: el.scrollWidth,
        client: el.clientWidth,
      }));
      expect(fit.scroll).toBeLessThanOrEqual(fit.client);
      // Every bar control keeps its 44 px and ends inside the window.
      const small = await bar.evaluate((el) =>
        [...el.querySelectorAll('a, button')]
          .filter((b) => {
            const r = b.getBoundingClientRect();
            return r.width > 0 && (r.width < 43.5 || r.height < 43.5);
          })
          .map((b) => b.getAttribute('aria-label') ?? b.textContent),
      );
      expect(small).toEqual([]);
      const overflow = await bar.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      // What's New is one tap away in the account menu.
      await bar.getByRole('button', { name: /^Account menu/u }).tap();
      await expect(page.getByRole('menuitem', { name: /^What’s new/u })).toBeVisible();
      await page.keyboard.press('Escape');
    });
  }
});

test('3. Books cover view: 2:3 cover cards, about six to a row at 1440', async ({ page }) => {
  await open(page, '/dashboard/books', DAY);
  const grid = page
    .getByRole('button', { name: /^Grid/ })
    .or(page.getByRole('tab', { name: /^Grid/ }));
  if (
    !(await grid
      .first()
      .isVisible()
      .catch(() => false))
  )
    test.skip(true, 'No view toggle.');
  await grid.first().click();
  const cards = page.locator('[data-slot="inventory-grid"] [data-glass="grid-card"]');
  if ((await cards.count()) < 2) test.skip(true, 'Fewer than two books.');
  try {
    const measures = await cards.evaluateAll((els) =>
      els.slice(0, 12).map((el) => {
        const r = el.getBoundingClientRect();
        const media = el.querySelector('[data-slot="grid-card-media"]')!.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          top: Math.round(r.top),
          ratio: media.height / media.width,
          padding: cs.paddingTop,
          radius: cs.borderTopLeftRadius,
        };
      }),
    );
    const firstRow = measures.filter((m) => m.top === measures[0]!.top).length;
    if (measures.length >= 7) {
      expect(firstRow).toBeGreaterThanOrEqual(5);
      expect(firstRow).toBeLessThanOrEqual(7);
    }
    for (const m of measures) {
      expect(m.ratio).toBeCloseTo(1.5, 1);
      expect(m.padding).toBe('12px');
      expect(m.radius).toBe('18px');
    }
    // Round 2, finding 3: a card with a one- or two-digit grade reads
    // "Grade 9" (the fact's label, then the bare number), never "Gr 9".
    const grades = await cards.evaluateAll((els) =>
      els
        .map((el) => el.querySelector('[data-glass-fact="Grade"]'))
        .filter((f): f is Element => f !== null)
        .map((f) => (f as HTMLElement).innerText.replace(/\s+/gu, ' ').trim()),
    );
    for (const text of grades) expect(text).not.toMatch(/\bGr\b/u);
    for (const text of grades) expect(text).toMatch(/^Grade /u);
  } finally {
    // Leave the list as the next spec expects it: the Table view.
    await page
      .getByRole('button', { name: /^Table/ })
      .or(page.getByRole('tab', { name: /^Table/ }))
      .first()
      .click();
  }
});

test('4. Books table: the board’s columns, one-line rows, the actions beside the title', async ({
  page,
}) => {
  await open(page, '/dashboard/books', DAY);
  const table = page.locator('table[data-glass="items-table"]');
  if (!(await table.isVisible().catch(() => false))) test.skip(true, 'No Books table.');
  const shownHeaders = () =>
    table.evaluate((t) =>
      [...t.querySelectorAll('thead th')]
        .filter((th) => getComputedStyle(th).display !== 'none')
        .map((th) => th.textContent?.trim() ?? ''),
    );
  expect(await shownHeaders()).toEqual(['', 'Item', 'Grade', 'Rack', 'Crate', 'On hand', 'Status']);
  // One line a row: a record row is no taller than its 44 px cover and padding.
  const tall = await table.evaluate((t) =>
    [...t.querySelectorAll('tbody tr[data-row-kind="record"]')]
      .map((tr) => tr.getBoundingClientRect().height)
      .filter((h) => h > 64),
  );
  expect(tall).toEqual([]);
  // The chooser brings a column back in its classic place, and takes it away.
  await page.getByRole('button', { name: 'Choose more columns' }).click();
  await page.getByRole('checkbox', { name: 'Charter' }).click();
  await expect
    .poll(shownHeaders)
    .toEqual(['', 'Item', 'Charter', 'Grade', 'Rack', 'Crate', 'On hand', 'Status']);
  await page.getByRole('checkbox', { name: 'Charter' }).click();
  await page.keyboard.press('Escape');
  await expect.poll(shownHeaders).not.toContain('Charter');
  // The header actions sit to the right of the title.
  const header = page.locator('[data-glass-page="books"] [data-glass="page-header"]');
  const h1 = (await header.locator('h1').boundingBox())!;
  const actions = (await header.locator('[data-slot="page-header-actions"]').boundingBox())!;
  expect(actions.x).toBeGreaterThan(h1.x + h1.width);
});

test('5. Settings > Appearance: the chosen option in the accent, Theme as segments', async ({
  page,
}) => {
  await open(page, '/dashboard/settings/profile', DAY);
  const chosen = page.locator('[data-glass="appearance-choice"][data-glass-state="on"]');
  await expect(chosen).toHaveCount(1);
  const style = await chosen.evaluate((el) => {
    const cs = getComputedStyle(el);
    const dot = el.querySelector('[data-glass="radio-dot"]')!;
    return {
      border: cs.borderTopColor,
      ring: cs.boxShadow,
      dot: getComputedStyle(dot).backgroundColor,
    };
  });
  expect(style.border).toBe('rgb(11, 122, 92)');
  expect(style.ring).toContain('rgb(11, 122, 92)');
  expect(style.dot).toBe('rgb(11, 122, 92)');
  // Round 2, finding 2: an unchosen option takes the light field line
  // (rgba(255, 255, 255, 0.78) in Day), as the board's glass .choice does.
  const unchosen = page.locator('[data-glass="appearance-choice"]:not([data-glass-state="on"])');
  if (await unchosen.count()) {
    expect(await unchosen.first().evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(
      'rgba(255, 255, 255, 0.78)',
    );
  }
  const seg = page.locator('[data-glass="appearance-seg"]');
  expect(await seg.evaluate((el) => getComputedStyle(el).display)).toBe('inline-flex');
  const on = seg.locator('[data-glass-state="on"]');
  await expect(on).toHaveCount(1);
  expect(await on.evaluate((el) => getComputedStyle(el).fontWeight)).toBe('650');
});
