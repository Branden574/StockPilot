import { expect, test, type Locator, type Page } from '@playwright/test';

import { chooseLook, glassBuild, settleIntroNotice, waitForLook, type Look } from './look';

/**
 * THE ITEM AND BOOK PAGE'S GLASS COMPOSITION, MEASURED (fidelity lane "detail";
 * Item-Detail.dc.html and Book-Detail.dc.html at 1440 x 1000, plan 8.1, and a
 * 390 px phone). The unit tests pin the markup and the stylesheet's values;
 * this run checks what only a browser with the compiled CSS can show:
 *
 *   - Classic: the figure strip and the Reorder card are on screen and no
 *     glass-only part is (display: none), so nothing glass draws reaches it;
 *   - Liquid Glass at 1440: the summary card sits left of the side column
 *     (300 to 360 px wide, tops level), the panels under the summary, the
 *     strip and the Classic Reorder card hidden; the head shows Edit, Adjust
 *     stock and Transfer at the right of the title with More last, the others
 *     hidden until More is pressed and shown in the same row after it, in
 *     their DOM order; Duplicate's dialog opened from there keeps More open
 *     and returns focus to its trigger on Escape;
 *   - Liquid Glass at 390: one column (summary, side column, panels: the
 *     side column precedes the panels in the DOM, a recorded deviation from
 *     the boards, which put it last; stage3/fidelity-rows.md, lane detail), the
 *     head's actions and More inside the page with no sideways scroll;
 *   - the summary photo is fetched only in glass (it is lazy and not drawn in
 *     Classic).
 *
 * Needs a running server and a signed-in lab user (storageState from
 * auth.setup.ts) who may edit, adjust and transfer, in an organisation with
 * items and books: the integrator's lab run (stage 5). In a build without
 * Liquid Glass (`off`) each test skips.
 */

const GLASS: Look = { design: 'liquid-glass', theme: 'light' };
const CLASSIC: Look = { design: 'classic', theme: 'light' };

async function openFirstRecord(page: Page, list: string): Promise<boolean> {
  await page.goto(list);
  const link = page.getByRole('table').locator('tbody tr a[href^="/dashboard/"]').first();
  if (!(await link.isVisible().catch(() => false))) return false;
  await link.click();
  await expect(page.locator('[data-glass-page="item-detail"]')).toBeVisible();
  return true;
}

async function setLook(page: Page, look: Look): Promise<void> {
  if (!(await glassBuild(page))) test.skip(true, 'This build does not offer Liquid Glass.');
  await settleIntroNotice(page);
  await chooseLook(page, look);
  await waitForLook(page, look);
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b, 'the element has a box').not.toBeNull();
  return b!;
}

const actions = (page: Page) => page.locator('[data-tour="item-actions"] > div > *');

/** The names of the head's actions that are on screen, in DOM order. */
async function shownActions(page: Page): Promise<string[]> {
  return actions(page).evaluateAll((els) =>
    els
      .filter((el) => getComputedStyle(el).display !== 'none')
      .map((el) => (el.textContent ?? '').trim()),
  );
}

test.describe('the item page at 1440 x 1000', () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test('Classic: the strip and the Reorder card show, no glass-only part does', async ({
    page,
  }) => {
    if (!(await openFirstRecord(page, '/dashboard/inventory'))) test.skip(true, 'No items.');
    await setLook(page, CLASSIC);
    await expect(page.getByTestId('item-figures')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Reorder' })).toBeVisible();
    for (const sel of [
      '[data-glass="item-summary"]',
      '[data-glass="item-aside"]',
      '[data-glass="item-more"]',
    ]) {
      await expect(page.locator(sel)).toBeHidden();
    }
    // Every classic action is on screen in Classic.
    const all = await actions(page).count();
    expect((await shownActions(page)).length).toBe(all);
  });

  test('Liquid Glass: summary beside the side column, panels under it, the head as drawn', async ({
    page,
  }) => {
    if (!(await openFirstRecord(page, '/dashboard/inventory'))) test.skip(true, 'No items.');
    await setLook(page, GLASS);
    const summary = page.locator('[data-glass="item-summary"]');
    const aside = page.locator('[data-glass="item-aside"]');
    await expect(summary).toBeVisible();
    await expect(aside).toBeVisible();
    await expect(page.getByTestId('item-figures')).toBeHidden();
    const s = await box(summary);
    const a = await box(aside);
    expect(a.x).toBeGreaterThan(s.x + s.width);
    expect(a.width).toBeGreaterThanOrEqual(299);
    expect(a.width).toBeLessThanOrEqual(361);
    expect(Math.abs(a.y - s.y)).toBeLessThanOrEqual(1);
    const details = page.getByRole('heading', { level: 2, name: 'Details' });
    expect((await box(details)).y).toBeGreaterThan(s.y + s.height);
    // The photo: 160 x 160, radius 20.
    const photo = summary.locator('[data-glass-part="photo"]');
    const p = await box(photo);
    expect(Math.round(p.width)).toBe(160);
    expect(Math.round(p.height)).toBe(160);

    // The head: the kept three at the right of the title, More last.
    const more = page.getByRole('button', { name: 'More actions' });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    const kept = await shownActions(page);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThanOrEqual(3);
    const h1 = await box(page.getByRole('heading', { level: 1 }));
    const firstKeptX = await actions(page).evaluateAll((els) => {
      const el = els.find((e) => getComputedStyle(e).display !== 'none');
      return el ? el.getBoundingClientRect().x : -1;
    });
    expect(firstKeptX).toBeGreaterThan(h1.x);
    const m = await box(more);
    expect(m.x).toBeGreaterThan(firstKeptX);
    expect(Math.round(m.height)).toBe(36);

    // Pressed: every action shows, in DOM order, More still last.
    const domOrder = await actions(page).evaluateAll((els) =>
      els.map((el) => (el.textContent ?? '').trim()),
    );
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(await shownActions(page)).toEqual(domOrder);
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(await shownActions(page)).toEqual(kept);
  });

  test('Liquid Glass: a dialog opened from a revealed action keeps More open and returns focus on Escape', async ({
    page,
  }) => {
    if (!(await openFirstRecord(page, '/dashboard/inventory'))) test.skip(true, 'No items.');
    await setLook(page, GLASS);
    const more = page.getByRole('button', { name: 'More actions' });
    await more.click();
    const label = page.locator('[data-tour="item-actions"]').getByRole('button', { name: 'Label' });
    await label.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(label).toBeFocused();
  });

  test('the summary photo is asked for in glass only', async ({ page }) => {
    if (!(await openFirstRecord(page, '/dashboard/inventory'))) test.skip(true, 'No items.');
    await setLook(page, CLASSIC);
    const img = page.locator('[data-glass="item-summary"] img');
    if ((await img.count()) === 0) test.skip(true, 'This record has no photo.');
    expect(await img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(0);
    await setLook(page, GLASS);
    await expect
      .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
  });
});

test.describe('the book page at 1440 x 1000', () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test('Liquid Glass: the cover (152 x 228) beside the book facts, the In Staging well', async ({
    page,
  }) => {
    if (!(await openFirstRecord(page, '/dashboard/books'))) test.skip(true, 'No books.');
    await setLook(page, GLASS);
    const summary = page.locator('[data-glass="item-summary"][data-glass-variant="book"]');
    await expect(summary).toBeVisible();
    const cover = await box(summary.locator('[data-glass-part="photo"]'));
    expect(Math.round(cover.width)).toBe(152);
    expect(Math.round(cover.height)).toBe(228);
    const facts = await box(summary.locator('[data-glass-part="facts"]'));
    expect(facts.x).toBeGreaterThan(cover.x + cover.width);
    await expect(summary.getByText('In Staging', { exact: true })).toBeVisible();
    await expect(summary.getByText('ISBN', { exact: true })).toBeVisible();
  });
});

test.describe('the item page on a 390 px phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('Liquid Glass: one column, and the head stays inside the page', async ({ page }) => {
    if (!(await openFirstRecord(page, '/dashboard/inventory'))) test.skip(true, 'No items.');
    await setLook(page, GLASS);
    const s = await box(page.locator('[data-glass="item-summary"]'));
    const a = await box(page.locator('[data-glass="item-aside"]'));
    expect(a.y).toBeGreaterThan(s.y + s.height);
    expect(Math.abs(a.x - s.x)).toBeLessThanOrEqual(1);
    // The column follows the DOM: the panels (Details first) after the side column.
    const details = await box(page.getByRole('heading', { level: 2, name: 'Details' }));
    expect(details.y).toBeGreaterThan(a.y + a.height);
    const more = await box(page.getByRole('button', { name: 'More actions' }));
    expect(more.x + more.width).toBeLessThanOrEqual(390);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
