import { APPEARANCE_STORAGE_KEYS } from '@stockpilot/core';

import type { LiquidGlassRollout } from './appearance-flag';
import {
  APPEARANCE_ATTRIBUTE,
  EARLY_HIDE_ATTRIBUTE,
  EARLY_HIDE_TIMEOUT_MS,
  earlyHideSnippet,
  LIQUID_GLASS_ATTRIBUTE_VALUE,
  LOW_POWER_ATTRIBUTE,
  LOW_POWER_ATTRIBUTE_VALUE,
  LOW_POWER_EXPRESSION,
  VARIANT_GUARD_STYLE_ATTRIBUTE,
} from './appearance-script';

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
 * parsed:
 *   - when the cookie selects the twin, it removes the early hide the head
 *     script put on a marketing path (appearance-script.ts: that hide covers
 *     the reverse case, a classic body under a cookie that selects glass), so
 *     a twin is never held back, and touches nothing else;
 *   - otherwise it hides the page with the guard's own style element
 *     (visibility:hidden on <html>, marked with EARLY_HIDE_ATTRIBUTE), so
 *     nothing of the twin is painted; the guard then refreshes to the right
 *     page and removes it. If the guard has not started within the guard's
 *     2 s (a slow device still hydrating, or no bundle at all), the page is
 *     shown with the attribute following the twin on screen (glass, and the
 *     low-power material where the head script would set it), as the guard's
 *     own 2 s rule does: never the twin on the classic CSS. A guard that
 *     starts later hides the page again before it paints and refreshes.
 *     A guard already running at 2 s owns the outcome and removes this hide.
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

export { EARLY_HIDE_ATTRIBUTE, EARLY_HIDE_TIMEOUT_MS, VARIANT_GUARD_STYLE_ATTRIBUTE };

/**
 * The head script's low-power test (LOW_POWER_EXPRESSION, isLowPowerBrowser)
 * with each "x<=2" written "2>=x": the same for every number and for NaN, and
 * no "<" in a script that sits in an element's innerHTML (twin-first-paint
 * test runs it over the head script's matrix).
 */
export const TWIN_LOW_POWER_EXPRESSION = LOW_POWER_EXPRESSION.replace(/(n\.\w+)<=2/gu, '2>=$1');

/** The script for this rollout, or null under `off`. */
export function twinFirstPaintScript(rollout: LiquidGlassRollout): string | null {
  if (rollout === 'off') return null;
  const selected = rollout === 'default' ? "v!=='classic'" : "v==='liquid-glass'";
  // The twin on screen under the guard's 2 s rule: the attribute follows it.
  const twinBody =
    `d.setAttribute('${APPEARANCE_ATTRIBUTE}','${LIQUID_GLASS_ATTRIBUTE_VALUE}');` +
    `var n=navigator;if(${TWIN_LOW_POWER_EXPRESSION})` +
    `d.setAttribute('${LOW_POWER_ATTRIBUTE}','${LOW_POWER_ATTRIBUTE_VALUE}');`;
  return (
    '(function(){try{var d=document.documentElement,' +
    `m=document.cookie.match(/(?:^|; )${APPEARANCE_STORAGE_KEYS.webCookie}=([^;]*)/),v=m&&m[1];` +
    // No "<" in the text: it sits in a hidden element's innerHTML.
    `if(${selected}){var e=document.head.querySelectorAll('style[${EARLY_HIDE_ATTRIBUTE}]'),i;` +
    'for(i=e.length;i--;)e[i].parentNode.removeChild(e[i]);return;}' +
    earlyHideSnippet(twinBody) +
    '}catch(e){}})();'
  );
}

/** Removes the early hides (this script's or the head script's), once the guard has decided. */
export function removeEarlyHide(doc: Document = document): void {
  for (const node of doc.head.querySelectorAll(`style[${EARLY_HIDE_ATTRIBUTE}]`)) node.remove();
}
