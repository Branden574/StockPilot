import 'server-only';

import { ServiceError, type ServiceContext } from './context';
import { fetchAllRowsByIds, rawErrorText, writeInIdBatches } from './lib/fetch-by-ids';
import { invalidateInventoryListAfterWrite } from './lib/inventory-list-cache';

/**
 * THE LEDGER INVARIANT IS ABSOLUTE: for every item,
 * SUM(stock_movements.quantity_change) = quantity_on_hand.
 *
 * Call this when an opening ('initial') movement insert FAILED for rows that
 * were already committed with stock. It compensates, then always throws.
 *
 * ONE COPY FOR EVERY CREATE PATH (pattern #26). InventoryService (create,
 * bulkCreate, bulkCreateSizedVariants) and BooksImportService used to carry
 * their own copies of this decision, and a fix to one copy is not a fix. Before
 * that, `create()` never even destructured the insert result and `bulkCreate()`
 * console.warn'd "the audit gap is recoverable" and returned success. That was
 * true of the ROWS and false of the BOOKS: the item Activity feed, the 14-day
 * sparklines, the dashboard history reconstruction (currentQty − SUM of later
 * deltas) and every reconciliation that sums the ledger are then wrong for
 * those items, forever, with nothing logged.
 *
 * Not merely a transient hazard, either: the two RLS floors differ.
 * inventory_items_insert (0212) admits `items:create`; stock_movements_insert
 * (0321) requires staff or `stock:adjust`. A viewer granted items:create
 * through configurable permissions creates stocked items whose ledger row is
 * refused EVERY time (pattern #4 + #28).
 *
 * TWO INVARIANTS, NOT ONE. `trg_seed_initial_level` (0199) is an AFTER INSERT
 * trigger on inventory_items: by the time the movement insert is even
 * attempted it has ALREADY written one item_stock_levels row per stocked row,
 * at the same quantity. Nothing syncs levels on UPDATE, so zeroing only
 * `quantity_on_hand` would leave Σlevels = N against on_hand = 0 — PHANTOM
 * PLACED STOCK, which the archive guard (max(on_hand, Σholdings)) refuses to
 * archive forever and the placed draw-down happily picks straight into a
 * negative on-hand. So both are restored: levels 0 = on_hand 0 = no movements.
 *
 * ONE CALL, BOTH WRITES. compensate_opening_stock (migration 0359) zeroes the
 * levels and then on-hand in one transaction, so there is no half-compensated
 * intermediate. It has to be an RPC: since 0359 the stock ledger's tables
 * refuse direct writes from the signed-in user. It is also narrow on purpose:
 * it touches only the caller's own items created in the last 15 minutes that
 * have NO movement row, so it can never zero stock with ledger history.
 *
 * Rolling the ITEMS back instead would be a hard DELETE on a table whose whole
 * convention is soft-delete (and one no API role may run since 0359).
 */
export async function compensateOpeningStockOrThrow(
  ctx: ServiceContext,
  stockedIds: string[],
  movementErr: { message: string },
  opts: { tag: string; subject: string; pronoun: 'its' | 'their'; invalidateLabel: string },
): Promise<never> {
  // BATCHED (bulkCreate stocks up to 500 items) and attempts every batch
  // (stopOnError: false) so one bad batch still lets the rest be rolled back.
  //
  // (a)+(b) The placements the 0199 trigger seeded, then the row quantity.
  // The RPC returns the ids it compensated; an id it skipped (not the caller's,
  // too old, or already ledgered) is missing from the count below and the throw
  // says the rollback failed.
  const comp = await writeInIdBatches<string, string>(
    stockedIds,
    (batch) =>
      ctx.supabase.rpc('compensate_opening_stock', {
        p_org_id: ctx.organizationId,
        p_item_ids: batch,
      }),
    { stopOnError: false },
  );
  const zeroErr = comp.error;
  const compensated = new Set(comp.rows).size;
  // Every exit below throws; the zeroed quantities must not be served from the
  // cache as the opening stock that was just rolled back.
  invalidateInventoryListAfterWrite(ctx.organizationId, opts.invalidateLabel);

  // (c) PROVE the placements are gone. The RPC's return says which rows it
  // matched, not what the table holds now — and ZERO level rows is a
  // legitimate outcome (the 0199 trigger swallows its own failures by design).
  // A re-read is the only unambiguous answer, and it is the answer that
  // matters: any surviving placement is exactly the phantom-stock state this
  // compensation exists to prevent.
  let verifyErr: string | null = null;
  let survivingPlacements = 0;
  try {
    const leftovers = await fetchAllRowsByIds<{ id: string }>(
      stockedIds,
      (batch) => (from, to) =>
        ctx.supabase
          .from('item_stock_levels')
          .select('id')
          .eq('organization_id', ctx.organizationId)
          .in('item_id', batch)
          .gt('quantity', 0)
          .order('id')
          .range(from, to),
    );
    survivingPlacements = leftovers.length;
  } catch (err) {
    verifyErr = rawErrorText(err);
  }

  if (zeroErr || verifyErr || compensated !== stockedIds.length || survivingPlacements > 0) {
    console.error(`${opts.tag} opening movements failed AND the rollback failed`, {
      movementError: movementErr.message,
      rollbackError: zeroErr,
      verifyError: verifyErr,
      compensated,
      survivingPlacements,
      stockedIds,
    });
    throw new ServiceError(
      'internal_error',
      `${opts.subject} created, but ${opts.pronoun} opening stock could not be recorded and the quantities could not be rolled back. Contact support to reconcile them before receiving, picking or counting against them.`,
    );
  }
  console.error(`${opts.tag} opening movements failed; on-hand and placements rolled back to 0`, {
    movementError: movementErr.message,
    stockedIds,
  });
  throw new ServiceError(
    'internal_error',
    `${opts.subject} created, but ${opts.pronoun} opening stock could not be recorded, so ${
      opts.pronoun === 'its' ? 'it was' : 'they were'
    } saved with zero on hand. Add ${
      opts.pronoun === 'its' ? 'the quantity' : 'the quantities'
    } with a stock adjustment.`,
  );
}
