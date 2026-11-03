import { expect, test, type Page } from '@playwright/test';

/**
 * The header appearance menu's trigger name on a real build (DECISIONS.md F6),
 * signed out on /signin, whose sign-in layout holds the menu in every design:
 *  - Classic (sp_style=classic), in every rollout: origin/main's trigger,
 *    "Toggle theme" with no tooltip, as served and after hydration.
 *  - Liquid Glass (sp_style=liquid-glass) in a build that offers it: the
 *    server HTML still says "Toggle theme" (the server cannot see the
 *    Design); once hydrated the trigger is "Appearance: design and theme",
 *    as its name and its tooltip. A production React build does not patch an
 *    attribute that differs at hydration, so a name read from the cookie or
 *    <html> during render would stay "Toggle theme" here.
 *  - Under `off` (no head script) the cookie changes nothing.
 *  - React reports no hydration error on either load.
 *
 * Needs a running server: the integrator's lab run. CI does not run
 * Playwright. Unit tests: components/theme/appearance-select.test.tsx.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const CLASSIC_NAME = 'Toggle theme';
const GLASS_NAME = 'Appearance: design and theme';
const TRIGGER = '#theme-toggle-trigger';
/** Written only by the head script, which only a build offering Liquid Glass emits (appearance-script.ts). */
const HEAD_SCRIPT_MARK = "setAttribute('data-appearance','liquid-glass')";
const HYDRATION_ERROR = /hydrat|Minified React error #(418|423|425)/iu;

interface Load {
  /** The trigger's start tag as the server sent it. */
  served: string;
  /** The build emits the head script (opt-in or default). */
  glassBuild: boolean;
  /** What the browser printed as errors. */
  errors: string[];
}

async function signInPage(
  page: Page,
  baseURL: string,
  style: 'classic' | 'liquid-glass',
): Promise<Load> {
  await page.context().addCookies([{ name: 'sp_style', value: style, url: baseURL }]);
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  const response = await page.goto('/signin');
  const html = (await response?.text()) ?? '';
  const served = /<button[^>]*id="theme-toggle-trigger"[^>]*>/u.exec(html)?.[0] ?? '';
  return { served, glassBuild: html.includes(HEAD_SCRIPT_MARK), errors };
}

/** Resolves once React has hydrated the trigger and the effects after that commit have run. */
async function hydrated(page: Page) {
  await page.waitForFunction((selector) => {
    const el = document.querySelector(selector);
    return el !== null && Object.keys(el).some((key) => key.startsWith('__reactFiber$'));
  }, TRIGGER);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

test('Classic: "Toggle theme" and no tooltip, as served and after hydration, in every rollout', async ({
  page,
  baseURL,
}) => {
  const load = await signInPage(page, baseURL!, 'classic');
  expect(load.served).toContain(`aria-label="${CLASSIC_NAME}"`);
  expect(load.served).not.toContain('title=');
  await hydrated(page);
  const trigger = page.locator(TRIGGER);
  await expect(trigger).toHaveAttribute('aria-label', CLASSIC_NAME);
  await expect(trigger).not.toHaveAttribute('title');
  expect(await page.evaluate(() => document.documentElement.hasAttribute('data-appearance'))).toBe(
    false,
  );
  expect(load.errors.filter((e) => HYDRATION_ERROR.test(e))).toEqual([]);
});

test('Liquid Glass: served as "Toggle theme", then "Appearance: design and theme" as name and tooltip once hydrated', async ({
  page,
  baseURL,
}) => {
  const load = await signInPage(page, baseURL!, 'liquid-glass');
  expect(load.served).toContain(`aria-label="${CLASSIC_NAME}"`);
  expect(load.served).not.toContain('title=');
  await hydrated(page);
  const trigger = page.locator(TRIGGER);
  if (load.glassBuild) {
    await expect(trigger).toHaveAttribute('aria-label', GLASS_NAME);
    await expect(trigger).toHaveAttribute('title', GLASS_NAME);
    await expect(page.getByRole('button', { name: GLASS_NAME })).toBeVisible();
  } else {
    // off: no head script, the provider inert, today's trigger.
    await expect(trigger).toHaveAttribute('aria-label', CLASSIC_NAME);
    await expect(trigger).not.toHaveAttribute('title');
  }
  expect(load.errors.filter((e) => HYDRATION_ERROR.test(e))).toEqual([]);
});
