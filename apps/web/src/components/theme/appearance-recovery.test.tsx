import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppearanceRecovery } from './appearance-recovery';

/**
 * "Use classic appearance" in the error boundaries (Liquid Glass plan 5.6):
 * nothing at all in classic, the way back in glass, and the one-time crash
 * fallback that leaves the stored choice alone.
 */

const reload = vi.fn();

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '1');
  reload.mockReset();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload, protocol: 'http:' },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = 'sp_appearance=; path=/; max-age=0';
  document.documentElement.removeAttribute('data-appearance');
});

describe('AppearanceRecovery', () => {
  it('renders nothing in the classic appearances', () => {
    localStorage.setItem(
      'sp-appearance',
      JSON.stringify({ v: 1, mode: 'dark', lastClassic: 'dark' }),
    );
    const { container } = render(<AppearanceRecovery />);
    expect(container).toBeEmptyDOMElement();
    expect(sessionStorage.getItem('sp-lg-fallback')).toBeNull();
  });

  it('renders nothing when this build does not offer Liquid Glass', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '');
    document.documentElement.setAttribute('data-appearance', 'liquid-glass');
    localStorage.setItem(
      'sp-appearance',
      JSON.stringify({ v: 1, mode: 'liquid-glass', lastClassic: 'dark' }),
    );
    const { container } = render(<AppearanceRecovery />);
    expect(container).toBeEmptyDOMElement();
  });

  it('in glass: holds the tab in classic once, keeps the stored choice, and offers the way back', () => {
    document.documentElement.setAttribute('data-appearance', 'liquid-glass');
    localStorage.setItem(
      'sp-appearance',
      JSON.stringify({ v: 1, mode: 'liquid-glass', lastClassic: 'light' }),
    );
    render(<AppearanceRecovery />);
    expect(sessionStorage.getItem('sp-lg-fallback')).toBe('pending');
    expect(JSON.parse(localStorage.getItem('sp-appearance')!).mode).toBe('liquid-glass');

    fireEvent.click(screen.getByRole('button', { name: 'Use classic appearance' }));
    expect(JSON.parse(localStorage.getItem('sp-appearance')!)).toEqual({
      v: 1,
      mode: 'light',
      lastClassic: 'light',
    });
    expect(document.documentElement.hasAttribute('data-appearance')).toBe(false);
    expect(sessionStorage.getItem('sp-lg-fallback')).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
