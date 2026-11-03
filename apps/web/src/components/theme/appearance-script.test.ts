import { afterEach, describe, expect, it } from 'vitest';

import { APPEARANCE_STORAGE_KEYS } from '@stockpilot/core';

import { EXEMPT_PATHS as FLAG_EXEMPT_PATHS } from './appearance-flag';
import {
  appearanceScript,
  EXEMPT_PATHS,
  isLowPowerBrowser,
  LOW_POWER_ATTRIBUTE,
  type LowPowerNavigator,
} from './appearance-script';

/**
 * The first-paint script (plans/REVISION-DEFAULT.md R6, R7; section 9 items
 * 8 and 40). Cookie only (`sp_style`), never localStorage. Under `default` it
 * sets glass unless the cookie says classic; under `opt-in` only when it says
 * liquid-glass; under `off` it is not emitted. It skips the print route and the
 * crash fallback, and adds the low-power attribute only where deviceMemory is
 * reported. Anything that is not glass leaves <html> byte-identical.
 */

function clearCookies() {
  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0]!.trim();
    if (name) document.cookie = `${name}=; path=/; max-age=0`;
  }
}

const html = () => document.documentElement;

function setNavigator(nav: Partial<LowPowerNavigator>) {
  for (const key of ['deviceMemory', 'hardwareConcurrency'] as const) {
    Object.defineProperty(window.navigator, key, {
      configurable: true,
      get: () => nav[key],
    });
  }
}

function run(rollout: 'opt-in' | 'default', path = '/dashboard') {
  window.history.replaceState(null, '', path);
  const script = appearanceScript(rollout);
  if (script === null) throw new Error('no script');
  // The script as the browser runs it: a classic inline script, no module.
  new Function(script)();
}

afterEach(() => {
  clearCookies();
  sessionStorage.clear();
  localStorage.clear();
  html().removeAttribute('data-appearance');
  html().removeAttribute(LOW_POWER_ATTRIBUTE);
  html().className = '';
  setNavigator({ deviceMemory: undefined, hardwareConcurrency: 8 });
  window.history.replaceState(null, '', '/');
});

describe('the first-paint appearance script', () => {
  it('is not emitted under off', () => {
    expect(appearanceScript('off')).toBeNull();
  });

  it('reads only the sp_style cookie and the fallback flag: never localStorage', () => {
    for (const rollout of ['opt-in', 'default'] as const) {
      const script = appearanceScript(rollout)!;
      expect(script).toContain(`${APPEARANCE_STORAGE_KEYS.webCookie}=`);
      expect(APPEARANCE_STORAGE_KEYS.webCookie).toBe('sp_style');
      expect(script).toContain(APPEARANCE_STORAGE_KEYS.webFallback);
      expect(script).not.toMatch(/localStorage|fetch|classList|\.style/u);
    }
  });

  it('default, no cookie: glass', () => {
    run('default');
    expect(html().getAttribute('data-appearance')).toBe('liquid-glass');
  });

  it('default, a malformed or legacy cookie means never chose: glass', () => {
    for (const value of ['', 'Classic', 'dark', 'liquid-glasses']) {
      document.cookie = `sp_style=${value}; path=/`;
      run('default');
      expect(html().getAttribute('data-appearance'), value).toBe('liquid-glass');
      html().removeAttribute('data-appearance');
    }
  });

  it('opt-in, no cookie: nothing', () => {
    const before = html().outerHTML;
    run('opt-in');
    expect(html().outerHTML).toBe(before);
  });

  it('opt-in, sp_style=liquid-glass: glass', () => {
    document.cookie = 'sp_style=liquid-glass; path=/';
    run('opt-in');
    expect(html().getAttribute('data-appearance')).toBe('liquid-glass');
  });

  it.each(['default', 'opt-in'] as const)(
    '%s, sp_style=classic: <html> byte-identical',
    (rollout) => {
      html().className = 'dark font-var';
      document.cookie = 'sp_style=classic; path=/';
      document.cookie = 'unrelated=liquid-glass; path=/';
      setNavigator({ deviceMemory: 1, hardwareConcurrency: 1 });
      const before = html().outerHTML;
      run(rollout);
      expect(html().outerHTML).toBe(before);
    },
  );

  it('ignores the stage 2 cookie name', () => {
    document.cookie = 'sp_appearance=liquid-glass; path=/';
    const before = html().outerHTML;
    run('opt-in');
    expect(html().outerHTML).toBe(before);
  });

  it('leaves the colour scheme to next-themes: the class is untouched', () => {
    html().className = 'light';
    run('default');
    expect(html().className).toBe('light');
  });

  it('the print route is never glass, even with no cookie under default', () => {
    const before = html().outerHTML;
    run('default', '/dashboard/orders/abc/print');
    expect(html().outerHTML).toBe(before);
  });

  it('the signature page is not exempt as a route: glass around its pad', () => {
    run('default', '/orders/sign/x');
    expect(html().getAttribute('data-appearance')).toBe('liquid-glass');
  });

  it('the one-time crash fallback wins', () => {
    sessionStorage.setItem('sp-lg-fallback', 'pending');
    document.cookie = 'sp_style=liquid-glass; path=/';
    const before = html().outerHTML;
    run('default');
    expect(html().outerHTML).toBe(before);
  });

  it('never throws when sessionStorage is blocked, and still paints the chosen design', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    try {
      expect(() => run('default')).not.toThrow();
      // The provider treats blocked storage as "no fallback" too, so the two agree.
      expect(html().getAttribute('data-appearance')).toBe('liquid-glass');
    } finally {
      if (original) Object.defineProperty(window, 'sessionStorage', original);
    }
  });

  it('uses the same EXEMPT_PATHS as the flag module', () => {
    expect(EXEMPT_PATHS).toBe(FLAG_EXEMPT_PATHS);
    expect(appearanceScript('default')).toContain(EXEMPT_PATHS.source);
  });
});

describe('the low-power material (R7)', () => {
  const MATRIX: [Partial<LowPowerNavigator>, boolean][] = [
    [{ deviceMemory: undefined, hardwareConcurrency: 1 }, false],
    [{ deviceMemory: undefined, hardwareConcurrency: 2 }, false],
    [{ deviceMemory: undefined, hardwareConcurrency: 8 }, false],
    [{ deviceMemory: 0.5, hardwareConcurrency: 8 }, true],
    [{ deviceMemory: 2, hardwareConcurrency: 8 }, true],
    [{ deviceMemory: 4, hardwareConcurrency: 2 }, true],
    [{ deviceMemory: 4, hardwareConcurrency: 4 }, false],
    [{ deviceMemory: 8, hardwareConcurrency: 16 }, false],
    [{ deviceMemory: 4, hardwareConcurrency: undefined }, false],
  ];

  it.each(MATRIX)('%o -> %s, the same in the head script and in isLowPowerBrowser', (nav, low) => {
    expect(isLowPowerBrowser(nav as LowPowerNavigator)).toBe(low);
    setNavigator(nav);
    run('default');
    expect(html().getAttribute('data-appearance')).toBe('liquid-glass');
    expect(html().getAttribute(LOW_POWER_ATTRIBUTE)).toBe(low ? 'reduced' : null);
  });

  it('never set when the script does not turn glass on', () => {
    setNavigator({ deviceMemory: 1, hardwareConcurrency: 1 });
    run('opt-in');
    expect(html().hasAttribute(LOW_POWER_ATTRIBUTE)).toBe(false);
  });
});
