import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import {
  ArrowLeftRight,
  ArrowUpRight,
  Boxes,
  Camera,
  ChevronLeft,
  Edit3,
  History,
  Minus,
  PackageMinus,
  Plus,
  RotateCcw,
  Wrench,
} from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  can,
  collectLegacyRefIdsByKind,
  formatOrderNumber,
  legacyOrderRefId,
  readDisplayStorage,
  reasonWithoutRefLabel,
  resolveMovementRefReason,
  type RackHoldingLike,
  type Role,
} from '@stockpilot/core';

import { MoveStockModal } from '@/components/move-stock-modal';
import { PhotoViewer } from '@/components/photo-viewer';
import { RemoveFromRackModal } from '@/components/remove-from-rack-modal';
import { Button } from '@/components/ui/button';
import { CachedImage } from '@/components/ui/cached-image';
import { Card, Hair } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { api } from '@/lib/api';
import { showWriteCta } from '@/lib/cta-gating';
import { useEnabledModules } from '@/lib/enabled-modules';
import { useOrg } from '@/lib/use-org';
import { signItemImage } from '@/lib/image-cache';
import { resizeForUpload } from '@/lib/image-resize';
import {
  MOVEMENT_SHADOWED_AUDIT_EVENTS,
  auditCapFor,
  formatRelativeTime,
  humanizeFieldName,
  mergeItemActivity,
  type ActivityEntry,
  type AuditCardModel,
} from '@/lib/item-activity';
import {
  collectReceiptLineIds,
  formatMovementRoute,
  movementAmount,
  movementNoteEditable,
  movementNotesForDisplay,
  movementReasonLabel,
  receiptLineSummary,
} from '@/lib/movement-display';
import {
  attachReferenceLabels,
  collectReferenceIdsByType,
  mergeReferenceLabelMaps,
  referenceRoute,
  referenceTypeLabel,
} from '@/lib/movement-references';
import {
  MOVEMENT_NOTE_MAX,
  applyNoteToMovements,
  normalizeMovementNote,
} from '@/lib/movement-note';
import { buildPlacementRows } from '@/lib/placement-rows';
import {
  SERIAL_STATUSES,
  SERIAL_STATUS_LABELS,
  type SerialStatus,
  canDeleteSerial,
  duplicateSerialFromDbError,
  formatSerialDate,
  isSerialStatus,
  serialSourceLabel,
  serialStatusColor,
  validateSerialInput,
} from '@/lib/serials';
import { shouldStackRow } from '@/lib/dynamic-type-layout';
import { supabase } from '@/lib/supabase';
import { ACCENT, FONT, SHADOW, TYPE_CEILING, capTo } from '@/lib/theme';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { useRole } from '@/lib/use-role';
import { useTheme } from '@/lib/use-theme';

interface Item {
  id: string;
  organization_id: string;
  warehouse_id: string | null;
  tracking_type: string;
  name: string;
  sku: string;
  barcode: string | null;
  description: string | null;
  quantity_on_hand: number;
  reorder_point: number;
  reorder_quantity: number;
  unit_cost: number;
  retail_price: number;
  unit_of_measure: string;
  status: string;
  /** True only when the SYSTEM auto-archived this item on zero stock
   *  (migration 0266), as opposed to a human archiving it — drives the
   *  "Auto-archived" badge shown alongside the Archived badge. */
  auto_archived: boolean;
  /** True while a PO-created item is awaiting its FIRST receipt (migration
   *  0277; a DB trigger clears it the moment any stock arrives). Such items
   *  are hidden from the default Items/Books lists — this detail screen is
   *  reachable via the Expected filter, scan, or search, so it shows an
   *  "Expected — awaiting first receipt" badge for instant context. */
  awaiting_first_receipt: boolean;
  category_id: string | null;
  category_name: string | null;
  supplier_name: string | null;
  location_name: string | null;
  warehouse_name: string | null;
  bin_location: string | null;
  charter_name: string | null;
  item_type: string | null;
  /**
   * The rack SUMMARY as the PAIR it is stored as, never as a rendered label.
   * The location card needs it in two different alphabets — "38 · A" for a
   * human, "38-A" to compare against a `locations.name` — and holding only the
   * rendered one is what made the RACK row vanish for almost every item
   * (see src/lib/placement-rows.ts). Carrying the pair lets each spelling be
   * derived from the source instead of from the other.
   */
  rack_number: string | null;
  rack_row: string | null;
  /** Legacy single free-text rack label; used only when the pair is empty. */
  legacy_rack_label: string | null;
  crate_color: string | null;
  crate_number: string | null;
  grade: string | null;
  imageUrl: string | null;
  /** Rack/crate HOLDINGS (item_stock_levels, qty > 0) — WHERE THE STOCK IS,
   *  as opposed to `rack_label` above, which is what the item's custom_fields
   *  REMEMBER. The two diverge after a put-away into a position-less crate
   *  (mig 0335 preserves the rack keys on purpose), and this screen used to
   *  show only the remembered one — and to SUPPRESS `bin_location` behind it,
   *  so it hid the correct label to print the stale one. Carries
   *  `locations.kind`, without which the crate rule cannot fire. */
  rackHoldings: RackHoldingLike[];
}

interface MovementRow {
  id: string;
  movement_type: string;
  quantity_change: number;
  previous_quantity: number;
  new_quantity: number;
  /** Physical qty moved by a net-zero transfer (mig 0231). quantity_change is
      ALWAYS 0 for transfers (ledger sums to on-hand) — render THIS for them.
      null on pre-0231 rows and non-transfer movements. */
  moved_quantity: number | null;
  /** Movement/Activity P5: pre-0231 'receipt_line' rows are pre-resolved here
   *  (in `fetchMovementsPage`, via the receipt→PO batched lookup) to
   *  'PO {number}' when resolvable, else the masked 'PO receipt' fallback —
   *  the raw 'receipt_line' sentinel and the receipt uuid never reach this
   *  field. Every other row carries its raw `stock_movements.reason`
   *  verbatim (new receipt rows already write 'PO {number}' directly). */
  reason: string | null;
  /** User-entered free-text notes (web parity: rendered as its OWN line,
   *  never silently dropped in favor of `reason`). Pre-0231 'receipt_line'
   *  rows stash an internal receipt uuid here — not real user text — but
   *  those rows are historical only; see movement-display.ts. */
  notes: string | null;
  /**
   * Whether this row's note is user-editable. false for pre-0231
   * 'receipt_line' rows — their `notes` holds a machine receipt reference the
   * RPC refuses to overwrite (errcode 22023). Computed from the RAW reason in
   * `fetchMovementsPage` before it's resolved to a 'PO {number}' display
   * string; mirrors the web's per-event `noteEditable`.
   */
  note_editable: boolean;
  created_at: string;
  actor: { full_name: string | null; email: string | null } | null;
  /**
   * The kind of record that CAUSED this movement (order_request |
   * cycle_count | return | bundle — the only values any writer ever sets on
   * stock_movements, per Unit 1's verification). null for movements with no
   * source record (manual adjust/remove/transfer). Feeds the
   * reference_type → route/label resolver in `@/lib/movement-references`.
   */
  reference_type: string | null;
  reference_id: string | null;
  from_location_id: string | null;
  to_location_id: string | null;
  /**
   * Server-resolved human label for `reference_id` (order number, return
   * number, bundle name) — resolved in loadMovements via one batched query
   * per type, mirroring the web's ActivityService.forItem resolvers. null
   * when there's no cheap number for the type (cycle_count has none) or the
   * lookup found nothing — the card then falls back to referenceTypeLabel().
   */
  reference_label: string | null;
  /**
   * Movement/Activity P1 review follow-up (web parity): display names for
   * `from_location_id`/`to_location_id`, resolved in `fetchMovementsPage` via
   * one batched `.in()` query on `locations` (same pattern as the other
   * reference resolvers below). null whenever the row has no location on
   * that side, OR the id didn't resolve (location since deleted/unknown) —
   * `formatMovementRoute` (movement-display.ts) turns these into the "A → B"
   * / "→ B" / "A →" route line and MovementCard omits the line entirely when
   * both are null, mirroring the web's `ActivityFeed` route logic exactly.
   */
  from_location_name: string | null;
  to_location_name: string | null;
}

/**
 * Raw `audit_logs` row for the Activity tab (Movement/Activity P4). Actor is
 * embedded via the same `user_profiles!user_id` FK join used everywhere else
 * in this screen (stock_movements' actor, admin/audit.tsx) rather than a
 * separate profile-batch lookup — audit_logs.user_id points at the same
 * table, so one query gets both the event and its actor.
 */
interface AuditRow {
  id: string;
  event: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  actor: { full_name: string | null; email: string | null } | null;
}

const TYPE_LABEL: Record<string, string> = {
  add: 'Added',
  remove: 'Removed',
  adjust: 'Adjusted',
  transfer: 'Transferred',
  receive_po: 'Received',
  return: 'Returned',
  damage: 'Damaged',
  loss: 'Lost',
  correction: 'Corrected',
  initial: 'Initialized',
};

type TabId = 'overview' | 'movements' | 'activity';

/** Page size for the Movements tab's own paginated `stock_movements` query
 *  (SerialsCard "Load more" pattern) — preserves the tab's original
 *  first-load size of 50 rows. */
const MOVEMENTS_PAGE_SIZE = 50;

/** Page size for the Activity tab's movements half — mirrors forItem's
 *  default `limit=30`. The audits half uses `auditCapFor(30)` (=15), the
 *  SAME ratio ActivityService.forItem derives server-side, so accumulating
 *  pages via "Load more" preserves the "movements never starved by audits"
 *  guarantee even as a fetch window rather than a one-shot limit. */
const ACTIVITY_MOVEMENTS_PAGE_SIZE = 30;
const ACTIVITY_AUDITS_PAGE_SIZE = auditCapFor(ACTIVITY_MOVEMENTS_PAGE_SIZE);

// Reference-label batch resolvers (Unit 3, mirrors web's
// ActivityService.forItem: resolveOrderNumbers / resolveReturnNumbers /
// resolveBundleNames). Mobile has no server "service" layer — these run
// directly against the Supabase client, same convention as every other read
// in this screen. cycle_count is intentionally NOT queried: the table
// carries no display field, so those events always fall back to the
// generic `referenceTypeLabel('cycle_count')` while still being tappable
// via `referenceRoute`.
//
// The merge (combine the 3 maps below into one) and attach (stitch the
// merged map onto each movement row) steps are deliberately NOT done here —
// they're pure and dependency-injected in `@/lib/movement-references`
// (`mergeReferenceLabelMaps` / `attachReferenceLabels`) so they're unit
// tested without mocking Supabase. Only the actual `.in()` network calls
// stay in this screen.

async function resolveOrderNumbers(orgId: string, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const { data } = await supabase
    .from('order_requests')
    .select('id, order_number')
    .eq('organization_id', orgId)
    .in('id', ids);
  for (const r of (data ?? []) as { id: string; order_number: number | null }[]) {
    const n = formatOrderNumber(r.order_number);
    if (n) map.set(r.id, n);
  }
  return map;
}

async function resolveReturnNumbers(orgId: string, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const { data } = await supabase
    .from('returns')
    .select('id, return_number')
    .eq('organization_id', orgId)
    .in('id', ids);
  for (const r of (data ?? []) as { id: string; return_number: string | null }[]) {
    if (r.return_number) map.set(r.id, r.return_number);
  }
  return map;
}

async function resolveBundleNames(orgId: string, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const { data } = await supabase
    .from('bundles')
    .select('id, name')
    .eq('organization_id', orgId)
    .in('id', ids);
  for (const r of (data ?? []) as { id: string; name: string | null }[]) {
    if (r.name) map.set(r.id, r.name);
  }
  return map;
}

/**
 * Movement/Activity P1 review follow-up (web parity): batch-resolves
 * `from_location_id`/`to_location_id` → the location's display name, one
 * org-scoped `.in('id', ids)` query per fetched page — same shape as
 * `resolveOrderNumbers`/`resolveReturnNumbers`/`resolveBundleNames` above.
 * Mirrors the web's `LocationsService.list()`-backed `locationNames` map in
 * `item-detail.tsx`, just scoped to this page's ids instead of the whole org
 * (same narrowing the web's own "Load older" server action does — see
 * `loadOlderItemActivityAction` in `server/actions/activity.ts`). Not
 * filtered by `deleted_at`: a movement can reference a location that's since
 * been archived, and the historical row should still show its name. Errors/
 * missing rows degrade to an empty map, same as every other resolver here —
 * `formatMovementRoute` then omits the line rather than showing a raw uuid.
 */
async function resolveLocationNames(orgId: string, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const { data, error } = await supabase
    .from('locations')
    .select('id, name')
    .eq('organization_id', orgId)
    .in('id', ids);
  if (error) return map;
  for (const r of (data ?? []) as { id: string; name: string | null }[]) {
    if (r.name) map.set(r.id, r.name);
  }
  return map;
}

/**
 * Movement/Activity P5 (mobile web-parity gap): batch-resolves pre-0231
 * 'receipt_line' rows' receipt ids → their PO's `po_number`, mirroring the
 * web's `resolveReceiptPoNumbers` in activity.ts EXACTLY — same table join
 * (`receipts` → embedded `purchase_orders(po_number)`), same org scope, same
 * one-batched-`.in()`-query shape as the other resolvers above.
 *
 * RLS verified: `receipts_select` (mig 0012) and `purchase_orders_select`
 * (mig 0003/0140) both grant SELECT to any accepted org member — NOT
 * manager+-gated like `audit_logs` — so this runs for every role including
 * staff/viewer under their own JWT (this file's plain `supabase` client,
 * never the service role). Errors (network, unexpected RLS change, etc.)
 * degrade to an empty map exactly like every other resolver in this file —
 * `receiptLineSummary` then falls back to the masked 'PO receipt' label,
 * never the raw uuid.
 */
async function resolveReceiptPoNumbers(
  orgId: string,
  receiptIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (receiptIds.length === 0) return map;
  const { data, error } = await supabase
    .from('receipts')
    .select('id, purchase_orders(po_number)')
    .eq('organization_id', orgId)
    .in('id', receiptIds);
  if (error) return map;
  for (const r of (data ?? []) as Record<string, unknown>[]) {
    const poField = r.purchase_orders as
      | { po_number?: string | null }
      | { po_number?: string | null }[]
      | null;
    const po = Array.isArray(poField) ? poField[0] : poField;
    if (po?.po_number) map.set(r.id as string, po.po_number);
  }
  return map;
}

function mimeForExt(ext: string): string {
  const e = ext.toLowerCase();
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'png') return 'image/png';
  if (e === 'heic') return 'image/heic';
  if (e === 'webp') return 'image/webp';
  return `image/${e}`;
}

export default function ItemDetail() {
  const { id, tab: tabParam } = useLocalSearchParams<{ id: string; tab?: string }>();
  const router = useRouter();
  const { c } = useTheme();
  const { orgId } = useOrg();
  const { role } = useRole();
  const [item, setItem] = React.useState<Item | null>(null);
  const [movements, setMovements] = React.useState<MovementRow[]>([]);
  const [movementsTotal, setMovementsTotal] = React.useState(0);
  const [movementsLoading, setMovementsLoading] = React.useState(true);
  const [movementsLoadingMore, setMovementsLoadingMore] = React.useState(false);
  const [movementsError, setMovementsError] = React.useState<string | null>(null);
  // Movement/Activity P4 Task 1 — merged Activity tab state. Movements and
  // audits are fetched (and paginated) as TWO independent queries, exactly
  // like ActivityService.forItem — see mergeItemActivity's doc-comment for
  // why they're never combined before capping.
  const [activityMovements, setActivityMovements] = React.useState<MovementRow[]>([]);
  const [activityMovementsTotal, setActivityMovementsTotal] = React.useState(0);
  const [activityAudits, setActivityAudits] = React.useState<AuditRow[]>([]);
  const [activityAuditsTotal, setActivityAuditsTotal] = React.useState(0);
  const [activityLoading, setActivityLoading] = React.useState(true);
  const [activityLoadingMore, setActivityLoadingMore] = React.useState(false);
  const [activityError, setActivityError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  // Web parity: /dashboard/inventory/[id]?tab=movements|activity deep-links
  // straight to a tab — mobile honors the same param (notification links,
  // in-app pushes, and tests can land directly on a tab). Unknown values
  // fall back to overview.
  const [tab, setTab] = React.useState<TabId>(() =>
    tabParam === 'movements' || tabParam === 'activity' ? tabParam : 'overview',
  );
  const [adjustOpen, setAdjustOpen] = React.useState(false);
  const [moveOpen, setMoveOpen] = React.useState(false);
  const [removeOpen, setRemoveOpen] = React.useState(false);
  const [photoBusy, setPhotoBusy] = React.useState(false);
  const [photoViewerOpen, setPhotoViewerOpen] = React.useState(false);
  const [restoring, setRestoring] = React.useState(false);
  const [serialCount, setSerialCount] = React.useState(0);
  const permissions = useEffectivePermissions();
  // Staff+ may manage serials — mirrors the serial_registry write RLS
  // (has_org_role(org,'staff') + warehouse-in-org, mig 0203). Cosmetic
  // gate only; RLS independently enforces on every write.
  const canWriteSerials = role !== null && role !== 'viewer';
  // Transfer / put-away gate — mirrors the web dialog's 'stock:transfer'
  // requirement. Cosmetic only; the /api/v1/items/[id]/transfer route
  // re-asserts stock:transfer inside InventoryService.transferStock.
  const isManager = role !== null && ['owner', 'admin', 'manager'].includes(role);
  const canTransfer =
    isManager || (role !== null && can({ role: role as Role, permissions }, 'stock:transfer'));
  // Remove-from-rack (write-off) gate — mirrors the web item detail's
  // 'stock:adjust' requirement. Cosmetic only; /api/v1/items/[id]/remove-stock
  // re-asserts stock:adjust inside InventoryService.removeStockFromLocation.
  const canAdjustStock =
    isManager || (role !== null && can({ role: role as Role, permissions }, 'stock:adjust'));
  // Gates the inline "+ New rack" option in the move sheet; the transfer route
  // asserts 'locations:manage' independently when it creates the rack.
  const canCreateLocation =
    isManager || (role !== null && can({ role: role as Role, permissions }, 'locations:manage'));
  // Restore gate — mirrors the web archive/restore actions' 'items:update'
  // requirement. Cosmetic only; /api/v1/items/[id]/restore re-asserts
  // items:update inside InventoryService.bulkUpdate.
  const canRestore =
    isManager || (role !== null && can({ role: role as Role, permissions }, 'items:update'));
  // Movement-note edit gate — mirrors the additive RLS/RPC gate exactly:
  // manager-or-above OR the grantable 'movements:edit_notes' permission
  // (mig 0274). Cosmetic only; PATCH /api/v1/movements/[id]/note re-asserts
  // the same gate (and the SECURITY DEFINER RPC asserts it a third time), so a
  // briefly over-shown control just 403s on save rather than leaking anything.
  const canEditNotes =
    isManager || (role !== null && can({ role: role as Role, permissions }, 'movements:edit_notes'));
  // "Report a problem" launch point (Task 20, master brief §8/§25) — the
  // SAME two-part gate web's ReportProblemButton uses on this exact page's
  // web twin (item-detail.tsx: `moduleEnabled && canReportProblem`), so a
  // viewer who cannot submit never sees a button that only dead-ends on the
  // destination screen's own re-gate.
  const enabledModules = useEnabledModules();
  const canReportProblem =
    enabledModules.has('maintenance_requests') &&
    showWriteCta(permissions, 'maintenance_requests:submit');

  // Optimistic reflect of a saved note edit across BOTH movement lists (the
  // Movements tab and the Activity tab keep independent arrays, and the same
  // row can appear in either). Pure helper is unit-tested in movement-note.ts.
  const handleNoteSaved = React.useCallback((movementId: string, note: string | null) => {
    setMovements((prev) => applyNoteToMovements(prev, movementId, note));
    setActivityMovements((prev) => applyNoteToMovements(prev, movementId, note));
  }, []);

  const load = React.useCallback(async () => {
    if (!id) return;
    const { data } = await supabase
      .from('inventory_items')
      .select(
        `id, organization_id, name, sku, barcode, description, quantity_on_hand,
         reorder_point, reorder_quantity, unit_cost, retail_price,
         unit_of_measure, status, auto_archived, awaiting_first_receipt,
         category_id, item_type, bin_location,
         warehouse_id, charter_id, custom_fields, tracking_type,
         category:categories!category_id (name),
         supplier:suppliers!supplier_id (name),
         primary_location:locations!primary_location_id (name)`,
      )
      .eq('id', id)
      .maybeSingle();
    if (!data) {
      Alert.alert('Not found', 'This item no longer exists.', [
        { text: 'OK', onPress: () => router.back() },
      ]);
      return;
    }
    const r = data as Record<string, unknown>;
    const cat = r.category as { name?: string } | { name?: string }[] | null;
    const sup = r.supplier as { name?: string } | { name?: string }[] | null;
    const loc = r.primary_location as { name?: string } | { name?: string }[] | null;

    // Rack stamp keys differ by item_type so books and products don't
    // clobber each other in custom_fields:
    //   • products:  rack_number + rack_row
    //   • books:     book_rack_number + book_rack_row
    // Crate info (color + number) and grade are book-only — products
    // are just on a rack.
    const cf = (r.custom_fields as Record<string, unknown> | null) ?? null;
    const cfStr = (key: string): string | null => {
      const v = cf?.[key];
      return typeof v === 'string' && v.trim() !== '' ? v : null;
    };
    const itemTypeStr = (r.item_type as string | null) ?? 'product';
    // ONE reader, shared with the scan sheet and owned by @stockpilot/core.
    // This screen used to hand-roll the canonical/legacy/cross-family fallback
    // chain itself, which meant the rules for "which key names this book's
    // rack" lived in three places and could disagree.
    //
    // `readDisplayStorage` and NOT `readBookStorage`: only the display reader
    // knows the legacy spellings older imports still carry, and the canonical
    // one must never learn them — it feeds the acknowledgement fingerprints.
    // See its header for the full reason.
    const display = readDisplayStorage(cf, itemTypeStr);
    const crateColor = display.crateColor;
    const crateNumber = display.crateNumber;
    const grade = display.grade;

    // Warehouse is resolved in a second pass to avoid a multi-FK embed
    // (`warehouses` has two relations into other tables that confuse
    // PostgREST). Cheap because we filter to one row.
    //
    // Charter comes from the ITEM's own charter_id — never from the
    // warehouse. warehouse_charters is many-to-many (one warehouse hosts
    // inventory for many charters), so deriving it from the warehouse
    // stamped an arbitrary charter (whichever row came first) on every
    // item in the building. charter_id IS NULL = "Generic" (any charter
    // the warehouse services can use) — same sentinel the web table uses.
    let warehouseName: string | null = null;
    let charterName: string | null = null;
    const whId = r.warehouse_id as string | null | undefined;
    const charterId = r.charter_id as string | null | undefined;
    // Serial count rides the same round trip — a cheap head-only count so
    // the Serials card can show for items that hold registry rows even
    // when tracking_type isn't 'serial' (e.g. tracking switched off later).
    const [whResp, chResp, serialResp, holdingResp] = await Promise.all([
      whId
        ? supabase.from('warehouses').select('name').eq('id', whId).maybeSingle()
        : Promise.resolve(null),
      charterId
        ? supabase.from('charters').select('name').eq('id', charterId).maybeSingle()
        : Promise.resolve(null),
      supabase
        .from('serial_registry')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', r.organization_id as string)
        .eq('item_id', r.id as string),
      // Rack/crate holdings ride the same round trip. No warehouse scope: this
      // screen has no single-warehouse context, same as the scan sheet and the
      // web lookup API.
      supabase
        .from('item_stock_levels')
        .select('quantity, locations!inner(name, kind)')
        .eq('organization_id', r.organization_id as string)
        .eq('item_id', r.id as string)
        .in('locations.kind', ['rack', 'crate'])
        .gt('quantity', 0),
    ]);
    const rackHoldings: RackHoldingLike[] = ((holdingResp?.data ?? []) as unknown as {
      quantity: number;
      locations: { name: string; kind: string } | { name: string; kind: string }[] | null;
    }[])
      .map((h): RackHoldingLike | null => {
        const l = Array.isArray(h.locations) ? h.locations[0] : h.locations;
        return l?.name
          ? { name: l.name, quantity: Number(h.quantity) || 0, kind: l.kind ?? null }
          : null;
      })
      .filter((h): h is RackHoldingLike => h !== null);
    setSerialCount(serialResp.count ?? 0);
    warehouseName = (whResp?.data?.name as string | undefined) ?? null;
    charterName = charterId ? ((chResp?.data?.name as string | undefined) ?? null) : 'Generic';

    // Primary image — cached signed URL (reused across screens).
    const { data: imgRow } = await supabase
      .from('item_images')
      .select('storage_path')
      .eq('item_id', r.id as string)
      .order('is_primary', { ascending: false })
      .order('sort_order', { ascending: true })
      .limit(1)
      .maybeSingle();
    let imageUrl: string | null = null;
    if (imgRow?.storage_path) {
      imageUrl = await signItemImage(imgRow.storage_path as string);
    }

    setItem({
      id: r.id as string,
      organization_id: r.organization_id as string,
      warehouse_id: (r.warehouse_id as string | null) ?? null,
      tracking_type: (r.tracking_type as string | null) ?? 'none',
      name: r.name as string,
      sku: r.sku as string,
      barcode: (r.barcode as string | null) ?? null,
      description: (r.description as string | null) ?? null,
      quantity_on_hand: Number(r.quantity_on_hand) || 0,
      reorder_point: Number(r.reorder_point) || 0,
      reorder_quantity: Number(r.reorder_quantity) || 0,
      unit_cost: Number(r.unit_cost) || 0,
      retail_price: Number(r.retail_price) || 0,
      unit_of_measure: (r.unit_of_measure as string) ?? 'EA',
      status: r.status as string,
      auto_archived: Boolean(r.auto_archived),
      awaiting_first_receipt: Boolean(r.awaiting_first_receipt),
      category_id: (r.category_id as string | null) ?? null,
      category_name: Array.isArray(cat) ? (cat[0]?.name ?? null) : (cat?.name ?? null),
      supplier_name: Array.isArray(sup) ? (sup[0]?.name ?? null) : (sup?.name ?? null),
      location_name: Array.isArray(loc) ? (loc[0]?.name ?? null) : (loc?.name ?? null),
      warehouse_name: warehouseName,
      bin_location: (r.bin_location as string | null) ?? null,
      charter_name: charterName,
      item_type: (r.item_type as string | null) ?? null,
      rack_number: display.rackNumber,
      rack_row: display.rackRow,
      legacy_rack_label: display.legacyRackLabel,
      crate_color: crateColor,
      crate_number: crateNumber,
      grade,
      imageUrl,
      rackHoldings,
    });
  }, [id, router]);

  /**
   * Fetches ONE page of `stock_movements` (SerialsCard "Load more" pattern:
   * `{count:'exact'}` + stable `.order(created_at desc).order(id)` tiebreak +
   * `.range()`), resolving and attaching this page's reference labels fresh
   * — the batched order/return/bundle resolvers run on EVERY page, initial
   * or "load more", exactly like ActivityService.forItem's per-call
   * resolvers; nothing is cached/skipped across pages. Shared by the
   * Movements tab and the Activity tab's movements half so both stay in
   * lockstep with the web merge semantics. Returns a discriminated result so
   * callers can surface a real error INLINE instead of silently defaulting
   * to `data ?? []`.
   *
   * `.range()` offset pagination can skip a row if one is deleted between
   * page fetches — accepted, since stock_movements is an append-only ledger
   * in normal operation (no UPDATE/DELETE path).
   */
  const fetchMovementsPage = React.useCallback(
    async (
      offset: number,
      pageSize: number,
    ): Promise<
      { ok: true; rows: MovementRow[]; count: number } | { ok: false; error: string }
    > => {
      if (!id || !orgId) return { ok: true, rows: [], count: 0 };
      const {
        data,
        count,
        error,
      } = await supabase
        .from('stock_movements')
        .select(
          `id, movement_type, quantity_change, previous_quantity, new_quantity,
           moved_quantity, reason, notes, created_at,
           reference_type, reference_id, from_location_id, to_location_id,
           actor:user_profiles!user_id (full_name, email)`,
          { count: 'exact' },
        )
        .eq('organization_id', orgId)
        .eq('item_id', id)
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) return { ok: false, error: error.message };
      const rows = data ?? [];

      // Clickable/labeled source references (Unit 3): group THIS PAGE's
      // reference ids by type so each resolver below runs ONE batched query
      // rather than N+1, same pattern as the web's ActivityService.forItem.
      const idsByType = collectReferenceIdsByType(
        rows.map((row) => {
          const r = row as Record<string, unknown>;
          return {
            reference_type: (r.reference_type as string | null) ?? null,
            reference_id: (r.reference_id as string | null) ?? null,
          };
        }),
      );
      // Pre-0306 pick/cancel rows have NULL reference columns and carry the
      // ORDER'S UUID inside the reason instead (order_number only arrived in
      // 0254; the ledger is append-only, so they're resolved at read time —
      // see packages/core movement-order-ref.ts). Folding those ids into the
      // bucket their kind already has resolves them at NO extra query cost,
      // and gives the legacy rows the clickable source the new ones get. The
      // return kind is folded the same way (its reference columns are normally
      // already set, so it is usually a no-op).
      const legacyRefIds = collectLegacyRefIdsByKind(
        rows.map((row) => ({ reason: (row as Record<string, unknown>).reason as string | null })),
      );
      for (const [kind, ids] of Object.entries(legacyRefIds)) {
        if (ids.length > 0) idsByType[kind] = [...new Set([...(idsByType[kind] ?? []), ...ids])];
      }
      // Pre-0231 receipt rows (reason='receipt_line', notes=receipt uuid):
      // collect THIS PAGE's receipt ids so they can be resolved to PO
      // numbers in one extra batched query (Movement/Activity P5) — mirrors
      // the web's ActivityService.forItem, which runs `receiptIdsPromise`
      // alongside its reference-label resolvers. Runs in the same
      // Promise.all as the 3 resolvers below.
      const receiptLineIds = collectReceiptLineIds(
        rows.map((row) => {
          const r = row as Record<string, unknown>;
          return {
            reason: (r.reason as string | null) ?? null,
            notes: (r.notes as string | null) ?? null,
          };
        }),
      );
      // Web parity (Movement/Activity P1 review follow-up): collect THIS
      // PAGE's from/to location ids so they resolve in one extra batched
      // query, same convention as the resolvers above/below — never N+1.
      const locationIds = [
        ...new Set(
          rows.flatMap((row) => {
            const r = row as Record<string, unknown>;
            return [r.from_location_id, r.to_location_id].filter(
              (v): v is string => typeof v === 'string',
            );
          }),
        ),
      ];

      // Each resolver runs its own batched `.in()` query (or no-ops on an
      // empty id list); errors degrade to `data ?? []` → an empty map, so a
      // failed lookup falls back to the generic type label rather than
      // breaking the page. mergeReferenceLabelMaps merges this page's 3
      // reference-label maps into one before attach — no network I/O beyond
      // the 5 awaits. locationNameById is kept separate (not merged into
      // pageLabelMap) since a location id could theoretically collide with a
      // reference id in that shared map's key space.
      const [orderLabels, returnLabels, bundleLabels, poNumberByReceipt, locationNameById] =
        await Promise.all([
          resolveOrderNumbers(orgId, idsByType.order_request ?? []),
          resolveReturnNumbers(orgId, idsByType.return ?? []),
          resolveBundleNames(orgId, idsByType.bundle ?? []),
          resolveReceiptPoNumbers(orgId, receiptLineIds),
          resolveLocationNames(orgId, locationIds),
        ]);
      const pageLabelMap = mergeReferenceLabelMaps([orderLabels, returnLabels, bundleLabels]);

      const mapped = rows.map((row) => {
        const r = row as Record<string, unknown>;
        const actor = r.actor as MovementRow['actor'] | MovementRow['actor'][] | null;
        const rawReason = (r.reason as string | null) ?? null;
        const rawNotes = (r.notes as string | null) ?? null;
        // Issue 3/P5 parity: `reason` resolves pre-0231 'receipt_line' rows
        // to 'PO {number}' (or the masked 'PO receipt' fallback) HERE, before
        // `notes` is masked below — mirrors activity.ts's movementEvents
        // mapping exactly (reason computed from the raw notes uuid, then
        // notes itself masked to null for the same row).
        const isReceiptLine = rawReason === 'receipt_line';
        const fromLocationId = (r.from_location_id as string | null) ?? null;
        const toLocationId = (r.to_location_id as string | null) ?? null;
        return {
          id: r.id as string,
          movement_type: r.movement_type as string,
          quantity_change: Number(r.quantity_change) || 0,
          previous_quantity: Number(r.previous_quantity) || 0,
          new_quantity: Number(r.new_quantity) || 0,
          moved_quantity: r.moved_quantity == null ? null : Number(r.moved_quantity),
          reason: isReceiptLine
            ? receiptLineSummary(rawNotes, poNumberByReceipt)
            : resolveMovementRefReason(rawReason, pageLabelMap),
          notes: movementNotesForDisplay(rawNotes),
          // Both computed from the RAW columns, BEFORE the reason is resolved
          // to a 'PO {number}' display string above. The note is system-managed
          // whenever it IS the receipt sentinel (0231+ rows keep the sentinel
          // but changed their reason, so the reason alone no longer detects
          // them) or whenever the reason is the pre-0231 'receipt_line' the RPC
          // rejects outright (errcode 22023).
          note_editable: movementNoteEditable(rawReason, rawNotes),
          created_at: r.created_at as string,
          actor: Array.isArray(actor) ? (actor[0] ?? null) : actor,
          // Legacy pick/cancel rows get the type/id they have always MEANT, so
          // the card links to the order like every other referenced movement.
          reference_type:
            (r.reference_type as string | null) ??
            (legacyOrderRefId(rawReason) ? 'order_request' : null),
          reference_id: (r.reference_id as string | null) ?? legacyOrderRefId(rawReason),
          from_location_id: fromLocationId,
          to_location_id: toLocationId,
          from_location_name: fromLocationId ? (locationNameById.get(fromLocationId) ?? null) : null,
          to_location_name: toLocationId ? (locationNameById.get(toLocationId) ?? null) : null,
        };
      });
      // Attach step (pure, unit-tested) — stitches pageLabelMap onto each
      // row, degrading to null for rows with no reference_id or whose
      // reference_id has no entry in the merged map.
      return { ok: true, rows: attachReferenceLabels(mapped, pageLabelMap), count: count ?? 0 };
    },
    [id, orgId],
  );

  const loadMovements = React.useCallback(async () => {
    setMovementsLoading(true);
    setMovementsError(null);
    const res = await fetchMovementsPage(0, MOVEMENTS_PAGE_SIZE);
    if (!res.ok) {
      setMovementsError(res.error);
      setMovements([]);
      setMovementsTotal(0);
      setMovementsLoading(false);
      return;
    }
    setMovements(res.rows);
    setMovementsTotal(res.count);
    setMovementsLoading(false);
  }, [fetchMovementsPage]);

  async function loadMoreMovements() {
    if (movementsLoadingMore || movementsLoading) return;
    setMovementsLoadingMore(true);
    setMovementsError(null);
    const res = await fetchMovementsPage(movements.length, MOVEMENTS_PAGE_SIZE);
    if (!res.ok) {
      setMovementsError(res.error);
      setMovementsLoadingMore(false);
      return;
    }
    setMovements((prev) => {
      // Dedupe by id — concurrent inserts can shift offset pages (same
      // rationale as SerialsCard's loadMore).
      const known = new Set(prev.map((m) => m.id));
      return [...prev, ...res.rows.filter((m) => !known.has(m.id))];
    });
    setMovementsTotal(res.count);
    setMovementsLoadingMore(false);
  }

  /**
   * Fetches ONE page of `audit_logs` scoped to this item via
   * `metadata->>entity_id` (expr index mig 0135 — extracted-text equality so
   * the index applies, same as web's forItem). Actor is embedded via the
   * `user_profiles!user_id` FK join (same convention as admin/audit.tsx and
   * the movements query above), so no separate profile-batch lookup is
   * needed. RLS scopes this to manager+ — staff/viewer legitimately get zero
   * rows here, matching web parity exactly (NOT worked around).
   *
   * Movement-shadowing stock.* events (see `MOVEMENT_SHADOWED_AUDIT_EVENTS`)
   * are excluded HERE, at the query layer, mirroring web's `forItem`
   * (activity.ts) — safe here because `audit_logs.event` is NOT NULL, so
   * `.not('event','in',…)` is always TRUE/FALSE, never the NULL-swallows-the-
   * row trap that keeps the equivalent `stock_movements.reason` filter
   * JS-only (see `mergeItemActivity`'s doc-comment / LIFECYCLE_REASON_
   * MOVEMENTS). Filtering here (not just in `mergeItemActivity`, which stays
   * as a belt-and-suspenders safety net) means `count: 'exact'` — and the
   * "Load more (N remaining)" footer it drives — reflects only rows that
   * actually render, instead of counting shadowed rows the UI throws away.
   *
   * `.range()` offset pagination can skip a row if one is deleted between
   * page fetches — accepted, since audit_logs/stock_movements are
   * append-only ledgers in normal operation (no UPDATE/DELETE path).
   */
  const fetchAuditsPage = React.useCallback(
    async (
      offset: number,
      pageSize: number,
    ): Promise<{ ok: true; rows: AuditRow[]; count: number } | { ok: false; error: string }> => {
      if (!id || !orgId) return { ok: true, rows: [], count: 0 };
      const {
        data,
        count,
        error,
      } = await supabase
        .from('audit_logs')
        .select(
          `id, event, metadata, created_at,
           actor:user_profiles!user_id (full_name, email)`,
          { count: 'exact' },
        )
        .eq('organization_id', orgId)
        .eq('metadata->>entity_id', id)
        .not('event', 'in', `(${MOVEMENT_SHADOWED_AUDIT_EVENTS.join(',')})`)
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) return { ok: false, error: error.message };
      const mapped = (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        const actor = r.actor as AuditRow['actor'] | AuditRow['actor'][] | null;
        return {
          id: r.id as string,
          event: r.event as string,
          metadata: (r.metadata as Record<string, unknown> | null) ?? null,
          created_at: r.created_at as string,
          actor: Array.isArray(actor) ? (actor[0] ?? null) : actor,
        };
      });
      return { ok: true, rows: mapped, count: count ?? 0 };
    },
    [id, orgId],
  );

  const loadActivity = React.useCallback(async () => {
    setActivityLoading(true);
    setActivityError(null);
    const [movRes, audRes] = await Promise.all([
      fetchMovementsPage(0, ACTIVITY_MOVEMENTS_PAGE_SIZE),
      fetchAuditsPage(0, ACTIVITY_AUDITS_PAGE_SIZE),
    ]);
    if (!movRes.ok) {
      setActivityError(movRes.error);
      setActivityLoading(false);
      return;
    }
    if (!audRes.ok) {
      setActivityError(audRes.error);
      setActivityLoading(false);
      return;
    }
    setActivityMovements(movRes.rows);
    setActivityMovementsTotal(movRes.count);
    setActivityAudits(audRes.rows);
    setActivityAuditsTotal(audRes.count);
    setActivityLoading(false);
  }, [fetchMovementsPage, fetchAuditsPage]);

  async function loadMoreActivity() {
    if (activityLoadingMore || activityLoading) return;
    setActivityLoadingMore(true);
    setActivityError(null);
    const [movRes, audRes] = await Promise.all([
      fetchMovementsPage(activityMovements.length, ACTIVITY_MOVEMENTS_PAGE_SIZE),
      fetchAuditsPage(activityAudits.length, ACTIVITY_AUDITS_PAGE_SIZE),
    ]);
    if (!movRes.ok) {
      setActivityError(movRes.error);
      setActivityLoadingMore(false);
      return;
    }
    if (!audRes.ok) {
      setActivityError(audRes.error);
      setActivityLoadingMore(false);
      return;
    }
    setActivityMovements((prev) => {
      const known = new Set(prev.map((m) => m.id));
      return [...prev, ...movRes.rows.filter((m) => !known.has(m.id))];
    });
    setActivityMovementsTotal(movRes.count);
    setActivityAudits((prev) => {
      const known = new Set(prev.map((a) => a.id));
      return [...prev, ...audRes.rows.filter((a) => !known.has(a.id))];
    });
    setActivityAuditsTotal(audRes.count);
    setActivityLoadingMore(false);
  }

  // Pure merge (Movement/Activity P4): separate per-kind caps derived from
  // whatever's been paginated so far (movementLimit/auditLimit = current
  // array lengths — the "cap" protection lives in the FIXED per-page ratio
  // ACTIVITY_MOVEMENTS_PAGE_SIZE : ACTIVITY_AUDITS_PAGE_SIZE, never in a
  // combined-then-sliced merge here). Applies the JS-only shadowed-event and
  // lifecycle-reason filters, then sorts desc.
  const activityEntries: ActivityEntry[] = React.useMemo(
    () =>
      mergeItemActivity({
        movements: activityMovements,
        audits: activityAudits,
        movementLimit: activityMovements.length,
        auditLimit: activityAudits.length,
      }),
    [activityMovements, activityAudits],
  );
  const activityMovementsRemaining = Math.max(0, activityMovementsTotal - activityMovements.length);
  const activityAuditsRemaining = Math.max(0, activityAuditsTotal - activityAudits.length);
  const activityRemaining = activityMovementsRemaining + activityAuditsRemaining;
  const movementsRemaining = Math.max(0, movementsTotal - movements.length);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: every set is post-await; the effect synchronizes with the server
    void load();
  }, [load]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- tab-change fetch: the sync sets inside the loaders are their loading/error flags (also used by pull-to-refresh); every data set is post-await
    if (tab === 'movements') void loadMovements();
    if (tab === 'activity') void loadActivity();
  }, [tab, loadMovements, loadActivity]);

  /** Pull-to-refresh: re-runs the item load plus whichever tab is active. */
  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
      if (tab === 'movements') await loadMovements();
      if (tab === 'activity') await loadActivity();
    } finally {
      setRefreshing(false);
    }
  }

  async function adjust(delta: number, reason = 'Mobile detail') {
    if (!item) return;
    setBusy(true);
    const { error } = await supabase.rpc('adjust_stock', {
      p_item_id: item.id,
      p_quantity_change: delta,
      p_movement_type: delta > 0 ? 'add' : 'remove',
      p_location_id: null,
      p_reason: reason,
      p_notes: null,
    });
    setBusy(false);
    if (error) {
      Alert.alert('Could not adjust', error.message);
      return;
    }
    setItem({ ...item, quantity_on_hand: item.quantity_on_hand + delta });
    if (tab === 'movements') void loadMovements();
    if (tab === 'activity') void loadActivity();
  }

  // T12 — REST parity for web's restore action. Goes through the Bearer
  // api() client to POST /api/v1/items/[id]/restore (InventoryService.
  // bulkUpdate({op:{kind:'unarchive'}}) under the hood) rather than a
  // direct Supabase `.update()` — the service is what asserts
  // 'items:update', clears auto_archived, and writes the audit event; a
  // raw client mutation would silently skip all three.
  async function restoreItem() {
    if (!item || restoring) return;
    setRestoring(true);
    try {
      await api(`/api/v1/items/${item.id}/restore`, { method: 'POST' });
      // Optimistic flip — clears both the Archived and Auto-archived
      // badges immediately rather than waiting on a refetch.
      setItem({ ...item, status: 'active', auto_archived: false });
    } catch (e) {
      Alert.alert('Could not restore', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setRestoring(false);
    }
  }

  function openEdit() {
    if (!item) return;
    Linking.openURL(`https://stockpilotusa.com/dashboard/inventory/${item.id}/edit`).catch(
      () => undefined,
    );
  }

  async function pickFromCamera() {
    let perm = await ImagePicker.getCameraPermissionsAsync();
    if (!perm.granted) perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        'Camera access needed',
        perm.canAskAgain
          ? 'Allow camera in the prompt to take photos.'
          : 'Enable camera in Settings → StockPilot.',
      );
      return;
    }
    try {
      const result = await ImagePicker.launchCameraAsync({
        quality: 0.7,
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        cameraType: ImagePicker.CameraType.back,
      });
      if (result.canceled || !result.assets[0]) return;
      const a = result.assets[0];
      const ext = (a.uri.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'jpg').toLowerCase();
      await uploadAndReplace(a.uri, ext);
    } catch (e) {
      Alert.alert('Camera unavailable', e instanceof Error ? e.message : 'Use Library instead.');
    }
  }

  async function pickFromLibrary() {
    let perm = await ImagePicker.getMediaLibraryPermissionsAsync();
    if (!perm.granted) perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Photo access needed', 'Allow photo library to attach images.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      quality: 0.7,
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: false,
    });
    if (result.canceled || !result.assets[0]) return;
    const a = result.assets[0];
    const ext = (a.uri.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'jpg').toLowerCase();
    await uploadAndReplace(a.uri, ext);
  }

  function openPhotoActions() {
    if (!item || photoBusy) return;
    const hasPhoto = !!item.imageUrl;
    Alert.alert(hasPhoto ? 'Replace photo' : 'Add photo', undefined, [
      { text: 'Take photo', onPress: () => void pickFromCamera() },
      { text: 'Choose from library', onPress: () => void pickFromLibrary() },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  async function uploadAndReplace(uri: string, ext: string) {
    if (!item || !orgId) return;
    setPhotoBusy(true);
    try {
      // Resize on-device so the bucket only stores list-friendly sizes
      // (~400 KB JPEGs instead of multi-megapixel phone photos).
      const resized = await resizeForUpload(uri);
      const path = `${orgId}/items/${item.id}/${Math.random().toString(36).slice(2, 14)}.${resized.ext}`;
      // ArrayBuffer upload — `fetch(uri).blob()` uploads a 0-byte object
      // to Supabase Storage in RN/Expo, so use arrayBuffer().
      const arrayBuffer = await (await fetch(resized.uri)).arrayBuffer();
      const { error: upErr } = await supabase.storage
        .from('item-images')
        .upload(path, arrayBuffer, { contentType: mimeForExt(resized.ext) });
      if (upErr) {
        Alert.alert('Upload failed', upErr.message);
        return;
      }
      // Wipe any existing image rows + their storage files. Cleans up
      // the legacy 0-byte uploads from before the arrayBuffer fix.
      const { data: oldRows } = await supabase
        .from('item_images')
        .select('id, storage_path')
        .eq('item_id', item.id);
      const oldPaths = ((oldRows ?? []) as { storage_path: string | null }[])
        .map((r) => r.storage_path)
        .filter((p): p is string => !!p);
      if (oldPaths.length > 0) {
        await supabase.storage.from('item-images').remove(oldPaths);
        await supabase.from('item_images').delete().eq('item_id', item.id);
      }
      const { error: insErr } = await supabase.from('item_images').insert({
        organization_id: orgId,
        item_id: item.id,
        storage_path: path,
        is_primary: true,
      });
      if (insErr) {
        Alert.alert('Save failed', insErr.message);
        return;
      }
      const signedUrl = await signItemImage(path);
      setItem({ ...item, imageUrl: signedUrl });
    } catch (e) {
      Alert.alert('Photo error', e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setPhotoBusy(false);
    }
  }

  if (!item) {
    return (
      <View
        style={[
          styles.root,
          { backgroundColor: c.paper, justifyContent: 'center', alignItems: 'center' },
        ]}
      >
        <ActivityIndicator color={c.ink} />
      </View>
    );
  }

  const lowStock = item.reorder_point > 0 && item.quantity_on_hand <= item.reorder_point;
  const status: 'ok' | 'warn' | 'crit' =
    item.quantity_on_hand <= 0 ? 'crit' : lowStock ? 'warn' : 'ok';
  const inventoryValue = item.unit_cost * item.quantity_on_hand;

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip icon={ChevronLeft} onPress={() => router.back()} />
          <IconChip icon={Edit3} onPress={openEdit} />
        </View>
      </SafeAreaView>

      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={c.ink} />
        }
      >
        {/* Hero */}
        <View style={styles.hero}>
          <Mono size={9.5} tracking={0.2} upper color={c.ink4}>
            — {item.sku}
          </Mono>
          <Display size={26} style={{ marginTop: 6 }}>
            {item.name}
          </Display>
          {item.category_name || item.barcode ? (
            <Mono size={11.5} tracking={0.04} color={c.ink4} style={{ marginTop: 6 }}>
              {[item.category_name, item.barcode].filter(Boolean).join(' · ')}
            </Mono>
          ) : null}
          {/* Archived / Auto-archived / Expected badges — mirrors the web
              detail's stock-status-badge.tsx. Auto-archived is meaningless on
              an active item, so it only ever renders alongside Archived.
              Expected (mig 0277) marks a PO-created item awaiting its FIRST
              receipt — hidden from the default lists, so when someone lands
              here via the Expected filter, scan, or search the badge makes
              the "why is this at zero" context instant. */}
          {item.status === 'archived' || item.awaiting_first_receipt ? (
            <View
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 8,
                marginTop: 10,
              }}
            >
              {item.status === 'archived' ? (
                <Pill status="default" dot={false}>
                  ARCHIVED
                </Pill>
              ) : null}
              {item.status === 'archived' && item.auto_archived ? (
                <Pill status="warn" dot={false}>
                  AUTO-ARCHIVED
                </Pill>
              ) : null}
              {item.awaiting_first_receipt ? (
                <Pill status="warn" dot={false}>
                  EXPECTED — AWAITING FIRST RECEIPT
                </Pill>
              ) : null}
            </View>
          ) : null}
          {item.status === 'archived' && item.auto_archived ? (
            <Body muted size={11} style={{ marginTop: 8 }}>
              The system archived this item automatically after it sat at zero stock past the
              configured dwell window.
            </Body>
          ) : null}
          {item.awaiting_first_receipt ? (
            <Body muted size={11} style={{ marginTop: 8 }}>
              Created from a purchase order — hidden from the default Items list until the first
              units are received. It appears automatically the moment any stock arrives.
            </Body>
          ) : null}
          {/* T12: restore action, now wired to POST /api/v1/items/[id]/restore
              (created for this task — see the route's doc-comment for why
              mobile must go through InventoryService.bulkUpdate rather than a
              raw client update). Cosmetic canRestore gate mirrors the route's
              'items:update' assertion; hidden entirely for viewers/staff who
              would just get a 403. */}
          {item.status === 'archived' && canRestore ? (
            <Button
              variant="outline"
              size="sm"
              onPress={() => void restoreItem()}
              disabled={restoring}
              leading={
                restoring ? (
                  <ActivityIndicator size="small" color={c.ink} />
                ) : (
                  <RotateCcw size={14} color={c.ink} strokeWidth={1.6} />
                )
              }
              style={{ marginTop: 12, alignSelf: 'flex-start' }}
            >
              {restoring ? 'Restoring…' : 'Restore'}
            </Button>
          ) : null}
        </View>

        {/* Image — with a photo, tapping it VIEWS full-screen (PhotoViewer);
            the REPLACE pill is its own sibling Pressable stacked above, so
            replace never hijacks the view tap. With no photo the whole tile
            keeps opening the add sheet. photoBusy disables both paths. */}
        <View style={{ paddingHorizontal: 20, marginTop: 10 }}>
          <View>
            <Pressable
              onPress={item.imageUrl ? () => setPhotoViewerOpen(true) : openPhotoActions}
              disabled={photoBusy}
              style={({ pressed }) => ({ opacity: pressed && !photoBusy ? 0.85 : 1 })}
              accessibilityRole="button"
              accessibilityLabel={item.imageUrl ? 'View photo' : 'Add photo'}
            >
              <View
                style={{
                  aspectRatio: 4 / 3,
                  borderRadius: 14,
                  overflow: 'hidden',
                  borderWidth: 1,
                  borderColor: c.hair,
                  backgroundColor: c.paper2,
                  justifyContent: 'center',
                  alignItems: 'center',
                }}
              >
                {item.imageUrl ? (
                  <CachedImage
                    uri={item.imageUrl}
                    style={{ width: '100%', height: '100%' }}
                    recyclingKey={`${item.id}-${item.imageUrl}`}
                  />
                ) : (
                  <View style={{ alignItems: 'center', gap: 8 }}>
                    <Camera size={28} color={c.ink4} strokeWidth={1.4} />
                    <Mono size={11} tracking={0.12} upper color={c.ink4}>
                      Tap to add photo
                    </Mono>
                  </View>
                )}
                {photoBusy ? (
                  <View
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      bottom: 0,
                      backgroundColor: 'rgba(0,0,0,0.4)',
                      justifyContent: 'center',
                      alignItems: 'center',
                    }}
                  >
                    <ActivityIndicator color="#fff" />
                  </View>
                ) : null}
              </View>
            </Pressable>
            {item.imageUrl && !photoBusy ? (
              <Pressable
                onPress={openPhotoActions}
                disabled={photoBusy}
                accessibilityRole="button"
                accessibilityLabel="Replace photo"
                hitSlop={6}
                style={({ pressed }) => ({
                  position: 'absolute',
                  bottom: 10,
                  right: 10,
                  backgroundColor: 'rgba(0,0,0,0.55)',
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  borderRadius: 8,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  opacity: pressed ? 0.8 : 1,
                })}
              >
                <Camera size={12} color="#fff" strokeWidth={1.6} />
                <Mono size={10} tracking={0.12} upper color="#fff">
                  Replace
                </Mono>
              </Pressable>
            ) : null}
          </View>
        </View>

        {/* Tab bar */}
        <View style={styles.tabsRow}>
          <TabButton
            label="Overview"
            active={tab === 'overview'}
            onPress={() => setTab('overview')}
          />
          <TabButton
            label="Movements"
            active={tab === 'movements'}
            onPress={() => setTab('movements')}
          />
          <TabButton
            label="Activity"
            active={tab === 'activity'}
            onPress={() => setTab('activity')}
          />
        </View>

        {tab === 'overview' ? (
          <View style={{ paddingHorizontal: 20, gap: 14 }}>
            {/* Stock card */}
            <Card hero style={{ padding: 20 }}>
              <Eyebrow>ON HAND</Eyebrow>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 8 }}>
                {/* capTo(56, 48) resolves to exactly 1 — no growth, by design.
                    56pt is already ~4x body; doubling it evicts the unit of
                    measure and the status pill from the hero card entirely. */}
                <Mono
                  size={56}
                  tracking={-0.025}
                  color={c.ink}
                  maxFontSizeMultiplier={capTo(56, TYPE_CEILING.display)}
                  style={{ fontFamily: FONT.display }}
                >
                  {item.quantity_on_hand}
                </Mono>
                <Body size={16} color={c.ink4}>
                  {item.unit_of_measure}
                </Body>
                <View style={{ marginLeft: 'auto' }}>
                  {status === 'ok' ? <Pill status="ok">OK</Pill> : null}
                  {status === 'warn' ? <Pill status="warn">LOW</Pill> : null}
                  {status === 'crit' ? <Pill status="crit">OUT</Pill> : null}
                </View>
              </View>
              <Mono size={11.5} tracking={0.04} color={c.ink4} style={{ marginTop: 6 }}>
                Reorder at {item.reorder_point} · suggested reorder {item.reorder_quantity}
              </Mono>

              <View style={styles.quickAdjust}>
                <QuickBtn label="−5" onPress={() => adjust(-5)} disabled={busy} />
                <QuickBtn label="−1" onPress={() => adjust(-1)} disabled={busy} />
                <QuickBtn label="+1" onPress={() => adjust(1)} disabled={busy} primary />
                <QuickBtn label="+5" onPress={() => adjust(5)} disabled={busy} primary />
              </View>

              <Button
                block
                variant="outline"
                onPress={() => setAdjustOpen(true)}
                leading={<ArrowLeftRight size={16} color={c.ink} strokeWidth={1.5} />}
                style={{ marginTop: 12 }}
              >
                Adjust with reason
              </Button>
              {canTransfer ? (
                <Button
                  block
                  variant="outline"
                  onPress={() => setMoveOpen(true)}
                  leading={<Boxes size={16} color={c.ink} strokeWidth={1.5} />}
                  style={{ marginTop: 10 }}
                >
                  Transfer / put away
                </Button>
              ) : null}
              {/* Remove-from-rack write-off (2026-07-23): draws down ONE rack,
                  leaving stock in every other rack alone — the tool Andrew
                  reached for when he archived a whole book to clear one rack.
                  Only meaningful on an active item that still holds stock. */}
              {canAdjustStock && item.status !== 'archived' && item.quantity_on_hand > 0 ? (
                <Button
                  block
                  variant="outline"
                  onPress={() => setRemoveOpen(true)}
                  leading={<PackageMinus size={16} color={c.ink} strokeWidth={1.5} />}
                  style={{ marginTop: 10 }}
                >
                  Remove from rack
                </Button>
              ) : null}
              {canReportProblem ? (
                <Button
                  block
                  variant="outline"
                  onPress={() =>
                    router.push({
                      pathname: '/maintenance/new',
                      // Deep-link HINT only — MaintenanceRequestsService.create()
                      // re-derives and validates this id server-side (uuid shape
                      // + THIS org) before it is ever attached to a request
                      // (binding constraint 6, mirrors web's ReportProblemButton
                      // doc comment for this identical launch point).
                      params: { itemId: item.id },
                      // .expo/types/router.d.ts is stale (regenerated only by
                      // the Expo dev server) and predates Task 19's route —
                      // same cast maintenance.tsx's own 'New' button needs.
                      // The double cast (TS's own suggested escape hatch) is
                      // required because an unregistered pathname doesn't
                      // structurally overlap any registered route's object
                      // shape, unlike the plain-string form.
                    } as unknown as Href)
                  }
                  leading={<Wrench size={16} color={c.ink} strokeWidth={1.5} />}
                  style={{ marginTop: 10 }}
                >
                  Report a problem
                </Button>
              ) : null}
              {/* Task 4 (Model B / SKU grouping clarity): quantity is a
                  PER-PLACEMENT field — adjusting it here only changes
                  on-hand at this item's specific rack/charter, never other
                  placements sharing the same SKU. Copy/UX only, no logic
                  change. */}
              <Body muted size={11} style={{ marginTop: 10, textAlign: 'center' }}>
                This placement only — on-hand adjustments here apply just to this rack/charter, not
                other placements of this SKU.
              </Body>
            </Card>

            {/* Meta card */}
            <Card padding={0}>
              <MetaRow label="UNIT COST" value={`$${item.unit_cost.toFixed(2)}`} />
              <Hair inset={20} />
              <MetaRow label="RETAIL PRICE" value={`$${item.retail_price.toFixed(2)}`} />
              <Hair inset={20} />
              <MetaRow label="INVENTORY VALUE" value={`$${inventoryValue.toFixed(2)}`} />
              {item.supplier_name ? (
                <>
                  <Hair inset={20} />
                  <MetaRow label="SUPPLIER" value={item.supplier_name} />
                </>
              ) : null}
            </Card>
            {/* Task 4: name, SKU, cost, price, category, etc. are SHARED
                across every placement of this SKU (see InventoryService.update,
                Task 3) — none of them are editable in-app, so this just tells
                the user what "Edit on web" (below) will affect. */}
            <Body muted size={11} style={{ textAlign: 'center' }}>
              Shared across all placements of this SKU — name, SKU, cost, price, and category update
              everywhere this item lives when edited on web.
            </Body>

            {/* Location block — only render when at least one field is
                populated. Mirrors what the web detail page shows under
                its "Location & storage" section. */}
            {(() => {
              // WHICH ROWS, and why, lives in src/lib/placement-rows.ts — a
              // pure module so the answers can be TESTED. While this logic was
              // inline the only available test was a source-text pin, and a
              // source-text pin cannot tell a true row from a hidden one: it
              // happily pinned the wiring that fed the DISPLAY label ("38 · A")
              // into a comparison against a `locations.name` ("38-A"), which
              // hid the RACK row for essentially every item with a holding.
              const rows = buildPlacementRows({
                itemType: item.item_type,
                warehouseName: item.warehouse_name,
                charterName: item.charter_name,
                locationName: item.location_name,
                rackNumber: item.rack_number,
                rackRow: item.rack_row,
                legacyRackLabel: item.legacy_rack_label,
                crateColor: item.crate_color,
                crateNumber: item.crate_number,
                grade: item.grade,
                binLocation: item.bin_location,
                holdings: item.rackHoldings,
              });
              if (rows.length === 0) return null;
              return (
                <>
                  <Card padding={0}>
                    {rows.map((row, i) => (
                      <React.Fragment key={row.label}>
                        {i > 0 ? <Hair inset={20} /> : null}
                        <MetaRow label={row.label} value={row.value} dot={row.dot} />
                      </React.Fragment>
                    ))}
                  </Card>
                  {/* Task 4: warehouse/charter/location/rack are PER-PLACEMENT —
                      they describe just this row, not the whole SKU. */}
                  <Body muted size={11} style={{ textAlign: 'center' }}>
                    This placement only — describes just this rack/charter, not other placements of
                    this SKU.
                  </Body>
                </>
              );
            })()}

            {/* Serials — shown for either serial mode ('serial_optional' from
                migration 0295 carries serials for only part of its quantity)
                OR any item that already holds registry rows (tracking may have
                been switched off after receipts stamped serials). */}
            {item.tracking_type === 'serial' ||
            item.tracking_type === 'serial_optional' ||
            serialCount > 0 ? (
              <SerialsCard
                itemId={item.id}
                organizationId={item.organization_id}
                defaultWarehouseId={item.warehouse_id}
                canWrite={canWriteSerials}
                onCountChange={setSerialCount}
              />
            ) : null}

            {item.description ? (
              <Card padding={16}>
                <Eyebrow>DESCRIPTION</Eyebrow>
                <Body style={{ marginTop: 8 }}>{item.description}</Body>
              </Card>
            ) : null}

            <Pressable
              onPress={openEdit}
              style={({ pressed }) => ({
                marginTop: 4,
                alignItems: 'center',
                paddingVertical: 14,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Mono size={11} tracking={0.12} upper color={c.ink}>
                  Edit on web
                </Mono>
                <ArrowUpRight size={12} color={c.ink} strokeWidth={1.6} />
              </View>
            </Pressable>
          </View>
        ) : null}

        {tab === 'movements' ? (
          <View style={{ paddingHorizontal: 20 }}>
            {movementsError ? (
              <Body size={12.5} color={ACCENT.crit} style={{ marginBottom: 12 }}>
                {movementsError}
              </Body>
            ) : null}
            {movementsLoading ? (
              <ActivityIndicator color={c.ink} style={{ marginTop: 32 }} />
            ) : movements.length === 0 ? (
              movementsError ? null : (
                <View style={{ padding: 32, alignItems: 'center' }}>
                  <ArrowLeftRight size={32} color={c.ink4} strokeWidth={1.3} />
                  <Display size={18} style={{ marginTop: 12 }}>
                    No movements <Em>yet.</Em>
                  </Display>
                  <Body muted style={{ marginTop: 6, textAlign: 'center', maxWidth: 280 }}>
                    Adjustments, receipts, and counts will appear here as you work.
                  </Body>
                </View>
              )
            ) : (
              <View style={{ gap: 8 }}>
                {movements.map((m) => (
                  <MovementCard
                    key={m.id}
                    movement={m}
                    canEditNotes={canEditNotes}
                    onNoteSaved={handleNoteSaved}
                  />
                ))}
                <LoadMoreFooter
                  remaining={movementsRemaining}
                  loading={movementsLoadingMore}
                  onPress={() => void loadMoreMovements()}
                />
              </View>
            )}
          </View>
        ) : null}

        {tab === 'activity' ? (
          <View style={{ paddingHorizontal: 20 }}>
            {activityError ? (
              <Body size={12.5} color={ACCENT.crit} style={{ marginBottom: 12 }}>
                {activityError}
              </Body>
            ) : null}
            {activityLoading ? (
              <ActivityIndicator color={c.ink} style={{ marginTop: 32 }} />
            ) : activityEntries.length === 0 ? (
              activityError ? null : (
                <View style={{ padding: 32, alignItems: 'center' }}>
                  <History size={32} color={c.ink4} strokeWidth={1.3} />
                  <Display size={18} style={{ marginTop: 12 }}>
                    No activity <Em>yet.</Em>
                  </Display>
                  <Body muted style={{ marginTop: 6, textAlign: 'center', maxWidth: 280 }}>
                    Edits, archive/restore, serials, tags, and stock changes will appear here as
                    you work.
                  </Body>
                </View>
              )
            ) : (
              <View style={{ gap: 8 }}>
                {activityEntries.map((entry) =>
                  entry.kind === 'movement' ? (
                    <MovementCard
                      key={entry.id}
                      movement={entry.movement}
                      canEditNotes={canEditNotes}
                      onNoteSaved={handleNoteSaved}
                    />
                  ) : (
                    <AuditCard key={entry.id} audit={entry.audit} />
                  ),
                )}
                <LoadMoreFooter
                  remaining={activityRemaining}
                  loading={activityLoadingMore}
                  onPress={() => void loadMoreActivity()}
                />
              </View>
            )}
          </View>
        ) : null}
      </ScrollView>

      <AdjustModal
        visible={adjustOpen}
        item={item}
        busy={busy}
        onClose={() => setAdjustOpen(false)}
        onConfirm={async (delta, reason) => {
          await adjust(delta, reason);
          setAdjustOpen(false);
        }}
      />

      <MoveStockModal
        visible={moveOpen}
        itemId={item.id}
        itemName={item.name}
        itemType={item.item_type}
        organizationId={item.organization_id}
        canCreateLocation={canCreateLocation}
        onClose={() => setMoveOpen(false)}
        onMoved={() => {
          void load();
          if (tab === 'movements') void loadMovements();
          if (tab === 'activity') void loadActivity();
        }}
      />

      <RemoveFromRackModal
        visible={removeOpen}
        itemId={item.id}
        itemName={item.name}
        organizationId={item.organization_id}
        onClose={() => setRemoveOpen(false)}
        onRemoved={() => {
          void load();
          if (tab === 'movements') void loadMovements();
          if (tab === 'activity') void loadActivity();
        }}
      />

      {item.imageUrl ? (
        <PhotoViewer
          uri={item.imageUrl}
          visible={photoViewerOpen}
          onClose={() => setPhotoViewerOpen(false)}
          label={item.name}
        />
      ) : null}
    </View>
  );
}

function TabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const { c } = useTheme();
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1, flex: 1 })}>
      <View
        style={{
          paddingVertical: 12,
          alignItems: 'center',
          borderBottomWidth: 2,
          borderBottomColor: active ? c.ink : 'transparent',
        }}
      >
        {/* Chrome cap: three equal `flex: 1` columns with no break opportunity
            inside a word — uncapped, MOVEMENTS breaks mid-word at 2x. The
            control ceiling is the segmented-control policy from lib/theme. */}
        <Mono
          size={11}
          tracking={0.12}
          upper
          numberOfLines={1}
          maxFontSizeMultiplier={capTo(11, TYPE_CEILING.control)}
          color={active ? c.ink : c.ink4}
          style={{ fontFamily: FONT.mono }}
        >
          {label}
        </Mono>
      </View>
    </Pressable>
  );
}

function QuickBtn({
  label,
  onPress,
  disabled,
  primary,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.quickBtn,
        {
          backgroundColor: primary ? c.ink : c.card,
          borderColor: primary ? c.ink : c.hair,
          opacity: disabled ? 0.4 : pressed ? 0.85 : 1,
        },
      ]}
    >
      {/* Three fixed `flex: 1` columns of pinned chrome — capped at the control
          ceiling, and allowed to ellipsize inside its own button rather than
          shove the neighbouring one off the strip. */}
      <Mono
        size={15}
        tracking={-0.012}
        numberOfLines={1}
        maxFontSizeMultiplier={capTo(15, TYPE_CEILING.control)}
        color={primary ? c.paper : c.ink}
        style={{ fontFamily: FONT.display, flexShrink: 1 }}
      >
        {label}
      </Mono>
    </Pressable>
  );
}

function MetaRow({ label, value, dot }: { label: string; value: string; dot?: string | null }) {
  const { c } = useTheme();
  const { fontScale } = useWindowDimensions();
  // Reflow, not a cap: label and value are both content (LOCATION / a rack
  // name, SUPPLIER / a vendor name) and `justify: space-between` gives neither
  // of them room to shrink into. Past the threshold the row becomes a
  // label-over-value stack, which is unbounded in the direction that is free.
  const stacked = shouldStackRow(fontScale);
  return (
    <View
      style={{
        flexDirection: stacked ? 'column' : 'row',
        justifyContent: 'space-between',
        alignItems: stacked ? 'flex-start' : 'center',
        gap: stacked ? 4 : 0,
        paddingVertical: 14,
        paddingHorizontal: 16,
      }}
    >
      <Mono size={10.5} tracking={0.12} upper color={c.ink4} style={{ flexShrink: 1 }}>
        {label}
      </Mono>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>
        {dot ? (
          <View
            style={{
              width: 10,
              height: 10,
              borderRadius: 5,
              backgroundColor: dot,
              borderWidth: 1,
              borderColor: c.hair,
            }}
          />
        ) : null}
        <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>
          {value}
        </Body>
      </View>
    </View>
  );
}

function MovementCard({
  movement,
  canEditNotes = false,
  onNoteSaved,
}: {
  movement: MovementRow;
  /** Cosmetic gate — manager+ or the granted 'movements:edit_notes' perm.
   *  The PATCH endpoint + RPC re-assert it, so this only hides the affordance. */
  canEditNotes?: boolean;
  /** Optimistic hook: parent updates its movement list(s) with the saved note. */
  onNoteSaved?: (movementId: string, note: string | null) => void;
}) {
  const { c } = useTheme();
  const router = useRouter();
  const [noteOpen, setNoteOpen] = React.useState(false);
  const isAdd = movement.quantity_change > 0;
  // Display mapping lives in src/lib/movement-display.ts (unit-tested):
  //  - transfers show moved_quantity (net-zero delta is always 0); pre-0231
  //    rows have none → no number, never "0",
  //  - pre-0231 receipt rows' internal 'receipt_line' reason → 'PO receipt'
  //    (new rows already carry 'PO {number}').
  const amount = movementAmount(movement);
  const Icon = isAdd ? Plus : movement.quantity_change < 0 ? Minus : RotateCcw;
  const pipColor = isAdd ? ACCENT.mint : movement.quantity_change < 0 ? ACCENT.crit : ACCENT.warn;
  const verb = TYPE_LABEL[movement.movement_type] ?? movement.movement_type;
  const actor = movement.actor?.full_name ?? movement.actor?.email ?? 'system';
  // Source reference (Unit 3, web parity): what CAUSED this movement — an
  // order, cycle count, return, or bundle. referenceHref is null whenever
  // the type is unrecognized OR has no native detail screen (currently:
  // `return`) — that's the graceful-degrade signal to render a plain label
  // instead of a broken navigation, never a dead link/route.
  const referenceHref = referenceRoute(movement.reference_type, movement.reference_id);
  const referenceDisplayLabel = movement.reference_type
    ? (movement.reference_label ?? referenceTypeLabel(movement.reference_type))
    : null;
  // Web parity with the activity feed: the reason and the reference chip are
  // resolved from the SAME record, so a pick row would otherwise read
  // "Order pick (SO-000060) … SO-000060" on one card. The chip is the tappable
  // one, so the reason gives the handle up.
  const reasonLabel = reasonWithoutRefLabel(
    movementReasonLabel(movement.reason),
    referenceDisplayLabel,
  );
  // Web parity (Movement/Activity P1 review follow-up): from/to location
  // route line, e.g. "Rack A1 → Rack B2" for a transfer, "→ Rack B2" for a
  // receive, "Rack A1 →" for a removal. null whenever neither side resolved
  // to a name — formatMovementRoute (movement-display.ts) is the single
  // source of truth for this four-case logic, unit-tested there.
  const route = formatMovementRoute(movement.from_location_name, movement.to_location_name);
  return (
    <Card padding={12}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: c.hair,
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            backgroundColor: c.card,
          }}
        >
          <Icon size={14} color={c.ink} strokeWidth={1.6} />
          <View
            style={{
              position: 'absolute',
              top: 4,
              right: 4,
              width: 5,
              height: 5,
              borderRadius: 3,
              backgroundColor: pipColor,
            }}
          />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Body size={14} color={c.ink} style={{ fontFamily: FONT.display }}>
            {verb}
            {reasonLabel ? ` · ${reasonLabel}` : ''}
          </Body>
          <Mono size={10.5} tracking={0.04} color={c.ink4} style={{ marginTop: 3 }}>
            {actor} ·{' '}
            {new Date(movement.created_at).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
            {referenceDisplayLabel ? (
              <Text
                onPress={referenceHref ? () => router.push(referenceHref as Href) : undefined}
                style={referenceHref ? { textDecorationLine: 'underline', color: c.ink } : undefined}
              >
                {' · '}
                {referenceDisplayLabel}
              </Text>
            ) : null}
          </Mono>
          {route ? (
            <Mono size={10.5} tracking={0.04} color={c.ink4} style={{ marginTop: 2 }}>
              {route}
            </Mono>
          ) : null}
          {movement.notes ? (
            <Body
              size={12.5}
              muted
              numberOfLines={2}
              style={{ marginTop: 3, fontStyle: 'italic' }}
            >
              “{movement.notes}”
            </Body>
          ) : null}
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          {amount.kind !== 'none' && (
            <Mono
              size={15}
              tracking={-0.012}
              color={
                amount.kind === 'moved'
                  ? c.ink
                  : amount.sign > 0
                    ? ACCENT.mintInk
                    : amount.sign < 0
                      ? ACCENT.crit
                      : c.ink
              }
              style={{ fontFamily: FONT.display }}
            >
              {amount.text}
            </Mono>
          )}
          <Mono size={9.5} tracking={0.04} color={c.ink4} style={{ marginTop: 2 }}>
            {movement.previous_quantity} → {movement.new_quantity}
          </Mono>
        </View>
      </View>

      {/* Add/Edit note affordance — visible only to a caller who can edit
          notes (manager+ or granted 'movements:edit_notes') AND on a row whose
          note isn't system-managed. Pre-0231 'receipt_line' rows
          (note_editable=false) stash a machine receipt reference in notes that
          the RPC refuses to overwrite — never show the affordance for them.
          Opens the inline sheet below, which PATCHes /api/v1/movements/[id]/note. */}
      {canEditNotes && movement.note_editable ? (
        <Pressable
          onPress={() => setNoteOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={movement.notes ? 'Edit note' : 'Add note'}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
            alignSelf: 'flex-start',
            marginTop: 8,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Edit3 size={11} color={c.ink4} strokeWidth={1.6} />
          <Mono size={9.5} tracking={0.12} upper color={c.ink4}>
            {movement.notes ? 'Edit note' : 'Add note'}
          </Mono>
        </Pressable>
      ) : null}

      <MovementNoteModal
        visible={noteOpen}
        movementId={movement.id}
        initialNote={movement.notes}
        onClose={() => setNoteOpen(false)}
        onSaved={(note) => {
          onNoteSaved?.(movement.id, note);
          setNoteOpen(false);
        }}
      />
    </Card>
  );
}

/**
 * Add/edit-note bottom sheet — same sheet scaffolding as AdjustModal, no new
 * UI lib. Saves via the Bearer endpoint `PATCH /api/v1/movements/[id]/note`,
 * which drives the SECURITY DEFINER `edit_movement_note` RPC (the only
 * sanctioned write into the append-only ledger — mig 0274). Errors surface
 * INLINE and persist until the next attempt (project modal-error rule); the
 * server response's normalized `note` is echoed back so the optimistic card
 * update matches exactly what was stored (empty/whitespace → cleared).
 */
function MovementNoteModal({
  visible,
  movementId,
  initialNote,
  onClose,
  onSaved,
}: {
  visible: boolean;
  movementId: string;
  initialNote: string | null;
  onClose: () => void;
  onSaved: (note: string | null) => void;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/* Reset-by-remount: keying the content on the open/closed flip gives
          every open a fresh draft/error/busy seeded from `initialNote` — the
          reset the old visible-effect performed. */}
      <MovementNoteModalContent
        key={String(visible)}
        movementId={movementId}
        initialNote={initialNote}
        onClose={onClose}
        onSaved={onSaved}
      />
    </Modal>
  );
}

function MovementNoteModalContent({
  movementId,
  initialNote,
  onClose,
  onSaved,
}: {
  movementId: string;
  initialNote: string | null;
  onClose: () => void;
  onSaved: (note: string | null) => void;
}) {
  const { c, mode } = useTheme();
  const [text, setText] = React.useState(initialNote ?? '');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const hadNote = normalizeMovementNote(initialNote) !== null;
  // Nothing to save when the normalized draft equals the current note (incl.
  // both being empty) — mirrors "no-op edit" so we never round-trip needlessly.
  const nextNote = normalizeMovementNote(text);
  const isDirty = nextNote !== normalizeMovementNote(initialNote);

  async function submit() {
    if (busy || !isDirty) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ ok: boolean; note: string | null }>(
        `/api/v1/movements/${movementId}/note`,
        { method: 'PATCH', body: { note: text } },
      );
      onSaved(res.note ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the note. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <Pressable
          onPress={onClose}
          style={{
            flex: 1,
            justifyContent: 'flex-end',
            backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)',
          }}
        >
          <Pressable
            onPress={() => undefined}
            style={[
              {
                backgroundColor: c.card,
                borderTopLeftRadius: 24,
                borderTopRightRadius: 24,
                paddingTop: 12,
                paddingBottom: 36,
                paddingHorizontal: 22,
              },
              SHADOW.sheet,
            ]}
          >
            <View style={{ alignItems: 'center', marginBottom: 18 }}>
              <View
                style={{
                  width: 36,
                  height: 5,
                  borderRadius: 100,
                  backgroundColor: mode === 'dark' ? 'rgba(250,250,247,0.22)' : 'rgba(14,15,13,0.18)',
                }}
              />
            </View>
            <Eyebrow>{hadNote ? 'EDIT NOTE' : 'ADD NOTE'}</Eyebrow>
            <Body muted size={11.5} style={{ marginTop: 6 }}>
              Notes are the only editable field on a movement — every change is recorded in the
              audit log.
            </Body>

            <View style={{ marginTop: 16, gap: 6 }}>
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder="Add context for this movement…"
                placeholderTextColor={c.ink5}
                multiline
                maxLength={MOVEMENT_NOTE_MAX}
                autoFocus
                style={{
                  fontFamily: FONT.displayRegular,
                  fontSize: 15,
                  minHeight: 90,
                  maxHeight: 180,
                  paddingHorizontal: 14,
                  paddingTop: 12,
                  paddingBottom: 12,
                  borderWidth: 1,
                  borderColor: c.hair,
                  borderRadius: 8,
                  color: c.ink,
                  backgroundColor: c.paper2,
                  textAlignVertical: 'top',
                }}
              />
              {error ? (
                <Body size={12.5} color={ACCENT.crit}>
                  {error}
                </Body>
              ) : null}
            </View>

            <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
              <View style={{ flex: 1 }}>
                <Button block variant="ghost" onPress={onClose}>
                  Cancel
                </Button>
              </View>
              <View style={{ flex: 1 }}>
                <Button block onPress={() => void submit()} disabled={busy || !isDirty}>
                  {busy ? 'Saving…' : 'Save'}
                </Button>
              </View>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
  );
}

/**
 * "Load more (N remaining)" footer — the SerialsCard load-more affordance
 * (see SerialsCard below), extracted so both the Movements tab and the
 * Activity tab share one implementation. Renders nothing once `remaining`
 * hits 0 (fully paginated).
 */
function LoadMoreFooter({
  remaining,
  loading,
  onPress,
}: {
  remaining: number;
  loading: boolean;
  onPress: () => void;
}) {
  const { c } = useTheme();
  if (remaining <= 0) return null;
  return (
    <Pressable
      onPress={onPress}
      disabled={loading}
      style={({ pressed }) => ({
        alignItems: 'center',
        paddingVertical: 13,
        opacity: loading ? 0.5 : pressed ? 0.7 : 1,
      })}
    >
      {loading ? (
        <ActivityIndicator color={c.ink} size="small" />
      ) : (
        <Mono size={11} tracking={0.12} upper color={c.ink}>
          Load more ({remaining} remaining)
        </Mono>
      )}
    </Pressable>
  );
}

/**
 * Audit event card for the Activity tab (Movement/Activity P4 Task 1) —
 * same Card/Body/Mono shell as MovementCard for visual consistency, no new
 * design system. `audit` is already a fully-formed, crash-safe
 * `AuditCardModel` built by `buildAuditCardModel` (item-activity.ts) — this
 * component only renders it, no metadata parsing here.
 */
function AuditCard({ audit }: { audit: AuditCardModel }) {
  const { c } = useTheme();
  const absolute = new Date(audit.createdAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const relative = formatRelativeTime(audit.createdAt);
  return (
    <Card padding={12}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: c.hair,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: c.card,
          }}
        >
          <Edit3 size={14} color={c.ink} strokeWidth={1.6} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Body size={14} color={c.ink} style={{ fontFamily: FONT.display }}>
            {audit.eventLabel}
          </Body>
          <Mono size={10.5} tracking={0.04} color={c.ink4} style={{ marginTop: 3 }}>
            {audit.actorName}
            {relative ? ` · ${relative}` : ''} · {absolute}
          </Mono>
          {audit.reason ? (
            <Body
              size={12.5}
              muted
              numberOfLines={2}
              style={{ marginTop: 3, fontStyle: 'italic' }}
            >
              “{audit.reason}”
            </Body>
          ) : null}
          {/* changed_keys chip — web parity (metadata-diff.tsx): buildAuditCardModel
              already nulls this out whenever diffRows is non-empty, so this only
              ever renders for LEGACY rows written before before/after capture. */}
          {audit.changedKeys && audit.changedKeys.length > 0 ? (
            <Mono size={10} tracking={0.02} color={c.ink4} style={{ marginTop: 6 }}>
              Fields on the edit (exact changes not recorded for this entry):{' '}
              {audit.changedKeys.map(humanizeFieldName).join(', ')}
            </Mono>
          ) : null}
          {/* Compact before → after rows, capped at AUDIT_DIFF_ROW_CAP with a
              "+N more" tail — metadata is untrusted jsonb, but everything
              here (diffRows/diffMoreCount) was already built crash-safely by
              buildAuditCardModel, so this is pure rendering. */}
          {audit.diffRows.length > 0 ? (
            <View style={{ marginTop: 6, gap: 3 }}>
              {audit.diffRows.map((row) => (
                <Mono key={row.field} size={10.5} tracking={0.02} color={c.ink4}>
                  {humanizeFieldName(row.field)}: {row.before} → {row.after}
                </Mono>
              ))}
              {audit.diffMoreCount > 0 ? (
                <Mono size={9.5} tracking={0.04} color={c.ink5}>
                  +{audit.diffMoreCount} more
                </Mono>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>
    </Card>
  );
}

function AdjustModal({
  visible,
  item,
  busy,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  item: Item;
  busy: boolean;
  onClose: () => void;
  onConfirm: (delta: number, reason: string) => Promise<void>;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/* Reset-by-remount: keying the content on the open/closed flip clears
          the delta/reason draft on every open — the reset the old
          visible-effect performed. */}
      <AdjustModalContent
        key={String(visible)}
        item={item}
        busy={busy}
        onClose={onClose}
        onConfirm={onConfirm}
      />
    </Modal>
  );
}

function AdjustModalContent({
  item,
  busy,
  onClose,
  onConfirm,
}: {
  item: Item;
  busy: boolean;
  onClose: () => void;
  onConfirm: (delta: number, reason: string) => Promise<void>;
}) {
  const { c, mode } = useTheme();
  const [delta, setDelta] = React.useState('');
  const [reason, setReason] = React.useState('');

  const parsedDelta = parseInt(delta, 10);
  const isValid = !Number.isNaN(parsedDelta) && parsedDelta !== 0;
  const preview = isValid ? item.quantity_on_hand + parsedDelta : item.quantity_on_hand;

  return (
    <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <Pressable
          onPress={onClose}
          style={[
            {
              flex: 1,
              justifyContent: 'flex-end',
              backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)',
            },
          ]}
        >
          <Pressable
            onPress={() => undefined}
            style={[
              {
                backgroundColor: c.card,
                borderTopLeftRadius: 24,
                borderTopRightRadius: 24,
                paddingTop: 12,
                paddingBottom: 36,
                paddingHorizontal: 22,
              },
              SHADOW.sheet,
            ]}
          >
            <View style={{ alignItems: 'center', marginBottom: 18 }}>
              <View
                style={{
                  width: 36,
                  height: 5,
                  borderRadius: 100,
                  backgroundColor:
                    mode === 'dark' ? 'rgba(250,250,247,0.22)' : 'rgba(14,15,13,0.18)',
                }}
              />
            </View>
            <Eyebrow>ADJUST STOCK</Eyebrow>
            <Display size={24} style={{ marginTop: 10 }}>
              {item.name}
            </Display>
            <Mono size={11.5} tracking={0.04} color={c.ink4} style={{ marginTop: 4 }}>
              on hand {item.quantity_on_hand} {item.unit_of_measure}
            </Mono>

            <View style={{ marginTop: 20, gap: 14 }}>
              <View style={{ gap: 6 }}>
                <Mono size={10} tracking={0.12} upper color={c.ink4}>
                  CHANGE (+ ADDS, − REMOVES)
                </Mono>
                <TextInput
                  value={delta}
                  onChangeText={setDelta}
                  placeholder="e.g. -3 or 12"
                  placeholderTextColor={c.ink5}
                  keyboardType="numbers-and-punctuation"
                  autoFocus
                  // Dynamic Type: minHeight + padding, not a hard 52pt frame —
                  // this is the box the user types the adjustment INTO, and a
                  // clipped value or caret here is a stock error.
                  style={{
                    fontFamily: FONT.display,
                    fontSize: 18,
                    minHeight: 52,
                    paddingHorizontal: 14,
                    paddingVertical: 12,
                    borderWidth: 1,
                    borderColor: c.hair,
                    borderRadius: 8,
                    color: c.ink,
                    backgroundColor: c.paper2,
                  }}
                />
              </View>
              <View style={{ gap: 6 }}>
                <Mono size={10} tracking={0.12} upper color={c.ink4}>
                  REASON (OPTIONAL)
                </Mono>
                <TextInput
                  value={reason}
                  onChangeText={setReason}
                  placeholder="Cycle count variance, damage, etc."
                  placeholderTextColor={c.ink5}
                  // minHeight for the same reason as the CHANGE box above.
                  style={{
                    fontFamily: FONT.displayRegular,
                    fontSize: 15,
                    minHeight: 50,
                    paddingHorizontal: 14,
                    paddingVertical: 12,
                    borderWidth: 1,
                    borderColor: c.hair,
                    borderRadius: 8,
                    color: c.ink,
                    backgroundColor: c.paper2,
                  }}
                />
              </View>
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  marginTop: 4,
                }}
              >
                <Mono size={10.5} tracking={0.12} upper color={c.ink4}>
                  NEW TOTAL
                </Mono>
                <Mono
                  size={28}
                  tracking={-0.022}
                  color={preview < 0 ? ACCENT.crit : preview === 0 ? ACCENT.warn : c.ink}
                  style={{ fontFamily: FONT.display }}
                >
                  {preview}
                </Mono>
              </View>
            </View>

            <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
              <View style={{ flex: 1 }}>
                <Button block variant="ghost" onPress={onClose}>
                  Cancel
                </Button>
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  block
                  onPress={() => isValid && onConfirm(parsedDelta, reason || 'Mobile detail')}
                  disabled={!isValid || busy}
                >
                  {busy ? 'Saving…' : 'Confirm'}
                </Button>
              </View>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
  );
}

// ─── Serials ────────────────────────────────────────────────────────

interface SerialRow {
  id: string;
  serial_number: string;
  current_status: SerialStatus;
  receipt_line_id: string | null;
  created_at: string;
}

const SERIALS_PAGE_SIZE = 25;

/**
 * Serial registry card — paginated list (25/page, Load more), tap a row
 * to change status, long-press a manually-added row to delete it.
 * Receipt-captured rows (receipt_line_id set) are never deletable from
 * mobile; they keep the PO audit trail — change status instead.
 *
 * Errors surface INLINE in the card (persistent crit-red Text), per the
 * project's modal-error rule; Alert only supplements confirmations.
 */
function SerialsCard({
  itemId,
  organizationId,
  defaultWarehouseId,
  canWrite,
  onCountChange,
}: {
  itemId: string;
  organizationId: string;
  defaultWarehouseId: string | null;
  canWrite: boolean;
  onCountChange: (count: number) => void;
}) {
  const { c } = useTheme();
  const [rows, setRows] = React.useState<SerialRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [mutatingId, setMutatingId] = React.useState<string | null>(null);
  const [statusTarget, setStatusTarget] = React.useState<SerialRow | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);

  const fetchPage = React.useCallback(
    async (offset: number): Promise<{ rows: SerialRow[]; count: number } | null> => {
      const {
        data,
        count,
        error: qErr,
      } = await supabase
        .from('serial_registry')
        .select('id, serial_number, current_status, receipt_line_id, created_at', {
          count: 'exact',
        })
        .eq('organization_id', organizationId)
        .eq('item_id', itemId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(offset, offset + SERIALS_PAGE_SIZE - 1);
      if (qErr) {
        setError(qErr.message);
        return null;
      }
      const mapped: SerialRow[] = (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        return {
          id: r.id as string,
          serial_number: r.serial_number as string,
          current_status: isSerialStatus(r.current_status) ? r.current_status : 'available',
          receipt_line_id: (r.receipt_line_id as string | null) ?? null,
          created_at: r.created_at as string,
        };
      });
      return { rows: mapped, count: count ?? 0 };
    },
    [itemId, organizationId],
  );

  // NOTE: `loading` starts true and `error` starts null, so reload() needs no
  // synchronous pre-await resets on mount; the post-add refresh below sets the
  // flags itself before re-invoking reload().
  const reload = React.useCallback(async () => {
    const res = await fetchPage(0);
    if (res) {
      setRows(res.rows);
      setTotal(res.count);
      onCountChange(res.count);
    }
    setLoading(false);
  }, [fetchPage, onCountChange]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: every set is post-await; the effect synchronizes with the server
    void reload();
  }, [reload]);

  async function loadMore() {
    if (loadingMore || loading) return;
    setLoadingMore(true);
    const res = await fetchPage(rows.length);
    if (res) {
      setRows((prev) => {
        // Dedupe by id — concurrent inserts can shift offset pages.
        const known = new Set(prev.map((r) => r.id));
        return [...prev, ...res.rows.filter((r) => !known.has(r.id))];
      });
      setTotal(res.count);
      onCountChange(res.count);
    }
    setLoadingMore(false);
  }

  async function changeStatus(row: SerialRow, next: SerialStatus) {
    if (next === row.current_status) return;
    setMutatingId(row.id);
    setError(null);
    // .update().eq() is fail-open on 0 rows — .select().maybeSingle()
    // proves a row actually changed (recurring bug pattern).
    const { data, error: uErr } = await supabase
      .from('serial_registry')
      .update({ current_status: next, updated_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('organization_id', organizationId)
      .select('id')
      .maybeSingle();
    setMutatingId(null);
    if (uErr) {
      setError(`Could not update ${row.serial_number}: ${uErr.message}`);
      return;
    }
    if (!data) {
      setError(
        `Could not update ${row.serial_number} — it may have been removed or you may not have access.`,
      );
      return;
    }
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, current_status: next } : r)));
  }

  function confirmDelete(row: SerialRow) {
    if (!canDeleteSerial(row.receipt_line_id)) {
      setError('From PO receipt — change status instead.');
      return;
    }
    setError(null);
    Alert.alert('Delete serial?', `${row.serial_number} will be removed from the registry.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          void (async () => {
            setMutatingId(row.id);
            const { data, error: dErr } = await supabase
              .from('serial_registry')
              .delete()
              .eq('id', row.id)
              .eq('organization_id', organizationId)
              .is('receipt_line_id', null)
              .select('id')
              .maybeSingle();
            setMutatingId(null);
            if (dErr) {
              setError(`Could not delete ${row.serial_number}: ${dErr.message}`);
              return;
            }
            if (!data) {
              setError(
                `Could not delete ${row.serial_number} — it may be receipt-linked or already removed.`,
              );
              return;
            }
            setRows((prev) => prev.filter((r) => r.id !== row.id));
            setTotal((t) => {
              const nextTotal = Math.max(0, t - 1);
              onCountChange(nextTotal);
              return nextTotal;
            });
          })(),
      },
    ]);
  }

  const remaining = Math.max(0, total - rows.length);

  return (
    <>
      <Card padding={0}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            paddingTop: 14,
            paddingBottom: 10,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
            <Eyebrow>SERIALS</Eyebrow>
            <Mono size={11} tracking={0.04} color={c.ink4}>
              {total}
            </Mono>
          </View>
          {canWrite ? (
            <Button
              size="sm"
              variant="outline"
              onPress={() => setAddOpen(true)}
              leading={<Plus size={13} color={c.ink} strokeWidth={1.6} />}
            >
              Add serials
            </Button>
          ) : null}
        </View>

        {error ? (
          <Body
            size={12.5}
            color={ACCENT.crit}
            style={{ paddingHorizontal: 16, paddingBottom: 10 }}
          >
            {error}
          </Body>
        ) : null}

        {loading ? (
          <ActivityIndicator color={c.ink} style={{ paddingVertical: 24 }} />
        ) : rows.length === 0 ? (
          error ? null : (
            <Body muted size={13} style={{ paddingHorizontal: 16, paddingBottom: 16 }}>
              No serials recorded yet.
              {canWrite ? ' Use “Add serials” to register units manually.' : ''}
            </Body>
          )
        ) : (
          <>
            {rows.map((row) => (
              <React.Fragment key={row.id}>
                <Hair inset={16} />
                <Pressable
                  onPress={canWrite && !mutatingId ? () => setStatusTarget(row) : undefined}
                  onLongPress={canWrite && !mutatingId ? () => confirmDelete(row) : undefined}
                  disabled={!canWrite}
                  accessibilityRole={canWrite ? 'button' : undefined}
                  accessibilityLabel={`Serial ${row.serial_number}, ${SERIAL_STATUS_LABELS[row.current_status]}`}
                  style={({ pressed }) => ({
                    opacity: mutatingId === row.id ? 0.4 : pressed && canWrite ? 0.7 : 1,
                  })}
                >
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 12,
                      paddingHorizontal: 16,
                      paddingVertical: 12,
                    }}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Mono size={12.5} tracking={-0.012} numberOfLines={1}>
                        {row.serial_number}
                      </Mono>
                      <Mono size={9.5} tracking={0.04} color={c.ink4} style={{ marginTop: 3 }}>
                        {serialSourceLabel(row.receipt_line_id)} ·{' '}
                        {formatSerialDate(row.created_at)}
                      </Mono>
                    </View>
                    <SerialStatusPill status={row.current_status} />
                  </View>
                </Pressable>
              </React.Fragment>
            ))}

            {remaining > 0 ? (
              <>
                <Hair inset={16} />
                <Pressable
                  onPress={() => void loadMore()}
                  disabled={loadingMore}
                  style={({ pressed }) => ({
                    alignItems: 'center',
                    paddingVertical: 13,
                    opacity: loadingMore ? 0.5 : pressed ? 0.7 : 1,
                  })}
                >
                  {loadingMore ? (
                    <ActivityIndicator color={c.ink} size="small" />
                  ) : (
                    <Mono size={11} tracking={0.12} upper color={c.ink}>
                      Load more ({remaining} remaining)
                    </Mono>
                  )}
                </Pressable>
              </>
            ) : null}

            {canWrite ? (
              <>
                <Hair inset={16} />
                <Mono
                  size={9.5}
                  tracking={0.04}
                  color={c.ink5}
                  style={{ paddingHorizontal: 16, paddingVertical: 10 }}
                >
                  Tap a serial to change status · long-press to delete manual entries
                </Mono>
              </>
            ) : null}
          </>
        )}
      </Card>

      <SerialStatusSheet
        row={statusTarget}
        onClose={() => setStatusTarget(null)}
        onSelect={(next) => {
          const target = statusTarget;
          setStatusTarget(null);
          if (target) void changeStatus(target, next);
        }}
      />

      <AddSerialsModal
        visible={addOpen}
        itemId={itemId}
        organizationId={organizationId}
        defaultWarehouseId={defaultWarehouseId}
        onClose={() => setAddOpen(false)}
        onAdded={() => {
          setAddOpen(false);
          setLoading(true);
          setError(null);
          void reload();
        }}
      />
    </>
  );
}

/**
 * Colored status pill — tones from serialStatusColor (theme tokens).
 *
 * Delegates to the shared `Pill` rather than re-rolling it. The hand-rolled
 * copy this replaces had the same `height: 22` frame the shared Pill was fixed
 * out of, so at larger text sizes it painted its label straight through its own
 * border; a duplicate primitive is exactly how a fix fails to reach a screen.
 */
function SerialStatusPill({ status }: { status: SerialStatus }) {
  const { mode } = useTheme();
  return (
    // Uppercased at the call site: the shared Pill takes its children verbatim
    // (every other call site passes OK / LOW / OUT), and the copy this replaces
    // rendered these labels through Mono's `upper`.
    <Pill tone={serialStatusColor(status, mode)}>
      {SERIAL_STATUS_LABELS[status].toUpperCase()}
    </Pill>
  );
}

/**
 * Bottom-sheet status picker — same sheet scaffolding as AdjustModal.
 * (Alert.alert caps at 3 buttons on Android, so the 6-status pick needs
 * a real sheet.)
 */
function SerialStatusSheet({
  row,
  onClose,
  onSelect,
}: {
  row: SerialRow | null;
  onClose: () => void;
  onSelect: (status: SerialStatus) => void;
}) {
  const { c, mode } = useTheme();
  return (
    <Modal
      visible={!!row}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable
        onPress={onClose}
        style={{
          flex: 1,
          justifyContent: 'flex-end',
          backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)',
        }}
      >
        <Pressable
          onPress={() => undefined}
          style={[
            {
              backgroundColor: c.card,
              borderTopLeftRadius: 24,
              borderTopRightRadius: 24,
              paddingTop: 12,
              paddingBottom: 36,
              paddingHorizontal: 22,
            },
            SHADOW.sheet,
          ]}
        >
          <View style={{ alignItems: 'center', marginBottom: 18 }}>
            <View
              style={{
                width: 36,
                height: 5,
                borderRadius: 100,
                backgroundColor: mode === 'dark' ? 'rgba(250,250,247,0.22)' : 'rgba(14,15,13,0.18)',
              }}
            />
          </View>
          <Eyebrow>SET STATUS</Eyebrow>
          <Mono size={14} tracking={-0.012} style={{ marginTop: 8 }} numberOfLines={1}>
            {row?.serial_number ?? ''}
          </Mono>

          <View
            style={{
              marginTop: 16,
              borderWidth: 1,
              borderColor: c.hair,
              borderRadius: 10,
              overflow: 'hidden',
            }}
          >
            {SERIAL_STATUSES.map((s, i) => {
              const tone = serialStatusColor(s, mode);
              const current = row?.current_status === s;
              return (
                <React.Fragment key={s}>
                  {i > 0 ? <Hair /> : null}
                  <Pressable
                    onPress={() => onSelect(s)}
                    accessibilityRole="button"
                    accessibilityLabel={`Set status ${SERIAL_STATUS_LABELS[s]}`}
                    style={({ pressed }) => ({
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 10,
                      paddingHorizontal: 14,
                      paddingVertical: 13,
                      backgroundColor: pressed ? c.paper2 : 'transparent',
                    })}
                  >
                    <View
                      style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tone.fg }}
                    />
                    <Body size={15} style={{ flex: 1 }}>
                      {SERIAL_STATUS_LABELS[s]}
                    </Body>
                    {current ? (
                      <Mono size={9.5} tracking={0.12} upper color={c.ink4}>
                        Current
                      </Mono>
                    ) : null}
                  </Pressable>
                </React.Fragment>
              );
            })}
          </View>

          <Button block variant="ghost" onPress={onClose} style={{ marginTop: 12 }}>
            Cancel
          </Button>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * Add-serials sheet — multiline "one per line" input + active-warehouse
 * picker. Inserts rows as manual ('available', receipt_line_id null).
 * All errors (validation, duplicate 23505, RLS) render INLINE and
 * persist until the next attempt.
 */
function AddSerialsModal({
  visible,
  itemId,
  organizationId,
  defaultWarehouseId,
  onClose,
  onAdded,
}: {
  visible: boolean;
  itemId: string;
  organizationId: string;
  defaultWarehouseId: string | null;
  onClose: () => void;
  onAdded: (added: number) => void;
}) {
  // Warehouse list + selection live on the WRAPPER so the chosen warehouse
  // deliberately persists across opens (kept when still valid, exactly as the
  // old visible-effect's functional set did); the sheet's draft fields live in
  // the keyed content below and reset by remount instead.
  const [warehouses, setWarehouses] = React.useState<{ id: string; name: string }[] | null>(null);
  const [warehouseId, setWarehouseId] = React.useState<string | null>(null);
  const [warehousesError, setWarehousesError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void (async () => {
      const { data, error: whErr } = await supabase
        .from('warehouses')
        .select('id, name')
        .eq('organization_id', organizationId)
        .eq('status', 'active')
        .order('name');
      if (cancelled) return;
      if (whErr) {
        setWarehouses([]);
        setWarehousesError(`Could not load warehouses: ${whErr.message}`);
        return;
      }
      setWarehousesError(null);
      const list = (data ?? []) as { id: string; name: string }[];
      setWarehouses(list);
      setWarehouseId((prev) => {
        if (prev && list.some((w) => w.id === prev)) return prev;
        if (defaultWarehouseId && list.some((w) => w.id === defaultWarehouseId)) {
          return defaultWarehouseId;
        }
        return list[0]?.id ?? null;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, organizationId, defaultWarehouseId]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/* Reset-by-remount: keying the content on the open/closed flip clears
          the serial draft / inline error / busy flag on every open — the reset
          the old visible-effect performed. */}
      <AddSerialsModalContent
        key={String(visible)}
        itemId={itemId}
        organizationId={organizationId}
        warehouses={warehouses}
        warehouseId={warehouseId}
        setWarehouseId={setWarehouseId}
        warehousesError={warehousesError}
        onClose={onClose}
        onAdded={onAdded}
      />
    </Modal>
  );
}

function AddSerialsModalContent({
  itemId,
  organizationId,
  warehouses,
  warehouseId,
  setWarehouseId,
  warehousesError,
  onClose,
  onAdded,
}: {
  itemId: string;
  organizationId: string;
  warehouses: { id: string; name: string }[] | null;
  warehouseId: string | null;
  setWarehouseId: (id: string) => void;
  warehousesError: string | null;
  onClose: () => void;
  onAdded: (added: number) => void;
}) {
  const { c, mode } = useTheme();
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  // One inline error slot, exactly as before the split: a submit error (fresh
  // per open) or the warehouse-load error from the wrapper's fetch.
  const error = submitError ?? warehousesError;

  const parsed = React.useMemo(() => validateSerialInput(text), [text]);
  const canSubmit =
    !busy && parsed.serials.length > 0 && parsed.errors.length === 0 && !!warehouseId;

  async function submit() {
    if (!canSubmit || !warehouseId) return;
    setBusy(true);
    setSubmitError(null);
    const { error: insErr } = await supabase.from('serial_registry').insert(
      parsed.serials.map((serial_number) => ({
        organization_id: organizationId,
        item_id: itemId,
        serial_number,
        warehouse_id: warehouseId,
        current_status: 'available',
        receipt_line_id: null,
      })),
    );
    setBusy(false);
    if (insErr) {
      if (insErr.code === '23505') {
        const dup = duplicateSerialFromDbError(insErr.details ?? insErr.message);
        setSubmitError(
          dup
            ? `Serial ${dup} already exists for this item. Remove it and try again.`
            : 'One of these serials already exists for this item.',
        );
      } else {
        setSubmitError(insErr.message);
      }
      return;
    }
    onAdded(parsed.serials.length);
  }

  return (
    <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <Pressable
          onPress={onClose}
          style={{
            flex: 1,
            justifyContent: 'flex-end',
            backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)',
          }}
        >
          <Pressable
            onPress={() => undefined}
            style={[
              {
                backgroundColor: c.card,
                borderTopLeftRadius: 24,
                borderTopRightRadius: 24,
                paddingTop: 12,
                paddingBottom: 36,
                paddingHorizontal: 22,
              },
              SHADOW.sheet,
            ]}
          >
            <View style={{ alignItems: 'center', marginBottom: 18 }}>
              <View
                style={{
                  width: 36,
                  height: 5,
                  borderRadius: 100,
                  backgroundColor:
                    mode === 'dark' ? 'rgba(250,250,247,0.22)' : 'rgba(14,15,13,0.18)',
                }}
              />
            </View>
            <Eyebrow>ADD SERIALS</Eyebrow>

            <View style={{ marginTop: 16, gap: 14 }}>
              <View style={{ gap: 6 }}>
                <Mono size={10} tracking={0.12} upper color={c.ink4}>
                  SERIAL NUMBERS (ONE PER LINE)
                </Mono>
                <TextInput
                  value={text}
                  onChangeText={setText}
                  placeholder={'SN-0001\nSN-0002'}
                  placeholderTextColor={c.ink5}
                  multiline
                  autoCapitalize="characters"
                  autoCorrect={false}
                  style={{
                    fontFamily: FONT.mono,
                    fontSize: 13,
                    minHeight: 110,
                    maxHeight: 180,
                    paddingHorizontal: 14,
                    paddingTop: 12,
                    paddingBottom: 12,
                    borderWidth: 1,
                    borderColor: c.hair,
                    borderRadius: 8,
                    color: c.ink,
                    backgroundColor: c.paper2,
                    textAlignVertical: 'top',
                  }}
                />
                {parsed.serials.length > 0 && parsed.errors.length === 0 ? (
                  <Mono size={10} tracking={0.04} color={c.ink4}>
                    {parsed.serials.length} {parsed.serials.length === 1 ? 'serial' : 'serials'}{' '}
                    ready
                  </Mono>
                ) : null}
                {parsed.errors.map((e) => (
                  <Body key={e} size={12.5} color={ACCENT.crit}>
                    {e}
                  </Body>
                ))}
              </View>

              <View style={{ gap: 6 }}>
                <Mono size={10} tracking={0.12} upper color={c.ink4}>
                  WAREHOUSE
                </Mono>
                {warehouses === null ? (
                  <ActivityIndicator color={c.ink} style={{ alignSelf: 'flex-start' }} />
                ) : warehouses.length === 0 ? (
                  <Body size={12.5} color={ACCENT.crit}>
                    No active warehouses — create one before adding serials.
                  </Body>
                ) : (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    {warehouses.map((w) => {
                      const selected = w.id === warehouseId;
                      return (
                        <Pressable
                          key={w.id}
                          onPress={() => setWarehouseId(w.id)}
                          accessibilityRole="button"
                          accessibilityLabel={`Warehouse ${w.name}`}
                          style={({ pressed }) => ({
                            paddingHorizontal: 12,
                            height: 34,
                            borderRadius: 8,
                            borderWidth: 1,
                            borderColor: selected ? c.ink : c.hair,
                            backgroundColor: selected ? c.ink : c.card,
                            alignItems: 'center',
                            justifyContent: 'center',
                            opacity: pressed ? 0.85 : 1,
                          })}
                        >
                          <Mono
                            size={11.5}
                            tracking={-0.012}
                            color={selected ? c.paper : c.ink}
                            style={{ fontFamily: FONT.display }}
                          >
                            {w.name}
                          </Mono>
                        </Pressable>
                      );
                    })}
                  </View>
                )}
              </View>

              {error ? (
                <Body size={12.5} color={ACCENT.crit}>
                  {error}
                </Body>
              ) : null}
            </View>

            <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
              <View style={{ flex: 1 }}>
                <Button block variant="ghost" onPress={onClose}>
                  Cancel
                </Button>
              </View>
              <View style={{ flex: 1 }}>
                <Button block onPress={() => void submit()} disabled={!canSubmit}>
                  {busy ? 'Adding…' : 'Add serials'}
                </Button>
              </View>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topbar: {
    paddingHorizontal: 12,
    paddingTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  hero: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
  },
  tabsRow: {
    flexDirection: 'row',
    marginTop: 16,
    marginBottom: 16,
    marginHorizontal: 20,
  },
  quickAdjust: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 16,
  },
  // Dynamic Type: minHeight so the strip grows with its labels (+1 / −1 /
  // Adjust) instead of clipping them; the labels themselves are capped at the
  // control ceiling in QuickBtn.
  quickBtn: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
