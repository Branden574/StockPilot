/**
 * One-shot handoff between an app-entry CTA and the branded <BootSplash>.
 *
 * Clicking "Open app" / "Sign in" sets this flag, then navigates into the app.
 * The BootSplash (mounted in the root layout) reads + clears it on the next
 * page load and plays once — so the splash covers the entry transition
 * (including the sign-in → dashboard redirect) without firing on refreshes or
 * direct/bookmarked loads.
 */
export const BOOT_HANDOFF_KEY = 'sp_boot_handoff';

/**
 * Request the boot splash on the next page load. Call from an app-entry CTA's
 * onClick immediately before navigation. Safe everywhere — if sessionStorage is
 * unavailable (hardened privacy modes) the splash simply doesn't play and
 * navigation still proceeds.
 */
export function requestBootSplash(): void {
  try {
    window.sessionStorage.setItem(BOOT_HANDOFF_KEY, '1');
  } catch {
    // no-op
  }
}
