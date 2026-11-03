import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getMy, setMy } = vi.hoisted(() => ({ getMy: vi.fn(), setMy: vi.fn() }));
vi.mock('@/server/actions/appearance', () => ({
  getMyAppearanceAction: (...a: unknown[]) => getMy(...a),
  setMyAppearanceAction: (...a: unknown[]) => setMy(...a),
}));
vi.mock('sonner', () => ({ toast: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { AppearanceAccountSync, AppearanceProvider } from './appearance-provider';
import { AppearanceRecovery } from './appearance-recovery';
import { ThemeProvider } from './theme-provider';

/**
 * "Use classic design" in the error boundaries (plan 5.6; plans/REVISION-
 * DEFAULT.md R13, item 27): offered whenever glass is SHOWN (the attribute on
 * <html>), so never in classic and never on the print route; nothing at all
 * under the `off` rollout; and the one-time crash fallback that leaves the
 * stored choice alone.
 */

const reload = vi.fn();

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  reload.mockReset();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload, protocol: 'http:' },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = 'sp_style=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  document.documentElement.removeAttribute('data-appearance');
});

describe('AppearanceRecovery', () => {
  it('renders nothing when glass is not on screen, even if the stored Design is Liquid Glass', () => {
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'liquid-glass' }));
    document.cookie = 'sp_style=liquid-glass; path=/';
    const { container } = render(<AppearanceRecovery />);
    expect(container).toBeEmptyDOMElement();
    expect(sessionStorage.getItem('sp-lg-fallback')).toBeNull();
  });

  it('renders nothing under the off rollout', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '');
    document.documentElement.setAttribute('data-appearance', 'liquid-glass');
    const { container } = render(<AppearanceRecovery />);
    expect(container).toBeEmptyDOMElement();
    expect(sessionStorage.getItem('sp-lg-fallback')).toBeNull();
  });

  it('in glass shown by default (no choice stored): offers Use classic design, which sets the Design and keeps the Theme', () => {
    document.documentElement.setAttribute('data-appearance', 'liquid-glass');
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, theme: 'dark' }));
    render(<AppearanceRecovery />);
    expect(sessionStorage.getItem('sp-lg-fallback')).toBe('pending');
    // The stored choice is untouched until the person picks the action.
    expect(JSON.parse(localStorage.getItem('sp-appearance')!)).toEqual({ v: 2, theme: 'dark' });

    fireEvent.click(screen.getByRole('button', { name: 'Use classic design' }));
    expect(JSON.parse(localStorage.getItem('sp-appearance')!)).toEqual({
      v: 2,
      style: 'classic',
      theme: 'dark',
    });
    expect(document.cookie).toContain('sp_style=classic');
    expect(document.documentElement.hasAttribute('data-appearance')).toBe(false);
    expect(sessionStorage.getItem('sp-lg-fallback')).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('no longer says "appearance"', () => {
    document.documentElement.setAttribute('data-appearance', 'liquid-glass');
    render(<AppearanceRecovery />);
    expect(screen.queryByRole('button', { name: 'Use classic appearance' })).toBeNull();
  });

  it('a server error (it carries a digest) never holds the tab in classic: the server renders every page the same in both designs', () => {
    document.documentElement.setAttribute('data-appearance', 'liquid-glass');
    const message = 'An error occurred in the Server Components render.';
    const serverError = Object.assign(new Error(message), { digest: '2938471' });
    render(<AppearanceRecovery error={serverError} />);
    expect(sessionStorage.getItem('sp-lg-fallback')).toBeNull();
    // The way back is still offered.
    expect(screen.getByRole('button', { name: 'Use classic design' })).toBeInTheDocument();
  });

  it('an error thrown in the browser (no digest) holds the tab in classic once, as before', () => {
    document.documentElement.setAttribute('data-appearance', 'liquid-glass');
    render(<AppearanceRecovery error={new Error('boom')} />);
    expect(sessionStorage.getItem('sp-lg-fallback')).toBe('pending');
  });
});

/**
 * Who the Design is marked dirty for (R4, SR1, SR4; item 12: "for the
 * signed-in person"). A sync record can outlive its session (the error card's
 * Sign out and back in, an expired session), so a record naming someone is no
 * proof they are signed in. Only the person a page named to the provider
 * (<AppearanceAccountSync>: the dashboard shell, the portal) is.
 */
describe('AppearanceRecovery inside the app: the account it marks', () => {
  const USER = '11111111-1111-4111-8111-111111111111';
  const STAMP = '2026-11-02T10:00:00.000001+00:00';
  const sync = () => JSON.parse(localStorage.getItem('sp-appearance-sync') ?? 'null') as unknown;

  beforeEach(() => {
    getMy.mockReset();
    setMy.mockReset();
    getMy.mockResolvedValue({
      ok: true,
      userId: USER,
      row: { style: null, theme: null, updated_at: STAMP },
    });
    localStorage.setItem(
      'sp-appearance-sync',
      JSON.stringify({ v: 2, userId: USER, dirtyAxes: [], syncedAt: STAMP }),
    );
    // Glass on screen, as the head script paints it under `default`.
    document.documentElement.setAttribute('data-appearance', 'liquid-glass');
  });

  it('the signed-in person the page named: their Design is marked dirty, to be saved after the reload', async () => {
    render(
      <ThemeProvider>
        <AppearanceProvider>
          <AppearanceAccountSync userId={USER} />
          <AppearanceRecovery />
        </AppearanceProvider>
      </ThemeProvider>,
    );
    await waitFor(() => expect(getMy).toHaveBeenCalledWith(USER));
    fireEvent.click(screen.getByRole('button', { name: 'Use classic design' }));
    expect(sync()).toEqual({ v: 2, userId: USER, dirtyAxes: ['style'], syncedAt: STAMP });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('no one named (a signed-out page): a leftover sync record is left alone', () => {
    render(
      <ThemeProvider>
        <AppearanceProvider>
          <AppearanceRecovery />
        </AppearanceProvider>
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use classic design' }));
    expect(sync()).toEqual({ v: 2, userId: USER, dirtyAxes: [], syncedAt: STAMP });
    expect(JSON.parse(localStorage.getItem('sp-appearance')!)).toMatchObject({ style: 'classic' });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
