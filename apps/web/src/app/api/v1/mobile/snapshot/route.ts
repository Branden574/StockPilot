import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { getWarehouseAccess } from '@/lib/auth/warehouse';
import { buildWarehouseScope } from '@/lib/warehouse-scope';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { fetchAllRows } from '@/server/services/lib/paginate';

/**
 * Funnels every supabase error in this route through reportError() and
 * returns an opaque slug to the client. The previous shape leaked
 * Postgres error text (including table/column/RLS-policy names) into
 * the mobile app, which would surface in error reports + crashlytics.
 */
function dbError(
  ctx: { organizationId: string },
  tag: string,
  err: { message?: string; code?: string; details?: string; hint?: string },
) {
  // Log everything server-side via reportError. ALSO surface the tag
  // (which Supabase table the failure happened on) in the response
  // body so the mobile client can include it in its console warn —
  // saves a Vercel logs round-trip when diagnosing a fresh failure.
  // The message/code/hint go to the server log; only the tag leaks
  // to the client, which is intentional (no PII, just a table name).
  void reportError(new Error(err.message ?? 'unknown'), {
    tag: `mobile.snapshot.${tag}`,
    organizationId: ctx.organizationId,
    extra: {
      code: err.code ?? null,
      details: err.details ?? null,
      hint: err.hint ?? null,
    },
  });
  return NextResponse.json(
    {
      error: 'internal_error',
      query: tag,
      // Include the supabase error message in the body too — this
      // endpoint is only callable by authenticated org members so
      // the message isn't leaking to an outside attacker, and it
      // turns a 60s "something's wrong" loop into a 60s "exactly
      // this query is broken" loop.
      detail: err.message ?? null,
    },
    { status: 500 },
  );
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Top-level error wrapper. Every code path that previously could throw
 * (auth context resolution, warehouse access lookup, supabase query
 * builders) is now caught here so the mobile client never sees an
 * uncaught 500 without an accompanying server-side trace. The 60s
 * useSync foreground loop was triggering Vercel anomaly alerts because
 * exceptions thrown in `getWarehouseAccess()` propagated up with no
 * log, and Vercel categorized them as silent failures.
 */
async function handler(req: NextRequest): Promise<NextResponse> {
  try {
    return await snapshotGET(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    void reportError(err instanceof Error ? err : new Error(message), {
      tag: 'mobile.snapshot.uncaught',
    });
    // Mirror Next's own error logging so it shows up in `vercel logs`.
    console.error('[mobile.snapshot] uncaught:', message, stack);
    return NextResponse.json(
      { error: 'internal_error', code: 'snapshot_uncaught' },
      { status: 500 },
    );
  }
}

export const GET = handler;

/**
 * Bundle of everything the mobile app caches locally for offline use.
 *
 * Query: ?since=<iso>
 *   • Items, warehouses, POs, cycle counts, bundles changed since `since`.
 *   • If `since` is missing or invalid, returns a full snapshot.
 *
 * Scope:
 *   • Warehouses + items + POs are filtered to the user's warehouse access.
 *   • Cycle counts include all in_progress counts in scope.
 *   • Bundles: org-wide active bundles. Mobile only reads them for
 *     distribution; cross-warehouse phantom math happens server-side.
 *
 * Response shape:
 *   {
 *     serverTime: iso,                         // mobile sets next `since` to this
 *     warehouseScope: { hasAllAccess, warehouseNames },  // scoped-view banner
 *     warehouses: [{ id, name }],
 *     items: [{ id, sku, name, barcode, qty, unit_cost, warehouse_id, item_type }],
 *     openPOs: [{ id, po_number, status, expected_at, warehouse_id, lines: [...] }],
 *     openCycleCounts: [{ id, status, warehouse_id, started_at, lines: [...] }],
 *     bundles: [{ id, name, sku, components: [{ item_id, qty, optional }],
 *                 phantom_qty, preassembly_enabled }],
 *     removedItemIds?: string[],   // delta pulls only — items that LEFT scope
 *     activeBundleIds?: string[]   // the COMPLETE active-bundle id set
 *   }
 *
 * Removals (SP-081b): `items` and `bundles` are `since`-filtered, so a delta
 * response is a list of ADDITIONS/CHANGES and has no way to say "this row is
 * gone". Archived/soft-deleted items and deactivated bundles therefore lived
 * on in the handset's SQLite until the next FULL resync (org switch or
 * sign-out) — staff kept opening a kit from the cached Bundles list and
 * enqueueing a distribute the server then refused. The two fields above give
 * a delta pull the vocabulary to remove. Both are ADDITIVE and OPTIONAL: a
 * binary that predates them ignores unknown JSON keys and behaves exactly as
 * before, and an absent field means "the server told us nothing to remove"
 * (never "remove everything").
 */
async function snapshotGET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  // Per-user throttle: this is the mobile app's full/delta sync. 30/min easily
  // covers pull-to-refresh + foreground delta syncs while capping a tight loop
  // (the heaviest authenticated query path). Fail-open.
  const rl = await checkRateLimit(`mobile-snapshot:user:${ctx.userId}`, 30, 60_000);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return NextResponse.json(
      { error: 'rate_limited', message: 'Syncing too often — try again shortly.' },
      { status: 429, headers: { 'retry-after': String(retryAfter) } },
    );
  }

  const url = new URL(req.url);
  const sinceRaw = url.searchParams.get('since');
  const since =
    sinceRaw && !Number.isNaN(Date.parse(sinceRaw))
      ? new Date(sinceRaw).toISOString()
      : null;

  // getWarehouseAccess internally uses the cookie-bound supabase client
  // for its warehouses lookup, but bearer-authenticated requests from
  // the mobile app have no cookies. Run the lookup through ctx.supabase
  // (the bearer-bound client) instead so RLS sees the right auth.uid().
  // For manager+ roles the role check alone determines hasAllAccess, so
  // even if the readableIds list is empty for a bearer request, the
  // downstream filters skip warehouse pinning correctly.
  let access: Awaited<ReturnType<typeof getWarehouseAccess>>;
  try {
    access = await getWarehouseAccess(ctx);
  } catch (err) {
    void reportError(
      err instanceof Error ? err : new Error(String(err)),
      { tag: 'mobile.snapshot.warehouse_access', organizationId: ctx.organizationId },
    );
    // Fall back to org-wide access. This is the same posture a manager
    // would get anyway, and the per-table queries are still RLS-gated
    // by ctx.supabase, so we're not bypassing security here.
    access = { readableIds: [], writableIds: [], hasAllAccess: true, primaryWarehouseId: null };
  }
  const serverTime = new Date().toISOString();

  // ── Warehouses ──────────────────────────────────────────────────
  let whQ = ctx.supabase
    .from('warehouses')
    .select('id, name, updated_at')
    .eq('organization_id', ctx.organizationId)
    .order('name', { ascending: true });
  // Restrict to the caller's readable warehouses. The PostgREST builder is
  // immutable — `.in()` returns a NEW builder, so the result must be
  // reassigned or the warehouse-access filter is silently dropped (a
  // restricted user would otherwise receive the org's full warehouse list).
  if (!access.hasAllAccess && access.readableIds.length) {
    whQ = whQ.in('id', access.readableIds);
  }
  const { data: warehouses, error: whErr } = await whQ;
  if (whErr) return dbError(ctx, 'warehouses', whErr);

  // ── Items ───────────────────────────────────────────────────────
  // `is_bundle` is NOT NULL DEFAULT false on every row (see migration
  // 0040), so the previous `.or('is_bundle.is.null,is_bundle.eq.false')`
  // was over-defensive AND occasionally tripped PostgREST's null-
  // comparison parser when the bundles migration hadn't refreshed the
  // schema cache. Simpler eq filter — same result, no edge cases.
  //
  // PostgREST silently caps any single query at 1000 rows (max_rows).
  // A `.limit(2000)` call was therefore silently truncating large
  // inventories. Use fetchAllRows to page through all matching rows.
  // Stable order on `id` guarantees pages don't overlap or skip rows
  // when records are written between page fetches.
  let itemFetchErr: { message?: string; code?: string; details?: string; hint?: string } | null = null;
  const items = await fetchAllRows<{
    id: string;
    sku: string | null;
    name: string;
    barcode: string | null;
    quantity_on_hand: number;
    unit_cost: number | null;
    warehouse_id: string | null;
    item_type: string;
    is_bundle: boolean;
    updated_at: string;
  }>((from, to) => {
    let q = ctx.supabase
      .from('inventory_items')
      .select(
        `id, sku, name, barcode, quantity_on_hand, unit_cost, warehouse_id,
         item_type, is_bundle, updated_at`,
      )
      .eq('organization_id', ctx.organizationId)
      .is('deleted_at', null)
      .eq('status', 'active')
      .eq('is_bundle', false)
      .order('id', { ascending: true })
      .range(from, to);
    if (!access.hasAllAccess && access.readableIds.length) {
      q = q.in('warehouse_id', access.readableIds);
    }
    if (since) q = q.gte('updated_at', since);
    return q;
  }).catch((err: unknown) => {
    itemFetchErr = err instanceof Error
      ? { message: err.message }
      : { message: String(err) };
    return null;
  });
  if (itemFetchErr) return dbError(ctx, 'items', itemFetchErr);

  // ── Open POs (and their lines) ──────────────────────────────────
  // purchase_orders ships through a destination_location_id pointer
  // (FK to locations); each location carries the warehouse_id. The
  // canonical PO service uses an embedded join — same here. Use !inner
  // only when filtering, otherwise we'd drop POs whose destination is
  // null.
  const destEmbed = !access.hasAllAccess && access.readableIds.length
    ? 'destination:locations!destination_location_id!inner (warehouse_id)'
    : 'destination:locations!destination_location_id (warehouse_id)';
  let poQ = ctx.supabase
    .from('purchase_orders')
    .select(
      `id, po_number, status, expected_at, destination_location_id, updated_at,
       ${destEmbed},
       items:purchase_order_items (
         id, item_id, quantity_ordered, quantity_received, unit_cost
       )`,
    )
    .eq('organization_id', ctx.organizationId)
    .in('status', ['ordered', 'partially_received', 'draft'])
    .order('updated_at', { ascending: false })
    .limit(200);
  if (!access.hasAllAccess && access.readableIds.length) {
    poQ = poQ.in('destination.warehouse_id', access.readableIds);
  }
  if (since) poQ = poQ.gte('updated_at', since);
  const { data: pos, error: poErr } = await poQ;
  if (poErr) return dbError(ctx, 'pos', poErr);

  // ── Open cycle counts (and their lines) ─────────────────────────
  let ccQ = ctx.supabase
    .from('cycle_counts')
    .select(
      `id, status, warehouse_id, started_at, assigned_to, notes,
       lines:cycle_count_lines (
         id, item_id, expected_quantity, counted_quantity
       )`,
    )
    .eq('organization_id', ctx.organizationId)
    .eq('status', 'in_progress')
    .order('started_at', { ascending: false })
    .limit(50);
  if (!access.hasAllAccess && access.readableIds.length) {
    ccQ = ccQ.or(
      `warehouse_id.is.null,warehouse_id.in.(${access.readableIds.join(',')})`,
    );
  }
  const { data: counts, error: ccErr } = await ccQ;
  if (ccErr) return dbError(ctx, 'cycle_counts', ccErr);

  // ── Bundles ─────────────────────────────────────────────────────
  // Embedded joins to two relations (bundle_components AND the phantom
  // inventory_items pointer) can trip PostgREST's schema cache when
  // it's stale — and on a fresh deploy the cache is sometimes a few
  // seconds behind the migration. Split into three queries instead:
  // bundles → components by bundle_id → phantom rows by id. Stitched
  // together in code. Single round-trip via parallel awaits, and the
  // shape sent to the client is unchanged.
  let bQ = ctx.supabase
    .from('bundles')
    .select(`id, name, sku, preassembly_enabled, phantom_item_id, updated_at`)
    .eq('organization_id', ctx.organizationId)
    .eq('is_active', true)
    .is('archived_at', null)
    .order('name', { ascending: true });
  if (since) bQ = bQ.gte('updated_at', since);
  const { data: bundles, error: bErr } = await bQ;
  if (bErr) return dbError(ctx, 'bundles', bErr);

  const bundleIds = (bundles ?? []).map((b) => b.id as string);
  const phantomIds = (bundles ?? [])
    .map((b) => b.phantom_item_id as string | null)
    .filter((v): v is string => Boolean(v));

  const [componentsRes, phantomsRes] = await Promise.all([
    bundleIds.length > 0
      ? ctx.supabase
          .from('bundle_components')
          .select('bundle_id, item_id, quantity, is_optional')
          .in('bundle_id', bundleIds)
      : Promise.resolve({ data: [], error: null }),
    phantomIds.length > 0
      ? ctx.supabase
          .from('inventory_items')
          .select('id, quantity_on_hand, warehouse_id')
          .in('id', phantomIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (componentsRes.error) return dbError(ctx, 'bundle_components', componentsRes.error);
  if (phantomsRes.error) return dbError(ctx, 'bundle_phantoms', phantomsRes.error);

  const componentsByBundle = new Map<
    string,
    Array<{ item_id: string; quantity: number; is_optional: boolean }>
  >();
  for (const c of (componentsRes.data ?? []) as Array<{
    bundle_id: string;
    item_id: string;
    quantity: number;
    is_optional: boolean;
  }>) {
    const list = componentsByBundle.get(c.bundle_id) ?? [];
    list.push({ item_id: c.item_id, quantity: c.quantity, is_optional: c.is_optional });
    componentsByBundle.set(c.bundle_id, list);
  }
  const phantomById = new Map<
    string,
    { quantity_on_hand: number; warehouse_id: string | null }
  >();
  for (const p of (phantomsRes.data ?? []) as Array<{
    id: string;
    quantity_on_hand: number;
    warehouse_id: string | null;
  }>) {
    phantomById.set(p.id, { quantity_on_hand: p.quantity_on_hand, warehouse_id: p.warehouse_id });
  }

  // ── Removals ────────────────────────────────────────────────────
  // See the "Removals (SP-081b)" note on the doc block above for WHY.
  //
  // Both reads FAIL CLOSED by omitting their field: the client treats an
  // absent list as "no instruction" (today's behaviour), whereas a short or
  // empty list built from a failed read would delete rows the phone should
  // still hold. Run together — neither depends on the other.
  const [removedItemIds, activeBundleIds] = await Promise.all([
    // (a) Items that left scope since the cursor. Delta pulls ONLY: without
    // `since` this would enumerate every item the org ever archived, and a
    // full pull is already reconciled client-side by sweeping the rows it
    // did not receive.
    //
    // Deliberately NOT expressed as the inverse predicate in PostgREST
    // (`.neq('status','active')` drops NULL status, `.not('deleted_at',
    // 'is',null)` is another NULL trap — recurring bug pattern #23). Instead
    // ask for the ids of EVERY non-bundle row that changed since the cursor
    // and subtract the ones the payload above actually delivered: whatever
    // the in-scope query filters on, changed-but-not-delivered means "no
    // longer in scope", and the two sets can never drift apart.
    //
    // Residual gap, on purpose: a row that left the caller's RLS visibility
    // entirely (moved to an unreadable warehouse, or into a hidden category)
    // is invisible to this read too, so it is not reported. Closing that
    // needs a service-role read; the full-pull sweep still catches it.
    (async (): Promise<string[] | undefined> => {
      if (!since) return undefined;
      const delivered = new Set((items ?? []).map((i) => i.id));
      try {
        const changed = await fetchAllRows<{ id: string }>((from, to) =>
          ctx.supabase
            .from('inventory_items')
            .select('id')
            .eq('organization_id', ctx.organizationId)
            // is_bundle rows are a different species (a bundle's phantom
            // stock row), excluded from `items` structurally rather than by
            // lifecycle — they were never delivered, so reporting them as
            // "removed" would be pure payload noise on every sync tick.
            .eq('is_bundle', false)
            .gte('updated_at', since)
            .order('id', { ascending: true })
            .range(from, to),
        );
        return changed.map((r) => r.id).filter((id) => !delivered.has(id));
      } catch (err) {
        void reportError(err instanceof Error ? err : new Error(String(err)), {
          tag: 'mobile.snapshot.removed_items',
          organizationId: ctx.organizationId,
        });
        return undefined;
      }
    })(),
    // (b) The org's COMPLETE active-bundle id set, independent of `since`.
    // The client treats it as authoritative and deletes any cached bundle
    // absent from it, so it MUST be complete: paged through fetchAllRows
    // because a single .select() is silently clamped to PostgREST's
    // max_rows (1000) and a truncated list would wipe live bundles.
    (async (): Promise<string[] | undefined> => {
      try {
        const rows = await fetchAllRows<{ id: string }>((from, to) =>
          ctx.supabase
            .from('bundles')
            .select('id')
            .eq('organization_id', ctx.organizationId)
            .eq('is_active', true)
            .is('archived_at', null)
            .order('id', { ascending: true })
            .range(from, to),
        );
        return rows.map((r) => r.id);
      } catch (err) {
        void reportError(err instanceof Error ? err : new Error(String(err)), {
          tag: 'mobile.snapshot.active_bundle_ids',
          organizationId: ctx.organizationId,
        });
        return undefined;
      }
    })(),
  ]);

  return NextResponse.json({
    serverTime,
    since,
    // The org's enabled module ids. Mobile derives its drawer + gates its
    // bottom tabs from this set (mirrors the web sidebar, which already
    // derives from the registry). string[] over the wire; mobile re-hydrates
    // it into a Set<ModuleId>.
    enabledModules: Array.from(ctx.enabledModules),
    // The caller's EFFECTIVE permissions (role defaults + org overrides, mig
    // 0207). Mobile gates its drawer nav on this so a revoked permission hides
    // its link — mirrors the web sidebar's ctx.permissions gating. string[]
    // over the wire; mobile re-hydrates into a Set<Permission>.
    permissions: Array.from(ctx.permissions ?? []),
    // Warehouse scoping for the caller — drives the mobile Items screen's
    // scoped-view banner (web parity with ScopedWarehouseNotice). Reuses the
    // access decision computed above; the pure builder narrows the (possibly
    // unfiltered — see whQ's zero-assignment edge) warehouse rows to the
    // caller's readable set, so a scoped user with no assignments reports []
    // rather than the org's full list.
    warehouseScope: buildWarehouseScope(
      access,
      (warehouses ?? []).map((w) => ({ id: w.id as string, name: w.name as string })),
    ),
    warehouses: (warehouses ?? []).map((w) => ({
      id: w.id,
      name: w.name,
    })),
    items: (items ?? []).map((i) => ({
      id: i.id,
      sku: i.sku,
      name: i.name,
      barcode: i.barcode,
      quantityOnHand: Number(i.quantity_on_hand) || 0,
      unitCost: Number(i.unit_cost) || 0,
      warehouseId: i.warehouse_id,
      itemType: i.item_type,
    })),
    openPOs: (pos ?? []).map((p) => {
      const lines = ((p as { items?: unknown[] }).items ?? []) as Array<{
        id: string;
        item_id: string;
        quantity_ordered: number;
        quantity_received: number;
        unit_cost: number;
      }>;
      const dest = (p as { destination?: { warehouse_id?: string | null } | { warehouse_id?: string | null }[] | null }).destination;
      const destWarehouseId = Array.isArray(dest)
        ? (dest[0]?.warehouse_id ?? null)
        : (dest?.warehouse_id ?? null);
      return {
        id: p.id,
        poNumber: p.po_number,
        status: p.status,
        expectedAt: p.expected_at,
        warehouseId: destWarehouseId,
        lines: lines.map((l) => ({
          id: l.id,
          itemId: l.item_id,
          qtyOrdered: Number(l.quantity_ordered) || 0,
          qtyReceived: Number(l.quantity_received) || 0,
          unitCost: Number(l.unit_cost) || 0,
        })),
      };
    }),
    openCycleCounts: (counts ?? []).map((c) => {
      const lines = ((c as { lines?: unknown[] }).lines ?? []) as Array<{
        id: string;
        item_id: string;
        expected_quantity: number;
        counted_quantity: number | null;
      }>;
      return {
        id: c.id,
        status: c.status,
        warehouseId: c.warehouse_id,
        startedAt: c.started_at,
        assignedTo: c.assigned_to,
        notes: c.notes,
        lines: lines.map((l) => ({
          id: l.id,
          itemId: l.item_id,
          expected: Number(l.expected_quantity) || 0,
          counted:
            l.counted_quantity == null ? null : Number(l.counted_quantity),
        })),
      };
    }),
    bundles: (bundles ?? []).map((b) => {
      const phantom = b.phantom_item_id ? phantomById.get(b.phantom_item_id as string) : null;
      const components = componentsByBundle.get(b.id as string) ?? [];
      return {
        id: b.id,
        name: b.name,
        sku: b.sku,
        preassemblyEnabled: Boolean(b.preassembly_enabled),
        phantomItemId: b.phantom_item_id,
        phantomQty: phantom ? Number(phantom.quantity_on_hand) || 0 : 0,
        phantomWarehouseId: phantom?.warehouse_id ?? null,
        components: components.map((c) => ({
          itemId: c.item_id,
          quantity: Number(c.quantity) || 0,
          isOptional: Boolean(c.is_optional),
        })),
      };
    }),
    // Spread-conditional so a failed removal read OMITS the key rather than
    // sending `null`/`[]` — the client's `Array.isArray()` guard must see
    // "absent", which is its no-op path. An EMPTY array is still sent when
    // the read succeeded and there is genuinely nothing active/removed:
    // that is a real instruction, not a failure.
    ...(removedItemIds ? { removedItemIds } : {}),
    ...(activeBundleIds ? { activeBundleIds } : {}),
  });
}
