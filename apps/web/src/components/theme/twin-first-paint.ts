import { APPEARANCE_STORAGE_KEYS } from '@stockpilot/core';

import type { LiquidGlassRollout } from './appearance-flag';

/**
 * The marketing twin's first-paint check (plans/REVISION-DEFAULT.md R8, round
 * 2 finding 2: "never a frame of the other twin").
 *
 * The variant guard (appearance-provider.tsx) runs after hydrate. Before it,
 * one case can paint the glass twin under a cookie that selects the classic
 * page: Back or Forward to a marketing page left by a whole-document link,
 * when the browser does not restore it from the back/forward cache but reads
 * the document again from its HTTP cache. A history load reuses the cached
 * response whatever its age, and the static page's response does not vary on
 * the cookie, so a Design chosen meanwhile (Classic on /signin, say) gets the
 * twin's HTML while the head script, reading the new cookie, leaves glass off:
 * the twin painted on the classic CSS until hydrate (seen on a local build:
 * the document from the disk cache, two frames before the guard hid it).
 *
 * The glass-site layout runs this script before any of the twin's content is
 * parsed. When the cookie does not select the twin it hides the page with the
 * guard's own style element (visibility:hidden on <html>, marked with
 * EARLY_HIDE_ATTRIBUTE), so nothing of the twin is painted; the guard then
 * refreshes to the right page and removes it. If the guard never comes
 * (no JavaScript bundle), the script shows the page again after the guard's
 * 2 s, as the guard itself would (offline). A page whose cookie selects the
 * twin, every fresh load among them, is not touched.
 *
 * Only the server's HTML runs it: the layout puts it inside a hidden element's
 * innerHTML, so the copy React renders on a client navigation into the twin
 * is inert (scripts inserted through innerHTML never run) and React does not
 * warn about a script it cannot run. The classic marketing files are not
 * touched (R8). Under `off` no twin is served and there is no script.
 *
 * The cookie test is twinSelected (appearance-flag.ts), written as the head
 * script writes it; twin-first-paint.test.ts runs both over one matrix.
 */

/** The guard's hiding style element (both the guard's own and this script's). */
export const VARIANT_GUARD_STYLE_ATTRIBUTE = 'data-lg-variant-guard';
/** Marks the hide this script adds, which the guard removes once it has decided. */
export const EARLY_HIDE_ATTRIBUTE = 'data-lg-variant-early';
/** The guard's cap, repeated here for the case where the guard never runs. */
export const EARLY_HIDE_TIMEOUT_MS = 2000;

/** The script for this rollout, or null under `off`. */
export function twinFirstPaintScript(rollout: LiquidGlassRollout): string | null {
  if (rollout === 'off') return null;
  const selected = rollout === 'default' ? "v!=='classic'" : "v==='liquid-glass'";
  return (
    '(function(){try{' +
    `var m=document.cookie.match(/(?:^|; )${APPEARANCE_STORAGE_KEYS.webCookie}=([^;]*)/),v=m&&m[1];` +
    `if(${selected})return;` +
    "var s=document.createElement('style');" +
    `s.setAttribute('${VARIANT_GUARD_STYLE_ATTRIBUTE}','');s.setAttribute('${EARLY_HIDE_ATTRIBUTE}','');` +
    "s.appendChild(document.createTextNode('html{visibility:hidden!important}'));" +
    'document.head.appendChild(s);' +
    `setTimeout(function(){if(s.parentNode)s.parentNode.removeChild(s)},${EARLY_HIDE_TIMEOUT_MS});` +
    '}catch(e){}})();'
  );
}

/** Removes this script's hide, once the guard has decided (or has nothing to decide). */
export function removeEarlyHide(doc: Document = document): void {
  for (const node of doc.head.querySelectorAll(`style[${EARLY_HIDE_ATTRIBUTE}]`)) node.remove();
}
