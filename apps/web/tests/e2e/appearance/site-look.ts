import {
  expect,
  type APIRequestContext,
  type BrowserContext,
  type Page,
  type Request,
} from '@playwright/test';

/**
 * Shared steps for the site lane's Liquid Glass specs (stage 3: the 7
 * marketing twins and the sign-in shell; IMPLEMENTATION-PLAN.md 4.6 M3, 8.2;
 * plans/REVISION-DEFAULT.md R8). The build's rollout is read from the head
 * script it emits, so one spec file serves the three builds the lab run
 * makes (NEXT_PUBLIC_LIQUID_GLASS unset/off, opt-in, default).
 *
 * Needs a running server: the integrator's lab run (`next start`). CI does
 * not run Playwright. Unit halves: app/(site-glass)/glass-site/twins.test.tsx,
 * components/theme/appearance-flag.test.ts, components/theme/
 * appearance-provider.test.tsx.
 */

export type Rollout = 'off' | 'opt-in' | 'default';
export type Design = 'classic' | 'liquid-glass';
export type Theme = 'light' | 'dark';
export interface Look {
  design: Design;
  theme: Theme;
}

/** The 7 marketing paths with a glass twin (components/theme/appearance-flag.ts). */
export const MARKETING_PATHS = [
  '/',
  '/contact',
  '/pricing',
  '/privacy',
  '/security',
  '/support',
  '/terms',
] as const;
export type MarketingPath = (typeof MARKETING_PATHS)[number];
/** The six pages whose words come from the shared content modules. */
export const CONTENT_PATHS = MARKETING_PATHS.filter((p) => p !== '/');

/** The twin's address, reachable only through the rewrite. */
export const twinPath = (path: string) => (path === '/' ? '/glass-site' : `/glass-site${path}`);

/** The glass-site layout's inert marker (the variant guard reads it). */
export const TWIN_MARKER = 'data-lg-twin';
const TRIGGER = '#theme-toggle-trigger';
const DESIGN_LABEL: Record<Design, string> = { 'liquid-glass': 'Liquid Glass', classic: 'Classic' };
const THEME_LABEL: Record<Theme, string> = { light: 'Light', dark: 'Dark' };
/** The classic landing's branded intro (components/marketing/landing-intro). */
const INTRO_SEEN_KEY = 'stockpilot:intro-seen:v1';

/** Which rollout a page's HTML was built with, from its head script (appearance-script.ts). */
export function rolloutOf(html: string): Rollout {
  if (html.includes("if(v!=='classic')")) return 'default';
  if (html.includes("if(v==='liquid-glass')")) return 'opt-in';
  return 'off';
}

/** The rollout of the build under test. */
export async function buildRollout(request: APIRequestContext): Promise<Rollout> {
  const response = await request.get('/privacy', { headers: { cookie: 'sp_style=classic' } });
  return rolloutOf(await response.text());
}

/** Exactly marketingRewrites' condition (appearance-flag.ts twinSelected). */
export function twinSelected(rollout: Rollout, cookie: string | null): boolean {
  if (rollout === 'default') return cookie !== 'classic';
  if (rollout === 'opt-in') return cookie === 'liquid-glass';
  return false;
}

/** The cookie that selects a Design in this rollout (null: none needed). */
export function cookieFor(rollout: Rollout, design: Design): string | null {
  if (design === 'classic') return 'classic';
  return rollout === 'default' ? null : 'liquid-glass';
}

/** GETs a path as a visitor with this sp_style cookie (null: none). */
export async function fetchAs(
  request: APIRequestContext,
  path: string,
  cookie: string | null,
  maxRedirects?: number,
) {
  return request.get(path, {
    headers: cookie === null ? {} : { cookie: `sp_style=${cookie}` },
    ...(maxRedirects === undefined ? {} : { maxRedirects }),
  });
}

/** Sets the Design cookie a visitor arrives with (null: none). */
export async function arriveWith(context: BrowserContext, baseURL: string, cookie: string | null) {
  await context.clearCookies({ name: 'sp_style' });
  if (cookie !== null)
    await context.addCookies([{ name: 'sp_style', value: cookie, url: baseURL }]);
}

/** Skips the classic landing's branded intro, so its nav is clickable at once. */
export async function skipLandingIntro(page: Page) {
  await page.addInitScript((key) => {
    try {
      sessionStorage.setItem(key, '1');
    } catch {
      /* storage blocked: the intro then plays and is skipped by its own control */
    }
  }, INTRO_SEEN_KEY);
}

/** Whether the glass twin is on screen. */
export async function twinOnScreen(page: Page): Promise<boolean> {
  return page.evaluate((marker) => document.querySelector(`[${marker}]`) !== null, TWIN_MARKER);
}

/** What <html> shows now. */
export async function shownLook(page: Page): Promise<Look> {
  return page.evaluate(() => ({
    design:
      document.documentElement.getAttribute('data-appearance') === 'liquid-glass'
        ? ('liquid-glass' as const)
        : ('classic' as const),
    theme: document.documentElement.classList.contains('dark')
      ? ('dark' as const)
      : ('light' as const),
  }));
}

/** Resolves once <html> shows `look`. */
export async function waitForLook(page: Page, look: Look): Promise<void> {
  await page.waitForFunction(
    ({ design, theme }) => {
      const html = document.documentElement;
      const glass = html.getAttribute('data-appearance') === 'liquid-glass';
      return glass === (design === 'liquid-glass') && html.classList.contains(theme);
    },
    look,
    { timeout: 10_000 },
  );
}

/** Resolves once the page shows the twin of `design` and the guard has shown the page. */
export async function waitForTwin(page: Page, design: Design): Promise<void> {
  await page.waitForFunction(
    ({ marker, glass }) =>
      (document.querySelector(`[${marker}]`) !== null) === glass &&
      document.head.querySelector('style[data-lg-variant-guard]') === null,
    { marker: TWIN_MARKER, glass: design === 'liquid-glass' },
    { timeout: 10_000 },
  );
}

/** Switches the page to `look` through its header appearance menu, one axis at a time. */
export async function chooseLook(page: Page, look: Look): Promise<void> {
  const now = await shownLook(page);
  if (now.design !== look.design) {
    await page.locator(TRIGGER).first().click();
    await page.getByRole('menuitemradio', { name: DESIGN_LABEL[look.design] }).click();
    await expect(page.getByRole('menu')).toBeHidden();
  }
  if (now.theme !== look.theme) {
    await page.locator(TRIGGER).first().click();
    await page.getByRole('menuitem', { name: THEME_LABEL[look.theme], exact: true }).click();
    await expect(page.getByRole('menu')).toBeHidden();
  }
  await waitForLook(page, look);
}

/** Brief section 13: Dark, Liquid Glass (Night, Day), Light, Dark. */
export const SEQUENCE: readonly Look[] = [
  { design: 'liquid-glass', theme: 'dark' },
  { design: 'liquid-glass', theme: 'light' },
  { design: 'classic', theme: 'light' },
  { design: 'classic', theme: 'dark' },
];

/**
 * A request a look switch may make: the Design cookie route, the scene photo,
 * the build's static files and the page's icons, analytics and error
 * reporting, a prefetch; on a
 * marketing page also the one refresh of the page itself (an RSC GET of the
 * same path), which is how the other twin arrives (R8).
 */
function allowedDuringSwitch(request: Request, refreshOf: string | null): boolean {
  const url = new URL(request.url());
  const headers = request.headers();
  if (headers['next-router-prefetch']) return true;
  if (url.pathname === '/api/appearance/style') return true;
  if (url.pathname.startsWith('/liquid-glass/')) return true;
  if (url.pathname.startsWith('/_next/static/')) return true;
  // The page's own icons, asked for again when the other twin's head arrives.
  if (/^\/(icon|apple-icon|favicon)\b/u.test(url.pathname)) return true;
  if (/posthog|sentry/iu.test(url.hostname) || url.pathname.startsWith('/monitoring')) return true;
  if (url.pathname.startsWith('/ingest')) return true;
  if (url.protocol === 'data:' || url.protocol === 'blob:') return true;
  if (refreshOf !== null && request.method() === 'GET' && headers.rsc === '1') {
    return url.pathname === refreshOf;
  }
  return false;
}

/** Records the data requests `page` makes from now on. */
export function watchRequests(
  page: Page,
  refreshOf: string | null,
): { list(): string[]; reset(): void } {
  let seen: string[] = [];
  page.on('request', (request) => {
    if (!allowedDuringSwitch(request, refreshOf)) seen.push(`${request.method()} ${request.url()}`);
  });
  return {
    list: () => [...seen],
    reset: () => {
      seen = [];
    },
  };
}

/**
 * Installs a sampler that records, for every animation frame the page paints
 * while <html> is visible on a marketing path, whether the twin on screen is
 * the one the cookie selects and whether the glass attribute matches the twin
 * (the variant guard's promise: no frame of the wrong design, never a twin on
 * the other design's CSS). Survives reloads (an init script).
 */
export async function sampleFrames(page: Page, rollout: Rollout): Promise<void> {
  await page.addInitScript(
    ({ paths, marker, rolloutName }) => {
      const w = window as unknown as { __lgFrames?: { wrongTwin: string[]; incoherent: string[] } };
      w.__lgFrames = { wrongTwin: [], incoherent: [] };
      const selected = (cookie: string | null) =>
        rolloutName === 'default'
          ? cookie !== 'classic'
          : rolloutName === 'opt-in'
            ? cookie === 'liquid-glass'
            : false;
      const tick = () => {
        const html = document.documentElement;
        if (paths.includes(location.pathname) && document.body) {
          const visible = getComputedStyle(html).visibility !== 'hidden';
          if (visible) {
            const twin = document.querySelector(`[${marker}]`) !== null;
            const glass = html.getAttribute('data-appearance') === 'liquid-glass';
            const cookie = /(?:^|; )sp_style=([^;]*)/.exec(document.cookie)?.[1] ?? null;
            const at = `${location.pathname} twin=${twin} glass=${glass} cookie=${cookie}`;
            if (twin !== selected(cookie)) w.__lgFrames!.wrongTwin.push(at);
            if (twin !== glass) w.__lgFrames!.incoherent.push(at);
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    { paths: [...MARKETING_PATHS] as string[], marker: TWIN_MARKER, rolloutName: rollout },
  );
}

/** The frames the sampler flagged since the last reset, and a reset. */
export async function flaggedFrames(
  page: Page,
  reset = false,
): Promise<{ wrongTwin: string[]; incoherent: string[] }> {
  return page.evaluate((clear) => {
    const w = window as unknown as { __lgFrames?: { wrongTwin: string[]; incoherent: string[] } };
    const out = w.__lgFrames ?? { wrongTwin: [], incoherent: [] };
    const copy = { wrongTwin: [...out.wrongTwin], incoherent: [...out.incoherent] };
    if (clear && w.__lgFrames) w.__lgFrames = { wrongTwin: [], incoherent: [] };
    return copy;
  }, reset);
}

/**
 * Headings in document order as "h2 Text", only those a reader meets (not
 * display:none), in the whole document or inside `scope` (a selector).
 */
export async function headingList(page: Page, scope = ':root'): Promise<string[]> {
  return page.evaluate(
    (within) =>
      [...(document.querySelector(within)?.querySelectorAll('h1, h2, h3, h4, h5, h6') ?? [])]
        .filter((h) => (h as HTMLElement).checkVisibility?.() ?? true)
        .map(
          (h) => `${h.tagName.toLowerCase()} ${(h.textContent ?? '').replace(/\s+/gu, ' ').trim()}`,
        ),
    scope,
  );
}

/** Link targets a reader meets, a landing section anchor counted as "/". */
export async function linkTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out = new Set<string>();
    for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      if (!(a.checkVisibility?.() ?? true)) continue;
      const raw = a.getAttribute('href') ?? '';
      if (raw.startsWith('#')) continue;
      const url = new URL(raw, location.origin);
      if (url.origin !== location.origin) {
        out.add(url.href);
        continue;
      }
      out.add(url.pathname === '/' && url.hash ? '/' : `${url.pathname}${url.hash}`);
    }
    return [...out].sort();
  });
}

/** One h1, no skipped level, no empty heading. */
export function expectHeadingOutline(list: string[]): void {
  const levels = list.map((h) => Number(h[1]));
  expect(levels[0], list.join('\n')).toBe(1);
  expect(
    levels.filter((l) => l === 1),
    list.join('\n'),
  ).toHaveLength(1);
  for (let i = 1; i < levels.length; i += 1) {
    expect(levels[i]! - levels[i - 1]!, `${list[i - 1]} -> ${list[i]}`).toBeLessThanOrEqual(1);
  }
  for (const h of list) expect(h.slice(3).trim(), 'an empty heading').not.toBe('');
}
