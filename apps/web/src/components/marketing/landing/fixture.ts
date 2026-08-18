/**
 * The landing page's single source of operational truth.
 *
 * Every number rendered anywhere on `/` comes from here, so the page
 * reconciles: if the hero says 238 received, the staging chapter cannot say
 * 240. `fixture.test.ts` asserts the arithmetic rather than trusting it.
 *
 * The shape of this data is not decorative. A warehouse buyer reads tables for
 * a living and detects regularity instantly, so the fixture deliberately
 * carries mixed identifier formats, non-round quantities, a truncated title,
 * and exception rows. Every exception below is a state StockPilot genuinely
 * produces — nothing is invented for drama, because the first prospect who logs
 * in would catch it.
 *
 * DOMAIN RULES THIS FILE ENCODES (breaking one misrepresents the product):
 *  1. Crate identity is (colour, number, rack, row). `gray BIN` alone is not an
 *     identity — the same name exists on five racks in real data.
 *  2. A crate sits ON a rack. It is not an alternative to one.
 *  3. Rack position is OPTIONAL — `Blue Shelf` holds stock with rack NULL.
 *  4. Over-receipt is ALLOWED and recorded, not blocked (line A: 52 of 48).
 *  5. Cycle-count variance is measured AT COUNT TIME; expected is re-stamped.
 *  6. Transfers move only PLACED stock.
 *  7. Books are an item_type, not a category. The sports vertical is a
 *     group/variant model.
 *  8. A PO's bill-to charter is independent of the items' ownership charter.
 *
 * Vendor names are invented. Naming a real publisher or distributor would imply
 * a commercial relationship that does not exist.
 */

/** Crate colour registry — mirrors packages/core/src/inventory/crate-colors.ts. */
export const CRATE_COLORS = {
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#eab308',
  green: '#22c55e',
  blue: '#3b82f6',
  purple: '#a855f7',
  pink: '#ec4899',
  black: '#27272a',
  white: '#f4f4f5',
  gray: '#9ca3af',
} as const;

export type CrateColor = keyof typeof CRATE_COLORS;

export interface Crate {
  color: CrateColor;
  number: string;
  /** Rack the crate sits on. NULL is legal — see `Blue Shelf`. */
  rack: string | null;
  row: string | null;
  /** Free-standing shelf name used when the crate has no rack coordinate. */
  shelf?: string;
}

/**
 * Human crate label — `formatCrateLabel()` in book-storage.ts.
 * NOT the dedupe key, which is `Blue #42` (`formatCrateLocationName()`).
 * The two spellings must never be mixed.
 */
export function crateLabel(c: Crate): string {
  const name = `${c.color.charAt(0).toUpperCase()}${c.color.slice(1)} ${c.number}`;
  if (c.rack) return `${name} · Rack ${c.rack}${c.row ? ` · Row ${c.row}` : ''}`;
  return `${name} · ${c.shelf ?? 'Unracked'}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The purchase order the whole story follows
// ─────────────────────────────────────────────────────────────────────────────

export interface PoLine {
  sku: string;
  title: string;
  /** Long titles truncate in the real table; one line here must. */
  truncates?: boolean;
  isbn?: string;
  grade?: string;
  ordered: number;
  received: number;
  unitCost: number;
}

export const PO = {
  number: 'PO-000412',
  supplier: 'Meridian Book Supply',
  /** Bill-to charter. Independent of the items' ownership charter (rule 8). */
  billToCharter: 'L4L',
  placed: 'Apr 18',
  expected: 'Apr 30',
  receipt: 'RCPT-0092',
} as const;

export const PO_LINES: PoLine[] = [
  {
    sku: 'TXT-ALG-G9-2026',
    title: 'Algebra I · Grade 9',
    isbn: '978-0-13-468599-1',
    grade: '9',
    ordered: 48,
    // RULE 4 — over-receipt. The dock counted four more than the PO claimed and
    // StockPilot recorded it instead of refusing the receipt.
    received: 52,
    unitCost: 41.5,
  },
  {
    sku: 'TXT-BIO-G10-2026',
    title: 'Biology · Grade 10',
    isbn: '978-0-393-93991-1',
    grade: '10',
    ordered: 30,
    received: 26,
    unitCost: 58.25,
  },
  {
    sku: 'TXT-WHI-G11-2026',
    title: 'World History and the Modern Era · Grade 11',
    truncates: true,
    isbn: '978-1-118-32976-5',
    grade: '11',
    ordered: 42,
    received: 42,
    unitCost: 47.0,
  },
  {
    sku: 'TXT-GEO-G10-2026',
    title: 'Geometry · Grade 10',
    isbn: '978-0-13-484554-8',
    grade: '10',
    ordered: 60,
    received: 60,
    unitCost: 44.75,
  },
  {
    sku: 'TXT-USH-G11-2026',
    title: 'US History · Grade 11',
    isbn: '978-0-19-852345-1',
    grade: '11',
    ordered: 30,
    received: 30,
    unitCost: 52.0,
  },
  {
    sku: 'TXT-ENL-G12-2026',
    title: 'English Literature · Grade 12',
    isbn: '978-0-321-99884-4',
    grade: '12',
    ordered: 30,
    received: 28,
    unitCost: 39.9,
  },
];

export const ORDERED = PO_LINES.reduce((n, l) => n + l.ordered, 0); // 240
export const RECEIVED = PO_LINES.reduce((n, l) => n + l.received, 0); // 238

// ─────────────────────────────────────────────────────────────────────────────
// Placement — where the 238 land
// ─────────────────────────────────────────────────────────────────────────────

export interface Holding {
  sku: string;
  title: string;
  qty: number;
  crate: Crate;
}

/**
 * RULE 1/2/3 all visible at once: two holdings of the SAME sku, one in a crate
 * on Rack 4, one in a crate with no rack at all. Rendering either as a bare
 * crate name would imply a merge that would be a data bug.
 */
/** The holding the cycle count is scoped to. Sits in a crate ON Rack 4. */
export const RACK_HOLDING: Holding = {
  sku: 'TXT-GEO-G10-2026',
  title: 'Geometry · Grade 10',
  qty: 48,
  crate: { color: 'gray', number: '07', rack: '4', row: '2' },
};

/** RULE 3 — the same sku, in a crate with NO rack coordinate at all. */
export const SHELF_HOLDING: Holding = {
  sku: 'TXT-GEO-G10-2026',
  title: 'Geometry · Grade 10',
  qty: 12,
  crate: { color: 'blue', number: '42', rack: null, row: null, shelf: 'Blue Shelf' },
};

export const HOLDINGS: Holding[] = [RACK_HOLDING, SHELF_HOLDING];
export const PLACED = HOLDINGS.reduce((n, h) => n + h.qty, 0);
/** Received but not yet placed. PLACED + AWAITING must equal RECEIVED. */
export const AWAITING = RECEIVED - PLACED;

// ─────────────────────────────────────────────────────────────────────────────
// Staging — what is waiting to be placed
// ─────────────────────────────────────────────────────────────────────────────

export interface StagingRow {
  sku: string;
  title: string;
  qty: number;
  /** `staged` = received from a PO. `unplaced` = on hand but never placed. */
  source: 'staged' | 'unplaced';
  po: string | null;
  receipt: string | null;
  receivedLabel: string;
  ageDays: number;
  warehouse: string;
}

/** Matches STALE_THRESHOLD_DAYS in staging-filters.ts. */
export const STALE_THRESHOLD_DAYS = 7;
export const isStaleAge = (ageDays: number): boolean => ageDays > STALE_THRESHOLD_DAYS;

/**
 * The one exception row. `unplaced` stock that has aged past the threshold — on
 * hand, counted in totals, and unpickable until someone places it.
 */
export const STALE_ROW: StagingRow = {
  sku: 'DEV-CHR-11-EDU',
  title: 'Chromebook 11" (student)',
  qty: 12,
  source: 'unplaced',
  po: null,
  receipt: null,
  receivedLabel: '2 weeks ago',
  ageDays: 11,
  warehouse: 'DC4 Warehouse',
};

export const STAGING: StagingRow[] = [
  ...PO_LINES.map((l, i) => ({
    sku: l.sku,
    title: l.title,
    qty: l.received,
    source: 'staged' as const,
    po: PO.number,
    receipt: PO.receipt,
    receivedLabel: '3 days ago',
    ageDays: 3 + i * 0,
    warehouse: 'DC4 Warehouse',
  })),
  STALE_ROW,
];

// ─────────────────────────────────────────────────────────────────────────────
// Reservation + the count that closes the loop
// ─────────────────────────────────────────────────────────────────────────────

export const RESERVED = 12;
export const AVAILABLE = RECEIVED - RESERVED; // 226

/**
 * RULE 5 — the count is scoped to Rack 4, which holds exactly the 48 Geometry
 * units from HOLDINGS[0]. Expected is re-stamped at count time, which is why a
 * pick landing mid-count cannot double-subtract the variance.
 */
export const COUNT = {
  scope: 'Rack 4',
  expected: 48,
  counted: 45,
  itemsInScope: 6,
  countedLines: 6,
} as const;

export const VARIANCE = COUNT.counted - COUNT.expected; // -3
export const ON_HAND_AFTER_COUNT = RECEIVED + VARIANCE; // 235

/** Signed variance, rendered with an explicit sign as the real app does. */
export const formatSigned = (n: number): string => (n > 0 ? `+${n}` : `${n}`);

// ─────────────────────────────────────────────────────────────────────────────
// The travelling quantity — the spine of the whole page
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The seven console interiors. Lives here rather than in console.tsx so each
 * Stage can carry its own key — index-matching two parallel arrays is exactly
 * how a chapter ends up rendering the wrong surface.
 */
export type StageKey =
  | 'purchase-order'
  | 'receive'
  | 'staging'
  | 'put-away'
  | 'on-hand'
  | 'transfer'
  | 'count';

export interface Stage {
  key: StageKey;
  code: string;
  name: string;
  /** The figure that stands beside this stage in the persistent ledger. */
  figure: string;
  /** One-line operational claim. Never a feature name. */
  claim: string;
  detail: string;
}

export const STAGES: readonly Stage[] = [
  {
    key: 'purchase-order',
    code: '01',
    name: 'Purchase order',
    figure: `${ORDERED} expected`,
    claim: 'The order is a document, not a promise',
    detail: `${PO.number} carries ${PO_LINES.length} lines against ${PO.supplier}. Its bill-to charter is ${PO.billToCharter} — which is not the same field as who ends up owning the stock. StockPilot keeps them separate because in a real district they diverge.`,
  },
  {
    key: 'receive',
    code: '02',
    name: 'Receive',
    figure: `${RECEIVED} received`,
    claim: 'The dock counted 52 against 48 ordered, and we wrote it down',
    detail:
      'Receiving in parts is normal, so each arrival posts its own receipt until the variance reaches zero. An over-receipt is recorded rather than refused — the units are physically on your floor either way, and a system that blocks the receipt just moves the discrepancy somewhere it cannot be audited.',
  },
  {
    key: 'staging',
    code: '03',
    name: 'Staging',
    figure: `${RECEIVED} staged · 1 stale`,
    claim: 'Nothing sits in staging unaccounted for',
    detail: `Received stock lands in Staging with its source PO, its receipt number and its age. It counts toward your totals immediately and cannot be picked until it is placed. One row here has been waiting ${STALE_ROW.ageDays} days and says so.`,
  },
  {
    key: 'put-away',
    code: '04',
    name: 'Put away',
    figure: crateLabel(RACK_HOLDING.crate),
    claim: 'A crate sits on a rack — it is not an alternative to one',
    detail:
      'Placement writes the exact crate the stock went into. Identity is colour plus number plus rack plus row, because the same crate name legitimately exists on several racks. Position is optional: the second holding here sits on a shelf with no rack coordinate at all.',
  },
  {
    key: 'on-hand',
    code: '05',
    name: 'On hand',
    figure: `${RECEIVED} on hand`,
    claim: 'Placed and unplaced are different questions',
    detail:
      'On-hand is the total. Placed is what a picker can actually reach. StockPilot reports both, because the gap between them is where every inventory argument starts.',
  },
  {
    key: 'transfer',
    code: '06',
    name: 'Order / transfer',
    figure: `${RESERVED} reserved · ${AVAILABLE} available`,
    claim: 'A transfer moves only stock that was actually placed',
    detail:
      'A picker claims the list before touching it, so two people cannot work the same pick. Releasing or reassigning is explicit. Reopening a completed pick restores the reservation, not merely the quantity — which is the difference between a correction and a second error.',
  },
  {
    key: 'count',
    code: '07',
    name: 'Count',
    figure: `${formatSigned(VARIANCE)} variance`,
    claim: 'Expected is stamped when the line is counted, not when the count opened',
    detail: `A count scoped to ${COUNT.scope} expected ${COUNT.expected} and found ${COUNT.counted}. Because expected is re-stamped at count time, a pick that lands mid-count is kept rather than subtracted twice. Posting brings on-hand to ${ON_HAND_AFTER_COUNT} and writes an adjustment row naming who counted it.`,
  },
];

/** Hero KPI strip. Reconciles with the rows rendered directly beneath it. */
export const HERO_KPIS = [
  { label: 'On hand', value: String(RECEIVED), foot: `${PLACED} placed · ${AWAITING} awaiting put-away` },
  { label: 'Open PO', value: PO.number, foot: `${PO_LINES.length} lines · ${ORDERED} expected`, mono: true },
  { label: 'Variance', value: formatSigned(VARIANCE), foot: `${COUNT.scope} · counted at ${COUNT.counted}`, alarm: true },
];
