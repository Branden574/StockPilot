// ── Status grouping ────────────────────────────────────────────────────────
// The DB has 6 statuses; we partition them into mutually-exclusive filter
// tabs (every status lands in exactly one tab) so the pills echo the design
// mockup while staying faithful to the real data model. Extracted from the
// purchase-orders page into its own pure module so the partition — and the
// "All excludes cancelled" derivation below — can be unit-tested without
// pulling in the RSC's server-only dependency graph (auth/session, supabase
// server client, etc.).
export type PoTab = 'all' | 'draft' | 'ordered' | 'in_transit' | 'received' | 'cancelled';

export const TAB_ORDER: PoTab[] = ['all', 'draft', 'ordered', 'in_transit', 'received', 'cancelled'];

export const TAB_LABELS: Record<PoTab, string> = {
  all: 'All',
  draft: 'Draft',
  ordered: 'Ordered',
  in_transit: 'In transit',
  received: 'Received',
  cancelled: 'Cancelled',
};

export const TAB_STATUSES: Record<Exclude<PoTab, 'all'>, string[]> = {
  draft: ['draft'],
  ordered: ['ordered'],
  in_transit: ['expected_inbound', 'partially_received'],
  received: ['received'],
  cancelled: ['cancelled'],
};

/**
 * "All" = every NON-cancelled status (owner request 2026-07-16): a cancelled
 * PO is void — mostly test/mistake noise — and shouldn't clutter the primary
 * work-queue view; it stays reachable via its own Cancelled tab. Derived from
 * TAB_STATUSES so it can never drift from the partition above.
 */
export const ALL_NON_CANCELLED_STATUSES: string[] = Object.entries(TAB_STATUSES)
  .filter(([tab]) => tab !== 'cancelled')
  .flatMap(([, statuses]) => statuses);

export function isPoTab(value: string | undefined): value is PoTab {
  return TAB_ORDER.includes(value as PoTab);
}

/**
 * Resolves the `statuses` argument to pass to listPage/listStats-style
 * queries for a given tab. Historically 'all' passed `null` ("no filter" —
 * every status including cancelled); it now always resolves to an explicit
 * array so cancelled POs are excluded from the primary view in BOTH the
 * instant (client-filtered) and server-paginated code paths, since both call
 * listPage with this same value.
 */
export function statusesForTab(tab: PoTab): string[] {
  return tab === 'all' ? ALL_NON_CANCELLED_STATUSES : TAB_STATUSES[tab];
}
