import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { cycleCountScopeLabel } from '@stockpilot/core';

import { ServiceError } from './context';
import { fetchAllRowsByIds } from './lib/fetch-by-ids';
import { fetchAllRows } from './lib/paginate';

export interface DigestLowStockGroup {
  warehouseName: string;
  items: Array<{
    id: string;
    sku: string;
    name: string;
    qty: number;
    reorderPoint: number;
  }>;
}

export interface DigestOpenPo {
  id: string;
  poNumber: string;
  supplierName: string | null;
  expectedAt: string | null;
  status: string;
  isOverdue: boolean;
}

export interface DigestCycleCount {
  id: string;
  /** Permanent reference number (0358), printed as CC-000042. */
  countNumber: number | null;
  /** What the count covers: the warehouse, "All warehouses" (an org-wide
   *  count) or "Selected items" (a selection with no single warehouse). */
  scopeLabel: string;
  warehouseName: string | null;
  startedAt: string;
  totalLines: number;
  countedLines: number;
}

export interface DigestPayload {
  /** The lowest LOW_STOCK_LIMIT low-stock items, grouped by warehouse. */
  lowStock: DigestLowStockGroup[];
  /** Every low-stock item the recipient may read (lowStock lists at most 20). */
  lowStockTotal: number;
  /** Of lowStockTotal, those with nothing on hand. */
  outOfStockTotal: number;
  /** The first PO_LIMIT open purchase orders, earliest expected first. */
  openPos: DigestOpenPo[];
  /** Every open purchase order the recipient may read (openPos lists at most 20). */
  openPosTotal: number;
  /** Of openPosTotal, those past their expected date. */
  overduePosTotal: number;
  openCycleCounts: DigestCycleCount[];
}

const LOW_STOCK_LIMIT = 20;
const PO_LIMIT = 20;

/**
 * Aggregates the data behind the weekly inventory digest email.
 *
 * For a caller reading through its own client, so row-level security has
 * already decided what it may see: the "Send preview now" action passes the
 * user's ctx.supabase. The cron does NOT use this: it reads once per org with
 * the service role (getDigestSource) and builds each recipient's payload with
 * that recipient's reader (buildDigestPayload), so the email shows what the
 * preview shows.
 *
 * Spec: docs/superpowers/specs/2026-05-08-weekly-email-digest-design.md
 */
export async function getDigestData(
  supabase: SupabaseClient,
  orgId: string,
): Promise<DigestPayload> {
  return buildDigestPayload(await getDigestSource(supabase, orgId), null);
}

export function isDigestEmpty(p: DigestPayload): boolean {
  return p.lowStock.length === 0 && p.openPos.length === 0 && p.openCycleCounts.length === 0;
}

export interface DigestSectionOptIns {
  lowStock: boolean;
  openPos: boolean;
  cycleCounts: boolean;
}

/**
 * Returns a copy of the payload with disabled sections zeroed out, so the
 * email template skips them. Cheaper than re-fetching with section-aware
 * queries — fetch is O(items+POs+CCs) and each section's filter is just
 * an array length 0 vs N.
 */
export function applySectionOptIns(
  payload: DigestPayload,
  optIns: DigestSectionOptIns,
): DigestPayload {
  return {
    lowStock: optIns.lowStock ? payload.lowStock : [],
    lowStockTotal: optIns.lowStock ? payload.lowStockTotal : 0,
    outOfStockTotal: optIns.lowStock ? payload.outOfStockTotal : 0,
    openPos: optIns.openPos ? payload.openPos : [],
    openPosTotal: optIns.openPos ? payload.openPosTotal : 0,
    overduePosTotal: optIns.openPos ? payload.overduePosTotal : 0,
    openCycleCounts: optIns.cycleCounts ? payload.openCycleCounts : [],
  };
}

// ── Source: one read per org ─────────────────────────────────────────

/** A low-stock item, with the columns that decide who may read it. */
interface DigestSourceItem {
  id: string;
  sku: string;
  name: string;
  qty: number;
  reorderPoint: number;
  warehouseId: string | null;
  charterId: string | null;
  categoryId: string | null;
  warehouseName: string;
}

/** An open purchase order, with where it is going. */
interface DigestSourcePo extends DigestOpenPo {
  destinationLocationId: string | null;
  /** The destination location's warehouse_id; undefined when the read
   *  returned no location row for a set destination_location_id. */
  destinationWarehouseId: string | null | undefined;
}

/** An in-progress cycle count, before its warehouse name is checked. */
interface DigestSourceCount {
  id: string;
  countNumber: number | null;
  warehouseId: string | null;
  warehouseName: string | null;
  scope: string | null;
  startedAt: string;
  totalLines: number;
  countedLines: number;
}

/**
 * Everything the digest can show for one org: EVERY low-stock item (lowest
 * quantity first), EVERY open purchase order (earliest expected first) and
 * every in-progress cycle count, none of it cut to the rendered limits yet,
 * because what each recipient sees is decided per recipient.
 */
export interface DigestSource {
  lowStock: DigestSourceItem[];
  openPos: DigestSourcePo[];
  openCycleCounts: DigestSourceCount[];
}

/** Three independent reads (all org-scoped): low stock, open POs and
 *  in-progress cycle counts. */
export async function getDigestSource(
  supabase: SupabaseClient,
  orgId: string,
): Promise<DigestSource> {
  const [lowStock, openPos, openCycleCounts] = await Promise.all([
    getLowStock(supabase, orgId),
    getOpenPos(supabase, orgId),
    getOpenCycleCounts(supabase, orgId),
  ]);
  return { lowStock, openPos, openCycleCounts };
}

// ── Readers: what one recipient may read ─────────────────────────────
//
// WHY THIS EXISTS. The cron reads with the service role, which bypasses
// row-level security, and it used to send ONE org-wide payload to every
// opted-in member. Any member can opt in, so a staff member scoped to one
// warehouse (or a viewer limited to some categories, or a member whose
// purchase_orders:read was revoked) was mailed every warehouse's low stock and
// every open purchase order: the class migration 0380 closed for reports.
//
// A DigestReader carries the facts the SELECT policies test, and the
// predicates below restate those policies clause for clause, so each
// recipient is sent what row-level security would return to them, which is
// also what their "Send preview now" shows. The policies (production, read
// from pg_policies and pg_get_functiondef on 2026-10-05):
//
//   inventory_items_select (0229 helpers):
//     ( warehouse_id IN rls_inv_read_full_warehouse_ids()
//         -- owner/admin/manager: every warehouse of the org;
//         -- anyone: warehouses assigned with charter_id NULL
//       OR (charter_id IS NULL AND warehouse_id IN rls_inv_read_assigned_warehouse_ids())
//       OR (warehouse_id, charter_id) IN rls_inv_read_warehouse_charter_ids() )
//     AND ( organization_id IN rls_cat_unrestricted_org_ids()
//         -- owner/admin/manager/staff, or a viewer with no category rows
//       OR (organization_id, category_id) IN rls_cat_allowed_category_ids() )
//         -- a viewer's assigned categories
//     An item with no warehouse matches none of the first three, so nobody
//     can read it.
//   purchase_orders_select (0322):
//     is_org_member AND has_permission(org, 'purchase_orders:read')
//     AND ( has_org_role(org, 'manager')          -- owner/admin/manager
//       OR destination_location_id IS NULL
//       OR the destination location has no warehouse
//       OR its warehouse IN my_warehouse_ids() )  -- staff/viewer: assigned
//   has_permission: owner always; else the user override, else the role
//     override, else a role_default_permissions row, else no.
//   warehouses_select: has_org_role(org, 'manager') OR
//     user_can_access_warehouse (staff/viewer with an assignment there). The
//     cycle-count section shows a warehouse's name only to its readers.
//   cycle_counts_select, cycle_count_lines_select, suppliers_select and
//     locations_select: any member, so counts and supplier names need no check.
//
// If one of those policies or helpers changes, change its predicate here in
// the same pull request: supabase/tests/digest_reader_policies.test.sql pins
// their definitions and fails until the hash is re-pinned.

/** has_org_role(org, 'manager') and the manager arm of every helper above. */
const ALL_WAREHOUSES_ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'manager']);
/** The roles my_warehouse_ids() and user_can_access_warehouse() scope by
 *  assignment. */
const ASSIGNED_WAREHOUSES_ROLES: ReadonlySet<string> = new Set(['staff', 'viewer']);
/** rls_cat_unrestricted_org_ids(): roles that read every category. */
const ALL_CATEGORIES_ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'manager', 'staff']);

const PO_READ = 'purchase_orders:read';

export interface DigestReaderAssignment {
  warehouseId: string;
  /** null = every charter at the warehouse. */
  charterId: string | null;
}

/** What one recipient may read in one org. */
export interface DigestReader {
  /** organization_members.role. */
  role: string;
  /** The recipient's user_warehouse_assignments rows in the org. */
  assignments: readonly DigestReaderAssignment[];
  /** The categories a category-limited viewer may read; null = every one. */
  categoryIds: ReadonlySet<string> | null;
  /** has_permission(org, 'purchase_orders:read'). */
  canReadPurchaseOrders: boolean;
}

/** The facts behind every recipient's reader in one org, read once. */
export interface DigestReaderData {
  assignments: Map<string, DigestReaderAssignment[]>;
  categories: Map<string, Set<string>>;
  /** user_permission_overrides.granted for purchase_orders:read, by user. */
  userPoRead: Map<string, boolean>;
  /** role_permission_overrides.granted for purchase_orders:read, by role. */
  rolePoRead: Map<string, boolean>;
  /** Roles with a role_default_permissions row for purchase_orders:read. */
  defaultPoReadRoles: Set<string>;
}

/**
 * Read, with the service role, everything that decides what the given
 * recipients may read in `orgId`. Any failed read throws: the digest must not
 * fall back to a wider view.
 */
export async function loadDigestReaderData(
  admin: SupabaseClient,
  orgId: string,
  userIds: readonly string[],
): Promise<DigestReaderData> {
  const [assignmentRows, categoryRows, userOverrideRows, roleOverrides, roleDefaults] =
    await Promise.all([
      fetchAllRowsByIds<{ user_id: string; warehouse_id: string; charter_id: string | null }>(
        userIds,
        (batch) => (from, to) =>
          admin
            .from('user_warehouse_assignments')
            .select('id, user_id, warehouse_id, charter_id')
            .eq('organization_id', orgId)
            .in('user_id', batch)
            .order('id', { ascending: true })
            .range(from, to),
      ),
      fetchAllRowsByIds<{ user_id: string; category_id: string }>(
        userIds,
        (batch) => (from, to) =>
          admin
            .from('user_category_assignments')
            .select('id, user_id, category_id')
            .eq('organization_id', orgId)
            .in('user_id', batch)
            .order('id', { ascending: true })
            .range(from, to),
      ),
      // One row per (org, user, permission), so user_id is a stable order.
      fetchAllRowsByIds<{ user_id: string; granted: boolean }>(
        userIds,
        (batch) => (from, to) =>
          admin
            .from('user_permission_overrides')
            .select('user_id, granted')
            .eq('organization_id', orgId)
            .eq('permission', PO_READ)
            .in('user_id', batch)
            .order('user_id', { ascending: true })
            .range(from, to),
      ),
      admin
        .from('role_permission_overrides')
        .select('role, granted')
        .eq('organization_id', orgId)
        .eq('permission', PO_READ),
      admin.from('role_default_permissions').select('role').eq('permission', PO_READ),
    ]);
  if (roleOverrides.error) throw new ServiceError('internal_error', roleOverrides.error.message);
  if (roleDefaults.error) throw new ServiceError('internal_error', roleDefaults.error.message);

  const assignments = new Map<string, DigestReaderAssignment[]>();
  for (const r of assignmentRows) {
    const list = assignments.get(r.user_id) ?? [];
    list.push({ warehouseId: r.warehouse_id, charterId: r.charter_id ?? null });
    assignments.set(r.user_id, list);
  }
  const categories = new Map<string, Set<string>>();
  for (const r of categoryRows) {
    const set = categories.get(r.user_id) ?? new Set<string>();
    set.add(r.category_id);
    categories.set(r.user_id, set);
  }
  return {
    assignments,
    categories,
    userPoRead: new Map(userOverrideRows.map((r) => [r.user_id, r.granted === true])),
    rolePoRead: new Map(
      ((roleOverrides.data ?? []) as Array<{ role: string; granted: boolean }>).map((r) => [
        r.role,
        r.granted === true,
      ]),
    ),
    defaultPoReadRoles: new Set(
      ((roleDefaults.data ?? []) as Array<{ role: string }>).map((r) => r.role),
    ),
  };
}

/** The reader of one recipient, whose membership role is `role`. */
export function digestReaderFor(
  data: DigestReaderData,
  userId: string,
  role: string,
): DigestReader {
  const assigned = data.categories.get(userId);
  const categoryIds = ALL_CATEGORIES_ROLES.has(role)
    ? null
    : role === 'viewer'
      ? assigned && assigned.size > 0
        ? assigned
        : null
      : // A role the policies do not name passes no category test.
        new Set<string>();
  const canReadPurchaseOrders =
    role === 'owner' ||
    (data.userPoRead.get(userId) ?? data.rolePoRead.get(role) ?? data.defaultPoReadRoles.has(role));
  return {
    role,
    assignments: data.assignments.get(userId) ?? [],
    categoryIds,
    canReadPurchaseOrders,
  };
}

/** inventory_items_select for one item. */
function canReadItem(reader: DigestReader | null, item: DigestSourceItem): boolean {
  // No warehouse: no arm of the policy can match, so no member reads it.
  if (item.warehouseId === null) return false;
  if (reader === null) return true;
  const byWarehouse =
    ALL_WAREHOUSES_ROLES.has(reader.role) ||
    reader.assignments.some(
      (a) =>
        a.warehouseId === item.warehouseId &&
        (a.charterId === null || item.charterId === null || a.charterId === item.charterId),
    );
  if (!byWarehouse) return false;
  if (reader.categoryIds === null) return true;
  return item.categoryId !== null && reader.categoryIds.has(item.categoryId);
}

/** purchase_orders_select for one open purchase order. */
function canReadPo(reader: DigestReader | null, po: DigestSourcePo): boolean {
  if (reader === null) return true;
  if (!reader.canReadPurchaseOrders) return false;
  if (ALL_WAREHOUSES_ROLES.has(reader.role)) return true;
  if (po.destinationLocationId === null) return true;
  // A destination the read could not see: refuse rather than guess.
  if (po.destinationWarehouseId === undefined) return false;
  if (po.destinationWarehouseId === null) return true;
  return canReachAssignedWarehouse(reader, po.destinationWarehouseId);
}

/** warehouses_select for one warehouse. */
function canReadWarehouse(reader: DigestReader | null, warehouseId: string): boolean {
  if (reader === null) return true;
  if (ALL_WAREHOUSES_ROLES.has(reader.role)) return true;
  return canReachAssignedWarehouse(reader, warehouseId);
}

/** my_warehouse_ids() / user_can_access_warehouse() for staff and viewers. */
function canReachAssignedWarehouse(reader: DigestReader, warehouseId: string): boolean {
  return (
    ASSIGNED_WAREHOUSES_ROLES.has(reader.role) &&
    reader.assignments.some((a) => a.warehouseId === warehouseId)
  );
}

/**
 * The payload one reader is sent: the source cut to what `reader` may read,
 * then to the rendered limits. `reader` null means the source was read through
 * the reader's own client, so row-level security has already cut it.
 */
export function buildDigestPayload(
  source: DigestSource,
  reader: DigestReader | null,
): DigestPayload {
  const items = source.lowStock.filter((item) => canReadItem(reader, item));
  // Group by warehouse, in the source's lowest-quantity-first order.
  const groups = new Map<string, DigestLowStockGroup>();
  for (const it of items.slice(0, LOW_STOCK_LIMIT)) {
    const group = groups.get(it.warehouseName) ?? { warehouseName: it.warehouseName, items: [] };
    group.items.push({
      id: it.id,
      sku: it.sku,
      name: it.name,
      qty: it.qty,
      reorderPoint: it.reorderPoint,
    });
    groups.set(it.warehouseName, group);
  }

  const pos = source.openPos.filter((po) => canReadPo(reader, po));

  return {
    lowStock: [...groups.values()].sort((a, b) => a.warehouseName.localeCompare(b.warehouseName)),
    // The lists are cut to the rendered limits; the counts the email prints
    // are not, or an org with more than 20 of either would read "20".
    lowStockTotal: items.length,
    outOfStockTotal: items.filter((it) => it.qty <= 0).length,
    openPosTotal: pos.length,
    overduePosTotal: pos.filter((po) => po.isOverdue).length,
    openPos: pos.slice(0, PO_LIMIT).map((po) => ({
      id: po.id,
      poNumber: po.poNumber,
      supplierName: po.supplierName,
      expectedAt: po.expectedAt,
      status: po.status,
      isOverdue: po.isOverdue,
    })),
    openCycleCounts: source.openCycleCounts.map((cc) => {
      const warehouseName =
        cc.warehouseId !== null && canReadWarehouse(reader, cc.warehouseId)
          ? cc.warehouseName
          : null;
      return {
        id: cc.id,
        countNumber: cc.countNumber,
        scopeLabel: cycleCountScopeLabel({
          warehouseId: cc.warehouseId,
          warehouseName,
          scope: cc.scope,
        }),
        warehouseName,
        startedAt: cc.startedAt,
        totalLines: cc.totalLines,
        countedLines: cc.countedLines,
      };
    }),
  };
}

async function getLowStock(
  supabase: SupabaseClient,
  orgId: string,
): Promise<DigestSourceItem[]> {
  type Row = {
    id: string;
    sku: string;
    name: string;
    quantity_on_hand: number;
    reorder_point: number;
    warehouse_id: string | null;
    charter_id: string | null;
    category_id: string | null;
    warehouse: { name: string } | { name: string }[] | null;
  };

  // PostgREST can't compare two columns in a single filter, so the
  // `quantity_on_hand <= reorder_point` half of the predicate has to run in JS
  // over a candidate pull.
  //
  // WHY PAGINATED, NOT `.limit(150)` (bug SP-132): the old query took the 150
  // LOWEST-quantity active items and only then narrowed. Whether a genuinely
  // low item made that window depended on how many OTHER items sat below it by
  // raw quantity, not on whether it was below its own reorder point — so an org
  // with >150 healthy slow movers at qty 1-5 (plain books are exactly that
  // shape) could have a fast mover at qty 300 / reorder_point 500 and get a
  // digest reporting NO low stock at all. Nothing about the data warned you;
  // the section just came back empty. Pattern #7 (silent caps that bound
  // coverage) and #3 (any candidate SELECT must paginate — PostgREST clamps
  // every response to 1000 rows, so raising the limit would not have fixed it).
  //
  // Two changes stop it: `.or(...)` narrows the pull server-side to rows that
  // COULD qualify (qty <= 0, or a reorder point is set at all), and
  // fetchAllRows walks 1000-row windows so no candidate is left behind. The
  // rendered slice is still LOW_STOCK_LIMIT, but it is now the 20 lowest of the
  // real low-stock set rather than of an arbitrary window. The slice is cut
  // per recipient, after their reader (buildDigestPayload).
  //
  // NB the `.or` is NULL-safe by construction: `reorder_point.gt.0` drops rows
  // whose reorder_point is NULL (pattern #23), but such a row can only qualify
  // via `quantity_on_hand <= 0`, which the first disjunct already keeps. The
  // column is `not null default 0` (0002_inventory.sql) anyway.
  const rows = await fetchAllRows<Row>((from, to) =>
    supabase
      .from('inventory_items')
      .select(
        'id, sku, name, quantity_on_hand, reorder_point, warehouse_id, charter_id, category_id, warehouse:warehouses!warehouse_id (name)',
      )
      .eq('organization_id', orgId)
      .eq('status', 'active')
      .is('deleted_at', null)
      // A kit's pre-assembled stock (is_bundle) is not low stock: kits are
      // built from their components and never reordered (0366), and a kit
      // whose assembled stock ran out is the normal state, not an alert.
      // NOT NULL (0040), so the equality is total.
      .eq('is_bundle', false)
      // An item created from an inbound PO sits at quantity 0 with
      // awaiting_first_receipt until its first receipt (0277). It is
      // expected, not out of stock: the dashboard's low-stock list and its
      // out-of-stock count leave it out, and so does the digest. Sorted by
      // quantity, these used to come first and fill the out-of-stock count.
      // NOT NULL (0277), so the equality is total.
      .eq('awaiting_first_receipt', false)
      .or('quantity_on_hand.lte.0,reorder_point.gt.0')
      // Quantity-ascending keeps the neediest items in the rendered slice; the
      // id tiebreak is what makes the paging windows stable (see paginate.ts).
      .order('quantity_on_hand', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );

  return rows
    .filter(
      (row) =>
        row.quantity_on_hand <= 0 ||
        (row.reorder_point > 0 && row.quantity_on_hand <= row.reorder_point),
    )
    .map((r) => {
      const wh = Array.isArray(r.warehouse) ? r.warehouse[0] : r.warehouse;
      return {
        id: r.id,
        sku: r.sku,
        name: r.name,
        qty: Number(r.quantity_on_hand) || 0,
        reorderPoint: Number(r.reorder_point) || 0,
        warehouseId: r.warehouse_id ?? null,
        charterId: r.charter_id ?? null,
        categoryId: r.category_id ?? null,
        warehouseName: wh?.name ?? 'Unassigned',
      };
    });
}

async function getOpenPos(supabase: SupabaseClient, orgId: string): Promise<DigestSourcePo[]> {
  type Row = {
    id: string;
    po_number: string;
    status: string;
    expected_at: string | null;
    destination_location_id: string | null;
    destination: { warehouse_id: string | null } | { warehouse_id: string | null }[] | null;
    supplier: { name: string } | { name: string }[] | null;
  };
  // EVERY open PO, paginated: who may read which one is decided per
  // recipient, so the first 20 of the org are not the first 20 of a scoped
  // reader. Earliest expected first (no date last); the id tiebreak keeps
  // the paging windows stable.
  const rows = await fetchAllRows<Row>((from, to) =>
    supabase
      .from('purchase_orders')
      .select(
        'id, po_number, status, expected_at, destination_location_id, destination:destination_location_id (warehouse_id), supplier:suppliers!supplier_id (name)',
      )
      .eq('organization_id', orgId)
      .in('status', ['expected_inbound', 'ordered', 'partially_received'])
      .order('expected_at', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true })
      .range(from, to),
  );

  const now = Date.now();
  return rows.map((r) => {
    const sup = Array.isArray(r.supplier) ? r.supplier[0] : r.supplier;
    const dest = Array.isArray(r.destination) ? r.destination[0] : r.destination;
    const expectedAtMs = r.expected_at ? new Date(r.expected_at).getTime() : null;
    return {
      id: r.id,
      poNumber: r.po_number,
      supplierName: sup?.name ?? null,
      expectedAt: r.expected_at,
      status: r.status,
      isOverdue: expectedAtMs != null && expectedAtMs < now,
      destinationLocationId: r.destination_location_id ?? null,
      destinationWarehouseId: dest ? (dest.warehouse_id ?? null) : undefined,
    };
  });
}

async function getOpenCycleCounts(
  supabase: SupabaseClient,
  orgId: string,
): Promise<DigestSourceCount[]> {
  // Load cycle counts PAGINATED (PostgREST caps any query at 1000 rows) and
  // WITHOUT the lines embed (embeds are capped too, which would silently
  // truncate large counts). Stable order (started_at, then unique id) so pages
  // don't overlap or skip.
  const counts = await fetchAllRows<{
    id: string;
    count_number: number | null;
    started_at: string;
    warehouse_id: string | null;
    scope: string | null;
    warehouse: { name: string } | { name: string }[] | null;
  }>((from, to) =>
    supabase
      .from('cycle_counts')
      .select(
        'id, count_number, started_at, warehouse_id, scope, warehouse:warehouses!warehouse_id (name)',
      )
      .eq('organization_id', orgId)
      .eq('status', 'in_progress')
      .order('started_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );

  if (counts.length === 0) return [];

  const countIds = counts.map((c) => c.id);

  // Fetch ALL lines for the open cycle counts, paginated to avoid the 1000-row
  // PostgREST cap. NB: the FK column on cycle_count_lines is `cycle_count_id`
  // (migration 0023), not `count_id`.
  //
  // Batched by count, and paged on `id`: ordering on `cycle_count_id` alone is
  // not unique, so range pages could repeat or skip lines (fetchAllRows needs
  // a stable key). Open counts have no cap, and one `.in()` past ~215 ids
  // fails.
  type LineRow = { cycle_count_id: string; counted_quantity: number | null };
  const lines = await fetchAllRowsByIds<LineRow>(
    countIds,
    (batch) => (from, to) =>
      supabase
        .from('cycle_count_lines')
        .select('cycle_count_id, counted_quantity')
        .in('cycle_count_id', batch)
        .order('id', { ascending: true })
        .range(from, to),
  );

  // Group line stats by cycle_count_id.
  const statsMap = new Map<string, { total: number; counted: number }>();
  for (const id of countIds) statsMap.set(id, { total: 0, counted: 0 });
  for (const line of lines) {
    const stats = statsMap.get(line.cycle_count_id);
    if (!stats) continue;
    stats.total += 1;
    if (line.counted_quantity != null) stats.counted += 1;
  }

  return counts.map((row) => {
    const wh = Array.isArray(row.warehouse) ? row.warehouse[0] : row.warehouse;
    const stats = statsMap.get(row.id) ?? { total: 0, counted: 0 };
    return {
      id: row.id,
      countNumber: row.count_number ?? null,
      warehouseId: row.warehouse_id ?? null,
      warehouseName: wh?.name ?? null,
      scope: row.scope ?? null,
      startedAt: row.started_at,
      totalLines: stats.total,
      countedLines: stats.counted,
    };
  });
}
