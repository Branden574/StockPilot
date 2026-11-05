import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildCustomRoute } from 'next/dist/lib/build-custom-route';
import { modifyRouteRegex } from 'next/dist/lib/redirect-status';
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';
import { prepareDestination } from 'next/dist/shared/lib/router/utils/prepare-destination';
import { GLASS_ROLLOUTS, parseRollout } from '@stockpilot/core';

import {
  EXEMPT_PATHS,
  glassSiteRedirects,
  isLiquidGlassEnabled,
  isMarketingPath,
  LIQUID_GLASS_FLAG_NAME,
  liquidGlassRollout,
  MARKETING_PATH_PATTERN,
  MARKETING_PATHS,
  MARKETING_TWINS_BUILT,
  marketingRewrites,
  twinSelected,
  type MarketingRewrite,
} from './appearance-flag';

/**
 * The kill switch with three values (plans/REVISION-DEFAULT.md R5, R8, section
 * 9 item 7): off, opt-in, default. Anything else reads as off.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

const web = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(web, p), 'utf8');

describe('the Liquid Glass rollout flag', () => {
  it('reads exactly opt-in or default; unset, the stage 2 value 1 and garbage read as off', () => {
    expect(LIQUID_GLASS_FLAG_NAME).toBe('NEXT_PUBLIC_LIQUID_GLASS');
    for (const value of ['', '0', '1', 'true', 'on', 'Default', ' default', 'opt_in', 'optin']) {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', value);
      expect(liquidGlassRollout(), JSON.stringify(value)).toBe('off');
      expect(isLiquidGlassEnabled(), JSON.stringify(value)).toBe(false);
    }
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'opt-in');
    expect(liquidGlassRollout()).toBe('opt-in');
    expect(isLiquidGlassEnabled()).toBe(true);
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    expect(liquidGlassRollout()).toBe('default');
    expect(isLiquidGlassEnabled()).toBe(true);
  });

  it('agrees with core parseRollout on every value (this module imports nothing, so it keeps its own copy)', () => {
    for (const value of [...GLASS_ROLLOUTS, '', '1', 'DEFAULT', 'opt-in ', 'x']) {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', value);
      expect(liquidGlassRollout(), value).toBe(parseRollout(value));
    }
  });

  it('the access is the literal process.env.NEXT_PUBLIC_LIQUID_GLASS, so Next inlines it', () => {
    expect(read('src/components/theme/appearance-flag.ts')).toContain(
      'process.env.NEXT_PUBLIC_LIQUID_GLASS',
    );
  });

  it('imports nothing (next.config.ts and global-error.tsx read it)', () => {
    expect(read('src/components/theme/appearance-flag.ts')).not.toMatch(/^import /mu);
  });
});

describe('the /glass-site/* redirect', () => {
  it('is unconditional in every rollout, so a twin URL never forces glass and is never indexed', () => {
    expect(glassSiteRedirects()).toEqual([
      { source: '/glass-site', destination: '/', permanent: false },
      { source: '/glass-site/:path*', destination: '/:path*', permanent: false },
    ]);
    for (const rule of glassSiteRedirects()) {
      expect(Object.keys(rule).sort(), rule.source).toEqual(['destination', 'permanent', 'source']);
    }
  });

  it('sends every twin address, the landing twin’s bare /glass-site included, to a non-empty public path (Next’s own matcher, first rule wins)', () => {
    // An empty destination becomes an empty Location header, which a browser
    // resolves to the address it asked for: /glass-site redirected to itself.
    const twins = [
      ...MARKETING_PATHS.map((path) => [path === '/' ? '/glass-site' : `/glass-site${path}`, path]),
      ['/glass-site/contact/anything', '/contact/anything'],
    ];
    for (const [twin, publicPath] of twins) {
      let destination: string | null = null;
      for (const rule of glassSiteRedirects()) {
        const params = getPathMatch(rule.source, { removeUnnamedParams: true, strict: true })(
          twin!,
        );
        if (!params) continue;
        destination = prepareDestination({
          appendParamsToQuery: false,
          destination: rule.destination,
          params,
          query: {},
        }).newUrl;
        break;
      }
      expect(destination, twin).toBe(publicPath);
    }
  });
});

/**
 * Every spelling of a marketing path that the rewrites take (FOLLOWUPS F7).
 * Next compiles each beforeFiles rule with no case and an optional trailing
 * slash (/pricing: ^/pricing(?:/)?$, caseSensitive false), and next.config.ts
 * sets skipTrailingSlashRedirect, so /pricing/ reaches the rule instead of a
 * 308 to /pricing. The head script and the variant guard must take the same
 * spellings, from one rule: one trailing slash dropped (never from / itself),
 * compared without case, over the raw pathname.
 */
const MARKETING_SPELLINGS = [
  ...MARKETING_PATHS,
  '/pricing/',
  '/Pricing',
  '/PRICING/',
  '/terms/',
  '/Contact/',
  '/sUpPoRt',
  '/PRIVACY',
  '/security/',
  // The root rule is ^/(?:/)?$, so it takes // too (next start answers // with
  // a 308 to / before any rule, as it does //pricing).
  '//',
];
const NOT_MARKETING = [
  '',
  '///',
  // A percent-encoded letter is not the letter: the rule reads the raw path.
  '/pric%69ng',
  '/%70ricing',
  '/pricing%2F',
  '/%2F',
  // Only one trailing slash, and only at the end.
  '/pricing//',
  '//pricing',
  '//pricing/',
  // Case without Unicode folding, as Next's /i: U+017F (long s) is not s.
  '/ſecurity',
  '/contact/x',
  '/contacts',
  '/xcontact',
  '/glass-site',
  '/glass-site/contact',
  '/signin',
  '/dashboard',
  '/support/tickets',
  '/terms.txt',
  ' /pricing',
  '/pricing ',
];

/** The rule as written: one trailing slash dropped (never from /), no case. */
function byTheRule(pathname: string): boolean {
  const trimmed = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return (MARKETING_PATHS as readonly string[]).includes(trimmed.toLowerCase());
}

describe('the marketing paths in every spelling the rewrites take (F7)', () => {
  it('matches the 7 marketing paths as written', () => {
    for (const path of MARKETING_PATHS) {
      expect(MARKETING_PATH_PATTERN.test(path), path).toBe(true);
      expect(isMarketingPath(path), path).toBe(true);
    }
  });

  it('takes one trailing slash and any case: /pricing/, /Pricing, /PRICING/, /terms/ and /', () => {
    // '/contact/' and '//' were asserted not to be marketing paths before F7.
    // Both reach a twin: Next's /contact rule takes /contact/ (an optional
    // trailing slash, and skipTrailingSlashRedirect lets it through), and its /
    // rule takes //. So both are marketing paths now.
    for (const path of MARKETING_SPELLINGS) {
      expect(byTheRule(path), `the rule: ${path}`).toBe(true);
      expect(MARKETING_PATH_PATTERN.test(path), `the head script's pattern: ${path}`).toBe(true);
      expect(isMarketingPath(path), `the guard: ${path}`).toBe(true);
    }
  });

  it('refuses a percent-encoded letter (/pric%69ng), a doubled slash (//pricing), a second trailing slash and every other path', () => {
    for (const path of NOT_MARKETING) {
      expect(byTheRule(path), `the rule: ${JSON.stringify(path)}`).toBe(false);
      expect(
        MARKETING_PATH_PATTERN.test(path),
        `the head script's pattern: ${JSON.stringify(path)}`,
      ).toBe(false);
      expect(isMarketingPath(path), `the guard: ${JSON.stringify(path)}`).toBe(false);
    }
  });

  it('agrees with Next’s own matchers for the rewrite rules on every spelling: next start’s and the routes-manifest’s', () => {
    // next start: server/lib/router-utils/filesystem.js buildCustomRoute
    // ('before_files_rewrite', item): getPathMatch strict, unnamed params
    // removed, modifyRouteRegex (the optional trailing slash), and no
    // caseSensitive argument, so no case.
    // The routes-manifest (what Vercel reads): lib/build-custom-route.js's
    // regex, matched without case because routes-manifest caseSensitive is
    // !!experimental.caseSensitiveRoutes, which next.config.ts leaves unset.
    const config = read('next.config.ts');
    expect(config).not.toContain('caseSensitiveRoutes');
    expect(config).toMatch(/^\s*skipTrailingSlashRedirect: true,$/mu);
    for (const rollout of ['default', 'opt-in'] as const) {
      const rules = marketingRewrites(rollout);
      const nextStart = rules.map((rule) =>
        getPathMatch(rule.source, {
          strict: true,
          removeUnnamedParams: true,
          regexModifier: (regex: string) => modifyRouteRegex(regex),
        }),
      );
      const manifest = rules.map(
        (rule) => new RegExp(buildCustomRoute('rewrite', rule).regex, 'i'),
      );
      for (const path of [...MARKETING_SPELLINGS, ...NOT_MARKETING]) {
        const at = `${rollout} ${JSON.stringify(path)}`;
        const rewritten = nextStart.some((match) => match(path) !== false);
        expect(
          manifest.some((regex) => regex.test(path)),
          `manifest ${at}`,
        ).toBe(rewritten);
        expect(isMarketingPath(path), at).toBe(rewritten);
        expect(MARKETING_PATH_PATTERN.test(path), at).toBe(rewritten);
      }
    }
  });
});

describe('the marketing rewrites (R8)', () => {
  it('lists the 7 marketing paths', () => {
    expect(MARKETING_PATHS).toEqual([
      '/',
      '/contact',
      '/pricing',
      '/privacy',
      '/security',
      '/support',
      '/terms',
    ]);
  });

  it('off: no rewrites', () => {
    expect(marketingRewrites('off')).toEqual([]);
  });

  it('default: every marketing path goes to its twin unless sp_style=classic', () => {
    expect(marketingRewrites('default')).toEqual(
      MARKETING_PATHS.map((path) => ({
        source: path,
        destination: path === '/' ? '/glass-site' : `/glass-site${path}`,
        missing: [{ type: 'cookie', key: 'sp_style', value: 'classic' }],
      })),
    );
  });

  it('opt-in: only with sp_style=liquid-glass', () => {
    expect(marketingRewrites('opt-in')).toEqual(
      MARKETING_PATHS.map((path) => ({
        source: path,
        destination: path === '/' ? '/glass-site' : `/glass-site${path}`,
        has: [{ type: 'cookie', key: 'sp_style', value: 'liquid-glass' }],
      })),
    );
  });

  /** Next's has/missing semantics for one cookie rule: an exact value match. */
  function fires(rule: MarketingRewrite, cookie: string | null): boolean {
    const matches = (c: { key: string; value: string }) =>
      c.key === 'sp_style' && cookie !== null && new RegExp(`^${c.value}$`, 'u').test(cookie);
    if (rule.has && !rule.has.every(matches)) return false;
    if (rule.missing && rule.missing.some(matches)) return false;
    return true;
  }

  it('twinSelected is exactly "the rewrite fires" for every rollout and cookie value', () => {
    const cookies = [null, '', 'classic', 'liquid-glass', 'Classic', 'dark', 'garbage'];
    for (const rollout of GLASS_ROLLOUTS) {
      const rules = marketingRewrites(rollout);
      for (const cookie of cookies) {
        const expected = rules.length > 0 && rules.every((rule) => fires(rule, cookie));
        expect(twinSelected(rollout, cookie), `${rollout} ${String(cookie)}`).toBe(expected);
      }
    }
  });

  it('next.config.ts wires the rewrites exactly when the twins are built (stage 3)', () => {
    const config = read('next.config.ts');
    expect(config).toContain('redirects()');
    expect(config).toContain('glassSiteRedirects()');
    if (MARKETING_TWINS_BUILT) {
      expect(config).toMatch(
        /async rewrites\(\)[\s\S]*marketingRewrites\(liquidGlassRollout\(\)\)/u,
      );
    } else {
      expect(config).not.toMatch(/async rewrites\(\)/u);
    }
  });
});

describe('EXEMPT_PATHS (R6)', () => {
  it('matches the order print route and nothing else', () => {
    for (const path of [
      '/dashboard/orders/abc/print',
      '/dashboard/orders/11111111-1111-4111-8111-111111111111/print',
      '/dashboard/orders/abc/print/',
    ]) {
      expect(EXEMPT_PATHS.test(path), path).toBe(true);
    }
    for (const path of [
      '/orders/sign/x',
      '/dashboard/orders/abc',
      '/dashboard/orders/print',
      '/dashboard/orders/a/b/print',
      '/dashboard/orders/abc/print/x',
      '/dashboard/inventory/labels',
      '/x/dashboard/orders/abc/print',
    ]) {
      expect(EXEMPT_PATHS.test(path), path).toBe(false);
    }
  });

  it('matches exactly one route of the app: the print page', async () => {
    const { readdirSync, statSync } = await import('node:fs');
    const app = join(web, 'src', 'app');
    const routes: string[] = [];
    const walk = (dir: string, segments: string[]) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          // Route groups and parallel/private folders do not appear in the URL.
          const inUrl = !/^\(.*\)$/u.test(name) && !name.startsWith('@') && !name.startsWith('_');
          walk(full, inUrl ? [...segments, name] : segments);
        } else if (/^page\.tsx?$/u.test(name)) {
          routes.push(`/${segments.map((s) => s.replace(/^\[.*\]$/u, 'x')).join('/')}`);
        }
      }
    };
    walk(app, []);
    expect(routes.length).toBeGreaterThan(50);
    expect(routes.filter((route) => EXEMPT_PATHS.test(route))).toEqual([
      '/dashboard/orders/x/print',
    ]);
  });
});
