import 'server-only';

import { requireOrgContext } from '@/lib/auth/session';
import { getOrgRowForRequest } from '@/lib/dashboard/request-cache';

/**
 * Per-org effective label for a sidebar nav item — for SERVER-rendered page
 * headings (h1s), the one white-label surface `navForRole` doesn't reach.
 *
 * Settings → Navigation renames live on `organizations.nav_overrides`
 * (migration 0158) as `labels: { [canonicalHref]: newLabel }`. The sidebar
 * and breadcrumbs get them via navForRole → applyNavOverrides; page headings
 * read the SAME jsonb through this helper so all three surfaces agree.
 *
 * ZERO new round-trips: `requireOrgContext` and `getOrgRowForRequest` are
 * both React.cache()'d and already resolved by the dashboard layout in the
 * same render — this is a plain lookup off data every page render already
 * paid for.
 */

/**
 * Pure lookup: pick the override label for `href` off a raw `nav_overrides`
 * jsonb value. Mirrors `applyNavOverrides`' validation exactly (`v === 1`,
 * `labels` object, non-empty string value) and fails CLOSED to `fallback` on
 * null/garbage. Exported for tests.
 */
export function navLabelFromOverrides(
  overrides: unknown,
  href: string,
  fallback: string,
): string {
  if (!overrides || typeof overrides !== 'object') return fallback;
  const rec = overrides as Record<string, unknown>;
  if (rec.v !== 1) return fallback;
  const labels = rec.labels;
  if (!labels || typeof labels !== 'object') return fallback;
  const label = (labels as Record<string, unknown>)[href];
  return typeof label === 'string' && label.length > 0 ? label : fallback;
}

/**
 * The org's effective label for the nav item at `href` (its CANONICAL
 * sidebar href, e.g. '/dashboard/inventory'), or `fallback` when the org has
 * no rename for it. `fallback` is the page's own static heading — it doesn't
 * have to match the nav item's default label (the Items page's heading is
 * "Inventory" while its nav label is "Items"; absent an override, the page
 * keeps its heading unchanged).
 */
export async function effectiveNavLabel(href: string, fallback: string): Promise<string> {
  const ctx = await requireOrgContext();
  const orgRow = await getOrgRowForRequest(ctx.organizationId);
  return navLabelFromOverrides(orgRow?.nav_overrides ?? null, href, fallback);
}
