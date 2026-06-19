/**
 * Pure helpers for the desktop sidebar hide/show preference. Kept free of
 * React + DOM-rendering so they can be unit-tested deterministically and
 * reused by both the server layout (cookie read) and the client shell.
 */

/** Cookie that persists the per-device preference. "1" = hidden. */
export const SIDEBAR_HIDDEN_COOKIE = 'sp_sidebar_hidden';

/** DOM id on the desktop sidebar <aside>, referenced by the toggle's aria-controls. */
export const SIDEBAR_DOM_ID = 'dashboard-sidebar';

/** Parse the persisted preference. Hidden only when the value is exactly "1". */
export function parseSidebarHidden(value: string | null | undefined): boolean {
  return value === '1';
}

/** `document.cookie` string that persists (1y) or clears the preference. */
export function sidebarCookieString(hidden: boolean): string {
  return hidden
    ? `${SIDEBAR_HIDDEN_COOKIE}=1; path=/; max-age=31536000; samesite=lax`
    : `${SIDEBAR_HIDDEN_COOKIE}=; path=/; max-age=0; samesite=lax`;
}

/** True when the viewport is desktop-width (Tailwind `md`, ≥768px). */
export function isDesktopViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches;
}

/** The chord that toggles the sidebar: Cmd+\ (mac) / Ctrl+\ (win/linux). */
export function isSidebarToggleChord(
  e: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'key'>,
): boolean {
  return (e.metaKey || e.ctrlKey) && e.key === '\\';
}

/** Whether focus is in a text-entry element (so we never swallow a typed "\"). */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return (el as HTMLElement).isContentEditable;
}
