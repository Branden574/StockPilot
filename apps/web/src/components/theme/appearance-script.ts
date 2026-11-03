import { APPEARANCE_STORAGE_KEYS } from '@stockpilot/core';

/**
 * The first-paint appearance script (Liquid Glass plan 2.1). app/layout.tsx
 * renders it inside <head>, ahead of <body>, ONLY when the kill switch is on
 * (appearance-flag.ts). It runs before the first paint and does one thing:
 * when the device cookie says `liquid-glass`, and this tab is not in the
 * one-time crash fallback (plan 5.6), it sets `data-appearance="liquid-glass"`
 * on <html>. With no cookie, or any other value, it touches nothing, so a
 * classic page gets no DOM change from it (appearance-script.test.ts proves
 * the serialised <html> is byte-identical).
 *
 * It never reads or writes the colour scheme: next-themes' own script, rendered
 * inside <body> by ThemeProvider, keeps setting the `light`/`dark` class and
 * `color-scheme` from localStorage `theme` (which is `system` for a glass
 * choice), so the two scripts never touch the same thing.
 *
 * CSP: script-src already allows 'unsafe-inline' (next.config.ts), which
 * next-themes relies on with no nonce. If a nonce CSP is ever enforced, this
 * script takes the same nonce next-themes would get; nothing is weakened now.
 */
const { webCookie, webFallback } = APPEARANCE_STORAGE_KEYS;

export const APPEARANCE_SCRIPT =
  '(function(){try{var d=document.documentElement,' +
  `m=document.cookie.match(/(?:^|; )${webCookie}=([^;]*)/);` +
  `if(m&&m[1]==='liquid-glass'&&!window.sessionStorage.getItem('${webFallback}'))` +
  "d.setAttribute('data-appearance','liquid-glass');}catch(e){}})();";

/** The attribute on <html> that every glass rule is scoped to. */
export const APPEARANCE_ATTRIBUTE = 'data-appearance';
export const LIQUID_GLASS_ATTRIBUTE_VALUE = 'liquid-glass';
