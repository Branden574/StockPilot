import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import GlobalError from './global-error';

/**
 * The last-resort error page and the way back to Classic (plans/REVISION-
 * DEFAULT.md R13, item 27). It sits outside every provider and its document
 * is never glass, so it decides from what the NEXT load would paint: the
 * rollout (inlined), the sp_style cookie and the path. Under `default` that
 * is glass unless the cookie says classic, so a person who never chose gets
 * the button too; never on the print route; never under `off`.
 */

const reload = vi.fn();

function setPath(path: string) {
  window.history.replaceState(null, '', path);
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
  reload.mockReset();
  vi.spyOn(window.location, 'reload').mockImplementation(reload);
  setPath('/dashboard');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = 'sp_style=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  setPath('/');
});

const button = () => screen.queryByRole('button', { name: 'Use classic design' });

describe('global-error: Use classic design', () => {
  it('default, no cookie (never chose): offered, holds the tab in classic once, and sets the Design', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    render(<GlobalError error={new Error('x')} reset={() => {}} />);
    expect(button()).not.toBeNull();
    expect(sessionStorage.getItem('sp-lg-fallback')).toBe('pending');
    fireEvent.click(button()!);
    expect(document.cookie).toContain('sp_style=classic');
    expect(JSON.parse(localStorage.getItem('sp-appearance')!)).toEqual({ v: 2, style: 'classic' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('default, sp_style=classic: not offered, nothing held', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    document.cookie = 'sp_style=classic; path=/';
    render(<GlobalError error={new Error('x')} reset={() => {}} />);
    expect(button()).toBeNull();
    expect(sessionStorage.getItem('sp-lg-fallback')).toBeNull();
  });

  it('opt-in: only with sp_style=liquid-glass', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'opt-in');
    render(<GlobalError error={new Error('x')} reset={() => {}} />);
    expect(button()).toBeNull();
    cleanup();
    document.cookie = 'sp_style=liquid-glass; path=/';
    render(<GlobalError error={new Error('x')} reset={() => {}} />);
    expect(button()).not.toBeNull();
  });

  it('never on the print route', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    setPath('/dashboard/orders/abc/print');
    render(<GlobalError error={new Error('x')} reset={() => {}} />);
    expect(button()).toBeNull();
  });

  it('never under off', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '');
    document.cookie = 'sp_style=liquid-glass; path=/';
    render(<GlobalError error={new Error('x')} reset={() => {}} />);
    expect(button()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use classic appearance' })).toBeNull();
  });

  it('a server error (it carries a digest) is offered the way back but never holds the tab in classic', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const serverError = Object.assign(new Error('x'), { digest: '2938471' });
    render(<GlobalError error={serverError} reset={() => {}} />);
    expect(button()).not.toBeNull();
    expect(sessionStorage.getItem('sp-lg-fallback')).toBeNull();
  });

  it('cannot know who is signed in, so a sync record left by an account is never marked dirty from here', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const lingering = JSON.stringify({
      v: 2,
      userId: '11111111-1111-4111-8111-111111111111',
      dirtyAxes: [],
      syncedAt: '2026-11-02T10:00:00.000001+00:00',
    });
    localStorage.setItem('sp-appearance-sync', lingering);
    render(<GlobalError error={new Error('x')} reset={() => {}} />);
    fireEvent.click(button()!);
    expect(localStorage.getItem('sp-appearance-sync')).toBe(lingering);
    expect(document.cookie).toContain('sp_style=classic');
  });
});
