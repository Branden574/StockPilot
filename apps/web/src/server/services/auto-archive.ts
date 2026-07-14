import 'server-only';

import { z } from 'zod';

import { audit } from './audit';
import { ServiceError, type ServiceContext } from './context';

// ---------------------------------------------------------------------------
// Opt-in, per-org automatic archiving of items that stay out of stock
// (quantity_on_hand <= 0) past a dwell window. The setting lives in the
// `inventory` module's organization_modules.settings jsonb under the
// `autoArchiveOnZeroStock` key (same per-module settings pattern as
// auto-delete-archived / auto-reorder). A daily cron calls
// archiveExpiredZeroStockItems() per enabled org.
//
// State (mig 0266): inventory_items.zero_since is stamped by a DB trigger on
// the >0 → <=0 crossing (NULL while in stock — the dwell clock), and
// inventory_items.auto_archived distinguishes a system archive (eligible for
// auto-restore-on-restock) from a manual one. "Archive" here = status flip to
// 'archived', mirroring the existing manual archive() path.
// ---------------------------------------------------------------------------

/** Floor: same-day auto-archiving is too aggressive to allow by accident. */
export const AUTO_ARCHIVE_MIN_DAYS = 1;
/** Ceiling: a year — bounded, but generous for slow-moving seasonal stock. */
export const AUTO_ARCHIVE_MAX_DAYS = 365;

export const autoArchiveSettingsSchema = z.object({
  enabled: z.boolean(),
  dwellDays: z.number().int().min(AUTO_ARCHIVE_MIN_DAYS).max(AUTO_ARCHIVE_MAX_DAYS),
});

export type AutoArchiveSettings = z.infer<typeof autoArchiveSettingsSchema>;

const DEFAULTS: AutoArchiveSettings = { enabled: false, dwellDays: 7 };

/** Tolerant parse for stored settings — unknown/garbage falls back to OFF. */
export function parseAutoArchiveSettings(raw: unknown): AutoArchiveSettings {
  const parsed = autoArchiveSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULTS;
}

/** Hard cap on how many items one cron pass auto-archives per org. */
const ARCHIVE_BATCH_LIMIT = 500; // matches bulkUpdate's hard cap

/**
 * Archive items that have sat at/below zero stock for longer than
 * dwellDays. Org-scoped, race-guarded (re-checks status/auto_archived/
 * quantity_on_hand in the UPDATE), skips items with an open reservation
 * (approved-unpicked order or an open rental checkout), and audits per item
 * so each archive is traceable. Returns the archived count + ids + items.
 *
 * Rental exclusion: rentals are NOT a distinct `item_type` value (item_type
 * is one of 'product' | 'book' | 'asset' | 'consumable' — see mig 0020).
 * A circulating rental asset is `inventory_items.is_rental = true` (mig
 * 0131) and legitimately sits at zero stock while checked out, so it must
 * never be swept into auto-archive on that basis alone — excluded via
 * `is_rental = false`, confirmed against inventory-list.ts's existing
 * `.eq('is_rental', false)` filter (there is no 'rental' item_type token).
 */
export async function archiveExpiredZeroStockItems(
  ctx: ServiceContext,
  dwellDays: number,
  opts: { limit?: number } = {},
): Promise<{
  archived: number;
  ids: string[];
  items: Array<{ id: string; name: string }>;
  truncated: boolean;
}> {
  const limit = opts.limit ?? ARCHIVE_BATCH_LIMIT;
  const cutoff = new Date(Date.now() - dwellDays * 86_400_000).toISOString();

  // Candidates: active, never-auto-archived, at/below zero, at-zero longer
  // than the dwell window, and NOT a rental (rentals sit at zero while
  // checked out). zero_since NOT NULL naturally excludes never-stocked
  // create-at-0 items (the trigger only stamps it on a >0 → <=0 crossing).
  const { data: cand, error: selErr } = await ctx.supabase
    .from('inventory_items')
    .select('id, name')
    .eq('organization_id', ctx.organizationId)
    .eq('status', 'active')
    .eq('auto_archived', false)
    .eq('is_rental', false)
    .lte('quantity_on_hand', 0)
    .not('zero_since', 'is', null)
    .lte('zero_since', cutoff)
    .order('zero_since', { ascending: true })
    .limit(limit);
  if (selErr) throw new ServiceError('internal_error', selErr.message);
  const rows = (cand ?? []) as Array<{ id: string; name: string }>;
  const truncated = rows.length === limit;
  if (rows.length === 0) return { archived: 0, ids: [], items: [], truncated: false };

  // Exclude items with active reservations (approved-unpicked order / open rental).
  const { data: resv, error: resvErr } = await ctx.supabase
    .from('stock_reservations')
    .select('item_id')
    .in(
      'item_id',
      rows.map((r) => r.id),
    )
    .is('released_at', null);
  if (resvErr) throw new ServiceError('internal_error', resvErr.message);
  const reserved = new Set((resv ?? []).map((r) => (r as { item_id: string }).item_id));
  const eligible = rows.filter((r) => !reserved.has(r.id));
  if (eligible.length === 0) return { archived: 0, ids: [], items: [], truncated };

  const { data: done, error: updErr } = await ctx.supabase
    .from('inventory_items')
    .update({ status: 'archived', auto_archived: true, updated_by: ctx.userId })
    .eq('organization_id', ctx.organizationId)
    .in(
      'id',
      eligible.map((r) => r.id),
    )
    .eq('status', 'active') // race guard
    .eq('auto_archived', false)
    .lte('quantity_on_hand', 0) // race guard: don't archive one restocked mid-run
    .select('id, name');
  if (updErr) throw new ServiceError('internal_error', updErr.message);
  const archived = (done ?? []) as Array<{ id: string; name: string }>;

  for (const item of archived) {
    await audit(
      {
        event: 'inventory.item.archived',
        entityType: 'inventory_item',
        entityId: item.id,
        after: { status: 'archived' },
        extra: { reason: 'auto_zero_stock', dwellDays, itemName: item.name },
      },
      ctx,
    );
  }
  return { archived: archived.length, ids: archived.map((d) => d.id), items: archived, truncated };
}
