/**
 * The Liquid Glass kill switch (stockpilot-work/liquid-glass/IMPLEMENTATION-PLAN.md
 * D12 and 2.1). One build-time flag, NEXT_PUBLIC_LIQUID_GLASS, gates EVERY
 * place that can turn glass on:
 *   - the first-paint head script is emitted only when it is on (app/layout.tsx);
 *   - the selectors offer Liquid Glass only when it is on (appearance-select.tsx);
 *   - next.config.ts redirects every /glass-site/* path to its classic path
 *     when it is off;
 *   - the client AppearanceProvider renders a stored 'liquid-glass' as classic
 *     System when it is off, and removes data-appearance if anything set it.
 * With the flag off a stored 'liquid-glass' is ignored, never deleted, so
 * turning the flag back on restores the person's choice.
 *
 * The access is a LITERAL `process.env.NEXT_PUBLIC_LIQUID_GLASS` so Next
 * inlines it into the browser bundle at build time (lib/env.client.ts explains
 * why a dynamic lookup would not be inlined). Plain module, no imports, so
 * next.config.ts can import it too.
 */
export const LIQUID_GLASS_FLAG_NAME = 'NEXT_PUBLIC_LIQUID_GLASS';

/** True only when the build was made with NEXT_PUBLIC_LIQUID_GLASS=1. */
export function isLiquidGlassEnabled(): boolean {
  return process.env.NEXT_PUBLIC_LIQUID_GLASS === '1';
}

/** One redirect rule in next.config.ts's shape (kept local: this module imports nothing). */
export interface GlassSiteRedirect {
  source: string;
  destination: string;
  permanent: false;
  missing?: { type: 'cookie'; key: string; value: string }[];
}

/**
 * The /glass-site/* paths (Liquid Glass plan 4.6, M3: the static glass twins
 * of the 7 marketing pages, built in stage 3) are reachable only through the
 * cookie-conditioned rewrite. So:
 *   - flag off: every /glass-site/* path redirects to its classic path,
 *     unconditionally, so a twin can never be reached;
 *   - flag on: a visitor without the glass cookie is redirected to the classic
 *     path, so a shared twin URL never forces Liquid Glass on anyone.
 * Temporary (307), so turning the flag on later is never undone by a browser's
 * cached permanent redirect.
 */
export function glassSiteRedirects(enabled: boolean): GlassSiteRedirect[] {
  const rule: GlassSiteRedirect = {
    source: '/glass-site/:path*',
    destination: '/:path*',
    permanent: false,
  };
  if (!enabled) return [rule];
  return [{ ...rule, missing: [{ type: 'cookie', key: 'sp_appearance', value: 'liquid-glass' }] }];
}
