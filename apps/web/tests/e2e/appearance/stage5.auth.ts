import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { expect, test as setup } from '@playwright/test';

import {
  assertLocal,
  credentialNames,
  isRole,
  msLeftInStep,
  storageStateFor,
  totp,
} from './stage5-env';

/**
 * STAGE 5 SIGN-IN, ONE ROLE PER SETUP PROJECT (playwright.stage5.config.ts:
 * projects setup-admin, setup-manager, setup-staff, setup-viewer,
 * setup-platform, setup-portal; the role comes from the project's metadata).
 * Writes tests/e2e/.auth/stage5-<role>.json, the storageState every stage 5
 * spec of that role reuses (the cross-writer interface in
 * liquid-glass/verify/stage5/inventory.md section 8).
 *
 * Credentials come from the environment only (stage5-env.ts
 * credentialNames), which the lab runner exports from the lab's own files;
 * nothing is printed or committed. The platform admin signs in at aal2 with a
 * TOTP code computed from STAGE5_PLATFORM_TOTP_SECRET (auth.setup.ts refuses
 * an MFA account, so the console tests skipped before stage 5).
 *
 * Lab command (one role):
 *   STAGE5_ROLE=manager PLAYWRIGHT_BASE_URL=http://127.0.0.1:3400 \
 *     pnpm exec playwright test -c playwright.stage5.config.ts --project=setup-manager
 * A role without credentials in the environment skips with its reason.
 */

setup("sign in this project's role and save its session", async ({ page }, testInfo) => {
  const role = (testInfo.project.metadata as { role?: string }).role;
  if (!isRole(role)) throw new Error(`project ${testInfo.project.name} names no stage 5 role`);
  const baseURL = testInfo.project.use.baseURL;
  assertLocal({ PLAYWRIGHT_BASE_URL: baseURL });
  const names = credentialNames(role);
  const email = process.env[names.email];
  const phrase = process.env[names.phrase];
  if (!email || !phrase) {
    setup.skip(
      true,
      `${names.email} and ${names.phrase} are not set: role ${role} is not signed in.`,
    );
    return;
  }

  await page.goto('/signin');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(phrase);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((url) => url.pathname !== '/signin', { timeout: 20_000 });

  if (page.url().includes('/signin/mfa')) {
    if (names.otp === null)
      throw new Error(`role ${role} asks for a second factor; only the platform admin should`);
    const seed = process.env[names.otp];
    if (!seed) throw new Error(`${names.otp} is not set: the platform admin cannot reach aal2`);
    // A code typed in the last seconds of its step can expire on the way: wait for the next step.
    if (msLeftInStep(Date.now()) < 4000) await page.waitForTimeout(msLeftInStep(Date.now()) + 250);
    await page.getByLabel('Authentication code').fill(totp(seed, Date.now()));
    await page.getByRole('button', { name: 'Verify & continue' }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/signin'), { timeout: 20_000 });
  }

  // The customer-portal principal lands on /portal; everyone else on the dashboard (or the console).
  if (role === 'portal') await expect(page).toHaveURL(/\/portal/u);
  else await expect(page).toHaveURL(/\/(dashboard|platform)/u);

  const path = storageStateFor(role);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  await page.context().storageState({ path });
});
