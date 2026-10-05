/**
 * A synthetic Items view shaped like L4L North Region's, plus a small
 * in-memory stand-in for PostgREST that answers the queries the Items list
 * loaders send (server/loaders/inventory-list.ts).
 *
 * WHY IT EXISTS: the Items page paints page 1 from the cached default-view
 * loader and, about half a second later, re-derives it from the full dataset
 * (instant mode). The two must show the same page. Proving that needs both
 * loaders to run against the SAME rows, through their real query code, so the
 * fake evaluates what the code actually asks for: filters (including filters
 * on an embedded table), ordering, the 1000-row cap, ranges, exact counts,
 * head requests and the two embeds the loaders use. Anything it cannot
 * evaluate throws, so a query shape it does not understand fails the test
 * instead of being answered wrongly.
 *
 * THE SHAPE (ranks are the default sort, most recently updated first):
 *   1      Clipboard (CLIP-1)
 *   2, 60  Chromebook 14 (CB-14) on two racks, two charters: a Model B SKU
 *          family whose second row sits deep in the list
 *   3-9    Learning Tee (2026) - XS..3XL, plus rank 90 (- 4XL): a size run
 *          that straddles the 30-row boundary
 *   10     Loose Batteries: blank SKU, no stock, no holding
 *   11     Stapler: one item split across two racks
 *   12     Misc Cables: blank SKU
 *   13-15  PD Shirt - S..L, plus ranks 67, 71, 74
 *   16-17  Women's Polo - S, M, plus 95, 100 (no stock, no rack: "unset"), 110
 *   18     Nike Pegasus 41, size 9, plus rank 115 (size 10): a STORED group
 *          (group_id) whose names carry no size token
 *   19     Men's Polo - XS, plus ranks 40-47: a 9-member run that does not fit
 *          on page 1, so the group-aware page 1 closes at 27 rows
 *   the rest: single "Widget N" rows, on racks, at the site, in Staging, or
 *          with nothing, two of them sharing one updated_at.
 * Photos: rank 1 has a primary and a secondary; rank 4 has two that tie on
 * primary and sort order, so only the id tiebreak picks the one shown.
 * Rows that must NOT reach the default view, each built to change page 1 if a
 * filter were missing: an archived Tee - 5XL and an archived CLIP-1 twin, an
 * awaiting-first-receipt Tee - 6XL and Projector, a discontinued stapler, a
 * book, a rental and a deleted row whose names would join a run, the same SKU
 * in another org, a holding with quantity 0 and a holding filed under another
 * org. `WH_SOUTH` holds a few rows (rank 60 among them) for the warehouse
 * filter.
 */

export const FIXTURE_ORG = '0f000000-0000-4000-8000-000000000001';
export const OTHER_ORG = '0f000000-0000-4000-8000-000000000002';
export const WH_NORTH = '0e000000-0000-4000-8000-000000000001';
export const WH_SOUTH = '0e000000-0000-4000-8000-000000000002';
const CHARTER_A = '0c000000-0000-4000-8000-00000000000a';
const CHARTER_B = '0c000000-0000-4000-8000-00000000000b';
const CHARTER_C = '0c000000-0000-4000-8000-00000000000c';
const CATEGORY_APPAREL = '0d000000-0000-4000-8000-000000000001';
const GROUP_PEGASUS = '0a000000-0000-4000-8000-000000000041';

export type FakeRow = Record<string, unknown>;

export interface FixtureDb {
  tables: Record<string, FakeRow[]>;
}

/** Ranks (default sort) of the rows group-aware page 1 holds, in page order. */
export const EXPECTED_PAGE_ONE_RANKS = [
  1, 2, 60, 3, 4, 5, 6, 7, 8, 9, 90, 10, 11, 12, 13, 14, 15, 67, 71, 74, 16, 17, 95, 100, 110, 18,
  115,
];

/** Rows in the default view (active, not awaiting, product, not rental). */
export const DEFAULT_VIEW_ROWS = 150;

/** A uuid whose sort order is NOT the rank order (ids decide only ties). */
function idFor(prefix: string, n: number): string {
  const scrambled = (Math.imul(n + 17, 2654435761) >>> 0).toString(16).padStart(8, '0');
  return `${scrambled}-${prefix}-4000-8000-${String(n).padStart(12, '0')}`;
}

export function itemIdForRank(rank: number): string {
  return idFor('0001', rank);
}

/** updated_at for a rank: one minute apart, newest first. Same text format on
 *  every row, so text order is time order (as PostgREST's output is). */
function updatedAtForRank(rank: number): string {
  return new Date(Date.UTC(2026, 8, 1, 12, 0, 0) - rank * 60_000).toISOString();
}

interface Holding {
  location: string;
  quantity: number;
  /** Org the holding row is filed under; defaults to the item's. */
  org?: string;
}

interface ItemSpec {
  rank: number;
  name: string;
  sku: string;
  holdings?: Holding[];
  status?: 'active' | 'archived' | 'discontinued';
  awaiting?: boolean;
  itemType?: 'product' | 'book';
  isRental?: boolean;
  deleted?: boolean;
  org?: string;
  warehouse?: string;
  charter?: string | null;
  category?: string | null;
  groupId?: string | null;
  variantSize?: string | null;
  unitCost?: number;
  /** Override updated_at (ties, or rows outside the ranked default view). */
  updatedAt?: string;
  /** `tie`: two photos, neither primary, same sort order: only the id
   *  tiebreak decides which one the list shows. */
  image?: { thumb: boolean; lqip?: boolean; secondary?: boolean; tie?: boolean };
}

const LOCATIONS: FakeRow[] = [
  ...[
    ['1-A', WH_NORTH],
    ['1-B', WH_NORTH],
    ['2-C', WH_SOUTH],
    ['3-B', WH_NORTH],
    ['3-C', WH_NORTH],
    ['4-A', WH_NORTH],
    ['5-A', WH_NORTH],
    ['6-A', WH_NORTH],
    ['7-A', WH_NORTH],
    ['8-A', WH_NORTH],
    ['9-Z', WH_NORTH],
    ['R-1', WH_NORTH],
    ['R-2', WH_NORTH],
    ['R-3', WH_SOUTH],
  ].map(([name, wh]) => ({
    id: `loc-${name}`,
    organization_id: FIXTURE_ORG,
    name,
    kind: 'rack',
    type: null,
    warehouse_id: wh,
    deleted_at: null,
  })),
  // The warehouse's own building: a NULL kind is the Site encoding.
  {
    id: 'loc-DC4',
    organization_id: FIXTURE_ORG,
    name: 'DC4',
    kind: null,
    type: 'warehouse',
    warehouse_id: WH_NORTH,
    deleted_at: null,
  },
  {
    id: 'loc-staging',
    organization_id: FIXTURE_ORG,
    name: 'Staging',
    kind: 'staging',
    type: null,
    warehouse_id: WH_NORTH,
    deleted_at: null,
  },
];

function rack(location: string, quantity: number): Holding {
  return { location: `loc-${location}`, quantity };
}

function itemSpecs(): ItemSpec[] {
  const specs: ItemSpec[] = [];
  const add = (s: ItemSpec) => specs.push(s);

  add({
    rank: 1,
    name: 'Clipboard',
    sku: 'CLIP-1',
    holdings: [rack('1-A', 12)],
    image: { thumb: true, lqip: true, secondary: true },
  });
  add({
    rank: 2,
    name: 'Chromebook 14',
    sku: 'CB-14',
    charter: CHARTER_A,
    holdings: [rack('1-B', 20)],
    image: { thumb: false },
  });
  add({
    rank: 60,
    name: 'Chromebook 14',
    sku: 'CB-14',
    charter: CHARTER_B,
    warehouse: WH_SOUTH,
    holdings: [rack('2-C', 15)],
    image: { thumb: true },
  });
  const tee: Array<[number, string, number]> = [
    [3, 'XS', 7],
    [4, 'S', 15],
    [5, 'M', 111],
    [6, 'L', 53],
    [7, 'XL', 72],
    [8, '2XL', 138],
    [9, '3XL', 139],
    [90, '4XL', 25],
  ];
  for (const [rank, size, qty] of tee) {
    add({
      rank,
      name: `Learning Tee (2026) - ${size}`,
      sku: `TEE-${size}`,
      category: CATEGORY_APPAREL,
      holdings: [rack('5-A', qty)],
      image:
        rank === 3 || rank === 90
          ? { thumb: true, lqip: true }
          : rank === 4
            ? { thumb: true, tie: true }
            : undefined,
    });
  }
  add({ rank: 10, name: 'Loose Batteries', sku: '', holdings: [] });
  add({
    rank: 11,
    name: 'Stapler',
    sku: 'STP-1',
    holdings: [rack('3-B', 4), rack('3-C', 6)],
    image: { thumb: true },
  });
  add({ rank: 12, name: 'Misc Cables', sku: '   ', holdings: [rack('9-Z', 3)] });
  const pd: Array<[number, string, number]> = [
    [13, 'S', 2],
    [14, 'M', 2],
    [15, 'L', 9],
    [67, 'XL', 3],
    [71, '2XL', 4],
    [74, '3XL', 2],
  ];
  for (const [rank, size, qty] of pd) {
    add({ rank, name: `PD Shirt - ${size}`, sku: `PD-${size}`, holdings: [rack('7-A', qty)] });
  }
  const wp: Array<[number, string, number]> = [
    [16, 'S', 59],
    [17, 'M', 16],
    [95, 'L', 20],
    [100, 'XL', 0],
    [110, '2XL', 21],
  ];
  for (const [rank, size, qty] of wp) {
    add({
      rank,
      name: `Women's Polo - ${size}`,
      sku: `WP-${size}`,
      // Rank 100 holds nothing: no holding row at all, so it has no rack.
      holdings: qty > 0 ? [rack('8-A', qty)] : [],
    });
  }
  add({
    rank: 18,
    name: 'Nike Pegasus 41',
    sku: 'PEG-9',
    groupId: GROUP_PEGASUS,
    variantSize: '9',
    holdings: [rack('6-A', 4)],
    image: { thumb: true },
  });
  add({
    rank: 115,
    name: 'Nike Pegasus 41',
    sku: 'PEG-10',
    groupId: GROUP_PEGASUS,
    variantSize: '10',
    holdings: [rack('6-A', 6)],
  });
  const mp: Array<[number, string]> = [
    [19, 'XS'],
    [40, 'S'],
    [41, 'M'],
    [42, 'L'],
    [43, 'XL'],
    [44, '2XL'],
    [45, '3XL'],
    [46, '4XL'],
    [47, '5XL'],
  ];
  for (const [rank, size] of mp) {
    add({
      rank,
      name: `Men's Polo - ${size}`,
      sku: `MP-${size}`,
      holdings: [rack('4-A', 10 + rank)],
    });
  }

  const taken = new Set(specs.map((s) => s.rank));
  for (let rank = 1; rank <= DEFAULT_VIEW_ROWS; rank++) {
    if (taken.has(rank)) continue;
    let holdings: Holding[];
    if (rank % 11 === 0)
      holdings = []; // no stock anywhere
    else if (rank % 7 === 0)
      holdings = [{ location: 'loc-DC4', quantity: rank }]; // at the site
    else if (rank % 13 === 0) holdings = [{ location: 'loc-staging', quantity: 2 }];
    else holdings = [rack(rank % 3 === 0 ? 'R-2' : 'R-1', rank)];
    add({
      rank,
      name: `Widget ${rank}`,
      sku: `W-${rank}`,
      holdings,
      warehouse: rank >= 140 ? WH_SOUTH : undefined,
      unitCost: rank % 4 === 0 ? 0.25 : 4,
    });
  }
  // Two fillers share one updated_at: the id tiebreak decides their order.
  const tieAt = updatedAtForRank(33);
  for (const s of specs) if (s.rank === 33 || s.rank === 34) s.updatedAt = tieAt;
  // A quantity-0 holding row on a filler (not a placement line) and holdings
  // filed under ANOTHER org (never this org's lines): one on an item with no
  // holding of its own, one beside a real one (a second line if counted).
  const w21 = specs.find((s) => s.rank === 21)!;
  w21.holdings = [...(w21.holdings ?? []), { location: 'loc-R-2', quantity: 0 }];
  const w22 = specs.find((s) => s.rank === 22)!;
  w22.holdings = [...(w22.holdings ?? []), { location: 'loc-R-3', quantity: 5, org: OTHER_ORG }];
  const w23 = specs.find((s) => s.rank === 23)!;
  w23.holdings = [...(w23.holdings ?? []), { location: 'loc-R-3', quantity: 5, org: OTHER_ORG }];

  // ---- rows the default view must exclude ---------------------------------
  const newest = new Date(Date.UTC(2026, 8, 1, 12, 30, 0)).toISOString();
  add({
    rank: 1001,
    name: 'Learning Tee (2026) - 5XL',
    sku: 'TEE-5XL',
    status: 'archived',
    updatedAt: newest,
    holdings: [],
  });
  add({
    rank: 1002,
    name: 'Clipboard',
    sku: 'CLIP-1',
    charter: CHARTER_C,
    status: 'archived',
    updatedAt: newest,
    holdings: [],
  });
  add({
    rank: 1003,
    name: 'Learning Tee (2026) - 6XL',
    sku: 'TEE-6XL',
    awaiting: true,
    updatedAt: newest,
    holdings: [],
  });
  add({
    rank: 1004,
    name: 'Projector',
    sku: 'PROJ-1',
    awaiting: true,
    updatedAt: newest,
    holdings: [],
  });
  add({
    rank: 1005,
    name: 'Old Stapler',
    sku: 'STP-OLD',
    status: 'discontinued',
    updatedAt: newest,
    holdings: [],
  });
  add({
    rank: 1006,
    name: 'Learning Tee (2026) - XXL',
    sku: 'BK-TEE',
    itemType: 'book',
    updatedAt: newest,
    holdings: [],
  });
  add({
    rank: 1007,
    name: "Men's Polo - 6XL",
    sku: 'MP-6XL',
    isRental: true,
    updatedAt: newest,
    holdings: [],
  });
  add({
    rank: 1008,
    name: 'PD Shirt - 4XL',
    sku: 'PD-4XL',
    deleted: true,
    updatedAt: newest,
    holdings: [],
  });
  add({
    rank: 1009,
    name: 'Clipboard',
    sku: 'CLIP-1',
    org: OTHER_ORG,
    updatedAt: newest,
    holdings: [],
  });
  return specs;
}

/** Build the fixture's tables. Fresh objects every call. */
export function buildFirstPageFixture(): FixtureDb {
  const items: FakeRow[] = [];
  const levels: FakeRow[] = [];
  const images: FakeRow[] = [];
  let levelSeq = 0;
  let imageSeq = 0;
  for (const s of itemSpecs()) {
    const id = itemIdForRank(s.rank);
    const org = s.org ?? FIXTURE_ORG;
    const onHand = (s.holdings ?? []).reduce(
      (sum, h) => sum + ((h.org ?? org) === org && h.quantity > 0 ? h.quantity : 0),
      0,
    );
    const updatedAt = s.updatedAt ?? updatedAtForRank(s.rank);
    items.push({
      id,
      organization_id: org,
      sku: s.sku,
      barcode: null,
      model_number: null,
      name: s.name,
      description: null,
      status: s.status ?? 'active',
      quantity_on_hand: onHand,
      reorder_point: s.rank % 5 === 0 ? 5 : 0,
      unit_cost: s.unitCost ?? 2.5,
      retail_price: 5,
      category_id: s.category ?? null,
      supplier_id: null,
      primary_location_id: null,
      warehouse_id: s.warehouse ?? WH_NORTH,
      charter_id: s.charter ?? null,
      tracking_type: 'none',
      item_type: s.itemType ?? 'product',
      is_rental: s.isRental ?? false,
      auto_archived: false,
      awaiting_first_receipt: s.awaiting ?? false,
      custom_fields: null,
      group_id: s.groupId ?? null,
      variant_size: s.variantSize ?? null,
      variant_size_system: null,
      jersey_number: null,
      variant_key: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: updatedAt,
      created_by: null,
      updated_by: null,
      deleted_at: s.deleted ? '2026-08-01T00:00:00.000Z' : null,
    });
    for (const h of s.holdings ?? []) {
      levelSeq += 1;
      levels.push({
        id: idFor('0002', levelSeq),
        organization_id: h.org ?? org,
        item_id: id,
        location_id: h.location,
        quantity: h.quantity,
      });
    }
    if (s.image) {
      const add = (primary: boolean, sortOrder: number) => {
        imageSeq += 1;
        images.push({
          id: idFor('0003', imageSeq),
          organization_id: org,
          item_id: id,
          storage_path: `${org}/items/${id}/${imageSeq}.jpg`,
          thumb_path: s.image!.thumb ? `${org}/items/${id}/${imageSeq}-thumb.webp` : null,
          lqip: s.image!.lqip ? `data:image/webp;base64,lqip${imageSeq}` : null,
          is_primary: primary,
          sort_order: sortOrder,
        });
      };
      if (s.image.tie) {
        add(false, 0);
        add(false, 0);
      } else {
        if (s.image.secondary) add(false, 0);
        add(true, 1);
      }
    }
  }
  return {
    tables: {
      inventory_items: items,
      item_stock_levels: levels,
      item_images: images,
      locations: LOCATIONS,
      categories: [
        {
          id: CATEGORY_APPAREL,
          organization_id: FIXTURE_ORG,
          name: 'Apparel',
          color: null,
          deleted_at: null,
        },
      ],
      charters: [
        {
          id: CHARTER_A,
          organization_id: FIXTURE_ORG,
          name: 'North Charter',
          code: 'NC',
          status: 'active',
        },
        {
          id: CHARTER_B,
          organization_id: FIXTURE_ORG,
          name: 'South Charter',
          code: 'SC',
          status: 'active',
        },
        {
          id: CHARTER_C,
          organization_id: FIXTURE_ORG,
          name: 'Closed Charter',
          code: 'CC',
          status: 'active',
        },
      ],
      tags: [],
      suppliers: [],
      organization_modules: [],
      organizations: [{ id: FIXTURE_ORG, all_modules_comp: false }],
    },
  };
}

/* ---- in-memory PostgREST --------------------------------------------------- */

/** Embeds the loaders use, parent table -> embed name -> how rows relate. */
const RELATIONS: Record<
  string,
  Record<string, { table: string; kind: 'many' | 'one'; parentKey: string; childKey: string }>
> = {
  inventory_items: {
    item_stock_levels: {
      table: 'item_stock_levels',
      kind: 'many',
      parentKey: 'id',
      childKey: 'item_id',
    },
  },
  item_stock_levels: {
    locations: { table: 'locations', kind: 'one', parentKey: 'location_id', childKey: 'id' },
  },
};

type SelectNode =
  | { kind: 'col'; name: string }
  | { kind: 'embed'; name: string; inner: boolean; children: SelectNode[] };

function parseSelect(text: string): SelectNode[] {
  let i = 0;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const ident = () => {
    const start = i;
    while (i < text.length && /[A-Za-z0-9_]/.test(text[i]!)) i++;
    if (start === i) throw new Error(`fake PostgREST: cannot parse select "${text}" at ${i}`);
    return text.slice(start, i);
  };
  const list = (): SelectNode[] => {
    const out: SelectNode[] = [];
    for (;;) {
      ws();
      const name = ident();
      let inner = false;
      if (text[i] === '!') {
        i++;
        const hint = ident();
        if (hint !== 'inner') throw new Error(`fake PostgREST: unsupported embed hint !${hint}`);
        inner = true;
      }
      ws();
      if (text[i] === ':') throw new Error('fake PostgREST: aliases are not supported');
      if (text[i] === '(') {
        i++;
        const children = list();
        ws();
        if (text[i] !== ')') throw new Error(`fake PostgREST: unclosed embed in "${text}"`);
        i++;
        out.push({ kind: 'embed', name, inner, children });
      } else {
        out.push({ kind: 'col', name });
      }
      ws();
      if (text[i] === ',') {
        i++;
        continue;
      }
      return out;
    }
  };
  const nodes = list();
  ws();
  if (i !== text.length) throw new Error(`fake PostgREST: trailing text in select "${text}"`);
  return nodes;
}

type FilterOp = 'eq' | 'neq' | 'is' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';

interface Filter {
  /** [column] for the main table, [embed, column] for an embedded one. */
  path: string[];
  op: FilterOp;
  value: unknown;
}

/** What one awaited query asked for, as the fake saw it. */
export interface ExecutedQuery {
  table: string;
  select: string;
  count: 'exact' | null;
  head: boolean;
  filters: Filter[];
  orders: Array<{ col: string; ascending: boolean }>;
  range: [number, number] | null;
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return (a as number | string) < (b as number | string) ? -1 : 1;
}

function matches(row: FakeRow, f: Filter, col: string): boolean {
  if (!(col in row)) throw new Error(`fake PostgREST: column "${col}" does not exist`);
  const v = row[col];
  switch (f.op) {
    case 'eq':
      return v === f.value;
    case 'neq':
      return v !== f.value;
    case 'is':
      return (v ?? null) === f.value;
    case 'gt':
      return v !== null && v !== undefined && compare(v, f.value) > 0;
    case 'gte':
      return v !== null && v !== undefined && compare(v, f.value) >= 0;
    case 'lt':
      return v !== null && v !== undefined && compare(v, f.value) < 0;
    case 'lte':
      return v !== null && v !== undefined && compare(v, f.value) <= 0;
    case 'in':
      return (f.value as unknown[]).includes(v);
  }
}

const MAX_ROWS = 1000;

function project(
  db: FixtureDb,
  table: string,
  row: FakeRow,
  nodes: SelectNode[],
  filters: Filter[],
): FakeRow | null {
  const out: FakeRow = {};
  for (const node of nodes) {
    if (node.kind === 'col') {
      if (!(node.name in row)) {
        throw new Error(`fake PostgREST: column ${table}.${node.name} does not exist`);
      }
      out[node.name] = row[node.name];
      continue;
    }
    const rel = RELATIONS[table]?.[node.name];
    if (!rel) throw new Error(`fake PostgREST: no relation ${table} -> ${node.name}`);
    const embedFilters = filters.filter((f) => f.path.length === 2 && f.path[0] === node.name);
    const children = (db.tables[rel.table] ?? [])
      .filter((c) => c[rel.childKey] === row[rel.parentKey])
      .filter((c) => embedFilters.every((f) => matches(c, f, f.path[1]!)))
      .map((c) => project(db, rel.table, c, node.children, []))
      .filter((c): c is FakeRow => c !== null);
    if (rel.kind === 'one') {
      if (children.length === 0 && node.inner) return null;
      out[node.name] = children[0] ?? null;
    } else {
      if (children.length === 0 && node.inner) return null;
      out[node.name] = children;
    }
  }
  return out;
}

class FakeQuery implements PromiseLike<{ data: unknown; error: null; count: number | null }> {
  private selectText = '*';
  private countMode: 'exact' | null = null;
  private head = false;
  private readonly filters: Filter[] = [];
  private readonly orders: Array<{ col: string; ascending: boolean }> = [];
  private rangeWindow: [number, number] | null = null;
  private single = false;

  constructor(
    private readonly db: FixtureDb,
    private readonly table: string,
    private readonly hooks: FakeAdminHooks,
  ) {}

  select(cols: string, opts?: { count?: 'exact'; head?: boolean }): this {
    this.selectText = cols;
    this.countMode = opts?.count ?? null;
    this.head = opts?.head === true;
    return this;
  }
  private filter(col: string, op: FilterOp, value: unknown): this {
    this.filters.push({ path: col.split('.'), op, value });
    return this;
  }
  eq(col: string, v: unknown) {
    return this.filter(col, 'eq', v);
  }
  neq(col: string, v: unknown) {
    return this.filter(col, 'neq', v);
  }
  is(col: string, v: unknown) {
    return this.filter(col, 'is', v);
  }
  gt(col: string, v: unknown) {
    return this.filter(col, 'gt', v);
  }
  gte(col: string, v: unknown) {
    return this.filter(col, 'gte', v);
  }
  lt(col: string, v: unknown) {
    return this.filter(col, 'lt', v);
  }
  lte(col: string, v: unknown) {
    return this.filter(col, 'lte', v);
  }
  in(col: string, v: unknown[]) {
    return this.filter(col, 'in', [...v]);
  }
  order(
    col: string,
    opts?: { ascending?: boolean; referencedTable?: string; foreignTable?: string },
  ) {
    if (opts?.referencedTable || opts?.foreignTable || col.includes('.')) {
      throw new Error('fake PostgREST: ordering an embedded table is not supported');
    }
    this.orders.push({ col, ascending: opts?.ascending !== false });
    return this;
  }
  range(from: number, to: number) {
    this.rangeWindow = [from, to];
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this.execute();
  }

  then<TResult1 = { data: unknown; error: null; count: number | null }, TResult2 = never>(
    onfulfilled?:
      | ((value: {
          data: unknown;
          error: null;
          count: number | null;
        }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<{ data: unknown; error: null; count: number | null }> {
    const executed: ExecutedQuery = {
      table: this.table,
      select: this.selectText,
      count: this.countMode,
      head: this.head,
      filters: this.filters.map((f) => ({ ...f, path: [...f.path] })),
      orders: [...this.orders],
      range: this.rangeWindow,
    };
    this.hooks.log?.push(executed);
    await this.hooks.beforeAnswer?.(executed);

    const nodes = parseSelect(this.selectText);
    const topFilters = this.filters.filter((f) => f.path.length === 1);
    for (const f of this.filters) {
      if (f.path.length > 2) throw new Error(`fake PostgREST: nested filter ${f.path.join('.')}`);
      if (f.path.length === 2 && !nodes.some((n) => n.kind === 'embed' && n.name === f.path[0])) {
        throw new Error(`fake PostgREST: filter on ${f.path[0]} which is not embedded`);
      }
    }
    let rows = (this.db.tables[this.table] ?? []).filter((r) =>
      topFilters.every((f) => matches(r, f, f.path[0]!)),
    );
    if (this.orders.length > 0) {
      rows = [...rows].sort((a, b) => {
        for (const o of this.orders) {
          const c = compare(a[o.col], b[o.col]);
          if (c !== 0) return o.ascending ? c : -c;
        }
        return 0;
      });
    }
    // Project (inner embeds can drop rows) before counting and windowing.
    const projected: FakeRow[] = [];
    for (const r of rows) {
      const p = project(this.db, this.table, r, nodes, this.filters);
      if (p) projected.push(p);
    }
    const count = this.countMode === 'exact' ? projected.length : null;
    const [from, to] = this.rangeWindow ?? [0, MAX_ROWS - 1];
    const windowed = projected.slice(from, Math.min(to, from + MAX_ROWS - 1) + 1);
    if (this.single) {
      if (windowed.length > 1) throw new Error('fake PostgREST: maybeSingle matched several rows');
      return { data: windowed[0] ?? null, error: null, count };
    }
    return { data: this.head ? null : windowed, error: null, count };
  }
}

export interface FakeAdminHooks {
  /** Every query, in the order it was awaited. */
  log?: ExecutedQuery[];
  /** Runs before a query is answered; a returned promise holds the answer. */
  beforeAnswer?: (q: ExecutedQuery) => void | Promise<void>;
}

/** The two RPCs the default-view loaders call, answered from the tables. */
function answerRpc(db: FixtureDb, name: string, args: Record<string, unknown>): unknown {
  if (name === 'inventory_trend_buckets') return [];
  if (name === 'inventory_value_on_hand') {
    // Mirrors migration 0227: active, not deleted, item_type, non-rental,
    // optional warehouse. (Awaiting rows sit at 0 on hand, so they add 0.)
    let sum = 0;
    for (const r of db.tables.inventory_items ?? []) {
      if (r.organization_id !== args.p_organization_id) continue;
      if (r.deleted_at !== null || r.status !== 'active' || r.is_rental !== false) continue;
      if (r.item_type !== args.p_item_type) continue;
      if (args.p_warehouse_id && r.warehouse_id !== args.p_warehouse_id) continue;
      sum += Number(r.quantity_on_hand) * Number(r.unit_cost);
    }
    return sum;
  }
  throw new Error(`fake PostgREST: unknown rpc ${name}`);
}

export function makeFakeAdmin(db: FixtureDb, hooks: FakeAdminHooks = {}) {
  return {
    from: (table: string) => new FakeQuery(db, table, hooks),
    rpc: async (name: string, args: Record<string, unknown>) => {
      hooks.log?.push({
        table: `rpc:${name}`,
        select: '',
        count: null,
        head: false,
        filters: [],
        orders: [],
        range: null,
      });
      return { data: answerRpc(db, name, args), error: null };
    },
  };
}

/**
 * Holds every query until the test releases the current WAVE: all queries
 * that are waiting when `release()` runs are answered together. The number of
 * releases a loader needs is the number of serial round trips it makes.
 */
export function makeWaveGate() {
  let waiting: Array<{ q: ExecutedQuery; go: () => void }> = [];
  return {
    beforeAnswer(q: ExecutedQuery): Promise<void> {
      return new Promise<void>((resolve) => {
        waiting.push({ q, go: resolve });
      });
    },
    /** Answers the waiting queries; returns them. */
    release(): ExecutedQuery[] {
      const wave = waiting;
      waiting = [];
      for (const w of wave) w.go();
      return wave.map((w) => w.q);
    },
    get waitingCount() {
      return waiting.length;
    },
  };
}
