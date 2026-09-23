import { NextResponse, type NextRequest } from 'next/server';
import { isManagerOrAbove } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { getWarehouseAccess, type WarehouseAccess } from '@/lib/auth/warehouse';
import { buildWarehouseScope } from '@/lib/warehouse-scope';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { fetchAllRowsByIds, settleAsDataError } from '@/server/services/lib/fetch-by-ids';
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

/**
 * A read's outcome held as a value, so a read that is still in flight (or has
 * already failed) can never become an unhandled rejection while the route
 * walks the results in order. `unwrap` re-throws a rejection at the exact
 * point the serial route would have thrown it.
 */
type Settled<T> = { ok: true; value: T } | { ok: false; reason: unknown };

function settle<T>(p: PromiseLike<T>): Promise<Settled<T>> {
  return Promise.resolve(p).then(
    (value): Settled<T> => ({ ok: true, value }),
    (reason: unknown): Settled<T> => ({ ok: false, reason }),
  );
}

function unwrap<T>(s: Settled<T>): T {
  if (!s.ok) throw s.reason;
  return s.value;
}

/**
 * What a warehouse-scoped read answers, without being sent, for a caller
 * narrowed to NO warehouse. Only `data` and `error` are ever read from a
 * result in this route.
 */
const NO_ROWS = { data: [] as never[], error: null };

/**
 * A warehouse-scoped read: sent, or, when the caller is narrowed to no
 * warehouse, answered with NO_ROWS and never sent (a PostgREST builder sends
 * its request only when awaited, and this never awaits it).
 */
function scopedRead<T>(
  narrowedToNothing: boolean,
  read: PromiseLike<T>,
): Promise<Settled<T | typeof NO_ROWS>> {
  return settle<T | typeof NO_ROWS>(narrowedToNothing ? Promise.resolve(NO_ROWS) : read);
}

/**
 * The access this route builds its filters from for manager-and-above: every
 * warehouse, by role. The id list is never read when hasAllAccess is true.
 */
const ROLE_GRANTS_ALL: Pick<WarehouseAccess, 'hasAllAccess' | 'readableIds'> = {
  hasAllAccess: true,
  readableIds: [],
};

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
 *   • A scoped (staff/viewer) user with NO readable warehouse gets none of
 *     the four above: narrowed to nothing, never unfiltered.
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

  // Manager-and-above see every warehouse because of their ROLE, and the
  // lookup is not made for them. getWarehouseAccess answers hasAllAccess =
  // true for them on the same isManagerOrAbove(role) test whatever its
  // `warehouses` list read returns (lib/auth/warehouse.ts), and this route
  // never reads a manager's id list: every warehouse filter below is skipped
  // for an all-access caller, and warehouseScope names come from this
  // route's own warehouses read. Asking anyway cost a manager one more read
  // per sync (on a Bearer ctx it is a direct `warehouses` query) and a way to
  // fail: a failed list read turned into a 500 for a caller whose access
  // never depended on it.
  //
  // Staff and viewer (the 0280 all-warehouses flag included) are decided by
  // their own assignment rows, so for them the lookup runs, through
  // ctx.supabase (the Bearer-bound client: the cookie client is anon on a
  // cookie-less request and would see zero assignment rows).
  //
  // Sent BEFORE the rate-limit verdict and read AFTER it, so the two round
  // trips overlap instead of queueing: measured 2026-09-22, a call through
  // our servers can stall 1-8 s at Supabase's entry point, and this route
  // used to pay for its ~11 calls one after another. This is the only read a
  // refused request can cause, and it is the cheap one (the caller's own
  // assignment rows); none of it reaches the response of a refused request.
  // Held as a settled value so a failure is handled, and reported, only when
  // the request is actually served, exactly as before.
  const accessP = isManagerOrAbove(ctx.role)
    ? null
    : settle((async () => getWarehouseAccess(ctx))());

  // Per-user throttle: this is the mobile app's full/delta sync. 30/min easily
  // covers pull-to-refresh + foreground delta syncs while capping a tight loop
  // (the heaviest authenticated query path). Fail-open.
  //
  // It cannot start any earlier than this. Its key is the VERIFIED user id,
  // which exists only once withApiContext has validated the token; keying it
  // on an unverified token's `sub` would let anyone holding a forged token
  // spend a real user's budget and stop that user's phone from syncing. And
  // no data read below starts until this says yes: the heavy reads are what
  // the limit exists to cap.
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

  // For staff and viewer, an access lookup that threw, or that answered from
  // a failed read, is a REFUSAL: no data read is built, and the phone keeps
  // what it has.
  //
  // This used to fall back to hasAllAccess: true ("RLS still gates"). That
  // dropped every warehouse filter below for a staff or viewer caller, so the
  // response was bounded by row level security alone, and it told the phone
  // "every warehouse" in warehouseScope. An authorization input that could
  // not be read must deny, never widen.
  //
  // Why a 500 and not an empty "no warehouses" 200: a 200 is an instruction
  // the phone acts on. On a full pull sync.ts sweeps every cached item the
  // response did not carry (STALE_ITEMS_SWEEP_SQL), so an empty answer to a
  // transient read failure would wipe a staffer's offline inventory, and the
  // banner would tell them they have no warehouses. Every other failed read in
  // this route already answers 500 `internal_error` with a `query` tag, and
  // pullSnapshot treats any non-2xx as "keep the cache, retry on the next
  // tick". Same contract, same report tag as before.
  let access: Pick<WarehouseAccess, 'hasAllAccess' | 'readableIds'> = ROLE_GRANTS_ALL;
  if (accessP) {
    const accessResult = await accessP;
    if (!accessResult.ok || accessResult.value.unreadable) {
      const err = accessResult.ok ? new Error('warehouse access unreadable') : accessResult.reason;
      void reportError(err instanceof Error ? err : new Error(String(err)), {
        tag: 'mobile.snapshot.warehouse_access',
        organizationId: ctx.organizationId,
      });
      return NextResponse.json(
        { error: 'internal_error', query: 'warehouse_access' },
        { status: 500 },
      );
    }
    access = accessResult.value;
  }

  // The warehouses every warehouse-scoped read below is narrowed to: null for
  // an all-access caller (no narrowing), otherwise exactly the readable ids.
  // Narrowing is decided by whether this is null, NEVER by its length. The
  // filters used to be guarded by `!hasAllAccess && readableIds.length`, so a
  // scoped member whose lookup succeeded but found no assignment got no
  // filter at all: every warehouse, item, PO and count that row level
  // security let through, and a phone that cached them. A scoped caller with
  // no readable warehouse is narrowed to nothing, and gets nothing.
  const scopeIds: string[] | null = access.hasAllAccess ? null : access.readableIds;
  // Narrowed to nothing: the four warehouse-scoped reads answer NO_ROWS and
  // are never sent (scopedRead). Not sent as `.in(col, [])` either: nothing
  // about the answer should rest on how PostgREST reads an empty list, and it
  // saves four round trips. The org-wide reads (bundles, and the two removal
  // reads) run as usual, so a delta pull still reports every item that
  // changed since its cursor as removed.
  const seesNoWarehouse = scopeIds !== null && scopeIds.length === 0;
  // Taken before any read below is sent, so the next delta's cursor can only
  // overlap this pull, never leave a gap after it.
  const serverTime = new Date().toISOString();

  // ── Every read goes out at once ─────────────────────────────────
  // Measured 2026-09-22: these ran one after another, so a stall at
  // Supabase's entry point on ANY of them was added to the phone's wait
  // (bundles alone took 3779 ms inside one user's snapshot at 18:45:23Z).
  // None of them depends on another, except the bundle components and
  // phantoms, which need the bundle ids and so chain behind the bundles read
  // without holding up anything else. The snapshot now costs its slowest
  // read instead of the sum of all of them.
  //
  // Every read is still built on ctx.supabase (the caller's own client, under
  // their row level security) with exactly the filters it had. The RESULTS
  // are checked in the old order further down, so a failure answers with the
  // same response and the same single report it always did: the first read,
  // in that order, that came back with an error or threw.

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
  // in-list-bound: the caller's readable warehouses (an org's handful of sites)
  if (scopeIds) whQ = whQ.in('id', scopeIds);
  const warehousesP = scopedRead(seesNoWarehouse, whQ);

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
  type ItemRow = {
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
  };
  const itemsP = seesNoWarehouse
    ? Promise.resolve({ rows: [] as ItemRow[], err: null })
    : fetchAllRows<ItemRow>((from, to) => {
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
        // in-list-bound: the caller's readable warehouses (an org's handful of sites)
        if (scopeIds) q = q.in('warehouse_id', scopeIds);
        if (since) q = q.gte('updated_at', since);
        return q;
      }).then(
        (rows) => ({ rows, err: null }),
        // Any failure, returned or thrown, is reported as the items read: the
        // same catch-all this read has always had.
        (err: unknown) => ({
          rows: null,
          err: { message: err instanceof Error ? err.message : String(err) },
        }),
      );

  // ── Open POs (and their lines) ──────────────────────────────────
  // purchase_orders ships through a destination_location_id pointer
  // (FK to locations); each location carries the warehouse_id. The
  // canonical PO service uses an embedded join — same here. Use !inner
  // only when filtering, otherwise we'd drop POs whose destination is
  // null.
  const destEmbed = scopeIds
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
  // in-list-bound: the caller's readable warehouses (an org's handful of sites)
  if (scopeIds) poQ = poQ.in('destination.warehouse_id', scopeIds);
  if (since) poQ = poQ.gte('updated_at', since);
  const posP = scopedRead(seesNoWarehouse, poQ);

  // ── Open cycle counts (and their lines) ─────────────────────────
  let ccQ = ctx.supabase
    .from('cycle_counts')
    .select(
      `id, count_number, status, warehouse_id, started_at, assigned_to, notes,
       lines:cycle_count_lines (
         id, item_id, expected_quantity, counted_quantity
       )`,
    )
    .eq('organization_id', ctx.organizationId)
    .eq('status', 'in_progress')
    .order('started_at', { ascending: false })
    .limit(50);
  if (scopeIds) {
    // in-list-bound: the caller's readable warehouses (an org's handful of sites)
    ccQ = ccQ.or(`warehouse_id.is.null,warehouse_id.in.(${scopeIds.join(',')})`);
  }
  // Narrowed to nothing answers no counts at all, the null-warehouse ones
  // included: the web's CycleCountsService.list() returns [] for a scoped
  // caller with no warehouse, and the phone should not list more than it.
  const countsP = scopedRead(seesNoWarehouse, ccQ);

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
  const bundlesP = settle(
    (async () => {
      const bundlesRes = await bQ;
      // A failed bundles read never sends the two follow-ups, as before.
      if (bundlesRes.error) return { ok: false as const, error: bundlesRes.error };

      const bundleIds = (bundlesRes.data ?? []).map((b) => b.id as string);
      const phantomIds = (bundlesRes.data ?? [])
        .map((b) => b.phantom_item_id as string | null)
        .filter((v): v is string => Boolean(v));

      // An org's active bundles are not capped. One `.in()` of every bundle
      // id failed past ~215 locally and ~395 in production, which failed the
      // whole snapshot (the phone's sync) for an org with that many bundles;
      // and a bundle's components were one unpaged read, cut at 1000 rows.
      // Both now go 100 ids per request, paged, into the same { data, error }
      // shape, so a failure still answers as bundle_components /
      // bundle_phantoms below.
      type ComponentRow = {
        bundle_id: string;
        item_id: string;
        quantity: number;
        is_optional: boolean;
      };
      type PhantomRow = { id: string; quantity_on_hand: number; warehouse_id: string | null };
      const [componentsRes, phantomsRes] = await Promise.all([
        settleAsDataError(
          fetchAllRowsByIds<ComponentRow>(bundleIds, (batch) => (from, to) =>
            ctx.supabase
              .from('bundle_components')
              .select('bundle_id, item_id, quantity, is_optional')
              .in('bundle_id', batch)
              // (bundle_id, item_id) is the primary key: a stable page order.
              .order('bundle_id', { ascending: true })
              .order('item_id', { ascending: true })
              .range(from, to),
          ),
        ),
        settleAsDataError(
          fetchAllRowsByIds<PhantomRow>(phantomIds, (batch) => (from, to) =>
            ctx.supabase
              .from('inventory_items')
              .select('id, quantity_on_hand, warehouse_id')
              .in('id', batch)
              .order('id', { ascending: true })
              .range(from, to),
          ),
        ),
      ]);
      return { ok: true as const, bundles: bundlesRes.data, componentsRes, phantomsRes };
    })(),
  );

  // ── Removal reads: sent now, read after the payload ─────────────
  // What they are for, and why each is shaped the way it is, is noted where
  // their results are read below.
  //
  // (a) Every non-bundle item id that changed since the cursor. Delta pulls
  // only. Sending it alongside the items read, instead of after every other
  // read, also narrows the window in which a row edited between the two
  // reads is reported as removed (it heals on the next pull either way).
  const changedItemsP = since
    ? settle(
        fetchAllRows<{ id: string }>((from, to) =>
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
        ),
      )
    : null;
  // (b) The org's COMPLETE active-bundle id set, independent of `since`.
  // Paged through fetchAllRows because a single .select() is silently
  // clamped to PostgREST's max_rows (1000) and a truncated list would wipe
  // live bundles.
  const activeBundleRowsP = settle(
    fetchAllRows<{ id: string }>((from, to) =>
      ctx.supabase
        .from('bundles')
        .select('id')
        .eq('organization_id', ctx.organizationId)
        .eq('is_active', true)
        .is('archived_at', null)
        .order('id', { ascending: true })
        .range(from, to),
    ),
  );

  // ── Results, in the serial route's order ────────────────────────
  const { data: warehouses, error: whErr } = unwrap(await warehousesP);
  if (whErr) return dbError(ctx, 'warehouses', whErr);

  const { rows: items, err: itemFetchErr } = await itemsP;
  if (itemFetchErr) return dbError(ctx, 'items', itemFetchErr);

  const { data: pos, error: poErr } = unwrap(await posP);
  if (poErr) return dbError(ctx, 'pos', poErr);

  const { data: counts, error: ccErr } = unwrap(await countsP);
  if (ccErr) return dbError(ctx, 'cycle_counts', ccErr);

  const bundleReads = unwrap(await bundlesP);
  if (!bundleReads.ok) return dbError(ctx, 'bundles', bundleReads.error);
  const { bundles, componentsRes, phantomsRes } = bundleReads;
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
  // still hold. Their failures are reported here and only here, so a pull
  // that already failed above still reports once, as it always did.
  //
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
  let removedItemIds: string[] | undefined;
  if (changedItemsP) {
    const changed = await changedItemsP;
    if (changed.ok) {
      const delivered = new Set((items ?? []).map((i) => i.id));
      removedItemIds = changed.value.map((r) => r.id).filter((id) => !delivered.has(id));
    } else {
      const err = changed.reason;
      void reportError(err instanceof Error ? err : new Error(String(err)), {
        tag: 'mobile.snapshot.removed_items',
        organizationId: ctx.organizationId,
      });
    }
  }
  // (b) The client treats this set as authoritative and deletes any cached
  // bundle absent from it, so it MUST be complete — hence the paging above.
  let activeBundleIds: string[] | undefined;
  const activeBundleRows = await activeBundleRowsP;
  if (activeBundleRows.ok) {
    activeBundleIds = activeBundleRows.value.map((r) => r.id);
  } else {
    const err = activeBundleRows.reason;
    void reportError(err instanceof Error ? err : new Error(String(err)), {
      tag: 'mobile.snapshot.active_bundle_ids',
      organizationId: ctx.organizationId,
    });
  }
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
    // access decision computed above; the pure builder also narrows the
    // warehouse rows to the caller's readable set, so a scoped user with no
    // assignments reports [] (and the banner says so) on either account.
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
        // The count's permanent reference (0358). The phone stores it beside
        // the header and renders it with formatCycleCountNumber.
        countNumber: (c as { count_number?: number | null }).count_number ?? null,
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
