import { test, expect, type Page } from '@playwright/test';

/**
 * What's New: the permanent entry point, the drawer, the history routes and the
 * update notice.
 *
 * The update-notice test needs the app to KNOW its own build, which a plain
 * `pnpm dev` does not (the identity is baked in at build time from Vercel's
 * variables, and an unknown identity is deliberately silent). Run it with:
 *
 *   VERCEL_GIT_COMMIT_SHA=e2e-local VERCEL_ENV=production pnpm dev
 *   E2E_BUILD_IDENTITY=1 pnpm test:e2e whats-new
 */

/**
 * A first-visit tour offer outranks the notice by design, and it arrives a beat
 * after the page does, so an instant visibility check misses it. Wait for it,
 * decline it, and carry on if this account is never offered one.
 */
async function declineTourOffer(page: Page) {
  const decline = page.getByRole('button', { name: /no thanks/i });
  try {
    await decline.waitFor({ state: 'visible', timeout: 6_000 });
    await decline.click();
  } catch {
    /* no offer for this account */
  }
}

test.describe("What's New", () => {
  test('the topbar entry opens a drawer in place and hands focus back', async ({ page }) => {
    await page.goto('/dashboard/inventory');
    await declineTourOffer(page);
    const url = page.url();

    const entry = page.locator('#whats-new-entry');
    await expect(entry).toBeVisible();
    await entry.click();

    const drawer = page.getByRole('dialog', { name: /what’s new/i });
    await expect(drawer).toBeVisible();
    expect(page.url()).toBe(url);
    await expect(drawer.getByRole('link', { name: /view release history/i })).toBeVisible();
    expect(await drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true);

    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(entry).toBeFocused();
    expect(page.url()).toBe(url);
  });

  test('history lists releases and each one has a stable page', async ({ page }) => {
    await page.goto('/dashboard/whats-new');
    await expect(page.getByRole('heading', { level: 1, name: /what’s new/i })).toBeVisible();

    const first = page.locator('ol > li a').first();
    await expect(first).toBeVisible();
    await first.click();
    await expect(page).toHaveURL(/\/dashboard\/whats-new\/[a-z0-9-]+$/);
    await expect(page.getByText(/what changed/i).first()).toBeVisible();
    await expect(page.getByText(/what you need to do/i).first()).toBeVisible();
  });

  test('an unknown release is a plain not-found page', async ({ page }) => {
    await page.goto('/dashboard/whats-new/no-such-release');
    await expect(page.getByText(/page not found/i)).toBeVisible();
  });

  test.describe('a newer deployment', () => {
    test.skip(!process.env.E2E_BUILD_IDENTITY, 'needs a dev server started with a build identity');

    const NEWER_BUILD = {
      build: 'e2e-newer-build',
      builtAt: '2999-01-01T00:00:00.000Z',
      env: 'production',
      releasesKey: null,
    };

    // A real release id, so the drawer loads its details from the real server.
    // Only the LIST is pinned: whether anything is unread otherwise depends on
    // how old the test account is (a new account is never handed a backlog).
    const UNREAD = {
      id: 'inventory-and-orders-2026-09',
      revision: 1,
      status: 'published',
      title: 'Inventory and orders',
      summary: 'Pinned by the e2e spec.',
      publishedAt: '2026-09-18T00:00:00.000Z',
      entryCount: 1,
      state: { read: false, dismissed: false },
    };

    test('with something unread: one notice, two separate actions', async ({ page }) => {
      await page.route('**/api/version', (route) => route.fulfill({ json: NEWER_BUILD }));
      await page.route('**/api/v1/me/releases', (route) =>
        route.fulfill({
          json: { releases: [UNREAD], unreadCount: 1, latestUnread: UNREAD, stateAvailable: true },
        }),
      );
      await page.goto('/dashboard/inventory');
      await declineTourOffer(page);
      const url = page.url();

      const notice = page.locator('[data-update-notice]');
      await expect(notice).toHaveCount(1, { timeout: 45_000 });
      await expect(notice.getByRole('button', { name: /what’s new/i })).toBeVisible();
      await expect(notice.getByRole('button', { name: /refresh to update/i })).toBeVisible();
      // Nonmodal: it must not have taken focus.
      expect(await notice.evaluate((el) => el.contains(document.activeElement))).toBe(false);

      await notice.getByRole('button', { name: /what’s new/i }).click();
      await expect(page.getByRole('dialog', { name: /what’s new/i })).toBeVisible();
      expect(page.url()).toBe(url);
    });

    test('with nothing unread: refresh only, and no promise of news', async ({ page }) => {
      await page.route('**/api/version', (route) => route.fulfill({ json: NEWER_BUILD }));
      await page.route('**/api/v1/me/releases', (route) =>
        route.fulfill({
          json: { releases: [], unreadCount: 0, latestUnread: null, stateAvailable: true },
        }),
      );
      await page.goto('/dashboard/inventory');
      await declineTourOffer(page);

      const notice = page.locator('[data-update-notice]');
      await expect(notice).toHaveCount(1, { timeout: 45_000 });
      await expect(notice.getByRole('button', { name: /refresh to update/i })).toBeVisible();
      await expect(notice.getByRole('button', { name: /what’s new/i })).toHaveCount(0);
      await expect(notice.getByText(/refresh when convenient/i)).toBeVisible();
    });
  });
});
