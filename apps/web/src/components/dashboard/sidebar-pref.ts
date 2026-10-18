/**
 * Pure helpers for the shell's per-viewer preferences: the desktop sidebar
 * hide/show, which nav sections are collapsed, and the table density. Each is
 * a cookie, so the server layout reads it for the first paint (no flash, no
 * database read) and the client shell writes it back. Kept free of React and
 * DOM rendering so they can be unit-tested deterministically and shared by the
 * server layout (cookie read) and the client shell (cookie write).
 */

import { isAdminRole, SECTION_ORDER, type NavSectionKey, type Role } from '@stockpilot/core';

/** Cookie that persists the per-device preference. "1" = hidden. */
export const SIDEBAR_HIDDEN_COOKIE = 'sp_sidebar_hidden';

/** DOM id on the desktop sidebar <aside>, referenced by the toggle's aria-controls. */
export const SIDEBAR_DOM_ID = 'dashboard-sidebar';

/** One year, the lifetime of every shell preference cookie. */
const ONE_YEAR = 31536000;

/** Parse the persisted preference. Hidden only when the value is exactly "1". */
export function parseSidebarHidden(value: string | null | undefined): boolean {
  return value === '1';
}

/** `document.cookie` string that persists (1y) or clears the preference. */
export function sidebarCookieString(hidden: boolean): string {
  return hidden
    ? `${SIDEBAR_HIDDEN_COOKIE}=1; path=/; max-age=${ONE_YEAR}; samesite=lax`
    : `${SIDEBAR_HIDDEN_COOKIE}=; path=/; max-age=0; samesite=lax`;
}

/** Desktop width: Tailwind `md`, where the pinned sidebar shows. */
const DESKTOP_QUERY = '(min-width: 768px)';

/** True when the viewport is desktop-width (Tailwind `md`, ≥768px). */
export function isDesktopViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(DESKTOP_QUERY).matches;
}

/** Calls `onChange` whenever the window crosses the desktop width; returns the unsubscribe. */
export function subscribeToDesktopViewport(onChange: () => void): () => void {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
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

// ── Collapsed nav sections ────────────────────────────────────────────────
// The registry's section keys (overview, inventory, workspace, tools, admin)
// are the identity: labels can be renamed per org, keys never change, so a
// saved choice keeps meaning the same section.

/** Cookie listing the nav sections this viewer has collapsed, joined by ".". */
export const NAV_COLLAPSED_COOKIE = 'sp_nav_collapsed';

/**
 * The sections that start collapsed before the viewer has chosen: Admin, for
 * owners and admins (a long group of rarely used setup pages under the daily
 * Inventory and Workspace links). Everyone else starts with every section open.
 */
export function defaultCollapsedSections(role: Role): NavSectionKey[] {
  return isAdminRole(role) ? ['admin'] : [];
}

/**
 * Parse the cookie. null = the viewer never chose (use the default); an empty
 * value = they chose to keep every section open. Unknown keys are dropped.
 */
export function parseCollapsedSections(value: string | null | undefined): NavSectionKey[] | null {
  if (value === null || value === undefined) return null;
  const known = new Set<string>(SECTION_ORDER);
  return [...new Set(value.split('.').filter((key) => known.has(key)))] as NavSectionKey[];
}

/** `document.cookie` string that persists the collapsed sections for a year. */
export function collapsedSectionsCookieString(keys: readonly NavSectionKey[]): string {
  return `${NAV_COLLAPSED_COOKIE}=${keys.join('.')}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
}

// ── Table density ─────────────────────────────────────────────────────────
// The shell root carries data-density; globals.css turns it into --row-py,
// the table body cells' vertical padding. Nothing else changes with it.

export type Density = 'comfortable' | 'compact';

/** Cookie that persists the per-viewer density. Absent = comfortable. */
export const DENSITY_COOKIE = 'sp_density';

/** Parse the persisted density. Compact only for exactly "compact". */
export function parseDensity(value: string | null | undefined): Density {
  return value === 'compact' ? 'compact' : 'comfortable';
}

/** `document.cookie` string that persists compact (1y) or clears back to comfortable. */
export function densityCookieString(density: Density): string {
  return density === 'compact'
    ? `${DENSITY_COOKIE}=compact; path=/; max-age=${ONE_YEAR}; samesite=lax`
    : `${DENSITY_COOKIE}=; path=/; max-age=0; samesite=lax`;
}
