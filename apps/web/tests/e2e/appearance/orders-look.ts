import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';

import { switchRequestFilter } from './switch-requests';

/**
 * Steps for the orders lane's Liquid Glass identity and transition specs
 * (plan 8.2): switching the look through the header appearance menu (the
 * real control, DECISIONS.md F6), or from a second tab of the same browser
 * (the appearance provider follows the `sp-appearance` storage event), which
 * is how a switch happens while a dialog or a sheet holds focus in the first
 * tab; and the watchers the transition rules need (data requests, realtime
 * joins, toasts). The same steps as the items lane's look.ts, kept in the
 * lane's own file so the two lanes merge without touching each other.
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

/** Brief section 13 (plan 8.2 case 1): from Dark, to Liquid Glass Night and
 *  Day, then Light and Dark again. */
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

/** Picks one item of the header appearance menu from the keyboard (the
 *  trigger's Enter opens it, the item's Enter chooses it), so the pointer
 *  never moves: no link under a resting pointer is hovered, and so none is
 *  prefetched, while a switch is watched. */
async function pickFromMenu(menuPage: Page, item: Locator): Promise<void> {
  await menuPage.locator(TRIGGER).focus();
  await menuPage.keyboard.press('Enter');
  await expect(menuPage.getByRole('menu')).toBeVisible();
  await item.focus();
  await menuPage.keyboard.press('Enter');
  await expect(menuPage.getByRole('menu')).toBeHidden();
}

/** Switches `menuPage` to `look` through its header appearance menu, one
 *  axis at a time, as a person would. */
export async function chooseLook(menuPage: Page, look: Look): Promise<void> {
  const now = await shownLook(menuPage);
  if (now.design !== look.design) {
    await pickFromMenu(
      menuPage,
      menuPage.getByRole('menuitemradio', { name: DESIGN_LABEL[look.design] }),
    );
  }
  if (now.theme !== look.theme) {
    await pickFromMenu(
      menuPage,
      menuPage.getByRole('menuitem', { name: THEME_LABEL[look.theme], exact: true }),
    );
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

/** Records the data requests `page` makes from now on (RSC payloads, server
 *  actions, API routes, the database, storage), each with why it counts.
 *  What a switch may make is in switch-requests.ts: the account save and no
 *  other server action, the Design cookie route, the scene photos, static
 *  files, analytics, and a prefetch of a link the page holds now (not of the
 *  page itself). */
export async function watchDataRequests(page: Page): Promise<{ list(): string[]; reset(): void }> {
  const linkHrefs = await page.evaluate(() =>
    [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') ?? ''),
  );
  const rules = switchRequestFilter({ pageUrl: page.url(), linkHrefs });
  let seen: string[] = [];
  page.on('request', (request) => {
    const why = rules.verdict({
      method: request.method(),
      url: request.url(),
      headers: request.headers(),
      postData: request.postData(),
    });
    if (why !== null) seen.push(`${request.method()} ${request.url()}: ${why}`);
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

/** Opens the first order on an Orders tab ("needs_approval", "picking", ...),
 *  by its order number link, or returns false when the tab is empty. */
export async function openFirstOrder(page: Page, tab: string): Promise<boolean> {
  await page.goto(`/dashboard/orders?status=${tab}`);
  await expect(page.locator('[data-glass-page="orders"]')).toBeVisible();
  const link = page.getByRole('table').locator('tbody tr td:first-child a').first();
  if (!(await link.isVisible().catch(() => false))) return false;
  await link.click();
  await expect(page.locator('[data-glass-page="order-detail"]')).toBeVisible();
  return true;
}
