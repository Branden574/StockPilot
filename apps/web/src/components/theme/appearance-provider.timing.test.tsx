import { APPEARANCE_STORAGE_KEYS } from '@stockpilot/core';
import * as React from 'react';
import { createRoot, hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE READERS LEARN A FACT BEFORE THE NEXT PAINT (L4 fix round, review
 * findings H1, R1, LG-R2, H2 and LG-R1).
 *
 * Moving the appearance facts out of the context value into a store (BF1)
 * kept the page's server HTML, but it moved the moment a reader learns a
 * fact: a reader of useSyncExternalStore subscribes, and notices a change
 * made since it rendered, only in a passive effect, which React may run after
 * the browser painted. Before, the provider set React state in its mount
 * layout effect, and React rendered every reader again inside that commit.
 *
 * So these tests look at the page at the END OF THE TASK THAT COMMITTED,
 * which is the last moment before the browser can paint: no `act` (it would
 * run the passive effects at once and hide the gap), a layout effect that
 * queues microtasks, and a read of the DOM when they ran.
 *
 *  - On a hard load the header trigger's glass name, the checked radios and
 *    the marketing variant guard have the device facts at that moment.
 *  - A reader inside content React adopts later (a Suspense boundary) has
 *    them at the end of ITS commit.
 *  - When the shell and the Appearance panel mount together on a client
 *    navigation, after the provider had already called the session known
 *    with nobody named, the status line does not hold "Saved on this
 *    device." at that moment for the person the shell is about to name.
 */

const { getMy, setMy, nav } = vi.hoisted(() => ({
  getMy: vi.fn(),
  setMy: vi.fn(),
  nav: { pathname: '/dashboard' },
}));
vi.mock('@/server/actions/appearance', () => ({
  setMyAppearanceAction: (...a: unknown[]) => setMy(...a),
}));
// The account read is a plain request (appearance-account-read.ts), never the
// read action: these tests answer it here.
vi.mock('@/components/theme/appearance-account-read', () => ({
  readAccountAppearance: (...a: unknown[]) => getMy(...a),
}));
vi.mock('sonner', () => ({ toast: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { AppearancePanel } from '@/components/settings/appearance-panel';

import { AppearanceAccountSync, AppearanceProvider, useAppearance } from './appearance-provider';
import { EARLY_HIDE_ATTRIBUTE } from './appearance-script';
import { ThemeProvider } from './theme-provider';

const USER = '11111111-1111-4111-8111-111111111111';
const NO_ACCOUNT_LINE = 'Saved on this device.';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What a reader shows of the appearance. */
function Reader({ id }: { id: string }) {
  const appearance = useAppearance();
  return (
    <i
      data-reader={id}
      data-hydrated={String(appearance?.hydrated)}
      data-glass={String(appearance?.glassApplied)}
      data-theme={String(appearance?.theme)}
    />
  );
}

/** Calls `read` at the end of the task of the commit that mounted it. */
function BeforePaint({ read }: { read: () => void }) {
  React.useLayoutEffect(() => {
    void (async () => {
      // Later than every microtask React itself queues in a commit.
      for (let i = 0; i < 50; i += 1) await null;
      read();
    })();
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

const readerFacts = (id: string): string => {
  const el = document.querySelector(`[data-reader="${id}"]`);
  return el
    ? `hydrated=${el.getAttribute('data-hydrated')} glass=${el.getAttribute('data-glass')} theme=${el.getAttribute('data-theme')}`
    : 'missing';
};

let container: HTMLElement;
let root: Root | null = null;
let actEnvironment: unknown;

/** The server's HTML for a tree, with the server renderer's contexts put back. */
function serverHtml(tree: React.ReactElement): string {
  const html = renderToString(tree);
  // One process plays both sides (appearance-provider.streaming.test.tsx has the reason).
  renderToString(null);
  return html;
}

beforeEach(() => {
  // No act here, on purpose: React schedules its work as it does in a browser.
  actEnvironment = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  getMy.mockReset();
  setMy.mockReset();
  // The account read never answers in these tests: only the load matters.
  getMy.mockReturnValue(new Promise(() => {}));
  setMy.mockReturnValue(new Promise(() => {}));
  nav.pathname = '/dashboard';
  container = document.createElement('div');
  document.body.appendChild(container);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  root?.unmount();
  root = null;
  await sleep(0);
  container.remove();
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = actEnvironment;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = 'sp_style=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  for (const node of document.head.querySelectorAll('style')) node.remove();
  for (const name of ['data-appearance', 'data-lg-material', 'class', 'style']) {
    document.documentElement.removeAttribute(name);
  }
});

describe('a hard load: the readers have the device facts before the first paint after hydration', () => {
  it('Liquid Glass (the default): hydrated, the glass name and the Theme are there at the end of the commit', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const seen: string[] = [];
    const tree = (
      <ThemeProvider>
        <AppearanceProvider>
          <Reader id="shell" />
          <BeforePaint
            read={() =>
              seen.push(
                `${document.documentElement.getAttribute('data-appearance')} ${readerFacts('shell')}`,
              )
            }
          />
        </AppearanceProvider>
      </ThemeProvider>
    );
    container.innerHTML = serverHtml(tree);
    // The server's HTML: nothing of this device is known.
    expect(readerFacts('shell')).toBe('hydrated=false glass=false theme=undefined');
    root = hydrateRoot(container, tree);
    await sleep(100);
    expect(seen).toEqual(['liquid-glass hydrated=true glass=true theme=system']);
    expect(readerFacts('shell')).toBe('hydrated=true glass=true theme=system');
  });

  it('a stored Classic under the default rollout: hydrated and the stored Theme, and no glass', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'classic' }));
    document.cookie = 'sp_style=classic; path=/';
    const seen: string[] = [];
    const tree = (
      <ThemeProvider>
        <AppearanceProvider>
          <Reader id="shell" />
          <BeforePaint
            read={() =>
              seen.push(
                `${document.documentElement.getAttribute('data-appearance')} ${readerFacts('shell')}`,
              )
            }
          />
        </AppearanceProvider>
      </ThemeProvider>
    );
    container.innerHTML = serverHtml(tree);
    root = hydrateRoot(container, tree);
    await sleep(100);
    expect(seen).toEqual(['null hydrated=true glass=false theme=system']);
  });

  it('a reader inside content adopted later has the facts at the end of its own commit', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const seen: string[] = [];
    const tree = (
      <ThemeProvider>
        <AppearanceProvider>
          <main>
            <React.Suspense fallback={null}>
              <Reader id="late" />
              <BeforePaint read={() => seen.push(readerFacts('late'))} />
            </React.Suspense>
          </main>
        </AppearanceProvider>
      </ThemeProvider>
    );
    container.innerHTML = serverHtml(tree);
    expect(readerFacts('late')).toBe('hydrated=false glass=false theme=undefined');
    root = hydrateRoot(container, tree);
    await sleep(200);
    expect(seen).toEqual(['hydrated=true glass=true theme=system']);
  });

  it('the marketing variant guard decides in the hydration commit: the early hide is gone before a paint', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    // A classic marketing page under a cookie that selects classic: a match.
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'classic' }));
    document.cookie = 'sp_style=classic; path=/';
    nav.pathname = '/pricing';
    // The head script's early hide, as a cached document under a changed cookie carries it.
    const hide = document.createElement('style');
    hide.setAttribute(EARLY_HIDE_ATTRIBUTE, '');
    hide.textContent = 'html{visibility:hidden!important}';
    document.head.appendChild(hide);
    const seen: boolean[] = [];
    const tree = (
      <ThemeProvider>
        <AppearanceProvider>
          <BeforePaint
            read={() =>
              seen.push(document.head.querySelector(`style[${EARLY_HIDE_ATTRIBUTE}]`) !== null)
            }
          />
        </AppearanceProvider>
      </ThemeProvider>
    );
    container.innerHTML = serverHtml(tree);
    root = hydrateRoot(container, tree);
    await sleep(100);
    // Still hidden at the end of the commit = a frame could be skipped hidden.
    expect(seen).toEqual([false]);
  });

  it('the crash fallback on a glass twin: the attribute follows the twin on screen before a paint', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    nav.pathname = '/pricing';
    // This tab is held in classic after a glass crash, and the page on screen is the glass twin.
    sessionStorage.setItem(APPEARANCE_STORAGE_KEYS.webFallback, 'shown');
    const seen: (string | null)[] = [];
    const tree = (
      <ThemeProvider>
        <AppearanceProvider>
          <div data-lg-twin="" />
          <BeforePaint
            read={() => seen.push(document.documentElement.getAttribute('data-appearance'))}
          />
        </AppearanceProvider>
      </ThemeProvider>
    );
    container.innerHTML = serverHtml(tree);
    root = hydrateRoot(container, tree);
    await sleep(100);
    expect(seen).toEqual(['liquid-glass']);
  });
});

describe('a client navigation that mounts the shell and the Appearance panel together', () => {
  const region = () => container.querySelector('div[aria-live="polite"]');

  it.each(['default', 'opt-in'] as const)(
    '%s: the status line does not hold the no-account sentence before a paint',
    async (rollout) => {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
      const seen: (string | null)[] = [];
      function Page({ signedIn }: { signedIn: boolean }) {
        return (
          <ThemeProvider>
            <AppearanceProvider>
              {signedIn ? (
                <>
                  <AppearanceAccountSync userId={USER} />
                  <main>
                    <AppearancePanel />
                  </main>
                  <BeforePaint read={() => seen.push(region()?.textContent ?? null)} />
                </>
              ) : (
                <p>Sign in</p>
              )}
            </AppearanceProvider>
          </ThemeProvider>
        );
      }
      // A page with no shell (sign-in): the provider mounts and nobody is named.
      root = createRoot(container);
      root.render(<Page signedIn={false} />);
      await sleep(50);
      expect(getMy).not.toHaveBeenCalled();
      // The client navigation: the shell and the panel arrive in one commit.
      root.render(<Page signedIn />);
      await sleep(100);
      expect(seen).toEqual(['']);
      expect(seen).not.toContain(NO_ACCOUNT_LINE);
      // The person was named after all, and their line is still not the no-account one.
      expect(getMy).toHaveBeenCalledWith(USER);
      expect(region()?.textContent).toBe('');
    },
  );

  it('a page with no shell keeps its line: nobody is named, so "Saved on this device." stays true', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    root = createRoot(container);
    root.render(
      <ThemeProvider>
        <AppearanceProvider>
          <AppearancePanel />
        </AppearanceProvider>
      </ThemeProvider>,
    );
    await sleep(100);
    expect(region()?.textContent).toBe(NO_ACCOUNT_LINE);
  });
});
