import { test, expect } from '@playwright/test';

test.describe('Settings flows', () => {
  test('Settings hub lists profile, security, organization, billing', async ({ page }) => {
    await page.goto('/dashboard/settings');
    await expect(page.getByRole('heading', { name: /^settings$/i })).toBeVisible();
    for (const label of [/profile/i, /security/i, /organization/i, /billing/i]) {
      await expect(page.getByRole('heading', { name: label }).first()).toBeVisible();
    }
  });

  test('Profile page renders avatar uploader + name editor', async ({ page }) => {
    await page.goto('/dashboard/settings/profile');
    await expect(page.getByRole('heading', { name: /^profile$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /upload|replace/i })).toBeVisible();
    await expect(page.getByLabel(/full name/i)).toBeVisible();
  });

  test('Security page renders authenticator card', async ({ page }) => {
    await page.goto('/dashboard/settings/security');
    await expect(page.getByRole('heading', { name: /authenticator app/i })).toBeVisible();
  });

  test('Organization page renders Logo + Name + Labels cards', async ({ page }) => {
    await page.goto('/dashboard/settings/organization');
    await expect(page.getByRole('heading', { name: /^organization$/i })).toBeVisible();
    for (const label of [/^logo$/i, /^name$/i, /^labels$/i]) {
      await expect(page.getByRole('heading', { name: label })).toBeVisible();
    }
  });
});
