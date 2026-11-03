import { APPEARANCE_STORAGE_KEYS } from '@stockpilot/core';

import { EXEMPT_PATHS, type LiquidGlassRollout } from './appearance-flag';

export { EXEMPT_PATHS };

/**
 * The first-paint appearance script (plans/REVISION-DEFAULT.md R6, R7).
 * app/layout.tsx renders it inside <head>, ahead of <body>, only when the
 * rollout is not `off`. It runs before the first paint and decides one thing
 * from the `sp_style` cookie alone:
 *   default  glass unless the cookie says `classic` (no cookie, or a value
 *            that is not a Design, means "never chose");
 *   opt-in   glass only when the cookie says `liquid-glass`.
 * It skips the one-time crash fallback (plan 5.6) and the print route
 * (EXEMPT_PATHS). When it turns glass on and the browser reports a weak
 * device, it also sets `data-lg-material="reduced"` (R7). When it does not
 * turn glass on it touches nothing, so a classic page gets no DOM change from
 * it (appearance-script.test.ts proves the serialised <html> is
 * byte-identical).
 *
 * COOKIE ONLY, never localStorage: the marketing rewrites (R8) choose the
 * page from the same cookie, so the two always agree. The provider repairs the
 * cookie from the device record after hydrate when they disagree.
 *
 * It never reads or writes the colour scheme: next-themes' own script, inside
 * <body>, keeps setting the `light`/`dark` class and `color-scheme` from
 * localStorage `theme`, so the two scripts never touch the same thing.
 *
 * CSP: script-src already allows 'unsafe-inline' (next.config.ts), which
 * next-themes relies on with no nonce. If a nonce CSP is ever enforced, this
 * script takes the same nonce next-themes would get; nothing is weakened now.
 */
const { webCookie, webFallback } = APPEARANCE_STORAGE_KEYS;

/** The attribute on <html> that every glass rule is scoped to. */
export const APPEARANCE_ATTRIBUTE = 'data-appearance';
export const LIQUID_GLASS_ATTRIBUTE_VALUE = 'liquid-glass';

/** The low-power material attribute on <html>, set only together with glass (R7). */
export const LOW_POWER_ATTRIBUTE = 'data-lg-material';
export const LOW_POWER_ATTRIBUTE_VALUE = 'reduced';

/** What isLowPowerBrowser reads (Navigator.deviceMemory is Chromium only). */
export interface LowPowerNavigator {
  deviceMemory?: number;
  hardwareConcurrency?: number;
}

/**
 * A weak browser (R7): it reports deviceMemory AND has at most 2 GB or at most
 * 2 cores. hardwareConcurrency alone is never trusted, because WebKit may clamp
 * it against fingerprinting, which would put every iPhone and iPad browser on
 * the reduced material. Browsers that do not report deviceMemory (Safari,
 * Firefox, every iOS browser) are never auto-reduced. The head script inlines
 * the same expression (LOW_POWER_EXPRESSION); appearance-script.test.ts runs
 * both over one matrix.
 */
export function isLowPowerBrowser(nav: LowPowerNavigator): boolean {
  const memory = nav.deviceMemory;
  const cores = nav.hardwareConcurrency;
  return typeof memory === 'number' && (memory <= 2 || (typeof cores === 'number' && cores <= 2));
}

/** isLowPowerBrowser as the head script writes it, over `n` = navigator. */
const LOW_POWER_EXPRESSION =
  "typeof n.deviceMemory==='number'&&(n.deviceMemory<=2||(typeof n.hardwareConcurrency==='number'&&n.hardwareConcurrency<=2))";

/**
 * The script for this rollout, or null under `off` (no script at all). The
 * rollout is written in as a constant when the page is built.
 */
export function appearanceScript(rollout: LiquidGlassRollout): string | null {
  if (rollout === 'off') return null;
  const glass = rollout === 'default' ? "v!=='classic'" : "v==='liquid-glass'";
  return (
    '(function(){try{var d=document.documentElement,' +
    `m=document.cookie.match(/(?:^|; )${webCookie}=([^;]*)/),v=m&&m[1],f=null;` +
    // Blocked storage is "no fallback", as the provider reads it.
    `try{f=window.sessionStorage.getItem('${webFallback}')}catch(e){}` +
    'if(f)return;' +
    `if(${EXEMPT_PATHS.toString()}.test(location.pathname))return;` +
    `if(${glass}){d.setAttribute('${APPEARANCE_ATTRIBUTE}','${LIQUID_GLASS_ATTRIBUTE_VALUE}');` +
    `var n=navigator;if(${LOW_POWER_EXPRESSION})` +
    `d.setAttribute('${LOW_POWER_ATTRIBUTE}','${LOW_POWER_ATTRIBUTE_VALUE}');}` +
    '}catch(e){}})();'
  );
}
