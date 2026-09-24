import 'server-only';

/**
 * WHICH ITEMS MAY GO ON A PURCHASE ORDER, AND WHICH THE REORDER PATHS PICK.
 *
 * Four reads choose items for reordering on their own (nobody ticked them):
 * the Planning table (PlanningService.getReorderSuggestions), the reorder-
 * forecast report (ReportsService.reorderForecast), "Draft PO from
 * suggestions" and the AI draft tool (PurchaseOrdersService
 * .createDraftsFromReorderForecast), and the daily auto-reorder
 * (PurchaseOrdersService.runAutoReorder). Each used to spell the filter out
 * by hand, and the copies drifted: none of them left out a kit's
 * pre-assembled stock (`is_bundle`, the hidden item assemble_bundle creates),
 * so a kit could be suggested, reported and drafted as if a supplier sold it.
 * They now share the one predicate below.
 *
 * Two layers:
 *
 *   whereOrderableItem   may this item be on a purchase order AT ALL: this
 *                        organization's, not deleted, not a kit's
 *                        pre-assembled stock. The explicit Items selection
 *                        ("Create draft POs") and the recurring-PO cron use it.
 *                        Archived and rental items stay orderable here: a
 *                        buyer may reorder an archived item or buy more rental
 *                        units by choosing them. save_purchase_order_draft
 *                        (0366) refuses the same two kinds of line
 *                        (po_line_deleted, po_line_bundle), for every caller.
 *
 *   whereReorderCandidate  what the reorder paths consider without being
 *                        asked: orderable, active and not a rental. With
 *                        `withReorderPoint`, only items that have a reorder
 *                        point (the three below-par reads; Planning ranks every
 *                        item, including ones with no reorder point yet).
 *
 * `is_bundle`, `is_rental` and `status` are NOT NULL (0040, 0131), so plain
 * equality is total: no `or(is.null)` is needed.
 *
 * Generic over the caller's builder and returns that same builder type, so
 * `.in()`, `.order()` and `.range()` chain on as before and the row type the
 * select string gives is kept. The constraint only asks that the three
 * filter methods exist: a self-referential structural constraint
 * (`Q extends Filterable<Q>`) made TypeScript compare each method against
 * the typed PostgREST builder's generic signatures at every call site, which
 * hit "type instantiation is excessively deep" (TS2589).
 */
type FilterBuilder = {
  eq(column: string, value: string | boolean): FilterBuilder;
  is(column: string, value: null): FilterBuilder;
  gt(column: string, value: number): FilterBuilder;
};
type HasFilters = { eq: unknown; is: unknown; gt: unknown };

export function whereOrderableItem<Q extends HasFilters>(query: Q, organizationId: string): Q {
  return (query as unknown as FilterBuilder)
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .eq('is_bundle', false) as unknown as Q;
}

export function whereReorderCandidate<Q extends HasFilters>(
  query: Q,
  organizationId: string,
  opts: { withReorderPoint: boolean },
): Q {
  const q = (whereOrderableItem(query, organizationId) as unknown as FilterBuilder)
    .eq('status', 'active')
    .eq('is_rental', false);
  return (opts.withReorderPoint ? q.gt('reorder_point', 0) : q) as unknown as Q;
}
