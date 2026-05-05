import { test, expect } from '@playwright/test';

test.describe('Dashboard shell', () => {
  test('renders sidebar nav + topbar without errors', async ({ page }) => {
    await page.goto('/dashboard');

    // Sidebar items should be present.
    await expect(page.getByRole('link', { name: /overview/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /^items$/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /^books$/i })).toBeVisible();

    // Topbar — search button has an aria-label.
    await expect(page.getByRole('button', { name: /command palette/i })).toBeVisible();
  });

  test('command palette opens with ⌘K and accepts text', async ({ page }) => {
    await page.goto('/dashboard');

    // Cmd/Ctrl+K
    await page.keyboard.press('Meta+k').catch(() => page.keyboard.press('Control+k'));
    const input = page.getByPlaceholder(/search items, pos, suppliers/i);
    await expect(input).toBeVisible();
    await input.fill('overview');
    // Nav-only mode shows the static "Overview" entry.
    await expect(page.getByRole('option', { name: /overview/i })).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('skip-to-content link is the first focusable element', async ({ page }) => {
    await page.goto('/dashboard');
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement?.textContent ?? null);
    expect(focused).toMatch(/skip to main content/i);
  });
});
