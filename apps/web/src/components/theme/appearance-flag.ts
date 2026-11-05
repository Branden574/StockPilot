/**
 * The Liquid Glass kill switch (stockpilot-work/liquid-glass/plans/
 * REVISION-DEFAULT.md R5, R6, R8). One build-time flag,
 * NEXT_PUBLIC_LIQUID_GLASS, with three values:
 *   off      classic for everyone: no head script, today's exact selectors,
 *            the provider inert; every stored choice is kept, none is shown;
 *   opt-in   classic unless the person chose Liquid Glass;
 *   default  Liquid Glass unless the person chose Classic.
 * Anything else, unset and the stage 2 value `1` included, reads as `off`
 * (the same rule as core's parseRollout; appearance-flag.test.ts pins the two
 * together, because this module imports nothing).
 *
 * The access is a LITERAL `process.env.NEXT_PUBLIC_LIQUID_GLASS` so Next
 * inlines it into the browser bundle at build time (lib/env.client.ts explains
 * why a dynamic lookup would not be inlined). Plain module, NO IMPORTS, so
 * next.config.ts and app/global-error.tsx (which may import only modules that
 * import nothing) can read it too.
 */
export const LIQUID_GLASS_FLAG_NAME = 'NEXT_PUBLIC_LIQUID_GLASS';

/** The three rollouts (core's GlassRollout, written out: no imports here). */
export type LiquidGlassRollout = 'off' | 'opt-in' | 'default';

/** The rollout this build was made with. */
export function liquidGlassRollout(): LiquidGlassRollout {
  const value = process.env.NEXT_PUBLIC_LIQUID_GLASS;
  return value === 'opt-in' || value === 'default' ? value : 'off';
}

/** True when this build offers Liquid Glass at all (opt-in or default). */
export function isLiquidGlassEnabled(): boolean {
  return liquidGlassRollout() !== 'off';
}

/** The Design cookie (core APPEARANCE_STORAGE_KEYS.webCookie, written out). */
const STYLE_COOKIE = 'sp_style';

/**
 * The one route that is never glass (R6): the order print page, which is
 * paper. The head script skips it and the provider's attribute writer checks
 * it on every pathname, so a hard load and a client navigation agree. The
 * signature pad and the label sheet are embedded surfaces inside glass pages
 * and carry `data-appearance-exempt` instead; /orders/sign/[token] itself is
 * glass around its pad. appearance-flag.test.ts proves this matches exactly
 * one route of the app.
 */
export const EXEMPT_PATHS = /^\/dashboard\/orders\/[^/]+\/print\/?$/u;

/** One redirect rule in next.config.ts's shape (kept local: this module imports nothing). */
export interface GlassSiteRedirect {
  source: string;
  destination: string;
  permanent: false;
}

/**
 * The /glass-site/* paths (the static glass twins of the 7 marketing pages,
 * stage 3) are reachable only through the internal rewrite. A direct URL is
 * redirected to its public path in EVERY rollout (R8): redirects run before
 * rewrites, so the rewrite still works, a twin URL is never indexed and a
 * shared twin link never forces Liquid Glass on anyone. Temporary (307), so
 * no browser caches it for good.
 */
export function glassSiteRedirects(): GlassSiteRedirect[] {
  return [{ source: '/glass-site/:path*', destination: '/:path*', permanent: false }];
}

/** The 7 marketing pages that have a glass twin (plan 4.6, M3). */
export const MARKETING_PATHS = [
  '/',
  '/contact',
  '/pricing',
  '/privacy',
  '/security',
  '/support',
  '/terms',
] as const;

/**
 * Whether the glass twins exist. Stage 3 built them (app/(site-glass)/
 * glass-site) and, in the same change, wired next.config.ts's `rewrites()` to
 * marketingRewrites(liquidGlassRollout()); with this true the provider renders
 * the variant guard on the 7 marketing paths (appearance-flag.test.ts checks
 * the flag and next.config.ts agree).
 */
export const MARKETING_TWINS_BUILT = true;

interface CookieCondition {
  type: 'cookie';
  key: string;
  value: string;
}

/** One beforeFiles rewrite rule in next.config.ts's shape. */
export interface MarketingRewrite {
  source: string;
  destination: string;
  has?: CookieCondition[];
  missing?: CookieCondition[];
}

function twinPath(path: string): string {
  return path === '/' ? '/glass-site' : `/glass-site${path}`;
}

/**
 * The marketing rewrites by rollout (R8):
 *   default  every marketing path goes to its twin unless sp_style=classic
 *            (so a visitor with no cookie, a crawler included, gets glass);
 *   opt-in   only with sp_style=liquid-glass;
 *   off      none.
 * Both variants stay fully static: the rewrite resolves before the cache
 * lookup, so each is cached under its own destination.
 */
export function marketingRewrites(rollout: LiquidGlassRollout): MarketingRewrite[] {
  if (rollout === 'off') return [];
  return MARKETING_PATHS.map((path) =>
    rollout === 'default'
      ? {
          source: path,
          destination: twinPath(path),
          missing: [{ type: 'cookie', key: STYLE_COOKIE, value: 'classic' }],
        }
      : {
          source: path,
          destination: twinPath(path),
          has: [{ type: 'cookie', key: STYLE_COOKIE, value: 'liquid-glass' }],
        },
  );
}

/**
 * Which twin the rewrites serve for this cookie value (null: no cookie): the
 * variant guard compares it with the twin on screen. Exactly "the rule in
 * marketingRewrites fires" (appearance-flag.test.ts).
 */
export function twinSelected(rollout: LiquidGlassRollout, cookieValue: string | null): boolean {
  if (rollout === 'default') return cookieValue !== 'classic';
  if (rollout === 'opt-in') return cookieValue === 'liquid-glass';
  return false;
}
