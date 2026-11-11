import { afterEach, describe, expect, it, vi } from 'vitest';

import { APPEARANCE_STORAGE_KEYS } from '@stockpilot/core';

import {
  EXEMPT_PATHS as FLAG_EXEMPT_PATHS,
  isMarketingPath,
  MARKETING_PATH_PATTERN,
  MARKETING_PATHS,
} from './appearance-flag';
import {
  appearanceScript,
  EARLY_HIDE_ATTRIBUTE,
  EARLY_HIDE_TIMEOUT_MS,
  EXEMPT_PATHS,
  isLowPowerBrowser,
  LOW_POWER_ATTRIBUTE,
  VARIANT_GUARD_STYLE_ATTRIBUTE,
  type LowPowerNavigator,
} from './appearance-script';
import { twinFirstPaintScript } from './twin-first-paint';

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
  vi.useRealTimers();
  document.head.innerHTML = '';
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

/**
 * The early hide on the 7 marketing paths (stage 3 review, finding 2): Back
 * or Forward may read a classic marketing page again from the HTTP cache under
 * a cookie that now selects glass, so the head script hides the page before
 * its first paint whenever it turns glass on there. The twin layout's script
 * removes the hide at once; on a classic body it stays until the variant guard
 * refreshes (or, with no guard, 2 s), and then the attribute follows the
 * classic body. Classic choosers and other paths get nothing.
 */
describe('the early hide on the marketing paths', () => {
  const hides = () => document.head.querySelectorAll(`style[${EARLY_HIDE_ATTRIBUTE}]`);
  const glassCookie = { default: null, 'opt-in': 'liquid-glass' } as const;

  for (const rollout of ['default', 'opt-in'] as const) {
    for (const path of MARKETING_PATHS) {
      it(`${rollout}, ${path}, the cookie selects glass: glass and the guard’s style, marked early, before the first paint`, () => {
        const cookie = glassCookie[rollout];
        if (cookie) document.cookie = `sp_style=${cookie}; path=/`;
        run(rollout, path);
        expect(html().getAttribute('data-appearance')).toBe('liquid-glass');
        const styles = hides();
        expect(styles).toHaveLength(1);
        expect(styles[0]!.hasAttribute(VARIANT_GUARD_STYLE_ATTRIBUTE)).toBe(true);
        expect(styles[0]!.textContent).toBe('html{visibility:hidden!important}');
      });
    }

    it(`${rollout}: a classic chooser on a marketing path gets nothing: <html> byte-identical`, () => {
      document.cookie = 'sp_style=classic; path=/';
      const before = html().outerHTML;
      run(rollout, '/pricing');
      expect(html().outerHTML).toBe(before);
    });

    it(`${rollout}: the twin’s own script, the first thing in its body, removes the hide at once`, () => {
      const cookie = glassCookie[rollout];
      if (cookie) document.cookie = `sp_style=${cookie}; path=/`;
      run(rollout, '/');
      expect(hides()).toHaveLength(1);
      new Function(twinFirstPaintScript(rollout)!)();
      expect(hides()).toHaveLength(0);
      expect(html().getAttribute('data-appearance')).toBe('liquid-glass');
    });
  }

  it('no hide anywhere else, the print route and the crash fallback included', () => {
    for (const path of ['/dashboard', '/signin', '/orders/sign/x', '/contact/x', '/glass-site']) {
      run('default', path);
      expect(hides(), path).toHaveLength(0);
    }
    run('default', '/dashboard/orders/abc/print');
    sessionStorage.setItem('sp-lg-fallback', 'pending');
    run('default', '/');
    expect(hides()).toHaveLength(0);
  });

  it('a classic body (no twin script) with no guard: after 2 s the page shows with the attribute following it, removed', () => {
    vi.useFakeTimers();
    run('default', '/pricing');
    setNavigatorLow();
    expect(hides()).toHaveLength(1);
    vi.advanceTimersByTime(EARLY_HIDE_TIMEOUT_MS - 1);
    expect(hides()).toHaveLength(1);
    expect(html().getAttribute('data-appearance')).toBe('liquid-glass');
    vi.advanceTimersByTime(1);
    expect(hides()).toHaveLength(0);
    expect(html().hasAttribute('data-appearance')).toBe(false);
    expect(html().hasAttribute(LOW_POWER_ATTRIBUTE)).toBe(false);
  });

  it('a guard already hiding the page at 2 s owns the outcome: the early hide and the attribute stay', () => {
    vi.useFakeTimers();
    run('default', '/pricing');
    const own = document.createElement('style');
    own.setAttribute(VARIANT_GUARD_STYLE_ATTRIBUTE, '');
    document.head.appendChild(own);
    vi.advanceTimersByTime(EARLY_HIDE_TIMEOUT_MS);
    expect(hides()).toHaveLength(1);
    expect(html().getAttribute('data-appearance')).toBe('liquid-glass');
  });

  it('a timer after the hide was removed (twin script or guard) changes nothing', () => {
    vi.useFakeTimers();
    run('default', '/');
    for (const node of hides()) node.remove();
    vi.advanceTimersByTime(EARLY_HIDE_TIMEOUT_MS);
    expect(html().getAttribute('data-appearance')).toBe('liquid-glass');
  });
});

/**
 * The spellings the rewrites take (FOLLOWUPS F7): Next matches each marketing
 * rule with no case and an optional trailing slash, and skipTrailingSlashRedirect
 * lets /pricing/ reach it, so /pricing/, /Pricing and /PRICING/ get the twin
 * as /pricing does. The head script must hide exactly there too, from the one
 * shared rule in appearance-flag.ts (isMarketingPath, MARKETING_PATH_PATTERN).
 */
describe('the early hide on every spelling the rewrites take (F7)', () => {
  const hides = () => document.head.querySelectorAll(`style[${EARLY_HIDE_ATTRIBUTE}]`);
  // An address with the page's own origin, so //pricing stays a path.
  const at = (path: string) => `${window.location.origin}${path}`;

  afterEach(() => {
    document.head.innerHTML = '';
  });

  for (const path of ['/pricing/', '/Pricing', '/PRICING/', '/terms/', '/']) {
    it(`${path}: glass and the early hide, as on the path as written`, () => {
      run('default', at(path));
      expect(window.location.pathname).toBe(path);
      expect(html().getAttribute('data-appearance')).toBe('liquid-glass');
      expect(hides()).toHaveLength(1);
    });
  }

  for (const path of ['/pric%69ng', '//pricing', '/pricing//']) {
    it(`${path}: no rewrite takes it, so glass without the hide`, () => {
      run('default', at(path));
      expect(window.location.pathname).toBe(path);
      expect(html().getAttribute('data-appearance')).toBe('liquid-glass');
      expect(hides()).toHaveLength(0);
    });
  }

  it('hides exactly where isMarketingPath says so, under both rollouts that emit the script', () => {
    const paths = [
      ...MARKETING_PATHS,
      '/pricing/',
      '/Pricing',
      '/PRICING/',
      '/Contact/',
      '/sUpPoRt',
      '/terms/',
      '//',
      '/pric%69ng',
      '/%70ricing',
      '//pricing',
      '/pricing//',
      '/contact/x',
      '/glass-site',
      '/dashboard',
    ];
    for (const rollout of ['default', 'opt-in'] as const) {
      for (const path of paths) {
        document.head.innerHTML = '';
        clearCookies();
        if (rollout === 'opt-in') document.cookie = 'sp_style=liquid-glass; path=/';
        run(rollout, at(path));
        expect(hides().length, `${rollout} ${path}`).toBe(isMarketingPath(path) ? 1 : 0);
      }
    }
  });

  it('inlines the one shared pattern, and nothing is emitted under off', () => {
    for (const rollout of ['default', 'opt-in'] as const) {
      expect(appearanceScript(rollout)).toContain(
        `if(${MARKETING_PATH_PATTERN.toString()}.test(location.pathname))`,
      );
    }
    expect(appearanceScript('off')).toBeNull();
  });
});

function setNavigatorLow() {
  // The low-power attribute, when the head script set it, goes with glass.
  html().setAttribute(LOW_POWER_ATTRIBUTE, 'reduced');
}
