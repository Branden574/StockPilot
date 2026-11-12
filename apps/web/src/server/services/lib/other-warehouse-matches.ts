import 'server-only';

import { inventoryViewPredicate, type InventoryListView } from '@stockpilot/core';

import { createClient } from '@/lib/supabase/server';

/**
 * How many rows the CURRENT query matches once the warehouse filter is lifted:
 * the count behind the Items and Books pages' "Nothing here in <warehouse>"
 * hint. Moved here from the Items page (review of batch D, 2026-10-20) so the
 * Books page asks the same question the same way.
 *
 * Runs only when the filtered view came back empty and the hint can answer it
 * (otherWarehouseHintApplies), so it costs one HEAD count on a path that was
 * already rendering nothing. Deliberately the USER-authed client, not the
 * service role the cached loaders use: this number is shown to a person, so
 * row level security decides what it may count — warehouse assignments and
 * category restrictions included. A scoped user therefore never sees "3 items
 * match elsewhere" for rows they could not open.
 *
 * It applies the search alone, to the active, received records of the view's
 * own type (products on Items, books on Books), in every warehouse.
 */
export async function countMatchesInOtherWarehouses(
  organizationId: string,
  params: { q?: string },
  view: InventoryListView,
): Promise<number> {
  try {
    const { itemType, isRental } = inventoryViewPredicate(view);
    const supabase = await createClient();
    let q = supabase
      .from('inventory_items')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .eq('status', 'active')
      .eq('item_type', itemType)
      .eq('is_rental', isRental)
      .eq('awaiting_first_receipt', false);
    const term = params.q?.trim();
    if (term) {
      const safe = term.replace(/[%,()]/g, ' ').trim();
      if (safe) q = q.or(`name.ilike.*${safe}*,sku.ilike.*${safe}*,barcode.ilike.*${safe}*`);
    }
    const { count, error } = await q;
    // A failed count must not turn into "0 elsewhere", which would read as a
    // confident "it is nowhere" — fall through to the ordinary empty state.
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}
