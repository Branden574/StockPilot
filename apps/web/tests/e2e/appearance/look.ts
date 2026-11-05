import { expect, type BrowserContext, type Page, type Request } from '@playwright/test';

/**
 * Shared steps for the Liquid Glass identity and transition specs (plan 8.2):
 * switching the look through the header appearance menu (the real control,
 * DECISIONS.md F6), or from a second tab of the same browser (the
 * appearance provider follows the `sp-appearance` storage event), which is
 * how a switch happens while a dialog or the command palette holds focus in
 * the first tab; and the watchers the transition rules need (data requests,
 * realtime joins, toasts).
 *
 * Needs a running server: the integrator's lab run. CI does not run
 * Playwright.
 */

export type Design = 'classic' | 'liquid-glass';
export type Theme = 'light' | 'dark';
export interface Look {
  design: Design;
  theme: Theme;
}

/** Brief section 13 (plan 8.2 case 1): Dark, Liquid Glass, Light, Dark, with
 *  both themes of each design on the way. */
export const SEQUENCE: readonly Look[] = [
  { design: 'liquid-glass', theme: 'dark' },
  { design: 'liquid-glass', theme: 'light' },
  { design: 'classic', theme: 'light' },
  { design: 'classic', theme: 'dark' },
];
export const START: Look = { design: 'classic', theme: 'dark' };

const TRIGGER = '#theme-toggle-trigger';
/** Written only by the head script, which only a build offering Liquid Glass emits (appearance-script.ts). */
const HEAD_SCRIPT_MARK = "setAttribute('data-appearance','liquid-glass')";
const DESIGN_LABEL: Record<Design, string> = { 'liquid-glass': 'Liquid Glass', classic: 'Classic' };
const THEME_LABEL: Record<Theme, string> = { light: 'Light', dark: 'Dark' };

/** Whether this build offers Liquid Glass at all (opt-in or default). */
export async function glassBuild(page: Page): Promise<boolean> {
  return (await page.content()).includes(HEAD_SCRIPT_MARK);
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

/** The one-time intro notice (R13) appears on the first glass view of a
 *  person whose Design is not explicit; keep the look and close it. */
export async function settleIntroNotice(page: Page): Promise<void> {
  const keep = page.getByRole('button', { name: 'Keep Liquid Glass' });
  if (await keep.isVisible().catch(() => false)) await keep.click();
}

/** Switches `menuPage` to `look` through its header appearance menu, one
 *  axis at a time, as a person would. */
export async function chooseLook(menuPage: Page, look: Look): Promise<void> {
  const now = await shownLook(menuPage);
  if (now.design !== look.design) {
    await menuPage.locator(TRIGGER).click();
    await menuPage.getByRole('menuitemradio', { name: DESIGN_LABEL[look.design] }).click();
    await expect(menuPage.getByRole('menu')).toBeHidden();
  }
  if (now.theme !== look.theme) {
    await menuPage.locator(TRIGGER).click();
    await menuPage.getByRole('menuitem', { name: THEME_LABEL[look.theme], exact: true }).click();
    await expect(menuPage.getByRole('menu')).toBeHidden();
  }
  await waitForLook(menuPage, look);
}

/** A second tab of the same browser, on a light page with the header menu. */
export async function openRemote(context: BrowserContext): Promise<Page> {
  const remote = await context.newPage();
  await remote.goto('/dashboard/whats-new');
  await expect(remote.locator(TRIGGER)).toBeVisible();
  await settleIntroNotice(remote);
  return remote;
}

/** Switches `page` to `look` from the second tab, without touching `page`. */
export async function chooseLookElsewhere(remote: Page, page: Page, look: Look): Promise<void> {
  await chooseLook(remote, look);
  await waitForLook(page, look);
}

/** A request a look switch may make: the account save (a server action), the
 *  Design cookie route, the scene photo, the build's own static files, and
 *  analytics or error reporting, which read no data. A route prefetch
 *  (next-router-prefetch) is the pointer resting on a link after a menu
 *  closes, not the switch; a refresh of the page itself has no such header
 *  and still counts. */
function allowedDuringSwitch(request: Request): boolean {
  const url = new URL(request.url());
  const headers = request.headers();
  if (request.method() === 'POST' && headers['next-action']) return true;
  if (headers['next-router-prefetch']) return true;
  if (url.pathname === '/api/appearance/style') return true;
  if (url.pathname.startsWith('/liquid-glass/')) return true;
  if (url.pathname.startsWith('/_next/static/')) return true;
  if (/posthog|sentry/iu.test(url.hostname) || url.pathname.startsWith('/monitoring')) return true;
  if (url.protocol === 'data:' || url.protocol === 'blob:') return true;
  return false;
}

/** Records the data requests `page` makes from now on (RSC payloads, API
 *  routes, the database, storage). */
export function watchDataRequests(page: Page): { list(): string[]; reset(): void } {
  let seen: string[] = [];
  page.on('request', (request) => {
    if (!allowedDuringSwitch(request)) seen.push(`${request.method()} ${request.url()}`);
  });
  return {
    list: () => [...seen],
    reset: () => {
      seen = [];
    },
  };
}

/** Counts realtime channel joins (`phx_join` frames). Attach before the page loads. */
export function watchRealtimeJoins(page: Page): { count(): number } {
  let joins = 0;
  page.on('websocket', (socket) => {
    socket.on('framesent', (frame) => {
      const text = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString();
      if (text.includes('phx_join')) joins += 1;
    });
  });
  return { count: () => joins };
}

/** The toasts on screen now, by their text. */
export async function toastTexts(page: Page): Promise<string[]> {
  return page.locator('[data-sonner-toast]').allInnerTexts();
}

/** Lets an effect a switch might start (a fetch, a toast) show itself. */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(800);
}
