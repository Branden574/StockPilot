import { APPEARANCE_STORAGE_KEYS } from '@stockpilot/core';

import {
  EXEMPT_PATHS,
  MARKETING_PATH_PATTERN,
  MARKETING_TWINS_BUILT,
  type LiquidGlassRollout,
} from './appearance-flag';

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
 * On the 7 marketing paths, in every spelling the rewrites take (one trailing
 * slash, any case: MARKETING_PATH_PATTERN, the rule the variant guard shares;
 * FOLLOWUPS F7), when it turns glass on, it also hides the page
 * before its first paint (the variant guard's style, marked as early): the
 * document there may be a classic page that Back or Forward read again from
 * the HTTP cache after Liquid Glass was chosen elsewhere (a history load reuses
 * the cached static page, which does not vary on the cookie), and the classic
 * markup must not paint on the glass CSS. The twin layout's own first-paint
 * script (twin-first-paint.ts), the first thing in a twin's body, removes the
 * hide at once, so a twin is not held back; on a classic body it stays until
 * the variant guard has refreshed to the twin and removed it. If the guard
 * never comes within EARLY_HIDE_TIMEOUT_MS (no bundle) and has not started its
 * own hide, the page is shown with the attribute following the classic body
 * on screen (removed), as the guard's own 2 s rule does. A classic chooser
 * (no glass) gets no hide, so classic stays byte-identical.
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
export const LOW_POWER_EXPRESSION =
  "typeof n.deviceMemory==='number'&&(n.deviceMemory<=2||(typeof n.hardwareConcurrency==='number'&&n.hardwareConcurrency<=2))";

/** The variant guard's hiding style element (the guard's own and the early ones). */
export const VARIANT_GUARD_STYLE_ATTRIBUTE = 'data-lg-variant-guard';
/** Marks a hide added before hydrate (head script, twin layout), which the guard removes once it has decided. */
export const EARLY_HIDE_ATTRIBUTE = 'data-lg-variant-early';
/** The guard's cap, repeated for an early hide whose guard never runs. */
export const EARLY_HIDE_TIMEOUT_MS = 2000;

/**
 * Inline JS for a classic script whose `d` is <html>: hide the page with the
 * variant guard's style marked as early. After EARLY_HIDE_TIMEOUT_MS, if the
 * hide is still there and the guard has not started its own (it then owns
 * the outcome and removes this one when it finishes), remove it and run
 * `coherent`, which makes the attribute follow the page on screen.
 */
export function earlyHideSnippet(coherent: string): string {
  return (
    "var s=document.createElement('style');" +
    `s.setAttribute('${VARIANT_GUARD_STYLE_ATTRIBUTE}','');s.setAttribute('${EARLY_HIDE_ATTRIBUTE}','');` +
    "s.appendChild(document.createTextNode('html{visibility:hidden!important}'));" +
    'document.head.appendChild(s);' +
    'setTimeout(function(){' +
    `if(!s.parentNode||document.head.querySelector('style[${VARIANT_GUARD_STYLE_ATTRIBUTE}]:not([${EARLY_HIDE_ATTRIBUTE}])'))return;` +
    `s.parentNode.removeChild(s);${coherent}},${EARLY_HIDE_TIMEOUT_MS});`
  );
}

/**
 * The script for this rollout, or null under `off` (no script at all). The
 * rollout is written in as a constant when the page is built.
 */
export function appearanceScript(rollout: LiquidGlassRollout): string | null {
  if (rollout === 'off') return null;
  const glass = rollout === 'default' ? "v!=='classic'" : "v==='liquid-glass'";
  // A classic body under the glass attribute: the attribute follows the body.
  const classicBody =
    `d.removeAttribute('${APPEARANCE_ATTRIBUTE}');` +
    `d.removeAttribute('${LOW_POWER_ATTRIBUTE}');`;
  return (
    '(function(){try{var d=document.documentElement,' +
    `m=document.cookie.match(/(?:^|; )${webCookie}=([^;]*)/),v=m&&m[1],f=null;` +
    // Blocked storage is "no fallback", as the provider reads it.
    `try{f=window.sessionStorage.getItem('${webFallback}')}catch(e){}` +
    'if(f)return;' +
    `if(${EXEMPT_PATHS.toString()}.test(location.pathname))return;` +
    `if(${glass}){d.setAttribute('${APPEARANCE_ATTRIBUTE}','${LIQUID_GLASS_ATTRIBUTE_VALUE}');` +
    `var n=navigator;if(${LOW_POWER_EXPRESSION})` +
    `d.setAttribute('${LOW_POWER_ATTRIBUTE}','${LOW_POWER_ATTRIBUTE_VALUE}');` +
    (MARKETING_TWINS_BUILT
      ? `if(${MARKETING_PATH_PATTERN.toString()}.test(location.pathname)){${earlyHideSnippet(classicBody)}}`
      : '') +
    '}' +
    '}catch(e){}})();'
  );
}
