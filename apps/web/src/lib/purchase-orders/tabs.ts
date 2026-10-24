// ── Status grouping ────────────────────────────────────────────────────────
// The DB has 6 statuses; we partition them into mutually-exclusive filter
// tabs (every status lands in exactly one tab) so the pills echo the design
// mockup while staying faithful to the real data model. Extracted from the
// purchase-orders page into its own pure module so the partition — and the
// "All excludes cancelled" derivation below — can be unit-tested without
// pulling in the RSC's server-only dependency graph (auth/session, supabase
// server client, etc.).
//
// OVERDUE is a VIEW, not part of the partition (small fixes slice 8): the
// purchase orders the dashboard's overdue line counts, across the open
// statuses, past their expected day in the organization's zone (#338's rule;
// PurchaseOrdersService.listOverdue). The dashboard links to
// ?status=overdue; until 2026-10-11 the list had no such view and showed All.
export type PoTab = 'all' | 'overdue' | 'draft' | 'ordered' | 'in_transit' | 'received' | 'cancelled';

export const TAB_ORDER: PoTab[] = ['all', 'overdue', 'draft', 'ordered', 'in_transit', 'received', 'cancelled'];

export const TAB_LABELS: Record<PoTab, string> = {
  all: 'All',
  overdue: 'Overdue',
  draft: 'Draft',
  ordered: 'Ordered',
  in_transit: 'In transit',
  received: 'Received',
  cancelled: 'Cancelled',
};

/**
 * The statuses a purchase order can be overdue in: receivable and not yet
 * fully received. The ONE list PurchaseOrdersService's overdue filter (the
 * dashboard's count and the Overdue view) and the CSV export use.
 */
export const OVERDUE_PO_STATUSES: readonly string[] = ['expected_inbound', 'ordered', 'partially_received'];

export const TAB_STATUSES: Record<Exclude<PoTab, 'all' | 'overdue'>, string[]> = {
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
  if (tab === 'all') return ALL_NON_CANCELLED_STATUSES;
  // The statuses only: the Overdue view also needs the expected day to have
  // passed (PurchaseOrdersService.listOverdue; the export applies the same
  // rule, core pastExpectedDayTest).
  if (tab === 'overdue') return [...OVERDUE_PO_STATUSES];
  return TAB_STATUSES[tab];
}
