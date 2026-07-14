import 'server-only';

import { z } from 'zod';

import type { createAdminClient } from '@/lib/supabase/admin';

import { audit } from './audit';
import { ServiceError, type ServiceContext } from './context';
import { createNotification } from './notifications';

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
 * The candidate predicate shared by `archiveExpiredZeroStockItems` (the
 * cron's archive pass) and `countEligibleForAutoArchive` (the settings-page
 * preview): active, never-auto-archived, at/below zero, at-zero longer than
 * the dwell window, and NOT a rental. Extracted so the two can never drift
 * — the preview count must show exactly what the cron would act on.
 *
 * Rental exclusion: rentals are NOT a distinct `item_type` value (item_type
 * is one of 'product' | 'book' | 'asset' | 'consumable' — see mig 0020).
 * A circulating rental asset is `inventory_items.is_rental = true` (mig
 * 0131) and legitimately sits at zero stock while checked out, so it must
 * never be swept into auto-archive on that basis alone — excluded via
 * `is_rental = false`, confirmed against inventory-list.ts's existing
 * `.eq('is_rental', false)` filter (there is no 'rental' item_type token).
 *
 * `columns` lets each caller select only what it needs (the archive path
 * needs `name` for the audit trail + notify batch; the preview count only
 * needs `id`). `limit` is shared with `ARCHIVE_BATCH_LIMIT` for the preview
 * too: capping the count at the same number the cron would actually archive
 * in one run keeps "N will be archived on the next daily run" literally true
 * even when more than that many items are eligible (the rest drain next run).
 */
async function selectAutoArchiveCandidates(
  ctx: ServiceContext,
  dwellDays: number,
  opts: { columns: string; limit: number },
): Promise<{ rows: Array<{ id: string; name?: string }>; truncated: boolean }> {
  const cutoff = new Date(Date.now() - dwellDays * 86_400_000).toISOString();

  // zero_since NOT NULL naturally excludes never-stocked create-at-0 items
  // (the trigger only stamps it on a >0 → <=0 crossing).
  const { data, error } = await ctx.supabase
    .from('inventory_items')
    .select(opts.columns)
    .eq('organization_id', ctx.organizationId)
    .eq('status', 'active')
    .eq('auto_archived', false)
    .eq('is_rental', false)
    .lte('quantity_on_hand', 0)
    .not('zero_since', 'is', null)
    .lte('zero_since', cutoff)
    .order('zero_since', { ascending: true })
    .limit(opts.limit);
  if (error) throw new ServiceError('internal_error', error.message);
  // `opts.columns` is a plain `string`, not a literal type, so supabase-js's
  // typed `.select()` overload can't narrow the row shape (it falls back to
  // a `GenericStringError` type) — cast through `unknown` to the real shape.
  const rows = (data ?? []) as unknown as Array<{ id: string; name?: string }>;
  return { rows, truncated: rows.length === opts.limit };
}

/**
 * Item ids (from `ids`) that currently carry an open reservation
 * (approved-unpicked order or an open rental checkout) — excluded from
 * auto-archive. Shared by the archive pass and the preview count so the
 * exclusion can never drift between the two.
 */
async function fetchReservedItemIds(ctx: ServiceContext, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { data, error } = await ctx.supabase
    .from('stock_reservations')
    .select('item_id')
    .in('item_id', ids)
    .is('released_at', null);
  if (error) throw new ServiceError('internal_error', error.message);
  return new Set((data ?? []).map((r) => (r as { item_id: string }).item_id));
}

/**
 * Archive items that have sat at/below zero stock for longer than
 * dwellDays. Org-scoped, race-guarded (re-checks status/auto_archived/
 * quantity_on_hand in the UPDATE), skips items with an open reservation
 * (approved-unpicked order or an open rental checkout), and audits per item
 * so each archive is traceable. Returns the archived count + ids + items.
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

  const { rows: cand, truncated } = await selectAutoArchiveCandidates(ctx, dwellDays, {
    columns: 'id, name',
    limit,
  });
  const rows = cand as Array<{ id: string; name: string }>;
  if (rows.length === 0) return { archived: 0, ids: [], items: [], truncated: false };

  // Exclude items with active reservations (approved-unpicked order / open rental).
  const reserved = await fetchReservedItemIds(
    ctx,
    rows.map((r) => r.id),
  );
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

/**
 * Count items currently eligible for auto-archive under `dwellDays` — the
 * exact same predicate as `archiveExpiredZeroStockItems` (including the
 * reservation exclusion), via the shared `selectAutoArchiveCandidates` /
 * `fetchReservedItemIds` helpers, so the two can never drift. Used by the
 * inventory-cleanup settings panel to show the blast radius before/while the
 * toggle is on. Read-only: no mutation, no audit.
 *
 * Capped at `ARCHIVE_BATCH_LIMIT` — the same cap the cron itself applies per
 * run — so a very large candidate set doesn't blow up the reservation
 * lookup, and so the number shown is never a promise the cron can't keep in
 * one pass (if there are more than that many eligible, the rest archive on a
 * later run, same as today).
 */
export async function countEligibleForAutoArchive(
  ctx: ServiceContext,
  dwellDays: number,
): Promise<number> {
  const { rows } = await selectAutoArchiveCandidates(ctx, dwellDays, {
    columns: 'id',
    limit: ARCHIVE_BATCH_LIMIT,
  });
  if (rows.length === 0) return 0;
  const reserved = await fetchReservedItemIds(
    ctx,
    rows.map((r) => r.id),
  );
  return rows.filter((r) => !reserved.has(r.id)).length;
}

/**
 * Notify owner/admin/manager recipients that items were auto-archived —
 * one notification per archived item per non-opted-out recipient. Gated by
 * the per-user `push_item_auto_archived` preference (0267): missing prefs
 * row OR pref = true → notify; pref explicitly false → skip. Goes through
 * createNotification (the ONE insert path) so the 0028 AFTER-INSERT trigger
 * fans out push — never call notifyUser() here, that double-pushes.
 */
export async function notifyAutoArchived(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  items: Array<{ id: string; name: string }>,
): Promise<void> {
  const { data: members } = await admin
    .from('organization_members')
    .select('user_id')
    .eq('organization_id', orgId)
    .in('role', ['owner', 'admin', 'manager'])
    .not('accepted_at', 'is', null);
  const userIds = ((members ?? []) as Array<{ user_id: string }>).map((m) => m.user_id);
  if (userIds.length === 0) return;

  const { data: prefRows } = await admin
    .from('notification_preferences')
    .select('user_id, push_item_auto_archived')
    .in('user_id', userIds);
  const prefById = new Map(
    (
      (prefRows ?? []) as Array<{ user_id: string; push_item_auto_archived: boolean | null }>
    ).map((r) => [r.user_id, r.push_item_auto_archived]),
  );

  for (const uid of userIds) {
    // Default-on opt-out model (0092 pattern): only an explicit false skips.
    if (prefById.get(uid) === false) continue;
    for (const item of items) {
      await createNotification({
        organizationId: orgId,
        userId: uid,
        type: 'inventory.item.auto_archived',
        title: 'Item auto-archived',
        body: item.name,
        link: `/dashboard/inventory/${item.id}`,
        metadata: { item_id: item.id },
      });
    }
  }
}
