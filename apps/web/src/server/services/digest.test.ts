import { describe, expect, it } from 'vitest';

import { NOT_A_LIST } from '@/test/postgrest-answers';
import { makeSupabaseStub } from '@/test/supabase-mock';

import {
  applySectionOptIns,
  buildDigestPayload,
  digestReaderFor,
  getDigestData,
  loadDigestReaderData,
  type DigestReaderData,
  type DigestSource,
} from './digest';
import { rawErrorText } from './lib/fetch-by-ids';

/**
 * The weekly digest's low-stock section cannot be tested with the generic
 * `makeSupabaseStub`: that stub returns its configured rows no matter what
 * filters/limits/ranges the chain applied, so a `.limit(150)` coverage hole
 * would be INVISIBLE to it (every row always comes back). These tests use a
 * tiny fake PostgREST builder that actually honours `.eq/.is/.or/.order/
 * .limit/.range` plus the 1000-row `max_rows` clamp, so the window the
 * service asks for is the window it gets — that is the thing under test.
 */

type ItemRow = {
  id: string;
  organization_id: string;
  status: string;
  deleted_at: string | null;
  /** NOT NULL DEFAULT false in the database (0040): a kit's pre-assembled stock. */
  is_bundle: boolean;
  /** NOT NULL DEFAULT false (0277): created from an inbound PO, never received. */
  awaiting_first_receipt: boolean;
  sku: string;
  name: string;
  quantity_on_hand: number;
  reorder_point: number;
  warehouse_id: string | null;
  warehouse: { name: string } | null;
};

/** PostgREST `[api] max_rows` (supabase/config.toml). */
const MAX_ROWS = 1000;

type Step = { method: string; args: unknown[] };

/** Evaluate one `or()` term of the form `col.op.value`. */
function matchesOrTerm(row: ItemRow, term: string): boolean {
  const [col, op, raw] = term.split('.');
  if (!col) return false;
  const value = Number(raw);
  const actual = (row as unknown as Record<string, number>)[col];
  if (actual == null) return false; // PostgREST drops NULLs from these comparisons
  switch (op) {
    case 'lte':
      return actual <= value;
    case 'lt':
      return actual < value;
    case 'gte':
      return actual >= value;
    case 'gt':
      return actual > value;
    case 'eq':
      return actual === value;
    default:
      throw new Error(`fake client: unsupported or() operator ${op}`);
  }
}

function runQuery(rows: ItemRow[], steps: Step[]): ItemRow[] {
  let out = rows.slice();
  for (const step of steps) {
    const [a, b] = step.args as [string, unknown];
    if (step.method === 'eq') {
      out = out.filter((r) => (r as unknown as Record<string, unknown>)[a] === b);
    } else if (step.method === 'is') {
      out = out.filter((r) => ((r as unknown as Record<string, unknown>)[a] ?? null) === b);
    } else if (step.method === 'or') {
      const terms = a.split(',');
      out = out.filter((r) => terms.some((t) => matchesOrTerm(r, t)));
    }
  }
  // Apply orders in declaration order (last order = least significant tiebreak
  // applied first, so walk them in reverse for a stable multi-key sort).
  const orders = steps.filter((s) => s.method === 'order');
  for (const o of orders.slice().reverse()) {
    const col = o.args[0] as string;
    const asc = ((o.args[1] as { ascending?: boolean } | undefined)?.ascending ?? true) ? 1 : -1;
    out = out
      .map((r, i) => ({ r, i }))
      .sort((x, y) => {
        const xv = (x.r as unknown as Record<string, string | number>)[col] ?? 0;
        const yv = (y.r as unknown as Record<string, string | number>)[col] ?? 0;
        if (xv === yv) return x.i - y.i;
        return (xv < yv ? -1 : 1) * asc;
      })
      .map((e) => e.r);
  }
  const range = steps.find((s) => s.method === 'range');
  if (range) {
    const from = range.args[0] as number;
    const to = range.args[1] as number;
    out = out.slice(from, from + Math.min(to - from + 1, MAX_ROWS));
  }
  const limit = steps.find((s) => s.method === 'limit');
  if (limit) out = out.slice(0, limit.args[0] as number);
  return out.slice(0, MAX_ROWS);
}

function makeFakeClient(items: ItemRow[]) {
  const itemChains: Step[][] = [];

  function builder(table: string) {
    const steps: Step[] = [];
    if (table === 'inventory_items') itemChains.push(steps);
    const proxy: Record<string, unknown> = {};
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === 'then') {
          return (resolve: (v: { data: unknown[]; error: null }) => void) => {
            const data = table === 'inventory_items' ? runQuery(items, steps) : [];
            resolve({ data, error: null });
          };
        }
        return (...args: unknown[]) => {
          steps.push({ method: prop, args });
          return new Proxy(proxy, handler);
        };
      },
    };
    return new Proxy(proxy, handler);
  }

  return {
    client: { from: (table: string) => builder(table) } as never,
    itemChains,
  };
}

function filler(i: number, over: Partial<ItemRow> = {}): ItemRow {
  return {
    id: `f${String(i).padStart(5, '0')}`,
    organization_id: 'org-1',
    status: 'active',
    deleted_at: null,
    is_bundle: false,
    awaiting_first_receipt: false,
    sku: `F-${i}`,
    name: `Filler ${i}`,
    quantity_on_hand: 1,
    reorder_point: 0,
    warehouse_id: 'wh-1',
    warehouse: { name: 'DC4' },
    ...over,
  };
}

const HOT: ItemRow = {
  id: 'hot',
  organization_id: 'org-1',
  status: 'active',
  deleted_at: null,
  is_bundle: false,
  awaiting_first_receipt: false,
  sku: 'HOT',
  name: 'Fast mover',
  quantity_on_hand: 300,
  reorder_point: 500,
  warehouse_id: 'wh-1',
  warehouse: { name: 'DC4' },
};

/** These read low stock; the open purchase orders' OVERDUE flag, which this
 *  clock decides, is digest.overdue.test.ts's subject. */
const CLOCK = { timeZone: 'America/Los_Angeles', now: new Date('2026-10-12T14:00:00.000Z') };

function lowStockIds(groups: Awaited<ReturnType<typeof getDigestData>>['lowStock']): string[] {
  return groups.flatMap((g) => g.items.map((i) => i.id));
}

describe('getDigestData low stock', () => {
  it('reports a below-reorder item that is not among the org’s lowest-quantity rows', async () => {
    // 160 healthy slow movers (qty 1, reorder_point 0 — never low) rank ahead
    // of the one real risk on a quantity-ascending sort. The old code pulled
    // only the 150 lowest rows, so `hot` never entered the window.
    const items = [...Array.from({ length: 160 }, (_, i) => filler(i)), HOT];
    const { client } = makeFakeClient(items);

    const payload = await getDigestData(client, 'org-1', CLOCK);

    expect(lowStockIds(payload.lowStock)).toContain('hot');
    expect(payload.lowStock[0]?.warehouseName).toBe('DC4');
  });

  it('pages past the 1000-row PostgREST cap to reach a low item ranked after a full page of candidates', async () => {
    // Every filler here is a CANDIDATE (reorder_point > 0) but fails the real
    // predicate (qty above its reorder point), so narrowing alone is not
    // enough — the pull must paginate or `hot` is lost on page 2.
    const items = [
      ...Array.from({ length: MAX_ROWS }, (_, i) =>
        filler(i, { quantity_on_hand: 5, reorder_point: 1 }),
      ),
      HOT,
    ];
    const { client } = makeFakeClient(items);

    const payload = await getDigestData(client, 'org-1', CLOCK);

    expect(lowStockIds(payload.lowStock)).toContain('hot');
  });

  it('narrows the pull to rows that can qualify instead of scanning every active item', async () => {
    const items = [...Array.from({ length: 5 }, (_, i) => filler(i)), HOT];
    const { itemChains, client } = makeFakeClient(items);

    await getDigestData(client, 'org-1', CLOCK);

    const steps = itemChains[0] ?? [];
    const or = steps.find((s) => s.method === 'or');
    expect(or?.args[0]).toBe('quantity_on_hand.lte.0,reorder_point.gt.0');
    // Paginated windows, not a single fixed slice of the table.
    expect(steps.some((s) => s.method === 'range')).toBe(true);
    expect(steps.some((s) => s.method === 'limit')).toBe(false);
  });

  it('still reports zero-quantity items that have no reorder point', async () => {
    const items = [filler(1, { id: 'zero', quantity_on_hand: 0, reorder_point: 0 })];
    const { client } = makeFakeClient(items);

    const payload = await getDigestData(client, 'org-1', CLOCK);

    expect(lowStockIds(payload.lowStock)).toEqual(['zero']);
  });

  it('stays org-scoped and skips archived/deleted rows', async () => {
    const items = [
      filler(1, { id: 'other-org', quantity_on_hand: 0, organization_id: 'org-2' }),
      filler(2, { id: 'archived', quantity_on_hand: 0, status: 'archived' }),
      filler(3, { id: 'deleted', quantity_on_hand: 0, deleted_at: '2026-01-01' }),
      filler(4, { id: 'mine', quantity_on_hand: 0 }),
    ];
    const { client } = makeFakeClient(items);

    const payload = await getDigestData(client, 'org-1', CLOCK);

    expect(lowStockIds(payload.lowStock)).toEqual(['mine']);
  });

  it('leaves out a kit whose pre-assembled stock ran out (kits are built from components, never reordered)', async () => {
    const items = [
      filler(1, { id: 'drained-kit', sku: '__BUNDLE__0a000000', quantity_on_hand: 0, is_bundle: true }),
      filler(2, { id: 'kit-with-reorder-point', quantity_on_hand: 1, reorder_point: 3, is_bundle: true }),
      filler(3, { id: 'out', quantity_on_hand: 0 }),
    ];
    const { client } = makeFakeClient(items);

    const payload = await getDigestData(client, 'org-1', CLOCK);

    expect(lowStockIds(payload.lowStock)).toEqual(['out']);
  });

  it('leaves out an item made from a purchase order that has not been received yet', async () => {
    // Since 0277 an item created from an inbound PO sits at quantity 0 with
    // awaiting_first_receipt until its first receipt. It is expected, not out
    // of stock: the dashboard's low-stock list and out-of-stock count skip it
    // and the inventory lists hide it by default. Sorted by quantity, these
    // came FIRST, filling "N out of stock" and the "X is out at Y" line ahead
    // of real low stock.
    const items = [
      filler(1, { id: 'expected', quantity_on_hand: 0, reorder_point: 5, awaiting_first_receipt: true }),
      filler(2, { id: 'really-out', quantity_on_hand: 0, reorder_point: 5 }),
    ];
    const { client, itemChains } = makeFakeClient(items);

    const payload = await getDigestData(client, 'org-1', CLOCK);

    expect(lowStockIds(payload.lowStock)).toEqual(['really-out']);
    // Server-side, so the paging windows never carry the expected items.
    const eq = (itemChains[0] ?? []).filter((s) => s.method === 'eq').map((s) => s.args);
    expect(eq).toContainEqual(['awaiting_first_receipt', false]);
  });

  it('omits healthy stock', async () => {
    const items = [filler(1, { quantity_on_hand: 50, reorder_point: 10 })];
    const { client } = makeFakeClient(items);

    const payload = await getDigestData(client, 'org-1', CLOCK);

    expect(payload.lowStock).toEqual([]);
  });
});

describe('buildDigestPayload: what one reader is sent (the edges route.scope.test.ts does not reach)', () => {
  const sourceItem = (
    id: string,
    warehouseId: string | null,
    over: Partial<DigestSource['lowStock'][number]> = {},
  ): DigestSource['lowStock'][number] => ({
    id,
    sku: id,
    name: id,
    qty: 0,
    reorderPoint: 5,
    warehouseId,
    charterId: null,
    categoryId: null,
    warehouseName: warehouseId ?? 'Unassigned',
    ...over,
  });
  const sourcePo = (
    id: string,
    over: Partial<DigestSource['openPos'][number]> = {},
  ): DigestSource['openPos'][number] => ({
    id,
    poNumber: id,
    supplierName: null,
    expectedAt: null,
    status: 'ordered',
    isOverdue: false,
    destinationLocationId: null,
    destinationWarehouseId: null,
    ...over,
  });
  const noFacts = (): DigestReaderData => ({
    assignments: new Map(),
    categories: new Map(),
    userPoRead: new Map(),
    rolePoRead: new Map(),
    defaultPoReadRoles: new Set(['owner', 'admin', 'manager', 'staff', 'viewer']),
  });

  it('keeps what the reader\'s own client returned (the preview), except an item no member can read', () => {
    const source: DigestSource = {
      lowStock: [sourceItem('placed', 'wh-1'), sourceItem('no-warehouse', null)],
      openPos: [sourcePo('po-1')],
      openCycleCounts: [],
    };
    const payload = buildDigestPayload(source, null);
    expect(payload.lowStock.flatMap((g) => g.items.map((i) => i.id))).toEqual(['placed']);
    expect(payload.openPos.map((p) => p.id)).toEqual(['po-1']);
  });

  it('refuses a purchase order whose destination location the read did not return, unless the reader sees every warehouse', () => {
    const source: DigestSource = {
      lowStock: [],
      openPos: [sourcePo('po-unknown-destination', { destinationLocationId: 'loc-x', destinationWarehouseId: undefined })],
      openCycleCounts: [],
    };
    const facts = noFacts();
    facts.assignments.set('staff', [{ warehouseId: 'wh-1', charterId: null }]);
    expect(buildDigestPayload(source, digestReaderFor(facts, 'staff', 'staff')).openPos).toEqual([]);
    expect(
      buildDigestPayload(source, digestReaderFor(facts, 'manager', 'manager')).openPos.map((p) => p.id),
    ).toEqual(['po-unknown-destination']);
  });

  it('gives a role the policies do not name no items and, without a grant, no purchase orders', () => {
    const source: DigestSource = {
      lowStock: [sourceItem('placed', 'wh-1')],
      openPos: [sourcePo('po-1')],
      openCycleCounts: [],
    };
    const facts = noFacts();
    facts.assignments.set('odd', [{ warehouseId: 'wh-1', charterId: null }]);
    const reader = digestReaderFor(facts, 'odd', 'auditor');
    expect(reader.canReadPurchaseOrders).toBe(false);
    const payload = buildDigestPayload(source, reader);
    expect(payload.lowStock).toEqual([]);
    expect(payload.openPos).toEqual([]);
  });

  it('cuts to the rendered limits AFTER the reader, so a scoped reader still gets their own lowest twenty', () => {
    // 30 low items elsewhere sort ahead of the reader's 3; cutting first
    // would have left the reader nothing.
    const source: DigestSource = {
      lowStock: [
        ...Array.from({ length: 30 }, (_, i) => sourceItem(`other-${i}`, 'wh-other', { qty: -1 })),
        ...Array.from({ length: 3 }, (_, i) => sourceItem(`mine-${i}`, 'wh-mine')),
      ],
      openPos: [
        ...Array.from({ length: 25 }, (_, i) =>
          sourcePo(`po-other-${i}`, { destinationLocationId: 'loc-other', destinationWarehouseId: 'wh-other' }),
        ),
        sourcePo('po-mine', { destinationLocationId: 'loc-mine', destinationWarehouseId: 'wh-mine' }),
      ],
      openCycleCounts: [],
    };
    const facts = noFacts();
    facts.assignments.set('staff', [{ warehouseId: 'wh-mine', charterId: null }]);
    const payload = buildDigestPayload(source, digestReaderFor(facts, 'staff', 'staff'));
    expect(payload.lowStock.flatMap((g) => g.items.map((i) => i.id))).toEqual(['mine-0', 'mine-1', 'mine-2']);
    expect(payload.openPos.map((p) => p.id)).toEqual(['po-mine']);
  });
});

describe('buildDigestPayload: totals', () => {
  it('counts every low item and open purchase order the reader may read, not the twenty listed', () => {
    const source: DigestSource = {
      lowStock: Array.from({ length: 30 }, (_, i) => ({
        id: `item-${String(i).padStart(2, '0')}`,
        sku: `S-${i}`,
        name: `Item ${i}`,
        qty: i < 5 ? 0 : 1,
        reorderPoint: 5,
        warehouseId: 'wh-1',
        charterId: null,
        categoryId: null,
        warehouseName: 'DC4',
      })),
      openPos: Array.from({ length: 25 }, (_, i) => ({
        id: `po-${String(i).padStart(2, '0')}`,
        poNumber: `PO-${i}`,
        supplierName: null,
        expectedAt: null,
        status: 'ordered',
        isOverdue: i < 7,
        destinationLocationId: null,
        destinationWarehouseId: null,
      })),
      openCycleCounts: [],
    };
    const payload = buildDigestPayload(source, null);
    expect(payload.lowStock.flatMap((g) => g.items)).toHaveLength(20);
    expect(payload.lowStockTotal).toBe(30);
    expect(payload.outOfStockTotal).toBe(5);
    expect(payload.openPos).toHaveLength(20);
    expect(payload.openPosTotal).toBe(25);
    expect(payload.overduePosTotal).toBe(7);

    // A section the recipient opted out of carries no count either.
    const gated = applySectionOptIns(payload, { lowStock: false, openPos: false, cycleCounts: true });
    expect([gated.lowStockTotal, gated.outOfStockTotal, gated.openPosTotal, gated.overduePosTotal]).toEqual([
      0, 0, 0, 0,
    ]);
  });
});

/**
 * docket S27: what decides each recipient's view is read with the service
 * role, so no row rule stands behind these reads: their answer is the
 * decision. An answer with no error that is not a list (postgrest-js resolves
 * an empty body with data null) was read as "no rows", which widens the
 * digest: no category rows gives a viewer every category, no override rows
 * gives back a purchase-order read the organization took away. Each read
 * refuses it, so the organization's digest is skipped and reported
 * (route.scope.test.ts runs the cron).
 */
describe('loadDigestReaderData: an answer that is not a list is a failed read', () => {
  const listed = (data: unknown[]) => ({ data, error: null, status: 200 });
  const READS = {
    'user_warehouse_assignments.select': listed([
      { id: 'uwa-1', user_id: 'user-1', warehouse_id: 'wh-1', charter_id: null },
    ]),
    'user_category_assignments.select': listed([
      { id: 'uca-1', user_id: 'user-1', category_id: 'cat-1' },
    ]),
    'user_permission_overrides.select': listed([{ user_id: 'user-1', granted: false }]),
    'role_permission_overrides.select': listed([{ role: 'viewer', granted: false }]),
    'role_default_permissions.select': listed([{ role: 'viewer' }]),
  };

  it('reads every list as it came', async () => {
    const data = await loadDigestReaderData(makeSupabaseStub(READS).client, 'org-1', ['user-1']);
    expect(data.categories.get('user-1')).toEqual(new Set(['cat-1']));
    expect(data.userPoRead.get('user-1')).toBe(false);
    expect(data.rolePoRead.get('viewer')).toBe(false);
    expect(data.defaultPoReadRoles).toEqual(new Set(['viewer']));
    // An empty body from the category read gave this viewer every category.
    const err = await loadDigestReaderData(
      makeSupabaseStub({ ...READS, 'user_category_assignments.select': NOT_A_LIST[0][1] }).client,
      'org-1',
      ['user-1'],
    ).catch((e: unknown) => e);
    expect(rawErrorText(err)).toBe('user_category_assignments answered no list (status 200)');
  });

  describe.each(Object.keys(READS).map((key) => [key.replace(/\.select$/, '')]))('%s', (table) => {
    it.each(NOT_A_LIST)('%s throws, naming the table and the status', async (_shape, answer) => {
      const stub = makeSupabaseStub({ ...READS, [`${table}.select`]: answer });
      const err = await loadDigestReaderData(stub.client, 'org-1', ['user-1']).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(rawErrorText(err)).toBe(`${table} answered no list (status ${answer.status})`);
    });
  });
});

/**
 * Cycle counts follow cycle_counts_select and cycle_count_lines_select (S48):
 * a staff member or viewer reads the counts of their warehouses (a count with
 * no header warehouse when it is assigned to them or has a line in their
 * warehouses), managers and all-warehouses members read every count, and the
 * totals count only the lines the reader may read: a manager every line,
 * anyone else a line in their warehouses whose item they may open.
 */
describe('buildDigestPayload: cycle counts', () => {
  type SourceCount = DigestSource['openCycleCounts'][number];
  type SourceLine = SourceCount['lines'][number];
  const ln = (
    warehouseId: string | null,
    counted: boolean,
    item: Partial<NonNullable<SourceLine['item']>> | null = {},
  ): SourceLine => ({
    warehouseId,
    counted,
    item: item === null ? null : { warehouseId, charterId: null, categoryId: null, ...item },
  });
  const count = (id: string, over: Partial<SourceCount>): SourceCount => ({
    id,
    countNumber: 1,
    warehouseId: null,
    warehouseName: null,
    scope: 'warehouse',
    startedAt: '2026-10-01T00:00:00Z',
    assignedTo: null,
    lines: [],
    ...over,
  });
  const source = (): DigestSource => ({
    lowStock: [],
    openPos: [],
    openCycleCounts: [
      count('north', {
        warehouseId: 'wh-n',
        warehouseName: 'North',
        lines: [
          ln('wh-n', true, { categoryId: 'cat-a' }),
          ln('wh-n', false, { categoryId: 'cat-b' }),
          ln('wh-n', true, { charterId: 'ch-2' }),
        ],
      }),
      count('south', {
        warehouseId: 'wh-s',
        warehouseName: 'South',
        lines: [ln('wh-s', true, { categoryId: 'cat-a' })],
      }),
      count('mixed', {
        scope: 'selection',
        lines: [
          ln('wh-n', true, { categoryId: 'cat-a' }),
          ln('wh-s', false, { categoryId: 'cat-a' }),
        ],
      }),
      count('south-mine', {
        scope: 'selection',
        assignedTo: 'staff-n',
        lines: [ln('wh-s', false)],
      }),
      count('no-warehouse-line', {
        scope: 'selection',
        lines: [ln(null, true, null)],
      }),
    ],
  });
  const facts = (): DigestReaderData => ({
    assignments: new Map([
      ['staff-n', [{ warehouseId: 'wh-n', charterId: null }]],
      ['staff-ch1', [{ warehouseId: 'wh-n', charterId: 'ch-1' }]],
      ['viewer-cat-a', [{ warehouseId: 'wh-n', charterId: null }]],
      [
        'flag-viewer',
        [
          { warehouseId: 'wh-n', charterId: null },
          { warehouseId: 'wh-s', charterId: null },
        ],
      ],
    ]),
    categories: new Map([
      ['viewer-cat-a', new Set(['cat-a'])],
      ['flag-viewer', new Set(['cat-a'])],
    ]),
    userPoRead: new Map(),
    rolePoRead: new Map(),
    defaultPoReadRoles: new Set(['owner', 'admin', 'manager', 'staff', 'viewer']),
  });
  const totals = (reader: Parameters<typeof buildDigestPayload>[1]) =>
    buildDigestPayload(source(), reader).openCycleCounts.map(
      (c) => `${c.id} ${c.countedLines}/${c.totalLines}`,
    );

  it("keeps every count and line the reader's own client returned (the preview)", () => {
    expect(totals(null)).toEqual([
      'north 2/3',
      'south 1/1',
      'mixed 1/2',
      'south-mine 0/1',
      'no-warehouse-line 1/1',
    ]);
  });

  it('gives a manager every count and every line, a line with no warehouse included', () => {
    expect(totals(digestReaderFor(facts(), 'mgr', 'manager'))).toEqual([
      'north 2/3',
      'south 1/1',
      'mixed 1/2',
      'south-mine 0/1',
      'no-warehouse-line 1/1',
    ]);
  });

  it('gives a North staff member North, the mixed count and her own assignment, with North lines only', () => {
    expect(totals(digestReaderFor(facts(), 'staff-n', 'staff'))).toEqual([
      'north 2/3',
      'mixed 1/1',
      'south-mine 0/0',
    ]);
  });

  it('leaves out the lines of another charter for a charter-limited staff member', () => {
    expect(totals(digestReaderFor(facts(), 'staff-ch1', 'staff'))).toEqual([
      'north 1/2',
      'mixed 1/1',
    ]);
  });

  it("gives a category-limited viewer only that category's lines", () => {
    expect(totals(digestReaderFor(facts(), 'viewer-cat-a', 'viewer'))).toEqual([
      'north 1/1',
      'mixed 1/1',
    ]);
  });

  it('gives an all-warehouses member every count, with lines by assignment and category', () => {
    // South's uncategorised line is not one of her categories.
    expect(totals(digestReaderFor(facts(), 'flag-viewer', 'viewer', true))).toEqual([
      'north 1/1',
      'south 1/1',
      'mixed 1/2',
      'south-mine 0/0',
      'no-warehouse-line 0/0',
    ]);
    // The flag decides the counts; lines still need the assignment rows.
    expect(totals(digestReaderFor(facts(), 'staff-n', 'staff', true))).toEqual([
      'north 2/3',
      'south 0/0',
      'mixed 1/1',
      'south-mine 0/0',
      'no-warehouse-line 0/0',
    ]);
  });

  it('reads a missing all-warehouses flag as false', () => {
    expect(digestReaderFor(facts(), 'staff-n', 'staff').allWarehouses).toBe(false);
    expect(totals(digestReaderFor(facts(), 'staff-n', 'staff'))).not.toContain('south 0/0');
  });

  it('never counts a line whose item the read did not return for a non-manager', () => {
    const src = source();
    src.openCycleCounts = [
      count('north', { warehouseId: 'wh-n', lines: [ln('wh-n', true, null)] }),
    ];
    expect(
      buildDigestPayload(src, digestReaderFor(facts(), 'staff-n', 'staff')).openCycleCounts.map(
        (c) => c.totalLines,
      ),
    ).toEqual([0]);
  });
});
