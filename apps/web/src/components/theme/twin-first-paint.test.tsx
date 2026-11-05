import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { twinSelected, type LiquidGlassRollout } from './appearance-flag';
import {
  EARLY_HIDE_ATTRIBUTE,
  EARLY_HIDE_TIMEOUT_MS,
  removeEarlyHide,
  twinFirstPaintScript,
  VARIANT_GUARD_STYLE_ATTRIBUTE,
} from './twin-first-paint';

/**
 * The twin's first-paint check (twin-first-paint.ts): a twin document read
 * again from the HTTP cache under a cookie that no longer selects it is
 * hidden before it paints, until the variant guard has decided. The browser
 * half is tests/e2e/appearance/variant-guard.spec.ts ("Back after a
 * whole-document link").
 */

vi.mock('@/components/marketing/glass/site-footer', () => ({
  SiteFooter: () => <footer>footer</footer>,
}));
vi.mock('@/components/marketing/json-ld', () => ({
  MarketingJsonLd: () => null,
}));

import GlassSiteLayout from '@/app/(site-glass)/glass-site/layout';

const COOKIES: Array<string | null> = [null, 'classic', 'liquid-glass', 'something-else', ''];

function setCookie(value: string | null) {
  document.cookie = 'sp_style=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  if (value !== null) document.cookie = `sp_style=${value}; path=/`;
}

const earlyHides = () => document.head.querySelectorAll(`style[${EARLY_HIDE_ATTRIBUTE}]`);

beforeEach(() => {
  document.head.innerHTML = '';
  setCookie(null);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  setCookie(null);
});

describe('twinFirstPaintScript', () => {
  it('is null under off: no twin is served', () => {
    expect(twinFirstPaintScript('off')).toBeNull();
  });

  for (const rollout of ['default', 'opt-in'] as LiquidGlassRollout[]) {
    for (const cookie of COOKIES) {
      const hides = !twinSelected(rollout, cookie);
      it(`${rollout}, sp_style=${JSON.stringify(cookie)}: ${hides ? 'hides the page' : 'touches nothing'} (as twinSelected says)`, () => {
        setCookie(cookie);
        new Function(twinFirstPaintScript(rollout)!)();
        const styles = earlyHides();
        expect(styles).toHaveLength(hides ? 1 : 0);
        if (hides) {
          expect(styles[0]!.hasAttribute(VARIANT_GUARD_STYLE_ATTRIBUTE)).toBe(true);
          expect(styles[0]!.textContent).toBe('html{visibility:hidden!important}');
        } else {
          expect(document.head.innerHTML).toBe('');
        }
      });
    }
  }

  it('shows the page again after the guard’s 2 s if nothing removed the hide (no bundle)', () => {
    vi.useFakeTimers();
    setCookie('classic');
    new Function(twinFirstPaintScript('default')!)();
    expect(earlyHides()).toHaveLength(1);
    vi.advanceTimersByTime(EARLY_HIDE_TIMEOUT_MS - 1);
    expect(earlyHides()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(earlyHides()).toHaveLength(0);
  });

  it('a timer after the guard removed the hide does nothing', () => {
    vi.useFakeTimers();
    setCookie('classic');
    new Function(twinFirstPaintScript('default')!)();
    removeEarlyHide();
    expect(() => vi.advanceTimersByTime(EARLY_HIDE_TIMEOUT_MS)).not.toThrow();
    expect(document.head.innerHTML).toBe('');
  });

  it('removeEarlyHide removes only the early hide, never the guard’s own', () => {
    setCookie('classic');
    new Function(twinFirstPaintScript('default')!)();
    const own = document.createElement('style');
    own.setAttribute(VARIANT_GUARD_STYLE_ATTRIBUTE, '');
    document.head.appendChild(own);
    removeEarlyHide();
    expect(earlyHides()).toHaveLength(0);
    expect(document.head.querySelectorAll(`style[${VARIANT_GUARD_STYLE_ATTRIBUTE}]`)).toHaveLength(
      1,
    );
  });
});

describe('the glass-site layout', () => {
  it('runs the check first, ahead of every word of the twin, in a hidden element (server HTML only)', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const html = renderToString(
      <GlassSiteLayout>
        <main>
          <h1>Page</h1>
        </main>
      </GlassSiteLayout>,
    );
    const host = document.createElement('div');
    host.innerHTML = html;
    const root = host.querySelector('[data-lg-twin]')!;
    const first = root.firstElementChild!;
    expect(first.tagName).toBe('DIV');
    expect(first.hasAttribute('hidden')).toBe(true);
    expect(first.innerHTML).toBe(`<script>${twinFirstPaintScript('default')}</script>`);
    expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('<h1>'));
  });

  it('carries the opt-in rollout’s test under opt-in, and nothing under off', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'opt-in');
    expect(renderToString(<GlassSiteLayout>x</GlassSiteLayout>)).toContain(
      twinFirstPaintScript('opt-in')!,
    );
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'off');
    expect(renderToString(<GlassSiteLayout>x</GlassSiteLayout>)).not.toContain('<script>');
  });
});
