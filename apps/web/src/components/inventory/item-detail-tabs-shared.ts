/**
 * Server-safe helpers shared between the client ItemDetailTabs component
 * and the server ItemDetail component. Kept in a non-'use client' file so
 * the server component can import parseDetailTab without tripping Next.js's
 * "client function called from server" boundary check.
 */

export type DetailTabId = 'overview' | 'movements' | 'activity';

/**
 * Parses the `?tab=` query string into a known DetailTabId, falling back
 * to `overview`. Used both server-side (ItemDetail picks which panel to
 * render) and client-side (ItemDetailTabs renders the active tab).
 */
export function parseDetailTab(raw: string | null | undefined): DetailTabId {
  if (raw === 'movements' || raw === 'activity' || raw === 'overview') return raw;
  return 'overview';
}
