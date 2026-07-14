import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { deriveLocationName } from '@/lib/locations/rack-name';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { revalidateInventoryList } from '@/server/loaders/inventory-list';
import { assertPermission, ServiceError, serviceErrorStatus } from '@/server/services/context';
import { InventoryService, type PlaceDest } from '@/server/services/inventory';
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
 * Body: { fromLocationId, quantity, notes?, (toLocationId | newRack) }
 *   - toLocationId: an existing rack/crate in your org.
 *   - newRack: { rackNumber, rackRow?, crateColor?, crateNumber? } — created via
 *     LocationsService.create (asserts 'locations:manage'; racks/crates don't
 *     count against the sites plan limit) in the SOURCE location's warehouse,
 *     which is derived server-side (never trusted from the client).
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
const newRackSchema = z.object({
  rackNumber: z.string().min(1).max(64),
  rackRow: z.string().max(64).optional(),
  crateColor: z.string().max(64).optional(),
  crateNumber: z.string().max(64).optional(),
});

const bodySchema = z
  .object({
    fromLocationId: z.string().uuid(),
    // `.finite()` rejects "Infinity"/"NaN" that coerce would otherwise pass.
    quantity: z.coerce.number().positive().finite(),
    notes: z.string().max(2000).optional(),
    // Exactly one destination: an existing location OR an inline-created rack.
    toLocationId: z.string().uuid().optional(),
    newRack: newRackSchema.optional(),
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
      const n = body.newRack;
      // findOrCreateRackOrCrate reuses an existing non-deleted rack/crate with
      // the same warehouse+name first — mirrors the web actions' dedup fix
      // (migration 0270); previously this always INSERTed, minting a
      // duplicate `locations` row every time the mobile app put away onto a
      // rack name that already existed. Asserts 'locations:manage' and scopes
      // the insert to ctx.organizationId on the create-fallback path only
      // (racks/crates don't consume the sites plan limit).
      const created = await new LocationsService(ctx).findOrCreateRackOrCrate({
        name: deriveLocationName(n),
        type: n.crateColor ? 'bin' : 'shelf',
        kind: n.crateColor ? 'crate' : 'rack',
        warehouseId: srcLoc.warehouse_id,
        rackNumber: n.rackNumber,
        rackRow: n.rackRow ?? null,
        crateColor: n.crateColor ?? null,
        crateNumber: n.crateNumber ?? null,
      });
      toLocationId = created.id as string;
      dest = {
        kind: n.crateColor ? 'crate' : 'rack',
        rackNumber: n.rackNumber ?? null,
        rackRow: n.rackRow ?? null,
        name: deriveLocationName(n),
      };
    } else {
      // TENANT-ISOLATION GUARD: pin the destination to THIS session's org and
      // reject the staging/unplaced system buckets. transfer_stock already asserts
      // both locations belong to the item's org (assert_location_in_org, 0201/0231);
      // this additionally ties the destination to ctx.organizationId (matters for a
      // dual-org member) and yields a clean 400 rather than a generic RPC 500.
      const { data: destLoc } = await ctx.supabase
        .from('locations')
        .select('id, kind, rack_number, rack_row, name')
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
      dest = {
        kind: destLoc.kind,
        rackNumber: (destLoc as { rack_number: string | null }).rack_number ?? null,
        rackRow: (destLoc as { rack_row: string | null }).rack_row ?? null,
        name: (destLoc as { name: string | null }).name ?? null,
      };
    }

    // Re-asserts 'stock:transfer' internally, then calls transfer_stock.
    const svc = new InventoryService(ctx);
    await svc.transferStock({
      itemId: id,
      fromLocationId: body.fromLocationId,
      toLocationId,
      quantity: body.quantity,
      notes: body.notes,
    });

    // Put-away (source was a staging/unplaced bucket) stamps the placement label
    // so bin_location tracks the rack — matching web placeStockAction. A plain
    // rack→rack move leaves the label alone, matching web transferStockAction.
    // Best-effort: stock is already placed, so a stamp failure never fails here.
    if (srcLoc?.kind === 'staging' || srcLoc?.kind === 'unplaced') {
      await svc.stampPlacementBin([id], dest);
    }

    // A move re-slices this item's placement holdings shown in the cached
    // Items/Books views — refresh the org's list cache (on-hand total is
    // unchanged, but the per-rack breakdown is not).
    revalidateInventoryList(ctx.organizationId);
    return NextResponse.json({ ok: true, toLocationId });
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
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, { tag: 'api.v1.items.transfer' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
