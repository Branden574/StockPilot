import { act, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * How the provider reads the signed-in person's account row: by a plain
 * request to POST /api/appearance/account, never through a server action.
 * A server action pending on load holds the hydration of the page's streamed
 * content and a client redirect (measured 2026-11-11); a plain request holds
 * neither. The save stays a server action: it only runs on a choice.
 *
 * The real reader runs here (appearance-account-read.ts) over a stubbed
 * `fetch`, and the action module is a spy that must stay untouched by a read.
 */

const { getMy, setMy, toast, nav, reportError } = vi.hoisted(() => ({
  getMy: vi.fn(),
  setMy: vi.fn(),
  toast: vi.fn(),
  nav: { pathname: '/dashboard' },
  reportError: vi.fn(),
}));
vi.mock('@/server/actions/appearance', () => ({
  getMyAppearanceAction: (...a: unknown[]) => getMy(...a),
  setMyAppearanceAction: (...a: unknown[]) => setMy(...a),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: (...a: unknown[]) => reportError(...a) }));
vi.mock('sonner', () => ({ toast: (...a: unknown[]) => toast(...a) }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ refresh: vi.fn() }),
}));

import {
  AppearanceAccountSync,
  AppearanceProvider,
  INTRO_NOTICE,
  useAppearance,
} from './appearance-provider';
import { ThemeProvider } from './theme-provider';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const STAMP = '2026-11-02T10:00:00.000001+00:00';
const ACCOUNT = '/api/appearance/account';

function Probe() {
  const appearance = useAppearance();
  return (
    <output data-testid="probe">
      {`${appearance?.style ?? 'none'}|${appearance?.status ?? 'unknown'}`}
    </output>
  );
}

function App({ userId = USER }: { userId?: string }) {
  return (
    <ThemeProvider>
      <AppearanceProvider>
        <AppearanceAccountSync userId={userId} />
        <Probe />
      </AppearanceProvider>
    </ThemeProvider>
  );
}

const html = () => document.documentElement;
const glassOn = () => html().getAttribute('data-appearance') === 'liquid-glass';
const probe = () => screen.getByTestId('probe').textContent;
const introCalls = () => toast.mock.calls.filter(([text]) => text === INTRO_NOTICE);

type Answer = () => Promise<Response> | Response;
let accountAnswer: Answer;
let fetchMock: ReturnType<typeof vi.fn>;
let consoleError: ReturnType<typeof vi.spyOn>;
const accountCalls = () =>
  fetchMock.mock.calls.filter(([url]) => url === ACCOUNT) as [string, RequestInit][];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
  nav.pathname = '/dashboard';
  getMy.mockReset();
  setMy.mockReset();
  toast.mockReset();
  reportError.mockReset();
  accountAnswer = () => json({ ok: true, userId: USER, row: null });
  fetchMock = vi.fn(async (url: string) =>
    url === ACCOUNT ? accountAnswer() : new Response(null, { status: 204 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = 'sp_style=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  html().removeAttribute('data-appearance');
  html().removeAttribute('data-lg-material');
  html().removeAttribute('class');
  html().removeAttribute('style');
});

describe('the account read is a plain request, never a server action', () => {
  it('goes to POST /api/appearance/account with the appearance header and the id in the body, once', async () => {
    accountAnswer = () =>
      json({ ok: true, userId: USER, row: { style: 'classic', theme: null, updated_at: STAMP } });
    render(<App />);
    await waitFor(() => expect(probe()).toBe('classic|synced'));
    expect(glassOn()).toBe(false);

    expect(accountCalls()).toHaveLength(1);
    const [url, init] = accountCalls()[0]!;
    expect(url).toBe(ACCOUNT);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json', 'x-sp-appearance': '1' });
    expect(JSON.parse(String(init.body))).toEqual({ userId: USER });
    expect(init.credentials).toBe('same-origin');
    expect(init.cache).toBe('no-store');

    // Neither action ran: the read is not one, and nothing was chosen.
    expect(getMy).not.toHaveBeenCalled();
    expect(setMy).not.toHaveBeenCalled();
  });

  it('a person who never chose keeps the default, and the read counts as done (the intro notice)', async () => {
    render(<App />);
    await waitFor(() => expect(introCalls()).toHaveLength(1));
    expect(glassOn()).toBe(true);
    expect(accountCalls()).toHaveLength(1);
    expect(getMy).not.toHaveBeenCalled();
  });

  it('an answer for another person is not taken', async () => {
    accountAnswer = () =>
      json({ ok: true, userId: OTHER, row: { style: 'classic', theme: null, updated_at: STAMP } });
    render(<App />);
    await waitFor(() => expect(accountCalls()).toHaveLength(1));
    await act(async () => {});
    expect(probe()).toBe('none|idle');
    expect(glassOn()).toBe(true);
    expect(introCalls()).toEqual([]);
  });

  it('a missing table is its own answer: the account store is unavailable, and the read counts as done', async () => {
    accountAnswer = () => json({ ok: false, reason: 'missing-table' });
    render(<App />);
    await waitFor(() => expect(probe()).toBe('none|unavailable'));
    await waitFor(() => expect(introCalls()).toHaveLength(1));
    expect(getMy).not.toHaveBeenCalled();
  });

  it.each<[string, Answer]>([
    ['the route refused the request (403)', () => new Response(null, { status: 403 })],
    ['the route found the body invalid (400)', () => json({ ok: false, reason: 'invalid' }, 400)],
    ['the server failed (500)', () => new Response('Internal Server Error', { status: 500 })],
    ['the session is signed out', () => json({ ok: false, reason: 'unauthenticated' })],
    ['the read failed on the server', () => json({ ok: false, reason: 'error' })],
    ['the body is a page, not the answer', () => new Response('<!doctype html><title>x</title>')],
    ['the network failed', () => Promise.reject(new TypeError('Failed to fetch'))],
    [
      'a navigation tore the request down',
      () => Promise.reject(new DOMException('The operation was aborted.', 'AbortError')),
    ],
  ])('a failed read claims nothing and tells no one: %s', async (_name, answer) => {
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'classic' }));
    // Held until the page has settled, so "as it was" is read first.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    accountAnswer = async () => {
      await held;
      return answer();
    };
    render(<App />);
    await waitFor(() => expect(accountCalls()).toHaveLength(1));
    await act(async () => {});
    const before = probe();
    expect(before).toMatch(/^classic\|/u);
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await act(async () => {});
    // The device's own choice stands, the status is what it was, and the
    // read does not count as done (no intro notice, nothing adopted).
    expect(probe()).toBe(before);
    expect(glassOn()).toBe(false);
    expect(toast).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(getMy).not.toHaveBeenCalled();
    expect(setMy).not.toHaveBeenCalled();
    // And it is not asked again by itself.
    expect(accountCalls()).toHaveLength(1);
  });

  it('sends nothing at all when no page names a signed-in person, and nothing under off', async () => {
    const signedOut = render(
      <ThemeProvider>
        <AppearanceProvider>
          <Probe />
        </AppearanceProvider>
      </ThemeProvider>,
    );
    await waitFor(() => expect(glassOn()).toBe(true));
    await act(async () => {});
    expect(accountCalls()).toEqual([]);
    signedOut.unmount();

    fetchMock.mockClear();
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '');
    render(<App />);
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getMy).not.toHaveBeenCalled();
  });
});
