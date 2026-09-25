import * as Network from 'expo-network';

import { getAccountDisabled } from './account-disabled-state';
import {
  ADJUST_STOCK_KIND,
  adjustDrainVerdict,
  adjustSendGate,
  parseQueuedAdjust,
  queuedAdjustRefusalReason,
  refusedQueuedAdjustMessage,
  unconfirmedQueuedAdjustMessage,
  wasAnswered,
} from './adjust-outbox';
import { api } from './api';
import {
  CYCLE_COUNT_HEADER_UPSERT_SQL,
  CYCLE_COUNT_LINE_UPSERT_SQL,
  CYCLE_COUNT_STALE_LINES_DELETE_SQL,
} from './cycle-count-snapshot-sql';
import { CACHE_USER_META_KEY, cacheOwnerAction } from './cache-owner';
import {
  currentCacheGeneration,
  deleteOrgData,
  getDb,
  getMeta,
  setMeta,
  withDbTransaction,
} from './db';
import { classifyDrainFailure } from './drain-failure';
import { ENABLED_MODULES_META_KEY, refreshEnabledModules } from './enabled-modules';
import {
  EFFECTIVE_PERMISSIONS_META_KEY,
  refreshEffectivePermissions,
} from './use-effective-permissions';
import { OutboxSessionChangedError, outboxSendDecision } from './outbox-scope';
import { listPending, markFailed, markHeld, markOk, markRejected, markSending } from './queue';
import { liveOutboxScope } from './session-scope';
import { unconfirmedStock } from './unconfirmed-stock';
import { WAREHOUSE_SCOPE_META_KEY, refreshWarehouseScope } from './warehouse-scope';

/**
 * Two-direction sync engine.
 *
 *   Pull: hit /api/v1/mobile/snapshot?since=… → upsert into local SQLite.
 *         Tracked via meta('last_synced_at').
 *
 *   Push: drain pending_actions in age order, hit each kind's matching
 *         endpoint with the idempotency_key from the row. On 2xx, delete
 *         the row. A definitive refusal (drain-failure.ts: 400/403/409/422,
 *         a 404 with our code, a 401 on a disabled account) is REJECTED —
 *         terminal, parked in Unsent work. Anything else is failed and
 *         retried next tick. `adjust_stock` rows follow their own at-most-once
 *         rules instead (adjust-outbox.ts): their route cannot recognise a
 *         replay, so a send that may have landed is parked, never re-sent.
 */

interface SnapshotResponse {
  serverTime: string;
  /**
   * The org's enabled module ids. Drives the drawer (derived from the
   * shared @stockpilot/core registry) + gates the optional bottom tabs.
   * Absent in snapshots cached before this field existed — readers must
   * default (the drawer/tab consumers fall back to DEFAULT_MODULE_IDS).
   */
  enabledModules: string[];
  /**
   * The user's effective permission set (role defaults + org overrides). Drives
   * the drawer's permission-based nav gating. Absent in snapshots cached before
   * this field existed — readers default to "not loaded" (fall back to the
   * static role permissions, today's behavior).
   */
  permissions?: string[];
  /**
   * The user's warehouse scoping (role + user_warehouse_assignments, computed
   * server-side). Drives the Items screen's scoped-view banner. Absent in
   * snapshots from servers pre-dating this field — readers must treat missing
   * as "not loaded" (no banner), never as all-access or as zero warehouses.
   */
  warehouseScope?: { hasAllAccess: boolean; warehouseNames: string[] };
  warehouses: { id: string; name: string }[];
  items: {
    id: string;
    sku: string;
    name: string;
    barcode: string | null;
    quantityOnHand: number;
    unitCost: number;
    warehouseId: string | null;
    itemType: string | null;
  }[];
  openPOs: {
    id: string;
    poNumber: string | null;
    status: string;
    expectedAt: string | null;
    warehouseId: string | null;
    lines: {
      id: string;
      itemId: string;
      qtyOrdered: number;
      qtyReceived: number;
      unitCost: number;
    }[];
  }[];
  openCycleCounts: {
    id: string;
    /** Permanent reference number (server 0358). Absent from older servers. */
    countNumber?: number | null;
    status: string;
    warehouseId: string | null;
    startedAt: string;
    assignedTo: string | null;
    notes: string | null;
    lines: {
      id: string;
      itemId: string;
      expected: number;
      counted: number | null;
    }[];
  }[];
  bundles: {
    id: string;
    name: string;
    sku: string | null;
    preassemblyEnabled: boolean;
    phantomItemId: string | null;
    phantomQty: number;
    phantomWarehouseId: string | null;
    components: { itemId: string; quantity: number; isOptional: boolean }[];
  }[];
  /**
   * Ids of items that LEFT scope since `since` (archived, deleted, or moved
   * out of the caller's warehouse access). The snapshot route documents this
   * as `deletedItemIds` "(future)" and does not emit it yet — the reader below
   * accepts it under this name and treats a missing/malformed value as "the
   * server told us nothing", which is exactly today's behaviour. See the
   * reconciliation block in pullSnapshot for why a delta response otherwise
   * cannot express a removal.
   */
  removedItemIds?: string[];
  /**
   * The org's COMPLETE active-bundle id list, independent of `since`. Also not
   * emitted yet. When present it is authoritative: anything local and absent
   * from it was deactivated/archived and is deleted, even on a delta pull.
   */
  activeBundleIds?: string[];
}

/**
 * The snapshot route's own `.limit(50)` on open cycle counts, mirrored here as
 * a TRUNCATION guard (see the reconciliation block). If the route ever raises
 * its limit this stays conservative — we prune less, never more.
 */
const SNAPSHOT_CYCLE_COUNT_LIMIT = 50;

/**
 * PostgREST clamps every response to `[api] max_rows = 1000`, and the
 * snapshot's bundles query has no explicit limit of its own — so a 1000-row
 * bundle payload may be a truncated page rather than the whole set. Same
 * truncation guard.
 */
const POSTGREST_MAX_ROWS = 1000;

/*
 * ── Removal SQL (SP-081) ───────────────────────────────────────────────────
 *
 * Exported so the statements can be exercised against a real SQLite in
 * sync.snapshot-removals.test.ts — the same posture as
 * cycle-count-snapshot-sql.ts: the SQL is where this bug lives, so the SQL is
 * what the test runs.
 *
 * `not in (select value from json_each(?))` is NULL-safe here because every id
 * compared is a NOT NULL primary key and json_each never yields NULL for a
 * string array — a NULL anywhere in a NOT IN list would make the whole
 * predicate false and quietly disable the delete.
 */

/** Params: (json array of the count ids the server still lists). */
export const STALE_CYCLE_COUNT_LINES_DELETE_SQL = `
  delete from cycle_count_lines
   where count_id not in (select value from json_each(?))
     and count_id not in (
       select count_id from cycle_count_lines where local_dirty = 1
     )`;

/** Params: (json array of the count ids the server still lists). */
export const STALE_CYCLE_COUNTS_DELETE_SQL = `
  delete from cycle_counts
   where id not in (select value from json_each(?))
     and id not in (
       select count_id from cycle_count_lines where local_dirty = 1
     )`;

/** Params: (json array of the bundle ids that are still active). */
export const STALE_BUNDLE_COMPONENTS_DELETE_SQL = `
  delete from bundle_components
   where bundle_id not in (select value from json_each(?))`;

/** Params: (json array of the bundle ids that are still active). */
export const STALE_BUNDLES_DELETE_SQL = `
  delete from bundles where id not in (select value from json_each(?))`;

/** Params: (json array of item ids the server says are gone). */
export const REMOVED_ITEMS_DELETE_SQL = `
  delete from items where id in (select value from json_each(?))`;

/*
 * Full-pull sweeps. Every row a pull writes gets `last_synced_at = now`, so
 * after a FULL pull anything still carrying an older stamp is a row the server
 * did not return — i.e. it left scope. Cheaper and safer than shipping a
 * 50k-id JSON array as a query parameter.
 */

/** Params: (this pull's `now`). */
export const STALE_ITEMS_SWEEP_SQL = `delete from items where last_synced_at < ?`;

/** Params: (this pull's `now`). Run BEFORE the bundles sweep — it reads them. */
export const STALE_BUNDLE_COMPONENTS_SWEEP_SQL = `
  delete from bundle_components
   where bundle_id in (select id from bundles where last_synced_at < ?)`;

/** Params: (this pull's `now`). */
export const STALE_BUNDLES_SWEEP_SQL = `delete from bundles where last_synced_at < ?`;

export async function isOnline(): Promise<boolean> {
  try {
    const state = await Network.getNetworkStateAsync();
    return Boolean(state.isConnected && state.isInternetReachable !== false);
  } catch {
    return true; // Assume online if the API fails — better to attempt than skip.
  }
}


/**
 * Pull the org snapshot into local SQLite.
 *
 * @param force When true, ignore the persisted `last_synced_at` cursor and
 *   request a FULL snapshot (no `?since`). Used on an org switch: the cursor
 *   belongs to the prior org's timeline, so a delta pull would be wrong — the
 *   caller (`setActiveOrg`) has already wiped the local cache, so a full pull
 *   re-scopes every table to the newly-active org.
 */
export async function pullSnapshot(
  force = false,
): Promise<{ items: number; pos: number; counts: number; bundles: number } | null> {
  // WHOSE cache (cache-owner.ts). Checked before the network check: an
  // offline sign-in as another account must not show the last account's rows
  // either. Another account's cache is cleared and pulled again in full, never
  // delta-pulled from their cursor.
  const { userId: liveUserId } = await liveOutboxScope();
  if (cacheOwnerAction(await getMeta(CACHE_USER_META_KEY), liveUserId) === 'reset') {
    await deleteOrgData();
    force = true;
    // The live readers still hold the previous account's modules, permissions
    // and warehouse banner in memory; the persisted values are gone, so they
    // fall back to their defaults now rather than whenever (or if) this pull
    // lands. Same as a workspace switch does after its wipe.
    refreshEnabledModules();
    refreshEffectivePermissions();
    refreshWarehouseScope();
  }

  if (!(await isOnline())) return null;

  // Noted before the cursor is read and before api() reads the workspace
  // header: any cache wipe asked for after this point (a workspace switch or
  // repair, a sign-out) makes this answer stale. See db.ts cacheGeneration.
  const generationAtRequest = currentCacheGeneration();
  const since = force ? null : await getMeta('last_synced_at');
  const path = since
    ? `/api/v1/mobile/snapshot?since=${encodeURIComponent(since)}`
    : '/api/v1/mobile/snapshot';

  let snap: SnapshotResponse;
  try {
    // Answered for the account recorded as the cache's owner below, or not at
    // all: a session that changed since the check refuses before sending.
    snap = await api<SnapshotResponse>(path, liveUserId ? { asUserId: liveUserId } : {});
    // This pull is the drain's probe of the link (adjust-outbox.ts
    // adjustSendGate): queued stock adjustments, which cannot be retried, are
    // handed off only after the server has just answered this phone.
    adjustSendGate.serverAnswered();
  } catch (e) {
    // Any HTTP status is an answer: the round trip worked. No status is a
    // network error or a timeout, and the drain that follows sends no queued
    // adjustment into it.
    if (wasAnswered(e)) adjustSendGate.serverAnswered();
    else adjustSendGate.noAnswer();
    console.warn('[sync] snapshot pull failed', e);
    return null;
  }

  const db = await getDb();
  const now = Date.now();
  // Once the generation moves (a wipe was asked for), the pull stops writing
  // and lets its transaction COMMIT what already ran: the wipe is queued right
  // behind this transaction and clears those rows. A ROLLBACK would also undo
  // plain writes other flows made on the shared connection meanwhile (the
  // outbox rejection at account eviction, a receipt queued offline).
  let stale = false;
  const moved = () => (stale ||= currentCacheGeneration() !== generationAtRequest);
  let modulesChanged = false;
  let permissionsChanged = false;
  let scopeChanged = false;

  await withDbTransaction(db, async () => {
    // A wipe asked for while the request was out (a workspace switch or
    // repair, a sign-out) means this answer belongs to a cache that no longer
    // exists: writing it would put the old workspace's rows, cursor, modules
    // and permissions under the new one, or a signed-out user's under the next.
    if (moved()) return;
    // A wipe asked for just BEFORE this pull began can still have run after
    // the cursor was read: a delta built on a cleared cursor would commit a
    // partial cache with a fresh cursor that never back-fills.
    if (since !== null && (await getMeta('last_synced_at')) !== since) {
      stale = true;
      return;
    }

    // Warehouses (full replace for simplicity — small set)
    if (snap.warehouses.length > 0) {
      await db.runAsync('delete from warehouses');
      for (const w of snap.warehouses) {
        if (moved()) return;
        await db.runAsync(
          'insert into warehouses (id, name) values (?, ?)',
          [w.id, w.name],
        );
      }
    }

    // Items (upsert on id)
    for (const i of snap.items) {
      if (moved()) return;
      await db.runAsync(
        `insert or replace into items
         (id, sku, name, barcode, quantity_on_hand, unit_cost,
          warehouse_id, item_type, last_synced_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          i.id,
          i.sku,
          i.name,
          i.barcode ?? null,
          i.quantityOnHand,
          i.unitCost,
          i.warehouseId,
          i.itemType,
          now,
        ],
      );
    }

    // POs + lines (replace on PO id)
    for (const p of snap.openPOs) {
      if (moved()) return;
      await db.runAsync(
        `insert or replace into purchase_orders
         (id, po_number, status, warehouse_id, expected_at, last_synced_at)
         values (?, ?, ?, ?, ?, ?)`,
        [p.id, p.poNumber, p.status, p.warehouseId, p.expectedAt, now],
      );
      await db.runAsync('delete from po_lines where po_id = ?', [p.id]);
      for (const l of p.lines) {
        if (moved()) return;
        await db.runAsync(
          `insert into po_lines
           (id, po_id, item_id, qty_ordered, qty_received, unit_cost)
           values (?, ?, ?, ?, ?, ?)`,
          [l.id, p.id, l.itemId, l.qtyOrdered, l.qtyReceived, l.unitCost],
        );
      }
    }

    // Cycle counts + lines — UPSERT, never replace. `insert or replace` is a
    // DELETE + INSERT in SQLite and the delete-then-reinsert of lines was
    // worse: together they wiped cached_at, warehouse_name, item names and —
    // the real damage — local_dirty and the operator's unsynced counted value,
    // every 60 s, on every open count. The statements and their rules are
    // documented and tested in cycle-count-snapshot-sql.ts.
    for (const c of snap.openCycleCounts) {
      if (moved()) return;
      await db.runAsync(CYCLE_COUNT_HEADER_UPSERT_SQL, [
        c.id,
        c.status,
        c.warehouseId,
        c.startedAt,
        c.assignedTo,
        c.notes,
        c.countNumber ?? null,
        now,
      ]);
      for (const l of c.lines) {
        if (moved()) return;
        await db.runAsync(CYCLE_COUNT_LINE_UPSERT_SQL, [
          l.id,
          c.id,
          l.itemId,
          l.expected,
          l.counted,
        ]);
      }
      await db.runAsync(CYCLE_COUNT_STALE_LINES_DELETE_SQL, [
        c.id,
        JSON.stringify(c.lines.map((l) => l.id)),
      ]);
    }

    // Bundles + components (replace on bundle id)
    for (const b of snap.bundles) {
      if (moved()) return;
      await db.runAsync(
        `insert or replace into bundles
         (id, name, sku, preassembly_enabled, phantom_item_id,
          phantom_qty, phantom_warehouse_id, last_synced_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          b.id,
          b.name,
          b.sku,
          b.preassemblyEnabled ? 1 : 0,
          b.phantomItemId,
          b.phantomQty,
          b.phantomWarehouseId,
          now,
        ],
      );
      await db.runAsync('delete from bundle_components where bundle_id = ?', [b.id]);
      for (const comp of b.components) {
        if (moved()) return;
        await db.runAsync(
          `insert into bundle_components
           (bundle_id, item_id, quantity, is_optional)
           values (?, ?, ?, ?)`,
          [b.id, comp.itemId, comp.quantity, comp.isOptional ? 1 : 0],
        );
      }
    }

    // ── Reconcile REMOVALS (SP-081) ────────────────────────────────────
    //
    if (moved()) return;
    // Everything above only ever UPSERTS. A row that leaves the server's
    // scope — an item archived or deleted, a count posted or cancelled, a
    // bundle deactivated — simply stops appearing in the payload, and the
    // only local delete in the whole app was clearOrgScopedTables (org
    // switch / sign-out). So the phone kept showing an archived bundle in
    // the Bundles list; a staffer opened it, enqueued a distribute, and the
    // server refused it ("This bundle is archived or inactive.") — terminal
    // work parked in Unsent work, from a row that should not have been on
    // the device at all.
    //
    // What may be reconciled depends on what the payload PROVES:
    //
    //   • openCycleCounts carries NO `since` filter server-side (the route
    //     builds it from status='in_progress' + warehouse scope only), so
    //     every pull returns the caller's COMPLETE open list. Absence IS
    //     proof of removal — reconcile on every pull.
    //   • items / openPOs / bundles ARE `since`-filtered: on a delta pull an
    //     untouched row is simply not in the payload, so absence proves
    //     nothing. They are reconciled only against a FULL pull, or against
    //     the explicit removal lists once the route emits them.
    //   • POs are deliberately left alone: the route filters them by status
    //     AND caps them at 200, so its response is not a complete set under
    //     either rule.

    // Cycle counts. A count still holding a local_dirty line is the
    // operator's own unsynced work waiting on the outbox — never delete it
    // here (same rule CYCLE_COUNT_STALE_LINES_DELETE_SQL already encodes for
    // lines); the outbox settles it and a later pull removes it.
    if (snap.openCycleCounts.length < SNAPSHOT_CYCLE_COUNT_LIMIT) {
      const openCountIds = JSON.stringify(snap.openCycleCounts.map((c) => c.id));
      await db.runAsync(STALE_CYCLE_COUNT_LINES_DELETE_SQL, [openCountIds]);
      await db.runAsync(STALE_CYCLE_COUNTS_DELETE_SQL, [openCountIds]);
    }

    // Items the server explicitly reported as gone (delta-safe; no-op until
    // the route emits the field).
    if (Array.isArray(snap.removedItemIds) && snap.removedItemIds.length > 0) {
      await db.runAsync(REMOVED_ITEMS_DELETE_SQL, [
        JSON.stringify(snap.removedItemIds.filter((id) => typeof id === 'string')),
      ]);
    }

    // The authoritative active-bundle list, when the server sends one.
    if (Array.isArray(snap.activeBundleIds)) {
      const activeIds = JSON.stringify(
        snap.activeBundleIds.filter((id) => typeof id === 'string'),
      );
      await db.runAsync(STALE_BUNDLE_COMPONENTS_DELETE_SQL, [activeIds]);
      await db.runAsync(STALE_BUNDLES_DELETE_SQL, [activeIds]);
    }

    // Full pull: everything the server returned was just stamped with `now`,
    // so an older stamp means "the server no longer lists this row".
    if (since === null) {
      // items are fetched with fetchAllRows server-side (paged past the
      // PostgREST 1000-row cap), so an items payload is never truncated.
      await db.runAsync(STALE_ITEMS_SWEEP_SQL, [now]);
      // bundles are ONE query with no explicit limit: at exactly max_rows we
      // cannot tell a complete set from a truncated page, and sweeping a
      // truncated page would delete live bundles on every full pull.
      if (snap.bundles.length < POSTGREST_MAX_ROWS && !Array.isArray(snap.activeBundleIds)) {
        await db.runAsync(STALE_BUNDLE_COMPONENTS_SWEEP_SQL, [now]);
        await db.runAsync(STALE_BUNDLES_SWEEP_SQL, [now]);
      }
    }

    if (moved()) return;
    // The cursor, modules, permissions and warehouse scope are part of the
    // same answer, so they are written only when the rows were.
    await setMeta('last_synced_at', snap.serverTime);
    // ...and so is whose answer it was (cache-owner.ts).
    if (liveUserId) await setMeta(CACHE_USER_META_KEY, liveUserId);
    // Persist the org's enabled modules so the drawer + tab gating can read
    // them synchronously between syncs (and while offline). Always written —
    // even an empty array is meaningful (the consumers treat "no persisted
    // value yet" differently from "explicitly no optional modules").
    //
    // If the set CHANGED since the last sync (e.g. an admin toggled a module on
    // the web control plane), notify the live useEnabledModules() subscribers so
    // the drawer + bottom tabs add/remove the entry IMMEDIATELY — on the next
    // foreground/60s sync, no app restart. Compared as JSON so we only re-render
    // the nav when it actually changed, not on every routine sync.
    const nextModulesJson = JSON.stringify(
      Array.isArray(snap.enabledModules) ? snap.enabledModules : [],
    );
    const prevModulesJson = await getMeta(ENABLED_MODULES_META_KEY);
    await setMeta(ENABLED_MODULES_META_KEY, nextModulesJson);
    modulesChanged = prevModulesJson !== nextModulesJson;

    // Same pattern for the user's EFFECTIVE permissions — drives the drawer's
    // permission-based nav gating. Re-renders the drawer immediately when an
    // admin grants/revokes access (next foreground/60s sync, no restart).
    const nextPermsJson = JSON.stringify(
      Array.isArray(snap.permissions) ? snap.permissions : [],
    );
    const prevPermsJson = await getMeta(EFFECTIVE_PERMISSIONS_META_KEY);
    await setMeta(EFFECTIVE_PERMISSIONS_META_KEY, nextPermsJson);
    permissionsChanged = prevPermsJson !== nextPermsJson;

    // Warehouse scope (same persist+notify pattern) — drives the Items
    // screen's scoped-view banner. Only written when the server actually sent
    // it: an older server omitting the field must not clobber a previously
    // persisted scope (and must never read as "no warehouses assigned").
    if (snap.warehouseScope && typeof snap.warehouseScope.hasAllAccess === 'boolean') {
      const nextScopeJson = JSON.stringify({
        hasAllAccess: snap.warehouseScope.hasAllAccess,
        warehouseNames: Array.isArray(snap.warehouseScope.warehouseNames)
          ? snap.warehouseScope.warehouseNames.filter((n): n is string => typeof n === 'string')
          : [],
      });
      const prevScopeJson = await getMeta(WAREHOUSE_SCOPE_META_KEY);
      await setMeta(WAREHOUSE_SCOPE_META_KEY, nextScopeJson);
      scopeChanged = prevScopeJson !== nextScopeJson;
    }
  });

  if (stale) {
    // The switch, repair or sign-out that wiped the cache gets a fresh pull:
    // syncNow chains one after this sync.
    console.warn('[sync] the cache was wiped while the snapshot was loading; it was discarded');
    return null;
  }
  // Notify the live readers only after the new values are committed.
  if (modulesChanged) refreshEnabledModules();
  if (permissionsChanged) refreshEffectivePermissions();
  if (scopeChanged) refreshWarehouseScope();

  return {
    items: snap.items.length,
    pos: snap.openPOs.length,
    counts: snap.openCycleCounts.length,
    bundles: snap.bundles.length,
  };
}

export async function drainQueue(): Promise<{
  ok: number;
  failed: number;
  rejected: number;
}> {
  if (!(await isOnline())) return { ok: 0, failed: 0, rejected: 0 };

  const pending = await listPending();
  let ok = 0;
  let failed = 0;
  let rejected = 0;

  for (const action of pending) {
    // record_count rows are owned by the cycle-count sync engine
    // (cycle-count-sync.ts). Skipping them here prevents the two
    // workers from racing to push the same edit to Supabase twice.
    if (action.kind === 'record_count') continue;

    // WHOSE row, decided now, for THIS row (outbox-scope.ts): the session can
    // end or change between two rows of one drain (a sign-out, "Use password
    // instead", a revoked session, a workspace switch). A row queued by
    // another account, or any row with nobody signed in, is HELD: skipped and
    // left exactly as it is, neither failed nor rejected.
    const decision = outboxSendDecision(action, await liveOutboxScope());
    if (!decision.send) continue;

    // A stock adjustment cannot be retried once it has left the phone
    // (adjust-outbox.ts), so it is handed off only while the link is known to
    // work: the server answered this phone since its last lost answer (the
    // gate; the pull that opens each pass is the probe), and the phone still
    // reports a connection NOW, re-read per row as the cycle-count drain does.
    // Otherwise the row is left exactly as it is, never handed off, and the
    // next pass sends it. Without this, one dropped connection parked every
    // adjustment behind it as "Not confirmed" although none reached the server.
    if (action.kind === ADJUST_STOCK_KIND) {
      if (!adjustSendGate.canSend()) continue;
      if (!(await isOnline())) {
        adjustSendGate.noAnswer();
        continue;
      }
    }

    // Stamps a legacy row with this account, so it is never sent as another.
    await markSending(action.id, { orgId: decision.orgId, userId: decision.userId });
    // When api() handed this row's request to fetch (null: not yet). Before
    // that moment nothing can have reached the server; an adjust_stock row's
    // failure is judged on it (adjust-outbox.ts), since its route cannot dedupe
    // a replay, and its "may still land" window starts there.
    let handedOffAt: number | null = null;
    try {
      await sendOne(
        action.kind,
        action.idempotencyKey,
        action.payload,
        { orgId: decision.orgId, asUserId: decision.userId },
        () => {
          handedOffAt = Date.now();
        },
      );
      await markOk(action.id);
      ok += 1;
    } catch (e) {
      // The account changed between the decision above and the moment api()
      // read the bearer: nothing left the device. Back in the queue, untouched.
      if (e instanceof OutboxSessionChangedError) {
        await markHeld(action.id);
        continue;
      }
      const msg = e instanceof Error ? e.message : String(e);
      // AT MOST ONCE. Retried only when provably not written; parked, never
      // re-sent, when it may have been; each parked row names the item and
      // the change, so the operator knows what to check.
      if (action.kind === ADJUST_STOCK_KIND) {
        const verdict = adjustDrainVerdict(e, {
          accountDisabled: getAccountDisabled(),
          handedOff: handedOffAt !== null,
        });
        if (verdict === 'failed') {
          await markFailed(action.id, msg);
          failed += 1;
        } else if (verdict === 'unconfirmed') {
          // The link just lost an answer: no further adjustment is handed off
          // until the server answers this phone again (the next pass's pull).
          adjustSendGate.noAnswer();
          // The write may still be committing (the server keeps going after
          // api() stops waiting), so the item's ON HAND is labelled "Not
          // confirmed" until it can no longer land. Recorded BEFORE the row
          // leaves the outbox: the item screen re-reads the item the moment it
          // does, and that read must not stand as the confirmed total.
          const itemId = typeof action.payload.itemId === 'string' ? action.payload.itemId : '';
          if (itemId) unconfirmedStock.recordUnconfirmed(itemId, handedOffAt ?? Date.now());
          await markRejected(action.id, unconfirmedQueuedAdjustMessage(action.payload));
          rejected += 1;
        } else {
          await markRejected(
            action.id,
            refusedQueuedAdjustMessage(action.payload, queuedAdjustRefusalReason(e, msg)),
          );
          rejected += 1;
        }
        continue;
      }
      // 4xx (bad payload, validation) and 5xx / network errors both stay in
      // 'failed' and are re-read next tick. The ONE terminal case is a 401 on a
      // known-disabled account: that write must never replay after re-enable.
      const outcome = classifyDrainFailure(e, { accountDisabled: getAccountDisabled() });
      if (outcome === 'rejected') {
        await markRejected(action.id, msg);
        rejected += 1;
      } else {
        await markFailed(action.id, msg);
        failed += 1;
      }
    }
  }
  return { ok, failed, rejected };
}

/** Every queued send goes out under its row's organization and account. */
interface OutboxSendScope {
  orgId: string | null;
  asUserId: string;
}

async function sendOne(
  kind: string,
  idempotencyKey: string,
  payload: Record<string, unknown>,
  scope: OutboxSendScope,
  /** Called by api() as the request is handed to fetch (adjust_stock only). */
  onSend: () => void,
): Promise<void> {
  switch (kind) {
    case 'receive_po_line': {
      const poId = String(payload.poId ?? '');
      if (!poId) throw new Error('receive_po_line: missing poId');
      await api(`/api/v1/po/${poId}/receive-line`, {
        method: 'POST',
        body: { ...payload, idempotencyKey },
        ...scope,
      });
      return;
    }
    // There is deliberately NO 'record_count' case here. drainQueue skips
    // those rows (see the `continue` above) so this branch was unreachable —
    // and it had already DRIFTED from the live sender, CycleCountSyncEngine's
    // sendRecordCount in cycle-count-sync.ts, which coerces countedQuantity,
    // refuses a non-finite or negative value and passes an AbortSignal. This
    // copy did none of that. Two copies of one send, one of them dead, is how
    // a future fix (an idempotency key, a client counted_at) lands in the copy
    // nobody runs — recurring pattern #26. A record_count row reaching sendOne
    // now hits `default:` and is marked failed, loudly, instead of taking a
    // second, weaker path to the server.
    case 'distribute_bundle': {
      const bundleId = String(payload.bundleId ?? '');
      if (!bundleId) throw new Error('distribute_bundle: missing bundleId');
      // The row's key is the same one the screen sent on its direct attempt
      // (0347), so the server returns the original distribution if that
      // attempt actually committed instead of drawing components again.
      await api(`/api/v1/bundles/${bundleId}/distribute`, {
        method: 'POST',
        body: { ...payload, idempotencyKey },
        ...scope,
      });
      return;
    }
    case 'adjust_stock': {
      // Queued by the item screen ONLY when the phone had no connection at the
      // tap (item-adjust.ts), so the first send is this one. The same route and
      // body as an online tap: permission and MFA gate, warehouse scope, audit
      // row, rack/Unplaced for an add, draw mode 'any' for a removal. No
      // idempotency key is sent: the route has none, which is why drainQueue
      // judges this kind's failures by adjust-outbox.ts (at most once).
      // parseQueuedAdjust throws before the hand-off on a malformed row.
      const { itemId, body } = parseQueuedAdjust(payload);
      // Encoded: the id comes from the device's own SQLite, and a path segment
      // is all it may ever be.
      await api(`/api/v1/items/${encodeURIComponent(itemId)}/adjust`, {
        method: 'POST',
        body,
        ...scope,
        onSend,
      });
      return;
    }
    case 'size_count_event': {
      // RETIRED 2026-08-24 with the mobile size-count screens. Kept as a
      // DRAIN-ONLY path: nothing enqueues this kind any more, but rows
      // already in an operator's outbox must still reach the server. The
      // /api/v1/size-counts endpoints remain live for exactly this.
      //
      // Two payload shapes share this kind:
      //   single — one tapped/detected garment = one event (legacy shape;
      //            the outbox row's own key IS the event key)
      //   batch  — `events: [...]`, each event carrying its OWN
      //            idempotencyKey, all enqueued as ONE outbox row.
      // The batch shape exists because a commit that enqueued one row per
      // size could PARTIALLY fail, and every repair of that (retrying with
      // fresh keys, retrying with stable keys) was proven by review to either
      // double-count or silently drop grown quantities. One row is atomic:
      // it either entered the outbox whole or not at all, a replay of the row
      // replays identical per-event keys, and the server dedups per event.
      const sessionId = String(payload.sessionId ?? '');
      if (!sessionId) throw new Error('size_count_event: missing sessionId');
      const batch = Array.isArray(payload.events) ? payload.events : null;
      const events = batch ?? [(() => {
        const { sessionId: _drop, ...event } = payload;
        void _drop;
        return { ...event, idempotencyKey };
      })()];
      await api(`/api/v1/size-counts/${sessionId}/events`, {
        method: 'POST',
        body: { events },
        ...scope,
      });
      return;
    }
    case 'create_book':
    case 'upload_image': {
      throw new Error(`${kind} queueing not yet wired`);
    }
    default:
      throw new Error(`unknown action kind: ${kind}`);
  }
}

/**
 * Single-flight guard. `syncNow` is fired from several lifecycle hooks
 * (app open, foreground event, 60s timer) which used to overlap and
 * race two `db.withTransactionAsync` calls on the same SQLite
 * connection — yielding the noisy `cannot start a transaction within
 * a transaction` and `cannot rollback - no transaction is active`
 * errors. We coalesce concurrent callers onto the in-flight promise so
 * only one sync runs at a time.
 */
let inFlightSync: Promise<void> | null = null;
/** A pull asked for while another sync was running (see syncNow). */
let forcedAfterInFlight: Promise<void> | null = null;
/** The cache generation the in-flight sync started under. */
let inFlightGeneration = 0;

/**
 * Run pull then push. Called on app open + foreground + a 60s timer.
 * Catches all errors so a failed sync never crashes the app shell.
 *
 * @param force Passed through to `pullSnapshot` — forces a full (no-`?since`)
 *   pull. Used on an org switch after the local cache has been wiped.
 */
export async function syncNow(force = false): Promise<void> {
  if (inFlightSync) {
    // Join a running sync only when it started against the current cache. A
    // forced pull (a workspace switch or repair), or any sync after a wipe (a
    // sign-out, then the next sign-in's first sync), would otherwise join a
    // pull that discards itself and leave the cache empty until the next
    // timer. Run a full pull once the running one finishes instead.
    if (!force && currentCacheGeneration() === inFlightGeneration) return inFlightSync;
    forcedAfterInFlight ??= inFlightSync.then(() => {
      forcedAfterInFlight = null;
      return syncNow(true);
    });
    return forcedAfterInFlight;
  }
  inFlightGeneration = currentCacheGeneration();
  inFlightSync = (async () => {
    try {
      await pullSnapshot(force);
      await drainQueue();
    } catch (e) {
      console.warn('[sync] syncNow failed', e);
    } finally {
      inFlightSync = null;
    }
  })();
  return inFlightSync;
}
