import {
  expect,
  test,
  type BrowserContext,
  type CDPSession,
  type Page,
  type TestInfo,
} from '@playwright/test';

import { chooseLook, settle } from './look';
import { arriveSignedOut, requireGlass, visit, type NamedLook } from './stage5-pages';
import { isAppearanceSaveBody } from './switch-requests';

/**
 * PLAN 8.3-4, 8.3-7 AND R12 (attribute = media query).
 *
 * 8.3-4, emulated media on glass routes (Overview, Items, Place an Order,
 * /signin and the landing), in Day and Night glass:
 *  - `prefers-reduced-transparency: reduce` (CDP Emulation.setEmulatedMedia;
 *    Chromium only, round 2 finding 8): nothing on screen blurs;
 *  - `prefers-contrast: more` (Chromium AND WebKit): the contrast set is on
 *    (--lg-focus-w is 3px) and nothing blurs;
 *  - `forced-colors: active` (Chromium): nothing blurs and the page draws its
 *    heading;
 *  - `prefers-reduced-motion: reduce`: no glass element runs an animation or
 *    transition longer than 100 ms.
 * R12: with `data-lg-material="reduced"` set on <html> (and no media
 * emulated) the page renders pixel-identical to the reduced-transparency
 * media query (screenshot diff, 0 differing pixels).
 * 8.3-7: toggling those settings at runtime never changes the stored
 * appearance: the sp_style cookie, the device and sync records and the
 * stored theme are byte-identical afterwards, and no appearance save (server
 * action) or Design cookie request is made.
 *
 * Lab command:
 *   STAGE5_ROLE=manager PLAYWRIGHT_BASE_URL=http://127.0.0.1:3400 \
 *     pnpm exec playwright test -c playwright.stage5.config.ts --project=chrome --project=webkit --project=anonymous a11y-media.spec.ts
 * Skips in a build without Liquid Glass.
 */

const SIGNED_IN = ['/dashboard', '/dashboard/inventory', '/dashboard/orders/new'] as const;
const SIGNED_OUT = ['/', '/signin'] as const;
const LOOKS: readonly NamedLook[] = [
  { label: 'Day glass', design: 'liquid-glass', theme: 'light' },
  { label: 'Night glass', design: 'liquid-glass', theme: 'dark' },
];

type Feature =
  'prefers-reduced-transparency' | 'prefers-contrast' | 'forced-colors' | 'prefers-reduced-motion';

const chromium = (info: TestInfo) =>
  info.project.name !== 'webkit' && info.project.name !== 'firefox';

/** Emulates media features through CDP (Chromium); an empty list clears them. */
async function cdpMedia(
  cdp: CDPSession,
  features: { name: Feature; value: string }[],
): Promise<void> {
  await cdp.send('Emulation.setEmulatedMedia', { features });
  await new Promise((r) => setTimeout(r, 150));
}

/** Elements on screen whose computed backdrop-filter is not none. */
async function blurring(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      const f =
        cs.backdropFilter ||
        (cs as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter ||
        'none';
      if (f === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || cs.display === 'none' || cs.visibility === 'hidden')
        continue;
      out.push(
        `${el.tagName.toLowerCase()}[data-glass=${el.getAttribute('data-glass') ?? ''}] ${f}`,
      );
    }
    return out.slice(0, 20);
  });
}

/** Glass elements running an animation or transition longer than 100 ms. */
async function longMotion(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => {
        const target = (a.effect as KeyframeEffect | null)?.target as Element | null;
        if (!target?.closest('[data-glass]')) return false;
        const d = a.effect?.getComputedTiming().duration;
        return typeof d === 'number' && d > 100 && a.playState === 'running';
      })
      .map((a) => {
        const t = (a.effect as KeyframeEffect).target as Element;
        return `${t.tagName.toLowerCase()}[data-glass=${t.closest('[data-glass]')?.getAttribute('data-glass')}] ${String(a.effect?.getComputedTiming().duration)}ms`;
      }),
  );
}

/** The stored appearance: cookie and the three local records. */
async function stored(page: Page): Promise<Record<string, string | null>> {
  return page.evaluate(() => {
    const read = (k: string) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    };
    return {
      cookie: /(?:^|; )sp_style=([^;]*)/u.exec(document.cookie)?.[1] ?? null,
      device: read('sp-appearance'),
      sync: read('sp-appearance-sync'),
      theme: read('theme'),
    };
  });
}

/** Counts appearance writes (the account save action and the Design cookie route) from now on. */
function watchWrites(page: Page): { list(): string[] } {
  const seen: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (r.method() === 'POST' && url.pathname === '/api/appearance/style')
      seen.push('POST /api/appearance/style');
    if (r.method() === 'POST' && r.headers()['next-action'] && isAppearanceSaveBody(r.postData()))
      seen.push('the appearance save action');
  });
  return { list: () => [...seen] };
}

/** Pixel difference of two PNG shots, decoded in a blank page. */
async function differingPixels(context: BrowserContext, a: Buffer, b: Buffer): Promise<number> {
  const blank = await context.newPage();
  try {
    await blank.goto('about:blank');
    return await blank.evaluate(
      async ({ x, y }) => {
        const decode = async (b64: string) => {
          const img = new Image();
          img.src = `data:image/png;base64,${b64}`;
          await img.decode();
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const ctx = c.getContext('2d')!;
          ctx.drawImage(img, 0, 0);
          return ctx.getImageData(0, 0, c.width, c.height);
        };
        const A = await decode(x);
        const B = await decode(y);
        if (A.width !== B.width || A.height !== B.height) return Number.MAX_SAFE_INTEGER;
        let n = 0;
        for (let i = 0; i < A.data.length; i += 4) {
          if (
            A.data[i] !== B.data[i] ||
            A.data[i + 1] !== B.data[i + 1] ||
            A.data[i + 2] !== B.data[i + 2] ||
            A.data[i + 3] !== B.data[i + 3]
          )
            n += 1;
        }
        return n;
      },
      { x: a.toString('base64'), y: b.toString('base64') },
    );
  } finally {
    await blank.close();
  }
}

async function mediaChecks(
  page: Page,
  context: BrowserContext,
  info: TestInfo,
  where: string,
): Promise<string[]> {
  const problems: string[] = [];
  // prefers-contrast: more works in both engines through Playwright.
  await page.emulateMedia({ contrast: 'more' });
  await page.waitForTimeout(150);
  const w = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--lg-focus-w').trim(),
  );
  if (w !== '3px') problems.push(`${where} contrast: --lg-focus-w is ${w || '(unset)'}, not 3px`);
  for (const b of await blurring(page)) problems.push(`${where} contrast: still blurs ${b}`);
  await page.emulateMedia({ contrast: 'no-preference', reducedMotion: 'reduce' });
  await page.waitForTimeout(150);
  for (const m of await longMotion(page)) problems.push(`${where} reduced motion: ${m}`);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  if (!chromium(info)) return problems;

  const cdp = await context.newCDPSession(page);
  await cdpMedia(cdp, [{ name: 'prefers-reduced-transparency', value: 'reduce' }]);
  for (const b of await blurring(page))
    problems.push(`${where} reduced transparency: still blurs ${b}`);
  const viaMedia = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  await cdpMedia(cdp, []);
  await page.evaluate(() => document.documentElement.setAttribute('data-lg-material', 'reduced'));
  await page.waitForTimeout(150);
  const viaAttribute = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  await page.evaluate(() => document.documentElement.removeAttribute('data-lg-material'));
  const diff = await differingPixels(context, viaMedia, viaAttribute);
  if (diff !== 0)
    problems.push(`${where}: attribute and media-query reduced renders differ in ${diff} pixels`);

  await cdpMedia(cdp, [{ name: 'forced-colors', value: 'active' }]);
  for (const b of await blurring(page)) problems.push(`${where} forced colours: still blurs ${b}`);
  if (
    !(await page
      .locator('h1')
      .first()
      .isVisible()
      .catch(() => false))
  )
    problems.push(`${where} forced colours: no heading drawn`);
  await cdpMedia(cdp, []);
  await cdp.detach();
  return problems;
}

/** 8.3-7: every OS-level toggle on, then off; the stored appearance is untouched. */
async function storeUnchanged(
  page: Page,
  context: BrowserContext,
  info: TestInfo,
  where: string,
): Promise<string[]> {
  const before = await stored(page);
  const writes = watchWrites(page);
  await page.emulateMedia({ contrast: 'more', reducedMotion: 'reduce' });
  await settle(page);
  await page.emulateMedia({ contrast: 'no-preference', reducedMotion: 'no-preference' });
  if (chromium(info)) {
    const cdp = await context.newCDPSession(page);
    await cdpMedia(cdp, [
      { name: 'prefers-reduced-transparency', value: 'reduce' },
      { name: 'forced-colors', value: 'active' },
    ]);
    await settle(page);
    await cdpMedia(cdp, []);
    await cdp.detach();
  }
  await settle(page);
  const after = await stored(page);
  const problems: string[] = [];
  if (JSON.stringify(after) !== JSON.stringify(before))
    problems.push(
      `${where}: stored appearance changed ${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
    );
  for (const w of writes.list()) problems.push(`${where}: ${w} during the toggles`);
  return problems;
}

const signedIn = (info: TestInfo) => typeof info.project.use.storageState === 'string';

test.describe('signed in', () => {
  test.beforeEach(() => {
    const info = test.info();
    test.skip(!signedIn(info), 'This project has no session.');
    test.skip(
      info.project.name === 'phone-390',
      'The header menu is a desktop control; phone layouts have their own specs.',
    );
    test.skip(
      ['platform', 'portal'].includes(process.env.STAGE5_ROLE ?? ''),
      'Dashboard routes only.',
    );
  });
  for (const route of SIGNED_IN) {
    test(`${route}: emulated media, attribute = media query, store unchanged`, async ({
      page,
      context,
    }, info) => {
      if (!(await visit(page, route, null)))
        test.skip(true, `${route} does not open for this role.`);
      await requireGlass(page);
      const problems: string[] = [];
      for (const look of LOOKS) {
        await chooseLook(page, look);
        await settle(page);
        problems.push(...(await mediaChecks(page, context, info, `${route} ${look.label}`)));
        problems.push(...(await storeUnchanged(page, context, info, `${route} ${look.label}`)));
      }
      expect(problems).toEqual([]);
    });
  }
});

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.beforeEach(() => {
    const info = test.info();
    test.skip(
      !['anonymous', 'webkit'].includes(info.project.name),
      'Signed-out routes run in anonymous and webkit.',
    );
  });
  for (const route of SIGNED_OUT) {
    test(`${route}: emulated media, attribute = media query, store unchanged`, async ({
      browser,
      baseURL,
    }, info) => {
      const problems: string[] = [];
      for (const look of LOOKS) {
        const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
          await arriveSignedOut(context, baseURL!, look);
          const page = await context.newPage();
          if (!(await visit(page, route, null))) continue;
          await requireGlass(page);
          problems.push(...(await mediaChecks(page, context, info, `${route} ${look.label}`)));
          problems.push(...(await storeUnchanged(page, context, info, `${route} ${look.label}`)));
        } finally {
          await context.close();
        }
      }
      expect(problems).toEqual([]);
    });
  }
});
