// Pure filter model for the Staging worklist table.
//
// The Staging page loads the whole put-away worklist for the org (server-
// filtered only by the ?type= tab and the active warehouse). Everything in
// this file runs CLIENT-SIDE over those already-loaded rows: search, the PO
// picker, the Staged/Unplaced source split and the Recent/Stale age split.
// Nothing here talks to the server, and nothing here ever moves stock — the
// output of `filterStagingRows` is a subset of the SAME row objects it was
// handed, so every downstream field (bookStorage, warehouseId,
// sourceLocationId, quantity, itemType) reaches the Place dialogs intact.
//
// Kept UI-free so the semantics are unit-testable in isolation
// (staging-filters.test.ts) and so the table component stays readable.

/**
 * The ONE staleness rule. The Stale badge in the Age column and the Age
 * filter's Recent/Stale buckets both read this constant, so they can never
 * disagree about which rows are stale.
 */
export const STALE_THRESHOLD_DAYS = 7;

/**
 * Sentinel for the "No PO / Unattributed" option in the PO picker: rows whose
 * `sourcePoNumber` is null (unplaced stock, manual adds, reversed receipts).
 * Chosen so it can never collide with a real PO number.
 */
export const NO_PO = '__none__';

export type StagingSourceFilter = 'all' | 'staging' | 'unplaced';
export type StagingAgeFilter = 'all' | 'recent' | 'stale';

export interface StagingFilters {
  /** Free-text search; trimmed + lower-cased at match time, never a regex. */
  query: string;
  /** A PO number to match (normalised comparison), NO_PO for unattributed rows, or null for all. */
  poNumber: string | null | typeof NO_PO;
  source: StagingSourceFilter;
  age: StagingAgeFilter;
}

export const EMPTY_STAGING_FILTERS: StagingFilters = {
  query: '',
  poNumber: null,
  source: 'all',
  age: 'all',
};

/** The minimum row shape the filters read. The table's StagedRow satisfies it. */
export interface StagingFilterableRow {
  name: string;
  sku: string;
  sourcePoNumber: string | null;
  receiptNumber: string | null;
  sourceKind: 'staging' | 'unplaced';
  ageDays: number | null;
  receivedAt: string | null;
  /** ISBN for books (barcode column), UPC/EAN otherwise. Optional so older row shapes still filter. */
  barcode?: string | null;
  modelNumber?: string | null;
}

// ── Normalisation ───────────────────────────────────────────────────────────

/** Trim + lower-case. Applied to BOTH sides of every text comparison. */
export function normalizeStagingText(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/** True when the row's PO number and `poNumber` denote the same PO ("po-1092" == " PO-1092 "). */
export function isSamePoNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeStagingText(a);
  const nb = normalizeStagingText(b);
  return na !== '' && na === nb;
}

// ── Age buckets ─────────────────────────────────────────────────────────────

/** Strictly older than the threshold: 8d is stale, 7d is not. Null age is never stale. */
export function isStaleAge(ageDays: number | null): boolean {
  return ageDays !== null && ageDays > STALE_THRESHOLD_DAYS;
}

/** At or under the threshold: 0d..7d. Null age is never recent either — it
 *  belongs to neither bucket and only shows under Age = All. */
export function isRecentAge(ageDays: number | null): boolean {
  return ageDays !== null && ageDays <= STALE_THRESHOLD_DAYS;
}

// ── Individual predicates ───────────────────────────────────────────────────

/** Case-insensitive, trimmed SUBSTRING match over the row's searchable text
 *  fields. An empty/whitespace query matches every row. Plain `includes`,
 *  never a RegExp built from user input. */
export function matchesStagingSearch(row: StagingFilterableRow, query: string): boolean {
  const q = normalizeStagingText(query);
  if (q === '') return true;
  const haystacks: Array<string | null | undefined> = [
    row.name,
    row.sku,
    row.sourcePoNumber,
    row.receiptNumber,
    row.barcode,
    row.modelNumber,
  ];
  return haystacks.some((h) => normalizeStagingText(h).includes(q));
}

export function matchesStagingPo(
  row: StagingFilterableRow,
  poNumber: StagingFilters['poNumber'],
): boolean {
  if (poNumber === null) return true;
  // Same "no PO" rule buildPoOptions counts by: null OR blank.
  if (poNumber === NO_PO) return normalizeStagingText(row.sourcePoNumber) === '';
  return isSamePoNumber(row.sourcePoNumber, poNumber);
}

export function matchesStagingSource(
  row: StagingFilterableRow,
  source: StagingSourceFilter,
): boolean {
  return source === 'all' || row.sourceKind === source;
}

export function matchesStagingAge(row: StagingFilterableRow, age: StagingAgeFilter): boolean {
  if (age === 'all') return true;
  return age === 'stale' ? isStaleAge(row.ageDays) : isRecentAge(row.ageDays);
}

// ── Composition ─────────────────────────────────────────────────────────────

/**
 * The canonical AND of every client-side filter. Returns the ORIGINAL row
 * objects (same references, all fields intact) in their original order. The
 * item-type tab is NOT applied here — it stays a server/URL filter, so the
 * `rows` handed in are already the right type.
 */
export function filterStagingRows<T extends StagingFilterableRow>(
  rows: readonly T[],
  filters: StagingFilters,
): T[] {
  return rows.filter(
    (row) =>
      matchesStagingSearch(row, filters.query) &&
      matchesStagingPo(row, filters.poNumber) &&
      matchesStagingSource(row, filters.source) &&
      matchesStagingAge(row, filters.age),
  );
}

export function hasActiveStagingFilters(filters: StagingFilters): boolean {
  return (
    normalizeStagingText(filters.query) !== '' ||
    filters.poNumber !== null ||
    filters.source !== 'all' ||
    filters.age !== 'all'
  );
}

// ── PO picker options ───────────────────────────────────────────────────────

export interface StagingPoOption {
  /** The PO number as first seen on a row (trimmed). Used as the filter value. */
  value: string;
  /** How many loaded rows carry this PO. */
  count: number;
  /** The newest receivedAt among those rows, for the most-recent-first sort. */
  latestReceivedAt: string | null;
}

export interface StagingPoOptions {
  /** One entry per distinct PO (normalised), most recently received first, then by PO number. */
  options: StagingPoOption[];
  /** Rows with no PO attribution (sourcePoNumber null/blank). > 0 unlocks the No PO option. */
  unattributedCount: number;
}

/**
 * Derives the PO picker's options from the loaded rows — never from the PO
 * table. Grouped by NORMALISED PO number so "po-100" and "PO-100" are one
 * option, sorted by the most recent receivedAt (rows without a date sort
 * last), then by PO number for a stable order among ties.
 */
export function buildPoOptions(rows: readonly StagingFilterableRow[]): StagingPoOptions {
  const byKey = new Map<string, StagingPoOption>();
  let unattributedCount = 0;
  for (const row of rows) {
    const key = normalizeStagingText(row.sourcePoNumber);
    if (key === '') {
      unattributedCount += 1;
      continue;
    }
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      if (isNewer(row.receivedAt, existing.latestReceivedAt)) {
        existing.latestReceivedAt = row.receivedAt;
      }
    } else {
      byKey.set(key, {
        value: (row.sourcePoNumber ?? '').trim(),
        count: 1,
        latestReceivedAt: row.receivedAt ?? null,
      });
    }
  }
  const options = [...byKey.values()].sort((a, b) => {
    const ta = toTime(a.latestReceivedAt);
    const tb = toTime(b.latestReceivedAt);
    if (ta !== tb) return tb - ta; // newest first; missing dates (-Infinity) last
    return a.value.localeCompare(b.value, undefined, { numeric: true, sensitivity: 'base' });
  });
  return { options, unattributedCount };
}

function toTime(iso: string | null): number {
  if (!iso) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

function isNewer(candidate: string | null, current: string | null): boolean {
  return toTime(candidate) > toTime(current);
}

// ── Count label ─────────────────────────────────────────────────────────────

/** "142 items" unfiltered; "18 of 142 items" when a filter is hiding rows.
 *  The noun follows the TOTAL ("1 of 1 item"), so it reads as "of the N items". */
export function formatStagingCount(visible: number, total: number): string {
  const noun = total === 1 ? 'item' : 'items';
  return visible === total ? `${total} ${noun}` : `${visible} of ${total} ${noun}`;
}
