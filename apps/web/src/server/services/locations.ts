import 'server-only';

import {
  formatRackLabel,
  normalizeCrateColorForWrite,
  normalizeRackFields,
  parseRackLabel,
} from '@stockpilot/core';
import { z } from 'zod';

import { isSiteLocation, isSystemLocation } from '@/lib/locations/groups';

import { audit } from './audit';
import { assertPermission, assertPlanLimit, ServiceError, withContext, type ServiceContext } from './context';

export const createLocationSchema = z.object({
  name: z.string().min(1).max(120).trim(),
  type: z.enum(['warehouse', 'room', 'shelf', 'bin', 'vehicle', 'jobsite', 'other']).optional(),
  parentId: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).optional(),
  // Placement fields for rack/crate inline creation (all optional for backward compat)
  kind: z.enum(['area', 'rack', 'crate']).optional(),
  warehouseId: z.string().uuid().nullable().optional(),
  rackNumber: z.string().max(64).nullable().optional(),
  rackRow: z.string().max(64).nullable().optional(),
  crateColor: z.string().max(64).nullable().optional(),
  crateNumber: z.string().max(64).nullable().optional(),
});
export type CreateLocationInput = z.infer<typeof createLocationSchema>;

export const updateLocationSchema = createLocationSchema.partial();
export type UpdateLocationInput = z.infer<typeof updateLocationSchema>;

/** A location an operator should pick as a normal bin (not a system bucket). */
export function isUserFacingLocation(loc: { kind: string | null }): boolean {
  return loc.kind !== 'staging' && loc.kind !== 'unplaced';
}

export class LocationsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new LocationsService(await withContext());
  }

  /**
   * Lists active locations by default. When `opts.includeArchived` is true,
   * returns ONLY archived rows (rows with `deleted_at` set).
   *
   * Picker scoping (mutually exclusive; sitesOnly wins if both are set):
   *   - `sitesOnly`     → only real stocking SITES (warehouse/room/vehicle/job
   *                       site). Excludes racks/shelves/crates/bins/areas AND
   *                       staging/unplaced. This is what an item's primary
   *                       location / a PO's receiving destination should offer.
   *   - `excludeSystem` → only drops staging/unplaced (kept for callers that
   *                       still want racks in the list, e.g. put-away flows).
   */
  async list(opts: { includeArchived?: boolean; excludeSystem?: boolean; sitesOnly?: boolean } = {}) {
    let query = this.ctx.supabase
      .from('locations')
      // rack_number/rack_row/crate_color/crate_number are FIRST-CLASS columns
      // (migration 0188). They travel with every list() row so a caller can
      // show what a rack/crate actually is without re-fetching — and, more
      // importantly, without parsing metadata back out of `name`. "Blue #42"
      // is a DEDUPE KEY, not a data source; never reverse-engineer a crate
      // from it while these columns exist.
      .select('id, parent_id, name, type, kind, notes, warehouse_id, rack_number, rack_row, crate_color, crate_number, deleted_at, created_at, updated_at')
      .eq('organization_id', this.ctx.organizationId)
      .order('name', { ascending: true });
    query = opts.includeArchived
      ? query.not('deleted_at', 'is', null)
      : query.is('deleted_at', null);
    const { data, error } = await query;
    if (error) throw new ServiceError('internal_error', error.message);
    const rows = data ?? [];
    if (opts.sitesOnly) return rows.filter(isSiteLocation);
    return opts.excludeSystem ? rows.filter(isUserFacingLocation) : rows;
  }

  async create(input: CreateLocationInput) {
    assertPermission(this.ctx, 'locations:manage');
    // The plan entitlement counts SITES only (see assertPlanLimit): creating a
    // rack/crate/area (or shelf/bin-typed) placement neither consumes the
    // limit nor gets blocked by an org already at its site cap.
    if (isSiteLocation({ type: input.type ?? null, kind: input.kind ?? null })) {
      await assertPlanLimit(this.ctx, 'locations');
    }
    const rack = normalizeRackFields({ number: input.rackNumber, row: input.rackRow });
    const { data, error } = await this.ctx.supabase
      .from('locations')
      .insert({
        organization_id: this.ctx.organizationId,
        name: input.name,
        type: input.type ?? null,
        parent_id: input.parentId ?? null,
        notes: input.notes ?? null,
        kind: input.kind ?? null,
        warehouse_id: input.warehouseId ?? null,
        // DECOMPOSE before storing. rack_number holds the bare number and
        // rack_row the row; a user who types the whole label ("22-B") into the
        // rack-number box gets it split rather than rejected. Storing the
        // composite is what broke the Items rack filter on 2026-07-23 — every
        // item put away there was stamped ("22-B", null) while the reader looks
        // for ("22","B"). This insert is the ONLY place locations.rack_number
        // is written, so normalising here covers every rack-creating surface.
        rack_number: rack.number || null,
        rack_row: rack.row,
        // NORMALISE the crate color on the way in — this insert is the ONLY
        // place `locations.crate_color` is written, so it is the one gate that
        // can keep mixed case out of the column. It gets there through shipped
        // UI: the Transfer dialog's crate-color box is free text ("e.g. Blue")
        // and `findOrCreateRackOrCrate` dedupes on `lower(name)`, so a row
        // created as "Blue" keeps that spelling forever and every reader that
        // matched the registry exactly then dropped the color. A known color
        // stores as its slug ("blue"); an unknown one keeps the user's own
        // spelling, because it is the only record of a color the registry has
        // never heard of. Every rack/crate-creating surface — both put-away
        // dialogs, the Transfer dialog, the bulk Set-rack path and the mobile
        // /api/v1 transfer route — reaches the column through here.
        crate_color: normalizeCrateColorForWrite(input.crateColor),
        crate_number: input.crateNumber ?? null,
      })
      .select('*')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    return data;
  }

  /**
   * Find an existing non-deleted rack/crate with the same (warehouse, name,
   * kind) before creating a new one — every "new rack" creation path
   * (interactive Transfer/Put-away `transferStockAction`/`placeStockAction`/
   * `bulkPlaceStockAction`, and the bulk "Set rack" auto-place path in
   * InventoryService) MUST dedupe this way, or repeated use of the same rack
   * name mints a fresh `locations` row every time — the duplicate-rack bug
   * fixed by migration 0270, which also adds a unique index on
   * `(organization_id, warehouse_id, lower(name), kind)` for `kind in
   * ('rack','crate')`. Matching here MUST stay case-insensitive to match that
   * index, or a same-name-different-case create would violate the
   * constraint instead of reusing the existing row.
   *
   * `kind` is matched EXACTLY (not `in ('rack','crate')`) so a rack request
   * never reuses a same-named crate (or vice versa) — rackNumber/crateNumber
   * are free text up to 64 chars and can collide (e.g. a rack number
   * containing " #" matching a crate named "Blue #42"), and the unique index
   * is now kind-scoped too, so a cross-kind reuse here would just be wrong,
   * not merely redundant.
   *
   * Falls through to `create()` (and its permission/plan-limit asserts) when
   * no match is found, or when `input.warehouseId` is missing (matching is
   * scoped per-warehouse; without one there's nothing to dedupe against).
   */
  async findOrCreateRackOrCrate(input: CreateLocationInput) {
    if (input.warehouseId && input.kind) {
      const { data: candidates, error } = await this.ctx.supabase
        .from('locations')
        .select('*')
        .eq('organization_id', this.ctx.organizationId)
        .eq('warehouse_id', input.warehouseId)
        .eq('kind', input.kind)
        .is('deleted_at', null);
      if (error) throw new ServiceError('internal_error', error.message);
      const rows = candidates ?? [];
      // Exact trimmed/lowercased match (what migration 0270's unique index
      // keys on) — the fast, common path.
      const target = input.name.trim().toLowerCase();
      const existing = rows.find(
        (loc) => (loc as { name: string }).name.trim().toLowerCase() === target,
      );
      if (existing) return existing;
      // RACK fallback: canonicalise through the SAME rack-label normalisation
      // the client's new-rack confirmation uses (formatRackLabel(parseRackLabel)).
      // Without this the two disagree: a legacy rack stored as "22 - B" (spaces
      // around the dash) reads as "exists" on the client, so no confirmation
      // shows, yet the raw-name compare here misses it and mints a duplicate
      // "22-B". Crates are excluded — their names ("Blue #42") are not
      // rack-shaped and must not be run through the rack parser.
      if (input.kind === 'rack') {
        const canonTarget = formatRackLabel(parseRackLabel(input.name)).toLowerCase();
        const canonMatch = rows.find(
          (loc) =>
            formatRackLabel(parseRackLabel((loc as { name: string }).name)).toLowerCase() ===
            canonTarget,
        );
        if (canonMatch) return canonMatch;
      }
    }
    return this.create(input);
  }

  async update(id: string, patch: UpdateLocationInput) {
    assertPermission(this.ctx, 'locations:manage');
    const updates: Record<string, unknown> = {};
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.type !== undefined) updates.type = patch.type ?? null;
    if (patch.parentId !== undefined) updates.parent_id = patch.parentId ?? null;
    if (patch.notes !== undefined) updates.notes = patch.notes ?? null;
    const { data, error } = await this.ctx.supabase
      .from('locations')
      .update(updates)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    return data;
  }

  async archive(id: string) {
    assertPermission(this.ctx, 'locations:manage');
    // Staging/Unplaced are auto-created per warehouse and receiving routes
    // stock through them — archiving one breaks put-away until it silently
    // re-creates (and strands whatever was sitting in it). Refuse loudly.
    const { data: existing } = await this.ctx.supabase
      .from('locations')
      .select('id, kind')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (existing && isSystemLocation({ type: null, kind: (existing as { kind: string | null }).kind })) {
      throw new ServiceError(
        'validation_error',
        "Staging and Unplaced are managed automatically per warehouse and can't be archived.",
      );
    }
    const { data: row, error } = await this.ctx.supabase
      .from('locations')
      .update({ deleted_at: new Date().toISOString(), deleted_by: this.ctx.userId })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!row) throw new ServiceError('not_found', 'Location not found.');
    void audit({ event: 'location.archived', entityType: 'location', entityId: id }, this.ctx);
  }

  /**
   * Restore an archived location — flips `deleted_at` back to null so it
   * reappears in the active list. Same permission gate as archive().
   *
   * `deleted_by` is intentionally preserved: it's the historical fact of
   * who archived the record. The restore action itself is logged via the
   * audit pipeline below, so we never lose the chain of custody.
   */
  async restore(id: string) {
    assertPermission(this.ctx, 'locations:manage');
    const { data: row, error } = await this.ctx.supabase
      .from('locations')
      .update({ deleted_at: null })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!row) throw new ServiceError('not_found', 'Location not found.');
    void audit({ event: 'location.restored', entityType: 'location', entityId: id }, this.ctx);
  }
}
