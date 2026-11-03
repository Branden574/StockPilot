import { isGlassShowing } from './appearance-cookie';
import { liquidGlassRollout } from './appearance-flag';
import { APPEARANCE_ATTRIBUTE } from './appearance-script';

/**
 * The dashboard's desktop width, by the Design on screen (Liquid Glass plan
 * section 6 stage 3, "the 761-767 px band where glass is already desktop";
 * read by components/dashboard/sidebar-pref.ts, the sidebar breakpoint helper
 * the appearance render guard names).
 *
 * Classic is desktop from Tailwind `md`, 768 px. The Liquid Glass boards lay
 * out a phone up to 760 px (sp.css `@media (max-width: 760px)`), so glass is
 * desktop from 761 px: shell.css shows the pinned sidebar there, and the shell
 * must agree about what its sidebar control does (collapse it, or open the
 * phone sheet). Under the `off` rollout, and whenever classic is on screen,
 * this is today's 768 px query and nothing else is listened to.
 */

/** Classic's desktop width: Tailwind `md`. */
export const CLASSIC_DESKTOP_QUERY = '(min-width: 768px)';

/** Liquid Glass's desktop width: one pixel past the boards' 760 px phone layout. */
export const GLASS_DESKTOP_QUERY = '(min-width: 761px)';

/** The media query that is "desktop" for the Design on screen right now. */
export function desktopViewportQuery(): string {
  return isGlassShowing() ? GLASS_DESKTOP_QUERY : CLASSIC_DESKTOP_QUERY;
}

/**
 * Calls `onChange` whenever the answer of desktopViewportQuery() may have
 * changed: the window crossed either width, or the Design on screen changed
 * (a switch never remounts the shell, so its state must re-read the width).
 * Returns the unsubscribe. Under `off` it listens to the classic query only.
 */
export function subscribeToDesktopViewportQueries(onChange: () => void): () => void {
  const classic = window.matchMedia(CLASSIC_DESKTOP_QUERY);
  classic.addEventListener('change', onChange);
  if (liquidGlassRollout() === 'off') {
    return () => classic.removeEventListener('change', onChange);
  }
  const glass = window.matchMedia(GLASS_DESKTOP_QUERY);
  glass.addEventListener('change', onChange);
  const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(onChange);
  observer?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [APPEARANCE_ATTRIBUTE],
  });
  return () => {
    classic.removeEventListener('change', onChange);
    glass.removeEventListener('change', onChange);
    observer?.disconnect();
  };
}
