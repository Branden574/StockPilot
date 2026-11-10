import { act } from '@testing-library/react';
import * as React from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE STATUS LINE SAYS NOTHING UNTIL THE SESSION IS KNOWN (L4 triage BF2).
 *
 * "Saved on this device." is the line for a person with no account. The
 * server cannot say it: it renders the panel before the page has named its
 * signed-in person to the appearance layer (<AppearanceAccountSync> names
 * them in an effect, so in the browser only). Before the fix the server HTML
 * of Settings > Profile held that sentence for every signed-in person on
 * every full load, inside a polite live region, and the browser then emptied
 * it.
 *
 * So: the server's panel has an empty status line; a signed-in person's line
 * is never that sentence while the page loads; and a person with no account
 * still gets it once the page has loaded and nobody was named.
 */

const { getMy, setMy } = vi.hoisted(() => ({ getMy: vi.fn(), setMy: vi.fn() }));
vi.mock('@/server/actions/appearance', () => ({
  getMyAppearanceAction: (...a: unknown[]) => getMy(...a),
  setMyAppearanceAction: (...a: unknown[]) => setMy(...a),
}));
vi.mock('sonner', () => ({ toast: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/settings/profile',
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { AppearanceAccountSync, AppearanceProvider } from '@/components/theme/appearance-provider';
import { ThemeProvider } from '@/components/theme/theme-provider';

import { AppearancePanel } from './appearance-panel';

const USER = '11111111-1111-4111-8111-111111111111';
const NO_ACCOUNT_LINE = 'Saved on this device.';

/** Settings > Profile as the app composes it: the shell names the person, the page holds the panel. */
function Page({ userId }: { userId?: string }) {
  return (
    <ThemeProvider>
      <AppearanceProvider>
        {userId ? <AppearanceAccountSync userId={userId} /> : null}
        <main>
          <AppearancePanel />
        </main>
      </AppearanceProvider>
    </ThemeProvider>
  );
}

/** The server's HTML for the page. */
function serverHtml(userId?: string): string {
  const html = renderToString(<Page userId={userId} />);
  // One process plays both sides: switch the server renderer's contexts back
  // to their defaults before the browser side starts
  // (appearance-provider.streaming.test.tsx has the reason).
  renderToString(null);
  return html;
}

const liveRegion = (root: ParentNode) => root.querySelector('div[aria-live="polite"]')!;

let container: HTMLElement;
let root: Root | null = null;
/** Every text the status line held in the browser, in order. */
let said: string[] = [];
let observer: MutationObserver | null = null;
let recoverable: unknown[] = [];
let consoleError: ReturnType<typeof vi.spyOn>;

/** Put the server's HTML in the document and let React adopt it, watching the status line. */
async function load(userId?: string): Promise<void> {
  container.innerHTML = serverHtml(userId);
  const region = liveRegion(container);
  said = [region.textContent ?? ''];
  observer = new MutationObserver(() => said.push(region.textContent ?? ''));
  observer.observe(region, { childList: true, subtree: true, characterData: true });
  await act(async () => {
    root = hydrateRoot(container, <Page userId={userId} />, {
      onRecoverableError: (error) => recoverable.push(error),
    });
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // The observer reports in a microtask.
  await Promise.resolve();
  // The server's region is the one on screen (adopted, not rebuilt).
  expect(liveRegion(container)).toBe(region);
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  getMy.mockResolvedValue({ ok: true, userId: USER, row: null });
  setMy.mockResolvedValue({ ok: false });
  container = document.createElement('div');
  document.body.appendChild(container);
  recoverable = [];
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  observer?.disconnect();
  observer = null;
  act(() => root?.unmount());
  root = null;
  container.remove();
  consoleError.mockRestore();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = 'sp_style=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  for (const name of ['data-appearance', 'data-lg-material', 'class', 'style']) {
    document.documentElement.removeAttribute(name);
  }
});

describe.each(['default', 'opt-in'] as const)(
  'the Appearance panel’s status line (%s)',
  (rollout) => {
    beforeEach(() => {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
    });

    it('the server’s HTML for a signed-in person: the live region is empty', () => {
      const holder = document.createElement('div');
      holder.innerHTML = serverHtml(USER);
      const region = liveRegion(holder);
      expect(region).not.toBeNull();
      expect(region.textContent).toBe('');
      expect(region.children).toHaveLength(0);
      expect(holder.innerHTML).not.toContain('Saved on');
    });

    it('the server’s HTML when no person is named: empty as well (the server never knows)', () => {
      const holder = document.createElement('div');
      holder.innerHTML = serverHtml();
      expect(liveRegion(holder).textContent).toBe('');
    });

    it('a signed-in person, through the whole load: the line never says the no-account sentence', async () => {
      await load(USER);
      expect(getMy).toHaveBeenCalledWith(USER);
      expect(said).not.toContain(NO_ACCOUNT_LINE);
      expect(said.join('')).not.toContain('this device');
      // Nothing to save and nothing saved: the line is empty.
      expect(liveRegion(container).textContent).toBe('');
      expect(recoverable).toEqual([]);
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('a signed-in person whose account read is still on the way: still nothing', async () => {
      getMy.mockReturnValue(new Promise(() => {}));
      await load(USER);
      expect(said).not.toContain(NO_ACCOUNT_LINE);
      expect(liveRegion(container).textContent).toBe('');
    });

    it('a person with no account: empty from the server, then the line says where the choice is kept', async () => {
      await load();
      expect(said[0]).toBe('');
      expect(liveRegion(container).textContent).toBe(NO_ACCOUNT_LINE);
      expect(getMy).not.toHaveBeenCalled();
      expect(recoverable).toEqual([]);
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('a person with no account who chooses a Design: the line still says this device', async () => {
      await load();
      const classic = container.querySelector<HTMLInputElement>(
        'input[type="radio"][value="classic"]',
      )!;
      await act(async () => {
        classic.click();
      });
      expect(classic.checked).toBe(true);
      expect(liveRegion(container).textContent).toBe(NO_ACCOUNT_LINE);
      expect(setMy).not.toHaveBeenCalled();
    });
  },
);
