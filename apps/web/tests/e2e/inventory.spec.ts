import { test, expect } from '@playwright/test';

test.describe('Inventory list + item flow', () => {
  test('inventory page loads and shows table or empty state', async ({ page }) => {
    await page.goto('/dashboard/inventory');
    await expect(
      page.getByRole('heading', { name: /^inventory$/i, level: 1 }),
    ).toBeVisible();

    // Either an EmptyState or a table renders. Both should resolve.
    const emptyHeading = page.getByRole('heading', { name: /no inventory yet/i });
    const headerSearch = page.getByPlaceholder(/search name, sku, barcode/i);
    await expect(emptyHeading.or(headerSearch)).toBeVisible();
  });

  test('search input updates URL with debounce', async ({ page }) => {
    await page.goto('/dashboard/inventory');
    const search = page.getByPlaceholder(/search name, sku, barcode/i);
    if (!(await search.isVisible().catch(() => false))) {
      test.skip(true, 'Empty inventory; skipping search test.');
    }
    await search.fill('widget');
    await page.waitForURL(/\?.*q=widget/, { timeout: 3000 });
    expect(page.url()).toContain('q=widget');
  });

  test('new item link navigates to /dashboard/inventory/new', async ({ page }) => {
    await page.goto('/dashboard/inventory');
    await page.getByRole('link', { name: /new item/i }).first().click();
    await expect(page).toHaveURL(/\/dashboard\/inventory\/new/);
  });
});
