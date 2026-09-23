import 'server-only';

import { z } from 'zod';

import { reportError } from '@/lib/error-reporter';

import { audit } from './audit';
import { ServiceError, type ServiceContext } from './context';
import { writeInIdBatches } from './lib/fetch-by-ids';
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
 * retentionDays. Only touches status='archived' rows (already removed from
 * active inventory + already on-hand-reconciled by archive()), so it does NOT
 * write a stock movement — re-emitting one would double-count the reduction.
 *
 * Org-scoped, race-guarded (re-checks status + deleted_at in the UPDATE), and
 * audited per item so each removal is recoverable. Returns the count + ids.
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
    // Oldest-archived first so the per-run cap drains deterministically and
    // never starves the longest-archived items (index-backed by 0184).
    .order('archived_at', { ascending: true })
    .limit(limit);
  if (selErr) throw new ServiceError('internal_error', selErr.message);

  const rows = (candidates ?? []) as Array<{ id: string; name: string }>;
  // True when we hit the per-run cap — the caller can surface that an org has a
  // backlog (the rest drain on subsequent daily runs).
  const truncated = rows.length === limit;
  if (rows.length === 0) return { deleted: 0, ids: [], truncated: false, failed: 0 };

  // Batched: up to 1000 ids, one batch at a time. One `.in()` of 1000 uuids
  // fails in production (and answers 414 locally), so an org with a full
  // backlog failed every daily run. Each row's update is independent and
  // race-guarded, so a batch is correct on its own; a failure stops the rest,
  // which the next run picks up oldest-first.
  const deletedAt = new Date().toISOString();
  const write = await writeInIdBatches<string, { id: string; name: string }>(
    rows.map((r) => r.id),
    (batch) =>
      ctx.supabase
        .from('inventory_items')
        .update({ deleted_at: deletedAt, deleted_by: ctx.userId, updated_by: ctx.userId })
        .eq('organization_id', ctx.organizationId)
        .in('id', batch)
        .eq('status', 'archived') // race guard: don't delete an un-archived row
        .is('deleted_at', null) // race guard: idempotent if a concurrent pass beat us
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
  for (const item of deleted) {
    await audit(
      {
        event: 'inventory.item.deleted',
        entityType: 'inventory_item',
        entityId: item.id,
        after: { deleted_at: '(auto)' },
        extra: { reason: 'auto_delete_archived', retentionDays, itemName: item.name },
      },
      ctx,
    );
  }

  return {
    deleted: deleted.length,
    ids: deleted.map((d) => d.id),
    truncated,
    failed: write.notWritten.length,
  };
}
