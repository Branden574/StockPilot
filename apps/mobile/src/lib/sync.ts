import * as Network from 'expo-network';

import { api } from './api';
import { getDb, getMeta, setMeta } from './db';
import { ENABLED_MODULES_META_KEY, refreshEnabledModules } from './enabled-modules';
import {
  EFFECTIVE_PERMISSIONS_META_KEY,
  refreshEffectivePermissions,
} from './use-effective-permissions';
import { listPending, markFailed, markOk, markSending } from './queue';
import { WAREHOUSE_SCOPE_META_KEY, refreshWarehouseScope } from './warehouse-scope';

/**
 * Two-direction sync engine.
 *
 *   Pull: hit /api/v1/mobile/snapshot?since=… → upsert into local SQLite.
 *         Tracked via meta('last_synced_at').
 *
 *   Push: drain pending_actions in age order, hit each kind's matching
 *         endpoint with the idempotency_key from the row. On 2xx, delete
 *         the row. On 4xx (client error — bad payload), mark failed; the
 *         user can retry from a queue UI. On 5xx / network failure, leave
 *         pending so the next tick retries.
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
  warehouses: Array<{ id: string; name: string }>;
  items: Array<{
    id: string;
    sku: string;
    name: string;
    barcode: string | null;
    quantityOnHand: number;
    unitCost: number;
    warehouseId: string | null;
    itemType: string | null;
  }>;
  openPOs: Array<{
    id: string;
    poNumber: string | null;
    status: string;
    expectedAt: string | null;
    warehouseId: string | null;
    lines: Array<{
      id: string;
      itemId: string;
      qtyOrdered: number;
      qtyReceived: number;
      unitCost: number;
    }>;
  }>;
  openCycleCounts: Array<{
    id: string;
    status: string;
    warehouseId: string | null;
    startedAt: string;
    assignedTo: string | null;
    notes: string | null;
    lines: Array<{
      id: string;
      itemId: string;
      expected: number;
      counted: number | null;
    }>;
  }>;
  bundles: Array<{
    id: string;
    name: string;
    sku: string | null;
    preassemblyEnabled: boolean;
    phantomItemId: string | null;
    phantomQty: number;
    phantomWarehouseId: string | null;
    components: Array<{ itemId: string; quantity: number; isOptional: boolean }>;
  }>;
}

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
  if (!(await isOnline())) return null;

  const since = force ? null : await getMeta('last_synced_at');
  const path = since
    ? `/api/v1/mobile/snapshot?since=${encodeURIComponent(since)}`
    : '/api/v1/mobile/snapshot';

  let snap: SnapshotResponse;
  try {
    snap = await api<SnapshotResponse>(path);
  } catch (e) {
    console.warn('[sync] snapshot pull failed', e);
    return null;
  }

  const db = await getDb();
  const now = Date.now();

  await db.withTransactionAsync(async () => {
    // Warehouses (full replace for simplicity — small set)
    if (snap.warehouses.length > 0) {
      await db.runAsync('delete from warehouses');
      for (const w of snap.warehouses) {
        await db.runAsync(
          'insert into warehouses (id, name) values (?, ?)',
          [w.id, w.name],
        );
      }
    }

    // Items (upsert on id)
    for (const i of snap.items) {
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
      await db.runAsync(
        `insert or replace into purchase_orders
         (id, po_number, status, warehouse_id, expected_at, last_synced_at)
         values (?, ?, ?, ?, ?, ?)`,
        [p.id, p.poNumber, p.status, p.warehouseId, p.expectedAt, now],
      );
      await db.runAsync('delete from po_lines where po_id = ?', [p.id]);
      for (const l of p.lines) {
        await db.runAsync(
          `insert into po_lines
           (id, po_id, item_id, qty_ordered, qty_received, unit_cost)
           values (?, ?, ?, ?, ?, ?)`,
          [l.id, p.id, l.itemId, l.qtyOrdered, l.qtyReceived, l.unitCost],
        );
      }
    }

    // Cycle counts + lines (replace on count id)
    for (const c of snap.openCycleCounts) {
      await db.runAsync(
        `insert or replace into cycle_counts
         (id, status, warehouse_id, started_at, assigned_to, notes, last_synced_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
        [c.id, c.status, c.warehouseId, c.startedAt, c.assignedTo, c.notes, now],
      );
      await db.runAsync('delete from cycle_count_lines where count_id = ?', [c.id]);
      for (const l of c.lines) {
        await db.runAsync(
          `insert into cycle_count_lines (id, count_id, item_id, expected, counted)
           values (?, ?, ?, ?, ?)`,
          [l.id, c.id, l.itemId, l.expected, l.counted],
        );
      }
    }

    // Bundles + components (replace on bundle id)
    for (const b of snap.bundles) {
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
        await db.runAsync(
          `insert into bundle_components
           (bundle_id, item_id, quantity, is_optional)
           values (?, ?, ?, ?)`,
          [b.id, comp.itemId, comp.quantity, comp.isOptional ? 1 : 0],
        );
      }
    }
  });

  await setMeta('last_synced_at', snap.serverTime);
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
  if (prevModulesJson !== nextModulesJson) {
    refreshEnabledModules();
  }

  // Same pattern for the user's EFFECTIVE permissions — drives the drawer's
  // permission-based nav gating. Re-renders the drawer immediately when an
  // admin grants/revokes access (next foreground/60s sync, no restart).
  const nextPermsJson = JSON.stringify(
    Array.isArray(snap.permissions) ? snap.permissions : [],
  );
  const prevPermsJson = await getMeta(EFFECTIVE_PERMISSIONS_META_KEY);
  await setMeta(EFFECTIVE_PERMISSIONS_META_KEY, nextPermsJson);
  if (prevPermsJson !== nextPermsJson) {
    refreshEffectivePermissions();
  }

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
    if (prevScopeJson !== nextScopeJson) {
      refreshWarehouseScope();
    }
  }

  return {
    items: snap.items.length,
    pos: snap.openPOs.length,
    counts: snap.openCycleCounts.length,
    bundles: snap.bundles.length,
  };
}

export async function drainQueue(): Promise<{ ok: number; failed: number }> {
  if (!(await isOnline())) return { ok: 0, failed: 0 };

  const pending = await listPending();
  let ok = 0;
  let failed = 0;

  for (const action of pending) {
    // record_count rows are owned by the cycle-count sync engine
    // (cycle-count-sync.ts). Skipping them here prevents the two
    // workers from racing to push the same edit to Supabase twice.
    if (action.kind === 'record_count') continue;

    await markSending(action.id);
    try {
      await sendOne(action.kind, action.idempotencyKey, action.payload);
      await markOk(action.id);
      ok += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 4xx errors (bad payload, validation) — don't retry; mark failed
      // so the user can review. 5xx / network errors — retry next tick
      // by leaving the row in 'failed' too (the worker re-reads
      // 'pending' or 'failed').
      await markFailed(action.id, msg);
      failed += 1;
    }
  }
  return { ok, failed };
}

async function sendOne(
  kind: string,
  idempotencyKey: string,
  payload: Record<string, unknown>,
): Promise<void> {
  switch (kind) {
    case 'receive_po_line': {
      const poId = String(payload.poId ?? '');
      if (!poId) throw new Error('receive_po_line: missing poId');
      await api(`/api/v1/po/${poId}/receive-line`, {
        method: 'POST',
        body: { ...payload, idempotencyKey },
      });
      return;
    }
    case 'record_count': {
      const countId = String(payload.cycleCountId ?? '');
      const lineId = String(payload.lineId ?? '');
      if (!countId || !lineId) throw new Error('record_count: missing ids');
      await api(`/api/v1/cycle-counts/${countId}/lines/${lineId}/record`, {
        method: 'POST',
        body: payload,
      });
      return;
    }
    case 'distribute_bundle': {
      const bundleId = String(payload.bundleId ?? '');
      if (!bundleId) throw new Error('distribute_bundle: missing bundleId');
      await api(`/api/v1/bundles/${bundleId}/distribute`, {
        method: 'POST',
        body: payload,
      });
      return;
    }
    case 'adjust_stock': {
      // Reuses the existing adjust_stock RPC via a thin server route;
      // in the meantime the mobile scan tab still hits supabase.rpc()
      // directly when online, so this branch only fires for offline-
      // queued adjusts.
      throw new Error('adjust_stock queueing not yet wired — adjust online for now');
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

/**
 * Run pull then push. Called on app open + foreground + a 60s timer.
 * Catches all errors so a failed sync never crashes the app shell.
 *
 * @param force Passed through to `pullSnapshot` — forces a full (no-`?since`)
 *   pull. Used on an org switch after the local cache has been wiped.
 */
export async function syncNow(force = false): Promise<void> {
  if (inFlightSync) return inFlightSync;
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
