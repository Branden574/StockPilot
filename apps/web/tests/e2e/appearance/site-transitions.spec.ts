import { expect, test } from '@playwright/test';

import {
  arriveWith,
  buildRollout,
  chooseLook,
  cookieFor,
  SEQUENCE,
  shownLook,
  skipLandingIntro,
  twinOnScreen,
  waitForLook,
  waitForTwin,
  watchRequests,
  type Rollout,
} from './site-look';

/**
 * The brief's section 13 transitions on the site lane's pages (IMPLEMENTATION-
 * PLAN.md 8.2 cases 1, 4 and 9; stage 3 "support-form draft across a
 * switch"), signed out, through the header appearance menu (the real
 * control): Dark, Liquid Glass Night, Liquid Glass Day, Light, Dark.
 *
 *  - /signin (M1: one tree in every appearance): the same DOM nodes survive
 *    every switch (a JS expando on the form, both inputs and the submit
 *    button; a remount makes new nodes without it), the typed email and
 *    password stay, focus stays in the field it was in, the URL stays, and
 *    no data request is made (only the Design cookie route, scene photos and
 *    static files).
 *  - /support (M3: two static twins): a switch of Design swaps the twin in
 *    place (same URL, the page hidden until the right twin is on screen) with
 *    exactly one request, the refresh of /support itself; what was typed in
 *    the form is still there in the other twin (the sessionStorage draft); a
 *    switch of Theme alone swaps nothing.
 *  - Public to sign-in in glass: from the glass landing, Sign in opens
 *    /signin in glass, and the choice made there is kept on the way back.
 *
 * Needs a running server: the integrator's lab run. Unit halves:
 * components/theme/appearance-provider.test.tsx (no remount),
 * components/marketing/support-form.draft.test.tsx (the draft).
 */

test.use({ storageState: { cookies: [], origins: [] } });

let rollout: Rollout;
test.beforeAll(async ({ request }) => {
  rollout = await buildRollout(request);
});

test.beforeEach(async ({ page }) => {
  test.skip(rollout === 'off', 'off: Liquid Glass is not offered, the menu has no Design group');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: 'dark' });
});

test('/signin: the same nodes, values and focus through Dark, Night and Day glass, Light, Dark', async ({
  page,
  baseURL,
}) => {
  await arriveWith(page.context(), baseURL!, 'classic');
  await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
  await page.goto('/signin');
  await waitForLook(page, { design: 'classic', theme: 'dark' });

  const email = page.getByLabel('Email');
  const password = page.getByLabel('Password', { exact: true });
  await email.fill('someone@example.test');
  await password.fill('not-a-real-password');
  await page.evaluate(() => {
    const form = document.querySelector('form')!;
    for (const el of [form, ...form.querySelectorAll('input, button[type="submit"]')]) {
      (el as unknown as { __lgProbe?: string }).__lgProbe = 'kept';
    }
  });
  const probed = () =>
    page.evaluate(() => {
      const form = document.querySelector('form');
      if (!form) return false;
      return [form, ...form.querySelectorAll('input, button[type="submit"]')].every(
        (el) => (el as unknown as { __lgProbe?: string }).__lgProbe === 'kept' && el.isConnected,
      );
    });

  const requests = watchRequests(page, null);
  for (const look of SEQUENCE) {
    await chooseLook(page, look);
    await page.waitForTimeout(300);
    expect(new URL(page.url()).pathname).toBe('/signin');
    expect(await probed(), `same nodes after ${look.design} ${look.theme}`).toBe(true);
    await expect(email).toHaveValue('someone@example.test');
    await expect(password).toHaveValue('not-a-real-password');
    expect(await shownLook(page)).toEqual(look);
  }
  // Focus stays in the field it was in across a switch made from a second tab.
  await password.focus();
  const remote = await page.context().newPage();
  await remote.goto('/privacy');
  await chooseLook(remote, { design: 'liquid-glass', theme: 'dark' });
  await waitForLook(page, { design: 'liquid-glass', theme: 'dark' });
  await expect(password).toBeFocused();
  expect(await probed()).toBe(true);
  expect(requests.list()).toEqual([]);
});

test('/support: a switch of Design swaps the twin in place, keeps what was typed, and asks only for the page again', async ({
  page,
  baseURL,
}) => {
  await arriveWith(page.context(), baseURL!, 'classic');
  await page.goto('/support');
  expect(await twinOnScreen(page)).toBe(false);

  const fill = async () => {
    await page.getByLabel(/^Name/u).fill('Sam Example');
    await page.getByLabel(/^Email/u).fill('sam@example.test');
    await page.getByLabel(/^Subject/u).fill('Cannot sign in');
    await page.getByLabel(/^Details/u).fill('The code is refused.');
  };
  const expectTyped = async () => {
    await expect(page.getByLabel(/^Name/u)).toHaveValue('Sam Example');
    await expect(page.getByLabel(/^Email/u)).toHaveValue('sam@example.test');
    await expect(page.getByLabel(/^Subject/u)).toHaveValue('Cannot sign in');
    await expect(page.getByLabel(/^Details/u)).toHaveValue('The code is refused.');
  };
  await fill();

  const requests = watchRequests(page, '/support');
  const refreshes: string[] = [];
  page.on('request', (r) => {
    if (r.headers().rsc === '1' && !r.headers()['next-router-prefetch']) refreshes.push(r.url());
  });

  const start = await shownLook(page);
  for (const design of ['liquid-glass', 'classic'] as const) {
    refreshes.length = 0;
    await chooseLook(page, { design, theme: start.theme });
    await waitForTwin(page, design);
    expect(new URL(page.url()).pathname).toBe('/support');
    await expectTyped();
    expect(refreshes, `one refresh of /support for ${design}`).toHaveLength(1);
    expect(new URL(refreshes[0]!).pathname).toBe('/support');
  }
  // A Theme alone: no twin swap, no refresh.
  refreshes.length = 0;
  await chooseLook(page, { design: 'classic', theme: start.theme === 'dark' ? 'light' : 'dark' });
  await page.waitForTimeout(500);
  expect(refreshes).toEqual([]);
  await expectTyped();
  expect(requests.list()).toEqual([]);
  // The draft is read once: nothing is left behind.
  expect(
    await page.evaluate(() => sessionStorage.getItem('stockpilot:support-draft:v1')),
  ).toBeNull();
});

test('from the glass landing, Sign in opens /signin in glass, and Classic chosen there holds on the way back', async ({
  page,
  baseURL,
}) => {
  await arriveWith(page.context(), baseURL!, cookieFor(rollout, 'liquid-glass'));
  await skipLandingIntro(page);
  await page.goto('/');
  expect(await twinOnScreen(page)).toBe(true);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Sign in', exact: true })
    .click();
  await page.waitForURL('**/signin');
  expect((await shownLook(page)).design).toBe('liquid-glass');
  await chooseLook(page, { design: 'classic', theme: (await shownLook(page)).theme });
  await page.goBack();
  await waitForTwin(page, 'classic');
  expect((await shownLook(page)).design).toBe('classic');
});
