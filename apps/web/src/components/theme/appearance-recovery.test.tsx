import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppearanceRecovery } from './appearance-recovery';

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
});
