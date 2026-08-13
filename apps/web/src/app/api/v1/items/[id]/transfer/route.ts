import { newLocationFieldsShape, planNewLocation, refineNewLocation } from '@stockpilot/core';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { isPositionedCrate, toPlaceDest, type PlaceDest } from '@/lib/locations/destination-option';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { revalidateInventoryList } from '@/server/loaders/inventory-list';
import { assertPermission, ServiceError, serviceErrorStatus } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';
import { LocationsService } from '@/server/services/locations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mobile "Move stock" — the REST parity for the web StockTransferDialog and the
 * Staging put-away flow (both web-only, driven by server actions). It moves a
 * quantity of one item from a SOURCE holding (a rack/crate, or a staging/
 * unplaced bucket for put-away) into a DESTINATION rack/crate — either an
 * EXISTING one (`toLocationId`) or one CREATED inline (`newRack`), mirroring the
 * web dialog's "+ New location…" branch.
 *
 * Why a REST route and not a direct RPC from the app: the transfer_stock RPC
 * only checks the staff-role floor. The 'stock:transfer' PERMISSION is asserted
 * in InventoryService.transferStock — so mobile MUST go through the service, or
 * a member without stock:transfer could move stock by calling the RPC directly.
 *
 * Body: { fromLocationId, quantity, notes?, (toLocationId | newRack),
 *         acknowledgedCrateChanges? }
 *   - toLocationId: an existing rack/crate in your org.
 *   - newRack: a RACK ({ rackNumber, rackRow? }) or a CRATE ({ crateNumber,
 *     crateColor?, rackNumber?, rackRow? }) — a crate SITS ON a rack, so the
 *     rack pair alongside crate fields is that crate's POSITION and both are
 *     kept; see packages/core/src/inventory/new-location.ts. Created via
 *     LocationsService.create (asserts 'locations:manage'; racks/crates don't
 *     count against the sites plan limit) in the SOURCE location's warehouse,
 *     which is derived server-side (never trusted from the client).
 *   - acknowledgedCrateChanges: the answer to a
 *     BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION refusal — item id + the
 *     fingerprint of the crate the client displayed, never a blanket flag.
 *
 * Answers { ok, toLocationId, crateSyncFailed?, crateSyncSkipped?,
 * crateSyncStale?, crateSyncUnplaced? }. The stock moved in every one of those
 * cases; the flags say whether the book's crate LABEL followed it.
 *
 * Defense in depth (three independent org-scoping layers, none sufficient to
 * bypass alone): (1) transfer_stock reads the item under the CALLER's RLS, so a
 * foreign-org itemId is invisible → item_not_found; (2) the RPC asserts BOTH
 * locations belong to the item's org (assert_location_in_org, mig 0201/0231);
 * (3) this route additionally pins the destination to THIS session's org
 * (ctx.organizationId) and rejects the staging/unplaced system buckets — which
 * also gives a clean 400 instead of a generic RPC 500. A newly created rack is
 * born in-org (LocationsService.create scopes to ctx.organizationId), and its
 * warehouse is taken from the source location's own warehouse, so it can't be
 * seeded under a foreign org.
 */
const newRackSchema = z
  .object({
    // The four fields and the rule they obey are ONE declaration shared with
    // the web actions (packages/core/src/inventory/new-location.ts). "rack A1 +
    // crate 9" is CRATE 9 ON RACK A1 — one row, named "Crate #9 on rack A1", so
    // the sheet's confirmation and the created row are the same string
    // (REPRO A/A' was the two disagreeing, not the input being invalid).
    ...newLocationFieldsShape,
  })
  .superRefine(refineNewLocation);

const bodySchema = z
  .object({
    fromLocationId: z.string().uuid(),
    // `.finite()` rejects "Infinity"/"NaN" that coerce would otherwise pass.
    quantity: z.coerce.number().positive().finite(),
    notes: z.string().max(2000).optional(),
    // Exactly one destination: an existing location OR an inline-created rack.
    toLocationId: z.string().uuid().optional(),
    newRack: newRackSchema.optional(),
    /**
     * The native sheet's answer to the book-crate confirmation — the SAME
     * scoped shape the web actions take: one entry per book, item id plus a
     * fingerprint of the crate the phone displayed. Never a blanket flag.
     */
    acknowledgedCrateChanges: z
      .array(
        z.object({
          itemId: z.string().uuid(),
          currentFingerprint: z.string().min(1).max(256),
        }),
      )
      .max(200)
      .optional(),
  })
  .refine((v) => (v.toLocationId ? 1 : 0) + (v.newRack ? 1 : 0) === 1, {
    message: 'Provide exactly one destination — an existing location or a new rack.',
    path: ['toLocationId'],
  })
  .refine((v) => !v.toLocationId || v.toLocationId !== v.fromLocationId, {
    message: 'Source and destination must be different locations.',
    path: ['toLocationId'],
  });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // Per-user throttle — defense-in-depth on top of the service's stock:transfer
  // gate. 60/min is far above a human tapping through put-away.
  const rl = await checkRateLimit(`stock-transfer:${ctx.userId}`, 60, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Too many requests — slow down.' },
      {
        status: 429,
        headers: {
          'retry-after': String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))),
        },
      },
    );
  }

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json(
      { error: 'validation_error', message: 'Invalid item id.' },
      { status: 400 },
    );
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid request' },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
    // Fail-fast on authorization BEFORE probing any locations — a caller without
    // stock:transfer shouldn't even learn whether a location exists. Throws
    // ServiceError('forbidden') → 403; transferStock asserts it again (defense
    // in depth).
    assertPermission(ctx, 'stock:transfer');

    // Read the SOURCE holding's kind once. It (a) confirms fromLocationId is a
    // real, in-org location, (b) yields the warehouse for an inline-created
    // rack (never trust a client warehouseId), and (c) tells a put-away (source
    // is a staging/unplaced bucket) from a rack→rack move — only a put-away
    // stamps the bin_location label below, mirroring web exactly (placeStockAction
    // stamps; transferStockAction does not).
    const { data: srcLoc } = await ctx.supabase
      .from('locations')
      .select('warehouse_id, kind')
      .eq('id', body.fromLocationId)
      .eq('organization_id', ctx.organizationId)
      .is('deleted_at', null)
      .maybeSingle();

    // Resolve the destination location id from either an existing location or an
    // inline-created rack/crate, and capture what we need to stamp its label.
    let toLocationId: string;
    let dest: PlaceDest;
    if (body.newRack) {
      if (!srcLoc?.warehouse_id) {
        return NextResponse.json(
          {
            error: 'validation_error',
            message: 'Source location not found in your organization, or has no warehouse.',
          },
          { status: 400 },
        );
      }
      // findOrCreateRackOrCrate reuses an existing non-deleted rack/crate with
      // the same warehouse+name first — mirrors the web actions' dedup fix
      // (migration 0270); previously this always INSERTed, minting a
      // duplicate `locations` row every time the mobile app put away onto a
      // rack name that already existed. Asserts 'locations:manage' and scopes
      // the insert to ctx.organizationId on the create-fallback path only
      // (racks/crates don't consume the sites plan limit).
      //
      // Kind, name and columns all come out of ONE `planNewLocation` verdict,
      // so the row created is provably the row the client's confirmation named.
      const plan = planNewLocation(body.newRack);
      if (plan.kind === 'invalid') {
        // Unreachable through bodySchema, which refuses the same combination
        // with the same message. Fail closed rather than guess a destination.
        return NextResponse.json(
          { error: 'validation_error', message: plan.message },
          { status: 400 },
        );
      }
      const isCrate = plan.kind === 'crate';
      const created = await new LocationsService(ctx).findOrCreateRackOrCrate({
        name: plan.name,
        type: isCrate ? 'bin' : 'shelf',
        kind: isCrate ? 'crate' : 'rack',
        warehouseId: srcLoc.warehouse_id,
        rackNumber: plan.rackNumber,
        rackRow: plan.rackRow,
        crateColor: plan.crateColor,
        crateNumber: plan.crateNumber,
      });
      toLocationId = created.id as string;
      // From the RESOLVED row, not the typed input: a case-insensitive reuse
      // returns the crate that already exists and ITS columns are the truth.
      dest = toPlaceDest(created as Record<string, unknown>);
    } else {
      // TENANT-ISOLATION GUARD: pin the destination to THIS session's org and
      // reject the staging/unplaced system buckets. transfer_stock already asserts
      // both locations belong to the item's org (assert_location_in_org, 0201/0231);
      // this additionally ties the destination to ctx.organizationId (matters for a
      // dual-org member) and yields a clean 400 rather than a generic RPC 500.
      const { data: destLoc } = await ctx.supabase
        .from('locations')
        .select('id, kind, rack_number, rack_row, crate_color, crate_number, name')
        .eq('id', body.toLocationId!)
        .eq('organization_id', ctx.organizationId)
        .is('deleted_at', null)
        .maybeSingle();
      if (!destLoc) {
        return NextResponse.json(
          {
            error: 'validation_error',
            message: 'Destination location not found in your organization.',
          },
          { status: 400 },
        );
      }
      if (destLoc.kind === 'staging' || destLoc.kind === 'unplaced') {
        return NextResponse.json(
          { error: 'validation_error', message: 'Pick a rack or crate as the destination.' },
          { status: 400 },
        );
      }
      toLocationId = destLoc.id;
      dest = toPlaceDest(destLoc as Record<string, unknown>);
    }

    // Re-asserts 'stock:transfer' internally, then calls transfer_stock.
    const svc = new InventoryService(ctx);

    // ═══ THE BOOK-CRATE GATE, ON MOBILE TOO — DEFECT 3(3) ═══
    //
    // This route used to run neither the gate nor the reconciliation, on the
    // grounds that its client had no confirmation UI. The consequence was worse
    // than the one it avoided: a book put away from the phone got NO
    // book_crate_* written AT ALL — not even on a FIRST assignment, where there
    // is provably nothing to confirm — because inventory_set_rack (migration
    // 0068) writes only the rack keys. Web's comment about "the next put-away
    // reconciles it" was therefore simply false for a mobile-first warehouse.
    //
    // The fix is not to skip the gate, it is to give the phone a way to answer:
    // apps/mobile/src/components/move-stock-modal.tsx now renders the refusal
    // and retries with `acknowledgedCrateChanges`, and the refusal's structured
    // `details` are forwarded below so it can. A client that does NOT answer
    // gets a clean 409 naming the crate — refusing loudly is safe; overwriting
    // quietly is not.
    const verified = await svc.assertBookCratePlacementAllowed([id], dest, {
      acknowledged: body.acknowledgedCrateChanges,
      toLocationId,
      moves: new Map([[id, { fromLocationId: body.fromLocationId, quantity: body.quantity }]]),
    });

    await svc.transferStock({
      itemId: id,
      fromLocationId: body.fromLocationId,
      toLocationId,
      quantity: body.quantity,
      notes: body.notes,
    });

    // Put-away (source was a staging/unplaced bucket) stamps the placement label
    // so bin_location tracks the rack — matching web placeStockAction. A plain
    // rack→rack move leaves the label alone, matching web transferStockAction —
    // EXCEPT into a positioned crate, where the crate summary and the rack
    // summary describe the same physical place and writing one without the
    // other publishes a self-contradicting row. Same narrowing, same helper, as
    // transferStockAction.
    // Best-effort: stock is already placed, so a stamp failure never fails here.
    if (
      srcLoc?.kind === 'staging' ||
      srcLoc?.kind === 'unplaced' ||
      isPositionedCrate(dest)
    ) {
      await svc.stampPlacementBin([id], dest);
    }

    // …and the crate SUMMARY follows the holdings, on BOTH kinds of move — same
    // as web. Never throws; a failure is reported, never rolled back.
    const crate = await svc.syncBookCratePlacement([id], {
      verified,
      audit: { toLocationId, quantityByItemId: new Map([[id, body.quantity]]) },
    });

    // A move re-slices this item's placement holdings shown in the cached
    // Items/Books views — refresh the org's list cache (on-hand total is
    // unchanged, but the per-rack breakdown is not).
    revalidateInventoryList(ctx.organizationId);
    return NextResponse.json({
      ok: true,
      toLocationId,
      // The stock moved in every one of these cases; the flags say whether the
      // book's crate LABEL followed it, so the phone can warn instead of
      // showing a bare success.
      ...(crate.failedItemIds.length > 0 ? { crateSyncFailed: true } : {}),
      ...(crate.skippedItemIds.length > 0 ? { crateSyncSkipped: true } : {}),
      ...(crate.staleItemIds.length > 0 ? { crateSyncStale: true } : {}),
      // No placed holding left after the move, so nothing to synchronize to and
      // the summary was left alone — it may now name a crate holding none of
      // it. Silence here was the web bug this route would otherwise inherit.
      ...(crate.unplacedItemIds.length > 0 ? { crateSyncUnplaced: true } : {}),
    });
  } catch (e) {
    // transfer_stock raises `insufficient_stock` (P0001); the service wraps it as
    // ServiceError('internal_error', ...) with the raw text on internalDetail
    // (public message is sanitized — S13). Map it to a friendly 400.
    if (
      e instanceof ServiceError &&
      e.code === 'internal_error' &&
      (e.internalDetail ?? '').toLowerCase().includes('insufficient_stock')
    ) {
      return NextResponse.json(
        {
          error: 'validation_error',
          message: "Can't move more than is available in the source location.",
        },
        { status: 400 },
      );
    }
    if (e instanceof ServiceError) {
      return NextResponse.json(
        {
          error: e.code,
          message: e.message,
          // APP-AUTHORED structured metadata only — the book-crate confirmation
          // payload the phone retries on. `internal_error` details are raw
          // DB/PostgREST text and must stay server-side (S13), the same
          // boundary the web action layer applies in toResult().
          ...(e.code !== 'internal_error' && e.details ? { details: e.details } : {}),
        },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, { tag: 'api.v1.items.transfer' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
