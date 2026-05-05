import { test, expect } from '@playwright/test';

test.describe('Movements ledger', () => {
  test('movements page renders header + table or empty state', async ({ page }) => {
    await page.goto('/dashboard/movements');
    await expect(page.getByRole('heading', { name: /stock movements/i })).toBeVisible();

    const empty = page.getByRole('heading', { name: /no movements yet/i });
    const byColumn = page.getByRole('columnheader', { name: /^by$/i });
    await expect(empty.or(byColumn)).toBeVisible();
  });

  test('movements table shows the actor column when rows exist', async ({ page }) => {
    await page.goto('/dashboard/movements');
    const byColumn = page.getByRole('columnheader', { name: /^by$/i });
    if (!(await byColumn.isVisible().catch(() => false))) {
      test.skip(true, 'No movements yet — actor column test requires seeded data.');
    }
    // Header order: When, Item, Type, Δ, After, By, Note
    const headers = await page.getByRole('columnheader').allTextContents();
    expect(headers.map((h) => h.trim().toLowerCase())).toEqual([
      'when',
      'item',
      'type',
      'δ',
      'after',
      'by',
      'note',
    ]);
  });
});
