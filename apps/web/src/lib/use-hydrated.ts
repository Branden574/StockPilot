import * as React from 'react';

const subscribe = () => () => {};

/**
 * False while the server renders and while the browser hydrates that HTML;
 * true from the render right after hydration, and from the first render of
 * anything mounted later (a client navigation, a dialog), so text gated on it
 * appears at once there.
 *
 * FOR TEXT THAT DEPENDS ON THE VIEWER'S ZONE OR LOCALE: toLocaleString(),
 * toLocaleDateString(), an Intl date format with no fixed timeZone. The server
 * prints it in ITS zone (UTC on Vercel), so an evening in Los Angeles is the
 * next day there and every time of day differs; hydrating that text throws
 * React error #418 (production 2026-10-05), and keeping the server's text with
 * suppressHydrationWarning would leave the wrong day or hour on screen
 * (receipt-history.tsx learned that). Print it only when this is true.
 *
 * Relative times ("3 minutes ago") are the other case: the server's words
 * stay right to within a minute, so their element carries
 * suppressHydrationWarning instead (comment-thread.tsx, return-workbench.tsx).
 */
export function useHydrated(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
