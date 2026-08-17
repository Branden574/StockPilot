import 'server-only';

import {
  formatCrateLocationName,
  formatRackLabel,
  formatRackPosition,
  locationNameSitsOnRack,
  normalizeCrateColorForWrite,
  normalizeRackFields,
  parseRackLabel,
} from '@stockpilot/core';
import { z } from 'zod';

import { isSiteLocation, isSystemLocation } from '@/lib/locations/groups';

import { audit } from './audit';
import {
  assertAnyPermission,
  assertPermission,
  assertPlanLimit,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';

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

/**
 * ═══ A POSITIONED CRATE'S NAME CARRIES ITS RACK — DECIDED HERE, NOT BY CALLERS ═══
 *
 * The `locations.name` a crate row is actually inserted with. Racks, sites and
 * everything else pass straight through; only `kind: 'crate'` is touched.
 *
 * A crate's rack lives in its NAME ("Gray #BIN on rack 43-B") because that is
 * what keeps migration 0270's `lower(name)` index holding five physically
 * distinct "gray BIN" bins as five rows, and because nothing that renders a
 * placement reads `rack_number`/`rack_row` — a holding reaches every formatter
 * as `{ name, quantity, kind }`. A row whose COLUMNS say 43-B while its NAME
 * has lost the suffix has quietly stopped sitting on a rack everywhere at once,
 * and `assertRenameKeepsCratePosition` then refuses every future rename of it,
 * because it reads the columns. That row is unrenameable and mis-rendered for
 * life.
 *
 * THIS FUNCTION EXISTS BECAUSE THE INVARIANT USED TO BE ENFORCED ON RENAME ONLY.
 * `create()` inserted `input.name` verbatim next to whatever rack columns came
 * with it, and the doc on the rename guard claimed "create composes the name
 * through formatCrateLocationName" — true of its CALLERS (they all go through
 * `planNewLocation`), false of `create` itself. `createLocationAction` is a live
 * authenticated server action that takes the whole `createLocationSchema`, so
 * `{ name: 'Gray BIN', kind: 'crate', rackNumber: '43', rackRow: 'B' }` minted
 * exactly the shape the rename guard refuses. No shipped UI sends it (the
 * Locations manager form posts name/type/notes only), so nothing in production
 * carries it — but "no caller does this today" is not an invariant, it is a
 * coincidence, and the gate belongs at the single insert every caller shares.
 *
 * THE THREE OUTCOMES, in order:
 *
 *   1. NO POSITION → the name is the caller's, verbatim. A position-less crate
 *      ("Blue #Shelf") is a legitimate permanent shape — production holds one —
 *      and there is nothing for the name to carry.
 *   2. THE NAME ALREADY SITS ON THE POSITION → verbatim, byte for byte. This is
 *      the branch every shipped caller takes, and taking it by TEST rather than
 *      by re-deriving is what makes double-composition ("Gray #BIN on rack 43-B
 *      on rack 43-B") structurally impossible rather than merely unlikely.
 *   3. OTHERWISE → COMPOSE it, through the one `formatCrateLocationName` that
 *      writes 0270's dedupe key. The columns win over the name: they are what
 *      the rename guard, the put-away stamp and the placement readers key on,
 *      so a name disagreeing with them is the defect, not the intent.
 *
 * A crate with a position and NO NUMBER cannot be composed — a colour alone
 * does not name a crate (`formatCrateLocationName` returns '') — so it is
 * REFUSED rather than inserted position-less. Unreachable from every shipped
 * caller: `planNewLocation`'s crate branch always carries a number.
 */
function crateAwareLocationName(input: CreateLocationInput): string {
  if (input.kind !== 'crate') return input.name;
  const position = formatRackPosition({ rackNumber: input.rackNumber, rackRow: input.rackRow });
  if (!position) return input.name;
  if (locationNameSitsOnRack(input.name, position)) return input.name;
  const composed = formatCrateLocationName(input.crateColor, input.crateNumber, {
    rackNumber: input.rackNumber,
    rackRow: input.rackRow,
  });
  if (!composed) {
    throw new ServiceError(
      'validation_error',
      `This crate sits on rack ${position}, and the position is part of its name — every pick slip, count sheet and item card reads the rack out of the name. Give the crate a number so it can be named, or create it without a rack position.`,
    );
  }
  return composed;
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
    // BEFORE the insert, so an uncomposable positioned crate is refused rather
    // than half-written (`.update().eq()`/insert both fail open on a guard that
    // runs alongside the write instead of ahead of it).
    const name = crateAwareLocationName(input);
    const rack = normalizeRackFields({ number: input.rackNumber, row: input.rackRow });
    const { data, error } = await this.ctx.supabase
      .from('locations')
      .insert({
        organization_id: this.ctx.organizationId,
        // A POSITIONED CRATE IS NAMED HERE, not by whoever called. See
        // `crateAwareLocationName`: the rack a crate sits on travels in its
        // name, so an insert that took `input.name` verbatim could mint the
        // exact name/column disagreement `assertRenameKeepsCratePosition`
        // refuses — and that row could then never be renamed again. Every
        // other kind (rack, site, area) passes through untouched.
        name,
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
   * ═══ A CRATE'S IDENTITY INCLUDES THE RACK IT SITS ON — VIA THE NAME ═══
   *
   * Matching on `lower(name)` is still correct BECAUSE the name now carries the
   * position: `formatCrateLocationName` names a positioned crate "Gray #BIN on
   * rack 43-B" (see packages/core/src/inventory/book-storage.ts). That is
   * deliberate and it is what makes this function safe for crates.
   *
   * Production, L4L North Region: "gray BIN" is FIVE physically distinct bins
   * (43-B, 43-C, 42-B, 42-C, 41-C), "yellow 5" is two, "blue 0" is three. If
   * identity stayed colour+number, putting away into gray BIN on 43-B and gray
   * BIN on 41-C would COLLAPSE FIVE BINS INTO ONE `locations` row and stamp one
   * bin's books with another bin's location — a worse data-integrity failure
   * than the one the positioned crate was added to fix. Folding the position
   * into the name (rather than into this predicate) keeps 0270's index correct
   * by construction, so this change ships with NO migration, and it leaves
   * every picker showing five distinguishable labels instead of five identical
   * "Gray #BIN" rows.
   *
   * BACKWARD COMPATIBLE BY THE SAME MECHANISM: every crate row in production
   * today was created position-less and is still named "Gray #BIN" / "Blue
   * #Shelf", so a put-away that names no position still matches and REUSES it.
   * A position-less crate is a legitimate permanent shape — production holds
   * one (blue "Blue Shelf", 5 books, no rack) — and is never backfilled.
   *
   * Falls through to `create()` (and its permission/plan-limit asserts) when
   * no match is found, or when `input.warehouseId` is missing (matching is
   * scoped per-warehouse; without one there's nothing to dedupe against).
   */
  async findOrCreateRackOrCrate(input: CreateLocationInput) {
    return (await this.findRackOrCrate(input)) ?? (await this.create(input));
  }

  /**
   * ═══ THE PLACEMENT PATH'S RESOLVE-OR-CREATE — UNDER stock:transfer ═══
   *
   * `findOrCreateRackOrCrate` for a PUT-AWAY: the same find (0270's key, the
   * same `crateAwareLocationName`), but the create half proceeds under
   * `stock:transfer` (or `locations:manage`) instead of `locations:manage`
   * alone, through the SECURITY DEFINER `mint_placement_location` (0340).
   *
   * WHY (owner decision D1, 2026-08-17). The book put-away's default
   * destination is the crate the book's own label already names — "Yellow #6
   * on rack 38-B" — and for 113 of L4L's 124 books that crate exists ONLY as
   * the label, so placing into it means minting the row first. Through
   * `create` that mint asserted `locations:manage`; the Staff preset holds
   * `stock:transfer` only, so staff saw "needs the Manage locations
   * permission" on every crated book and were pushed onto the bare rack — the
   * crate-erasing path (Maus I). The owner ruled that putting stock into a
   * crate the label (or the operator's four fields) names is a STOCK
   * operation, not location administration, and may proceed under
   * `stock:transfer` — but ONLY from the placement path. Ordinary location
   * creation, `create` and every other caller of `findOrCreateRackOrCrate`
   * (bulk Set rack's auto-place, manual item create) keep `locations:manage`.
   *
   * WHY A DATABASE FUNCTION. The app-layer gate alone cannot land the row:
   * `locations_insert` (0212) is manager-or-above OR `locations:manage`, so
   * RLS refuses a staff insert regardless of what this method asserts. A
   * SECURITY DEFINER function bypasses that policy for exactly this insert and
   * RE-CHECKS the caller's accepted membership of `p_org`, the permission, the
   * warehouse and the parent INSIDE its own body — so a direct call from a
   * client can only ever mint a rack or crate in the caller's own org's
   * warehouse, the same row a put-away would, and a direct table insert stays
   * refused by the unchanged policy. (Widening the policy instead would have
   * made every staff member's raw PostgREST rack/crate insert legal, which is
   * wider than the decision.)
   *
   * WHAT IS THE SAME AS `create`. Racks and crates only (the function refuses
   * every other kind — this cannot become a site back door); the name a
   * positioned crate is inserted with is composed by `crateAwareLocationName`;
   * the rack pair is decomposed by `normalizeRackFields`; the crate colour is
   * normalised by `normalizeCrateColorForWrite`. The columns that reach the
   * table are byte-identical to what `create` would have written. Racks and
   * crates never consumed the site plan limit, so none is asserted here either.
   * A manager's put-away goes through the same function — one placement path,
   * one behaviour, one dedupe (the function itself reuses a concurrent winner's
   * row instead of surfacing 23505).
   */
  async findOrCreatePlacementDestination(input: CreateLocationInput) {
    return (await this.findRackOrCrate(input)) ?? (await this.mintPlacementDestination(input));
  }

  private async mintPlacementDestination(input: CreateLocationInput) {
    if (input.kind !== 'rack' && input.kind !== 'crate') {
      // Fail closed. Every shipped caller comes through `planNewLocation`,
      // whose only verdicts are rack and crate; anything else here is a
      // caller trying to use the put-away's exception for a site.
      throw new ServiceError(
        'validation_error',
        'A put-away can only place into a rack or a crate.',
      );
    }
    if (!input.warehouseId) {
      throw new ServiceError('validation_error', 'A rack or crate needs a warehouse.');
    }
    // THE GATE, in the app layer: the placement permission, or the wider one.
    // The function re-checks the same three grants inside; this is the check
    // that answers with the app's own ServiceError shape (and the MFA step-up)
    // before a round trip is spent.
    assertAnyPermission(this.ctx, ['stock:transfer', 'locations:manage']);
    const name = crateAwareLocationName(input);
    const rack = normalizeRackFields({ number: input.rackNumber, row: input.rackRow });
    const { data, error } = await this.ctx.supabase.rpc('mint_placement_location', {
      p_org: this.ctx.organizationId,
      p_warehouse_id: input.warehouseId,
      p_kind: input.kind,
      p_name: name,
      p_type: input.type ?? null,
      p_parent_id: input.parentId ?? null,
      p_notes: input.notes ?? null,
      p_rack_number: rack.number || null,
      p_rack_row: rack.row,
      p_crate_color: normalizeCrateColorForWrite(input.crateColor),
      p_crate_number: input.crateNumber ?? null,
    });
    if (error) {
      // 42501 = the function's own gate (membership, permission, warehouse,
      // parent). Say what it means rather than "internal error": the operator
      // can act on a permission message; nobody can act on a scrubbed one.
      if ((error as { code?: string }).code === '42501') {
        throw new ServiceError(
          'forbidden',
          'Placing stock into a new rack or crate needs the Transfer stock permission.',
        );
      }
      throw new ServiceError('internal_error', error.message);
    }
    // `returns setof ... rows 1`: PostgREST answers with a one-element array.
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new ServiceError('internal_error', 'mint_placement_location returned no row');
    }
    return row as Record<string, unknown>;
  }

  /**
   * The FIND half of `findOrCreateRackOrCrate`, on its own: the existing row
   * this input would reuse, or null when it would mint a new one. Creates
   * nothing and asserts nothing — it is a read.
   *
   * ═══ WHY THE HALVES ARE SEPARABLE: GATE BEFORE MINT ═══
   *
   * The placement gate must run BEFORE the destination row is created, or
   * "Go back" at the confirmation leaves an empty rack/crate behind that no
   * flow ever cleans up. (L4L runs 50 racks and zero crates today, so an orphan
   * would be visible clutter in their locations list from day one.)
   *
   * The gate's safety-critical half — the ITEM's current summary — still comes
   * from the database and never from the client. The DESTINATION half is
   * different: it is what the operator typed and is about to create, so
   * comparing against those provisional values is legitimate and is NOT the
   * "trust the client" hazard that caused the original data loss. This split is
   * what lets the caller resolve an EXISTING destination (whose real columns are
   * the truth, exactly as before) without committing to an insert for one that
   * does not exist yet.
   *
   * THE WINDOW between this read and the later create is closed by
   * `findOrCreateRackOrCrate` itself, which re-runs this lookup and reuses
   * whatever appeared. And a row that appears in that window cannot change the
   * gate's verdict: the dedupe key is `lower(name)`, the name is COMPOSED from
   * the very crate columns being compared (`crateAwareLocationName`), and the
   * comparison normalises case — so any row that matches the name carries the
   * same normalised crate pair the provisional values did.
   */
  async findRackOrCrate(input: CreateLocationInput) {
    // THE NAME THIS RESOLVES AGAINST MUST BE THE NAME `create` WOULD INSERT.
    // For every shipped caller they are identical (all compose through
    // `planNewLocation`), but a positioned crate handed an uncomposed name is
    // renamed by `crateAwareLocationName` on the way into the insert — so
    // matching on the raw `input.name` would miss the row this very function
    // created a moment ago and fall through to a second insert, which 0270's
    // unique index rejects with a 23505 the caller reads as an internal error.
    // One name, one lookup, one insert.
    const name = crateAwareLocationName(input);
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
      const target = name.trim().toLowerCase();
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
        const canonTarget = formatRackLabel(parseRackLabel(name)).toLowerCase();
        const canonMatch = rows.find(
          (loc) =>
            formatRackLabel(parseRackLabel((loc as { name: string }).name)).toLowerCase() ===
            canonTarget,
        );
        if (canonMatch) return canonMatch;
      }
    }
    return null;
  }

  /**
   * ═══ A RENAME MUST NOT STRIP A CRATE'S POSITION ═══
   *
   * A crate's rack is carried by its NAME — "Gray #BIN on rack 43-B" — because
   * that is what makes migration 0270's `lower(name)` index keep five real
   * "gray BIN" bins as five rows (see `findOrCreateRackOrCrate`). The
   * `rack_number`/`rack_row` columns hold the same pair, but nothing that
   * renders a placement reads them: a holding travels to every formatter as
   * `{ name, quantity, kind }` and nothing else.
   *
   * So a crate whose columns say 43-B but whose NAME has lost the suffix is a
   * row that has quietly stopped sitting on a rack, everywhere at once — every
   * pick slip, count sheet and detail card. No write path produces that shape,
   * and each of the two is stopped by its OWN gate: `create` composes (or
   * refuses) the name inside `crateAwareLocationName`, in the single insert
   * every caller shares — this used to say "create composes through
   * `formatCrateLocationName`" while only create's CALLERS did, leaving
   * `createLocationAction` able to mint the shape this guard refuses — and this
   * `update` cannot touch the columns at all (it patches name/type/parent/notes
   * only). A RENAME is the other way in, and this is the gate on it.
   *
   * REFUSE rather than regenerate. Regenerating would silently discard what the
   * operator typed, and it cannot be right in the case they most plausibly
   * meant — retyping the position to MOVE the crate — because the columns would
   * still say 43-B afterwards. Refusing states the constraint and leaves the
   * name theirs. (Moving a crate is a put-away, not a rename.)
   *
   * Racks are not covered: a rack's name IS its label, so a rename changes what
   * it is called and nothing silently disagrees.
   */
  private async assertRenameKeepsCratePosition(id: string, nextName: string) {
    const { data: row } = await this.ctx.supabase
      .from('locations')
      .select('kind, rack_number, rack_row')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (!row) return;
    const loc = row as { kind: string | null; rack_number: string | null; rack_row: string | null };
    if (loc.kind !== 'crate') return;
    const position = formatRackPosition({ rackNumber: loc.rack_number, rackRow: loc.rack_row });
    if (!position) return;
    if (locationNameSitsOnRack(nextName, position)) return;
    throw new ServiceError(
      'validation_error',
      `This crate sits on rack ${position}, and the position is part of its name — every pick slip, count sheet and item card reads the rack out of the name. Keep "on rack ${position}" at the end, or move the crate with a put-away instead of renaming it.`,
    );
  }

  async update(id: string, patch: UpdateLocationInput) {
    assertPermission(this.ctx, 'locations:manage');
    if (patch.name !== undefined) await this.assertRenameKeepsCratePosition(id, patch.name);
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
