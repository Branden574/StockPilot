import { test as setup, expect } from '@playwright/test';

/**
 * One-time auth setup: signs in once, then dumps the cookies to a
 * storage state file every other test reuses. Saves ~3s per test.
 *
 * Required env:
 *   TEST_USER_EMAIL    — pre-existing Supabase user with org membership
 *   TEST_USER_PASSWORD — that user's password
 *
 * If those aren't set we skip rather than fail — lets devs run lint /
 * typecheck without a live test account.
 */

const STORAGE_STATE = 'tests/e2e/.auth/user.json';

setup('authenticate', async ({ page }) => {
  const email = process.env.TEST_USER_EMAIL;
  const password = process.env.TEST_USER_PASSWORD;
  if (!email || !password) {
    setup.skip(
      true,
      'Skipping auth setup: TEST_USER_EMAIL + TEST_USER_PASSWORD not set.',
    );
    return;
  }

  await page.goto('/signin');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();

  // Either MFA prompt or dashboard. We bail if MFA is required —
  // automated MFA codes need a TOTP seed which we don't pass through.
  await Promise.race([
    page.waitForURL(/\/dashboard/, { timeout: 15_000 }),
    page.waitForURL(/\/signin\/mfa/, { timeout: 15_000 }),
  ]);
  if (page.url().includes('/signin/mfa')) {
    throw new Error(
      'MFA is enabled on the test account — disable for E2E or wire a TOTP seed.',
    );
  }

  // Sanity-check that we landed on the dashboard.
  await expect(page).toHaveURL(/\/dashboard/);

  await page.context().storageState({ path: STORAGE_STATE });
});
