/**
 * Staging put-away worklist — the PURE half of the native Staging screen.
 *
 * Warehouse staff do put-away on their feet, so the phone needs the same
 * worklist the web page shows. Both surfaces read the SAME
 * InventoryService.stagedWorklist() (web renders it directly, mobile through
 * GET /api/v1/inventory/staging), so the only thing that could still make the
 * two disagree is the client-side massaging of that payload. That massaging
 * lives here — no React, no Supabase, no expo modules — because apps/mobile has
 * no component-test harness and this is where coverage can actually live. The
 * screen (app/(drawer)/staging.tsx) does nothing but fetch, call into this
 * module, and paint.
 *
 * BINDING RULE for everything below: the phone renders the SAME WORDS the web
 * staging table renders for the same row. Every formatter here is a deliberate
 * mirror of apps/web/src/components/inventory/staging-table.tsx (SourceCell,
 * AgeBadge, the received-date cell, the warehouse cell, the source-kind badge)
 * — the owner compares a phone against a browser row by row, so no cell may
 * invent wording the web table does not use, and that includes the em dash the
 * web table shows for an unknown value.
 */

import type { BookStorageInfo } from '@stockpilot/core';

// ── Row shape ──────────────────────────────────────────────────────────────

/**
 * Mirror of the web service's staged-worklist row. Deliberately re-declared
 * rather than imported: apps/mobile cannot import from apps/web, and the wire
 * format is the contract between them. Field names/semantics must stay 1:1
 * with the return type of stagedWorklist() in
 * apps/web/src/server/services/inventory.ts.
 */
export interface StagingWorklistRow {
  itemId: string;
  name: string;
  sku: string;
  itemType: string;
  warehouseId: string | null;
  sourceLocationId: string;
  /** 'staging' = arrived from a PO receipt; 'unplaced' = on hand, never racked. */
  sourceKind: 'staging' | 'unplaced';
  quantity: number;
  sourceReceiptId: string | null;
  sourcePoNumber: string | null;
  receiptNumber: string | null;
  receivedAt: string | null;
  ageDays: number | null;
  /**
   * A BOOK's recorded rack/crate summary (readBookStorage on the item), or
   * null for a non-book. The endpoint has always sent it; this parser used to
   * DROP it, so the put-away sheet opened knowing nothing about where the book
   * already lives — and offered the bare rack, which clears the crate (Maus I,
   * 2026-08-17). It now seeds the sheet's four destination fields.
   */
  bookStorage: BookStorageInfo | null;
}

export interface StagingWorklist {
  rows: StagingWorklistRow[];
  /** Server's own `can(ctx, 'stock:transfer')`. Gates the Place control so a
   *  user is never shown a button whose action will always 403. */
  canPlace: boolean;
}

/** The web table's stand-in for an unknown value. Same glyph, same meaning. */
export const STAGING_EMPTY = '—';

// ── Filters ────────────────────────────────────────────────────────────────

export type StagingTypeFilter = 'all' | 'book' | 'non-book';

/** Same three buckets, same labels, same order as the web table's toolbar.
 *  ('non-book' is labelled "Items" on web — keep the wording identical.) */
export const STAGING_TYPE_OPTIONS: readonly {
  value: StagingTypeFilter;
  label: string;
}[] = [
  { value: 'all', label: 'All' },
  { value: 'book', label: 'Books' },
  { value: 'non-book', label: 'Items' },
];

/**
 * The Bearer endpoint path for a filter, narrowed to the active warehouse.
 *
 * `all` sends NO type param — the route treats an absent `type` as "both", and
 * sending `type=all` would fail its zod enum and 400 the whole screen.
 *
 * The warehouse is explicit because the web page reads it from the
 * active-warehouse COOKIE (getActiveWarehouseFilter) and mobile has no cookie.
 * Omitting it would leave the phone showing every warehouse while the browser
 * shows one — two surfaces disagreeing about the same worklist, which is the
 * class of bug this whole screen exists to end. "All warehouses" is null in the
 * drawer switcher and must stay absent here: the route's zod wants a UUID, so
 * an empty value 400s instead of widening.
 */
export function stagingWorklistPath(
  filter: StagingTypeFilter,
  warehouseId?: string | null,
): string {
  // Built by hand, NOT with URLSearchParams: React Native's polyfill
  // (Libraries/Blob/URLSearchParams.js) throws 'not implemented' from .set(),
  // and it would only throw on a device — vitest runs on node, where the real
  // class exists, so the crash would ship green. No other mobile module uses it
  // either.
  const params: string[] = [];
  if (filter !== 'all') params.push(`type=${filter}`);
  const wh = warehouseId?.trim();
  if (wh) params.push(`warehouseId=${encodeURIComponent(wh)}`);
  return params.length > 0
    ? `/api/v1/inventory/staging?${params.join('&')}`
    : '/api/v1/inventory/staging';
}

// ── Age / staleness ────────────────────────────────────────────────────────

/** Same threshold the web staging table uses. Keep the two in lockstep. */
export const STAGING_STALE_THRESHOLD_DAYS = 7;

/** Strictly greater-than, exactly like the web table's `ageDays > 7`. */
export function isStagingStale(ageDays: number | null): boolean {
  return ageDays !== null && ageDays > STAGING_STALE_THRESHOLD_DAYS;
}

/**
 * The Age cell: '3d', or the em dash the web AgeBadge renders when the age is
 * unknown. Never an empty cell — a blank reads as "zero days", which is a
 * different (and wrong) claim than "we don't know when this arrived".
 */
export function stagingAgeLabel(ageDays: number | null): string {
  return ageDays === null ? STAGING_EMPTY : `${ageDays}d`;
}

/** The web AgeBadge's "Stale" chip text, verbatim. */
export const STAGING_STALE_LABEL = 'Stale';

// ── Source PO / receipt ────────────────────────────────────────────────────

/**
 * The "Source PO / receipt" cell, mirroring the web SourceCell exactly:
 * both present → "PO / RECEIPT", one present → that one alone, neither → em
 * dash. The separator is a spaced slash because that is what web renders.
 */
export function stagingSourceLabel(
  poNumber: string | null,
  receiptNumber: string | null,
): string {
  if (!poNumber && !receiptNumber) return STAGING_EMPTY;
  if (poNumber && receiptNumber) return `${poNumber} / ${receiptNumber}`;
  return (poNumber ?? receiptNumber) as string;
}

/**
 * The staged/unplaced badge. Web prints the raw `sourceKind` under a CSS
 * `capitalize`, so the words on screen are "Staging" and "Unplaced" — not
 * "STAGED", which is a third word for a state neither surface names that way.
 */
export function stagingSourceKindLabel(sourceKind: 'staging' | 'unplaced'): string {
  return sourceKind === 'unplaced' ? 'Unplaced' : 'Staging';
}

// ── Received date ──────────────────────────────────────────────────────────

type RelUnit = 'year' | 'month' | 'week' | 'day' | 'hour' | 'minute' | 'second';

/** Same ladder, same second-counts, same order as the web formatRelative(). */
const REL_UNITS: readonly (readonly [RelUnit, number])[] = [
  ['year', 60 * 60 * 24 * 365],
  ['month', 60 * 60 * 24 * 30],
  ['week', 60 * 60 * 24 * 7],
  ['day', 60 * 60 * 24],
  ['hour', 60 * 60],
  ['minute', 60],
  ['second', 1],
];

/**
 * The words Intl.RelativeTimeFormat('en', { numeric: 'auto' }) substitutes for
 * a plain "N units ago" — the only place where 'auto' differs from 'always'.
 * Hand-tabled because Hermes does not ship RelativeTimeFormat (see the note in
 * item-activity.ts), so the phone cannot call the same API the browser does and
 * must reproduce its output. staging-worklist.test.ts pins every one of these
 * against the real Intl implementation under node.
 */
const REL_SPECIAL: Readonly<Record<RelUnit, Readonly<Record<string, string>>>> = {
  year: { '-1': 'last year', '0': 'this year', '1': 'next year' },
  month: { '-1': 'last month', '0': 'this month', '1': 'next month' },
  week: { '-1': 'last week', '0': 'this week', '1': 'next week' },
  day: { '-1': 'yesterday', '0': 'today', '1': 'tomorrow' },
  hour: { '0': 'this hour' },
  minute: { '0': 'this minute' },
  second: { '0': 'now' },
};

/**
 * The "Received" cell: the same relative phrase the web table renders through
 * formatRelative(), or the em dash it renders when the row has no received
 * date (a holding that never came from a posted receipt).
 */
export function stagingReceivedLabel(
  receivedAt: string | null,
  now: Date = new Date(),
): string {
  if (!receivedAt) return STAGING_EMPTY;
  const ms = new Date(receivedAt).getTime();
  // An unparseable timestamp is not a duration. Web would throw on it; the
  // phone must not invent "now" out of it either.
  if (Number.isNaN(ms)) return STAGING_EMPTY;

  const diff = (ms - now.getTime()) / 1000;
  for (const [unit, secs] of REL_UNITS) {
    if (Math.abs(diff) < secs && unit !== 'second') continue;
    const value = Math.round(diff / secs);
    const special = REL_SPECIAL[unit][String(value)];
    if (special) return special;
    const n = Math.abs(value);
    const noun = `${unit}${n === 1 ? '' : 's'}`;
    return value < 0 ? `${n} ${noun} ago` : `in ${n} ${noun}`;
  }
  return STAGING_EMPTY;
}

// ── Warehouse ──────────────────────────────────────────────────────────────

/**
 * The Warehouse cell. Same three cases the web table has: the resolved name; a
 * truncated id for a warehouse missing from the name map (archived/inactive);
 * the em dash for a holding with no warehouse at all.
 */
export function stagingWarehouseLabel(
  warehouseId: string | null,
  warehouseNames: Readonly<Record<string, string>>,
): string {
  if (!warehouseId) return STAGING_EMPTY;
  const name = warehouseNames[warehouseId];
  if (name) return name;
  return `${warehouseId.slice(0, 8)}…`;
}

/** A warehouse row as the phone reads it — id, name, and the status that
 *  decides whether it is a NAME or a truncated id on screen. */
export interface StagingWarehouseOption {
  id: string;
  name: string;
  status?: string | null;
}

/**
 * warehouseId → name, built from the SAME population web builds it from:
 * WarehousesService.listNames(), which selects `status = 'active'` only.
 *
 * The phone's drawer switcher list is deliberately wider — it drops archived
 * warehouses but keeps INACTIVE ones, so you can still switch to a warehouse
 * that is temporarily not operating. Feeding that wider list into this map made
 * a staged row in an inactive warehouse print a name on the phone and a
 * truncated UUID in the browser: two surfaces describing the same row
 * differently, which is the one thing this screen exists to prevent. So the map
 * is narrowed here rather than at the call site, where the difference is
 * invisible.
 */
export function stagingWarehouseNameMap(
  warehouses: readonly StagingWarehouseOption[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const w of warehouses) {
    if (w.status !== 'active') continue;
    if (!w.id) continue;
    map[w.id] = w.name;
  }
  return map;
}

// ── Counts ─────────────────────────────────────────────────────────────────

/** The toolbar's "12 items" / "1 item" count, pluralised like web. */
export function stagingCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}

// ── Row identity + placement ───────────────────────────────────────────────

/**
 * Per-row identity. Neither field is unique alone: one item can hold stock in
 * BOTH staging and unplaced (two rows, same itemId) and one staging location
 * holds many items (many rows, same sourceLocationId). Same composite the web
 * table keys on.
 */
export function stagingRowKey(r: {
  itemId: string;
  sourceLocationId: string;
}): string {
  return `${r.itemId}::${r.sourceLocationId}`;
}

/**
 * Can this specific row be placed? Mirrors the web table: the permission gate
 * AND a real warehouse (the destination racks are scoped to the source
 * holding's warehouse, so a holding with no warehouse has nowhere to go).
 * Cosmetic only — /api/v1/items/[id]/transfer re-asserts 'stock:transfer'.
 */
export function canPlaceStagingRow(
  row: { warehouseId: string | null },
  canPlace: boolean,
): boolean {
  return canPlace && row.warehouseId !== null;
}

/** The web table's tooltip on the disabled Place button, verbatim. */
export const STAGING_NO_WAREHOUSE_REASON = 'No warehouse — cannot place';

/**
 * Why this row's Place control is disabled, or null when there is nothing to
 * say. Mirrors the web table exactly:
 *
 *  • no 'stock:transfer' → web renders NO Actions column at all, so the phone
 *    renders no control either (null);
 *  • permitted but the row has no warehouse → web still renders the button,
 *    disabled, carrying this reason. The phone previously rendered nothing,
 *    which reads as "this row is different somehow" rather than "this row
 *    cannot be placed, and here is why".
 */
export function stagingPlaceDisabledReason(
  row: { warehouseId: string | null },
  canPlace: boolean,
): string | null {
  if (!canPlace) return null;
  return row.warehouseId === null ? STAGING_NO_WAREHOUSE_REASON : null;
}

// ── Wire parsing ───────────────────────────────────────────────────────────

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asNullableString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function asNullableNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** One wire row → a typed row, or null when it is too malformed to place. */
function normalizeRow(raw: unknown): StagingWorklistRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const itemId = asNullableString(r.itemId);
  const sourceLocationId = asNullableString(r.sourceLocationId);
  // Without these two there is no identity and no Place action — a row we
  // could neither key nor act on is worse than no row.
  if (!itemId || !sourceLocationId) return null;

  return {
    itemId,
    name: asString(r.name, 'Untitled item'),
    sku: asString(r.sku),
    itemType: asString(r.itemType),
    warehouseId: asNullableString(r.warehouseId),
    sourceLocationId,
    sourceKind: r.sourceKind === 'unplaced' ? 'unplaced' : 'staging',
    quantity: asNumber(r.quantity),
    sourceReceiptId: asNullableString(r.sourceReceiptId),
    sourcePoNumber: asNullableString(r.sourcePoNumber),
    receiptNumber: asNullableString(r.receiptNumber),
    receivedAt: asNullableString(r.receivedAt),
    ageDays: asNullableNumber(r.ageDays),
    bookStorage: normalizeBookStorage(r.bookStorage),
  };
}

/**
 * The wire `bookStorage` → a BookStorageInfo, or null. Field by field through
 * the same nullable-string reader as the rest of the row, so a malformed
 * payload degrades to "nothing recorded" rather than seeding garbage into the
 * destination fields.
 */
function normalizeBookStorage(raw: unknown): BookStorageInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  return {
    rackNumber: asNullableString(b.rackNumber),
    rackRow: asNullableString(b.rackRow),
    crateColor: asNullableString(b.crateColor),
    crateNumber: asNullableString(b.crateNumber),
    grade: asNullableString(b.grade),
    rackLabel: asNullableString(b.rackLabel),
    crateLabel: asNullableString(b.crateLabel),
  };
}

/**
 * Parse GET /api/v1/inventory/staging. Fail-soft in the same spirit as the
 * service: a garbage payload yields an empty, placeable-by-nobody worklist
 * instead of throwing the screen into an error state.
 */
export function parseStagingWorklist(raw: unknown): StagingWorklist {
  if (!raw || typeof raw !== 'object') return { rows: [], canPlace: false };
  const body = raw as Record<string, unknown>;
  const rows = Array.isArray(body.rows)
    ? body.rows
        .map(normalizeRow)
        .filter((r): r is StagingWorklistRow => r !== null)
    : [];
  return { rows, canPlace: body.canPlace === true };
}
