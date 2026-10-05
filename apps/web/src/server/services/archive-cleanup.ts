import 'server-only';

import { z } from 'zod';

import { reportError } from '@/lib/error-reporter';

import { auditMany } from './audit';
import { ServiceError, type ServiceContext } from './context';
import { fetchAllRowsByIds, writeInIdBatches } from './lib/fetch-by-ids';
import { invalidateInventoryListAfterWrite } from './lib/inventory-list-cache';

// ---------------------------------------------------------------------------
// Opt-in, per-org automatic cleanup of long-archived inventory items. The
// setting lives in the `inventory` module's organization_modules.settings jsonb
// under the `autoDeleteArchived` key (same per-module settings pattern as
// auto-reorder). A daily cron calls purgeExpiredArchivedItems() per enabled org.
// "Delete" = SOFT delete (deleted_at) — recoverable + preserves PO/receipt
// history; never a hard delete.
// ---------------------------------------------------------------------------

/** Floor: a week, so nobody can configure same-day destruction by accident. */
export const AUTO_DELETE_MIN_DAYS = 7;
/** Ceiling: 10 years (effectively "keep", but bounded). */
export const AUTO_DELETE_MAX_DAYS = 3650;

export const autoDeleteArchivedSchema = z.object({
  enabled: z.boolean(),
  days: z.number().int().min(AUTO_DELETE_MIN_DAYS).max(AUTO_DELETE_MAX_DAYS),
});

export type AutoDeleteArchivedSettings = z.infer<typeof autoDeleteArchivedSchema>;

const DEFAULTS: AutoDeleteArchivedSettings = { enabled: false, days: 90 };

/** Tolerant parse for stored settings — unknown/garbage falls back to OFF. */
export function parseAutoDeleteArchivedSettings(raw: unknown): AutoDeleteArchivedSettings {
  const parsed = autoDeleteArchivedSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULTS;
}

/** Hard cap on how many items one cron pass soft-deletes per org. */
const PURGE_BATCH_LIMIT = 1000;

/**
 * Soft-delete archived items that have sat archived for longer than
 * retentionDays. Only touches status='archived' rows, so it does NOT write a
 * stock movement — re-emitting one would double-count the reduction.
 *
 * Only an item that holds NOTHING is deleted. "Archive anyway" keeps an item's
 * stock, so an archived item can still have stock on record; deleting it would
 * make that stock vanish with the item (L15). So a candidate must have no
 * stock on record (`quantity_on_hand = 0`, also the update's race guard), no
 * non-zero holding on any location and no open hold (an approved order or a
 * rental still holding it). The rest are kept and counted as `skipped`.
 *
 * Org-scoped, race-guarded (re-checks status, deleted_at and the stock on
 * record in the UPDATE), and audited per item so each removal is recoverable.
 * The holdings and holds reads fail closed: a run that cannot prove an item
 * holds nothing deletes nothing (it throws; the cron reports it per org).
 */
export async function purgeExpiredArchivedItems(
  ctx: ServiceContext,
  retentionDays: number,
  opts: { limit?: number } = {},
): Promise<{
  deleted: number;
  ids: string[];
  truncated: boolean;
  /** Candidates a failed write batch left in place (reported). */
  failed: number;
  /** Items past retention kept because they still hold stock: stock on
   *  record, a holding on a location, an open hold, or stock that arrived
   *  during the run. */
  skipped: number;
}> {
  const limit = opts.limit ?? PURGE_BATCH_LIMIT;
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();

  const { data: candidates, error: selErr } = await ctx.supabase
    .from('inventory_items')
    .select('id, name')
    .eq('organization_id', ctx.organizationId)
    .eq('status', 'archived')
    .is('deleted_at', null)
    .not('archived_at', 'is', null)
    .lte('archived_at', cutoff)
    // No stock on record. Filtered in the read, not after it, so items kept
    // for their stock never fill the per-run cap and starve the rest.
    .eq('quantity_on_hand', 0)
    // Oldest-archived first so the per-run cap drains deterministically and
    // never starves the longest-archived items (index-backed by 0184).
    .order('archived_at', { ascending: true })
    .limit(limit);
  if (selErr) throw new ServiceError('internal_error', selErr.message);

  // How many past-retention items the read left out for their stock on
  // record. Reporting only: a failed count is logged, never fatal.
  const keptForStockOnRecord = await countKeptForStockOnRecord(ctx, cutoff);

  const rows = (candidates ?? []) as Array<{ id: string; name: string }>;
  // True when we hit the per-run cap — the caller can surface that an org has a
  // backlog (the rest drain on subsequent daily runs).
  const truncated = rows.length === limit;
  if (rows.length === 0) {
    return { deleted: 0, ids: [], truncated: false, failed: 0, skipped: keptForStockOnRecord };
  }

  // Drop any candidate that still holds stock somewhere or is held for an
  // order or rental. Both reads throw on error (fail closed).
  const holding = await itemIdsStillHolding(
    ctx,
    rows.map((r) => r.id),
  );
  const eligible = rows.filter((r) => !holding.has(r.id));
  const skippedBeforeWrite = keptForStockOnRecord + (rows.length - eligible.length);
  if (eligible.length === 0) {
    return { deleted: 0, ids: [], truncated, failed: 0, skipped: skippedBeforeWrite };
  }

  // Batched: up to 1000 ids, one batch at a time. One `.in()` of 1000 uuids
  // fails in production (and answers 414 locally), so an org with a full
  // backlog failed every daily run. Each row's update is independent and
  // race-guarded, so a batch is correct on its own; a failure stops the rest,
  // which the next run picks up oldest-first.
  const deletedAt = new Date().toISOString();
  const write = await writeInIdBatches<string, { id: string; name: string }>(
    eligible.map((r) => r.id),
    (batch) =>
      ctx.supabase
        .from('inventory_items')
        .update({ deleted_at: deletedAt, deleted_by: ctx.userId, updated_by: ctx.userId })
        .eq('organization_id', ctx.organizationId)
        .in('id', batch)
        .eq('status', 'archived') // race guard: don't delete an un-archived row
        .is('deleted_at', null) // race guard: idempotent if a concurrent pass beat us
        .eq('quantity_on_hand', 0) // race guard: stock that arrived since the read keeps it
        .select('id, name'),
  );
  if (write.error !== null && write.written.length === 0) {
    throw new ServiceError('internal_error', write.error);
  }

  const deleted = write.rows;
  if (deleted.length > 0) {
    // Deleted rows leave the Archived view and the instant dataset.
    invalidateInventoryListAfterWrite(ctx.organizationId, 'item.purge_archived');
  }
  if (write.error !== null) {
    // Part of the run committed: audit and return that part, report the rest.
    void reportError(new Error('Archived-item purge stopped partway through a run'), {
      tag: 'archive_cleanup.purge.partial',
      organizationId: ctx.organizationId,
      extra: { deleted: deleted.length, failed: write.notWritten.length, detail: write.error },
    });
  }
  // Up to 1000 rows per run: batched INSERTs (auditMany) instead of one
  // awaited request per deleted item.
  await auditMany(
    deleted.map((item) => ({
      event: 'inventory.item.deleted' as const,
      entityType: 'inventory_item',
      entityId: item.id,
      after: { deleted_at: '(auto)' },
      extra: { reason: 'auto_delete_archived', retentionDays, itemName: item.name },
    })),
    ctx,
  );

  return {
    deleted: deleted.length,
    ids: deleted.map((d) => d.id),
    truncated,
    failed: write.notWritten.length,
    // A written batch that returned fewer rows than it carried: the race
    // guards kept those items (stock arrived, or another pass got there).
    skipped: skippedBeforeWrite + (write.written.length - deleted.length),
  };
}

/** Archived items past retention that the candidate read left out because
 *  they have stock on record (positive or negative). Never throws. */
async function countKeptForStockOnRecord(ctx: ServiceContext, cutoff: string): Promise<number> {
  try {
    const { count, error } = await ctx.supabase
      .from('inventory_items')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', ctx.organizationId)
      .eq('status', 'archived')
      .is('deleted_at', null)
      .not('archived_at', 'is', null)
      .lte('archived_at', cutoff)
      .neq('quantity_on_hand', 0);
    if (error) throw new Error(error.message);
    return count ?? 0;
  } catch (e) {
    void reportError(e, {
      tag: 'archive_cleanup.purge.count_kept',
      organizationId: ctx.organizationId,
    });
    return 0;
  }
}

/**
 * Candidate ids that still hold stock: a non-zero holding on any location
 * (item_stock_levels) or an open hold (stock_reservations, released_at null).
 * Batched and paged (one `.in()` of 1000 uuids fails in production). THROWS on
 * a failed read: this decides what may be deleted, so a failure must never
 * read as "holds nothing".
 */
async function itemIdsStillHolding(ctx: ServiceContext, ids: string[]): Promise<Set<string>> {
  const [holdings, holds] = await Promise.all([
    fetchAllRowsByIds<{ item_id: string }>(
      ids,
      (batch) => (from, to) =>
        ctx.supabase
          .from('item_stock_levels')
          .select('item_id')
          .eq('organization_id', ctx.organizationId)
          .in('item_id', batch)
          .neq('quantity', 0)
          .order('id')
          .range(from, to),
    ),
    fetchAllRowsByIds<{ item_id: string }>(
      ids,
      (batch) => (from, to) =>
        ctx.supabase
          .from('stock_reservations')
          .select('item_id')
          .eq('organization_id', ctx.organizationId)
          .in('item_id', batch)
          .is('released_at', null)
          .order('id')
          .range(from, to),
    ),
  ]);
  const out = new Set<string>();
  for (const r of holdings) out.add(r.item_id);
  for (const r of holds) out.add(r.item_id);
  return out;
}
