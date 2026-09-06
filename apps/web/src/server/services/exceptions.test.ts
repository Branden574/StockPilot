import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

// Typed explicitly: inferring from an all-empty literal makes readableIds
// `never[]`, so a test that scopes an auditor to a real warehouse id cannot
// even be written.
const { mockAccess } = vi.hoisted(() => ({
  mockAccess: vi.fn(
    async (): Promise<{ hasAllAccess: boolean; readableIds: string[]; writableIds: string[] }> => ({
      hasAllAccess: true,
      readableIds: [],
      writableIds: [],
    }),
  ),
}));
vi.mock('@/lib/auth/warehouse', () => ({ getWarehouseAccess: mockAccess }));

import { ExceptionsService } from './exceptions';
import { type ServiceContext } from './context';

const ORG = 'org-test';
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

function holding(o: {
  item?: string;
  name?: string;
  bin?: string | null;
  loc?: string;
  locName?: string;
  kind?: string | null;
  deleted?: string | null;
  qty?: number;
  age?: number;
}) {
  return {
    quantity: o.qty ?? 5,
    updated_at: daysAgo(o.age ?? 0),
    item_id: o.item ?? 'i1',
    inventory_items: { name: o.name ?? 'A book', sku: 'SKU-1', bin_location: o.bin ?? null },
    locations: {
      id: o.loc ?? 'l1',
      name: o.locName ?? 'Rack 1-A',
      kind: o.kind ?? 'rack',
      warehouse_id: 'wh-1',
      deleted_at: o.deleted ?? null,
    },
  };
}

function ctxFor(client: unknown): ServiceContext {
  return {
    supabase: client,
    organizationId: ORG,
    userId: 'u1',
    role: 'admin',
    permissions: new Set(['items:read']),
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set(),
  } as unknown as ServiceContext;
}

function svcWith(opts: {
  holdings?: unknown[];
  reservations?: unknown[];
  items?: unknown[];
}) {
  const stub = makeSupabaseStub({
    'item_stock_levels.select': { data: opts.holdings ?? [], error: null },
    'stock_reservations.select': { data: opts.reservations ?? [], error: null },
    'inventory_items.select': { data: opts.items ?? [], error: null },
  });
  return new ExceptionsService(ctxFor(stub.client));
}

beforeEach(() => {
  mockAccess.mockResolvedValue({ hasAllAccess: true, readableIds: [], writableIds: [] });
});

describe('ExceptionsService — severity precedence', () => {
  it('an ARCHIVED staging bucket is an orphan, not a stale put-away', () => {
    // Both rules match the same row. The more severe reading has to win, or a
    // critical condition renders under a warning heading and gets triaged last.
    return svcWith({
      holdings: [holding({ kind: 'staging', deleted: daysAgo(1), age: 40, locName: 'Staging' })],
    })
      .list()
      .then((r) => {
        expect(r.exceptions.map((e) => e.rule)).toEqual(['orphaned_stock']);
      });
  });
});

describe('ExceptionsService — age thresholds', () => {
  it('does not report staging that is still being worked', async () => {
    const r = await svcWith({ holdings: [holding({ kind: 'staging', age: 2 })] }).list();
    expect(r.exceptions).toEqual([]);
  });

  it('reports staging past a week, with the age in the detail', async () => {
    const r = await svcWith({ holdings: [holding({ kind: 'staging', age: 9, qty: 12 })] }).list();
    expect(r.exceptions).toHaveLength(1);
    expect(r.exceptions[0]!.rule).toBe('stale_staging');
    expect(r.exceptions[0]!.detail).toContain('9 days');
    expect(r.exceptions[0]!.units).toBe(12);
  });

  it('unplaced has a longer fuse than staging', async () => {
    // 9 days in Staging is a problem; 9 days Unplaced is not, because Unplaced
    // has no put-away cadence to be late against.
    const short = await svcWith({ holdings: [holding({ kind: 'unplaced', age: 9 })] }).list();
    expect(short.exceptions).toEqual([]);
    const long = await svcWith({ holdings: [holding({ kind: 'unplaced', age: 55 })] }).list();
    expect(long.exceptions.map((e) => e.rule)).toEqual(['long_unplaced']);
  });
});

describe('ExceptionsService — label mismatch', () => {
  it('does NOT flag a composite label whose rack half matches', async () => {
    // "41-C · grayBIN" is a rack plus the crate sitting on it. Comparing the
    // whole string flags every crated book in the warehouse — the false
    // positive that turns this screen into noise nobody opens.
    const r = await svcWith({
      holdings: [holding({ bin: '41-C · grayBIN', locName: '41-C', kind: 'rack' })],
    }).list();
    expect(r.exceptions).toEqual([]);
  });

  it('flags a label naming a rack that holds none of the stock', async () => {
    const r = await svcWith({
      holdings: [holding({ bin: '38-C', locName: '38-B', kind: 'rack', name: 'The distance between us' })],
    }).list();
    expect(r.exceptions).toHaveLength(1);
    expect(r.exceptions[0]!.rule).toBe('label_mismatch');
    expect(r.exceptions[0]!.detail).toContain('labelled 38-C');
    expect(r.exceptions[0]!.detail).toContain('38-B');
  });

  it('compares case-insensitively — production holds both "42-c" and "42-C"', async () => {
    const r = await svcWith({
      holdings: [holding({ bin: '42-c · grayBIN', locName: '42-C', kind: 'rack' })],
    }).list();
    expect(r.exceptions).toEqual([]);
  });

  it('skips items with no rack holdings, so nothing is double-counted', async () => {
    // Its stock is all in Unplaced. That is already reported under its own
    // rule; reporting it again as a bad label counts one problem twice.
    const r = await svcWith({
      holdings: [holding({ bin: '38-C', kind: 'unplaced', age: 55, locName: 'Unplaced' })],
    }).list();
    expect(r.exceptions.map((e) => e.rule)).toEqual(['long_unplaced']);
  });

  it('reports an item once even when it is split across racks', async () => {
    const r = await svcWith({
      holdings: [
        holding({ item: 'i9', bin: '99-Z', loc: 'a', locName: '12-A', kind: 'rack' }),
        holding({ item: 'i9', bin: '99-Z', loc: 'b', locName: '12-B', kind: 'rack' }),
      ],
    }).list();
    expect(r.exceptions).toHaveLength(1);
    // Both real locations are named, so the reader knows where it actually is.
    expect(r.exceptions[0]!.detail).toContain('12-A');
    expect(r.exceptions[0]!.detail).toContain('12-B');
  });

  it('ignores an empty label rather than flagging every unlabelled item', async () => {
    const r = await svcWith({ holdings: [holding({ bin: '', locName: '1-A' })] }).list();
    expect(r.exceptions).toEqual([]);
  });
});

describe('ExceptionsService — over-reserved', () => {
  it('reports only when promises exceed stock', async () => {
    const r = await svcWith({
      reservations: [
        { item_id: 'i1', quantity: 8 },
        { item_id: 'i1', quantity: 6 },
        { item_id: 'i2', quantity: 3 },
      ],
      items: [
        { id: 'i1', name: 'Oversold book', sku: 'S1', quantity_on_hand: 10 },
        { id: 'i2', name: 'Fine book', sku: 'S2', quantity_on_hand: 50 },
      ],
    }).list();
    expect(r.exceptions).toHaveLength(1);
    expect(r.exceptions[0]!.rule).toBe('over_reserved');
    // Reservations SUM across rows: 8 + 6 = 14 against 10.
    expect(r.exceptions[0]!.detail).toContain('14 promised');
    expect(r.exceptions[0]!.units).toBe(4);
  });

  it('exactly promised out is normal and is not reported', async () => {
    const r = await svcWith({
      reservations: [{ item_id: 'i1', quantity: 10 }],
      items: [{ id: 'i1', name: 'Book', sku: 'S1', quantity_on_hand: 10 }],
    }).list();
    expect(r.exceptions).toEqual([]);
  });

  it('skips the item lookup entirely when nothing is reserved', async () => {
    const r = await svcWith({ reservations: [] }).list();
    expect(r.exceptions).toEqual([]);
  });
});

describe('ExceptionsService — scope and caps', () => {
  it('an auditor scoped to no warehouse sees an empty page, not an error', async () => {
    mockAccess.mockResolvedValue({ hasAllAccess: false, readableIds: [], writableIds: [] });
    const r = await svcWith({ holdings: [holding({ kind: 'staging', age: 30 })] }).list();
    expect(r.exceptions).toEqual([]);
    expect(r.truncatedRules).toEqual([]);
  });

  it('REPORTS truncation instead of silently showing a partial list', async () => {
    // A capped list that looks complete is a lie the reader cannot detect.
    const many = Array.from({ length: 150 }, (_, i) =>
      holding({ item: `i${i}`, loc: `l${i}`, kind: 'unplaced', age: 60, locName: 'Unplaced' }),
    );
    const r = await svcWith({ holdings: many }).list();
    expect(r.exceptions).toHaveLength(100);
    expect(r.truncatedRules).toContain('long_unplaced');
  });

  it('does not claim truncation when everything fits', async () => {
    const r = await svcWith({
      holdings: [holding({ kind: 'unplaced', age: 60, locName: 'Unplaced' })],
    }).list();
    expect(r.truncatedRules).toEqual([]);
  });
});

describe('ExceptionsService — the SOURCE read is paginated', () => {
  /**
   * A stub that behaves like PostgREST: it honours `.range(from, to)` and
   * NEVER returns more than `[api] max_rows = 1000` rows in one response —
   * including when no `.range()` was asked for at all, which is exactly the
   * silent clamp that made exceptions vanish.
   */
  function rangeAwareHoldings(rows: unknown[]) {
    const holder: { stub?: ReturnType<typeof makeSupabaseStub> } = {};
    const rangeCalls: Array<[number, number]> = [];
    const MAX_ROWS = 1000;
    const stub = makeSupabaseStub({
      'item_stock_levels.select': () => {
        const chain = holder.stub!.chains.get('item_stock_levels.select') ?? [];
        const args = holder.stub!.chainArgs.get('item_stock_levels.select') ?? [];
        const i = chain.indexOf('range');
        if (i === -1) return { data: rows.slice(0, MAX_ROWS), error: null };
        const [from, to] = args[i] as [number, number];
        rangeCalls.push([from, to]);
        return { data: rows.slice(from, Math.min(to + 1, from + MAX_ROWS)), error: null };
      },
      'stock_reservations.select': { data: [], error: null },
      'inventory_items.select': { data: [], error: null },
    });
    holder.stub = stub;
    return { stub, rangeCalls };
  }

  it('finds exceptions living past the PostgREST 1000-row cap', async () => {
    // 1,000 healthy rack holdings followed by 50 long-unplaced ones. A single
    // unpaginated select returns only the first window, so every one of the 50
    // real findings disappears — and `truncatedRules` stays EMPTY, because the
    // per-rule cap only ever sees rows PostgREST actually returned. The page
    // built to catch undetected wrongness would itself be silently wrong.
    const head = Array.from({ length: 1000 }, (_, i) =>
      holding({ item: `h${i}`, loc: `hl${i}`, kind: 'rack', locName: 'Rack 1-A' }),
    );
    const tail = Array.from({ length: 50 }, (_, i) =>
      holding({ item: `t${i}`, loc: `tl${i}`, kind: 'unplaced', age: 60, locName: 'Unplaced' }),
    );
    const { stub, rangeCalls } = rangeAwareHoldings([...head, ...tail]);

    const r = await new ExceptionsService(ctxFor(stub.client)).list();

    expect(r.exceptions.filter((e) => e.rule === 'long_unplaced')).toHaveLength(50);
    // Nothing was actually dropped, so nothing may claim to be truncated.
    expect(r.truncatedRules).toEqual([]);
    // Negative pin: a build that ignores `.range` (or asks only once) cannot
    // satisfy this, so the pagination cannot be quietly reverted.
    expect(rangeCalls).toContainEqual([0, 999]);
    expect(rangeCalls).toContainEqual([1000, 1999]);
  });

  it('SAYS SO when the source read itself hits its ceiling', async () => {
    // Paging to exhaustion still needs a ceiling, and an undisclosed ceiling is
    // the original bug wearing a bigger number: the rules would be evaluated
    // against a subset while the page claimed to be complete. Hitting it marks
    // all four holdings-derived rules truncated, even though none of them
    // individually exceeded PER_RULE_CAP.
    const head = Array.from({ length: 20_000 }, (_, i) =>
      holding({ item: `h${i}`, loc: `hl${i}`, kind: 'rack', locName: 'Rack 1-A' }),
    );
    const tail = Array.from({ length: 50 }, (_, i) =>
      holding({ item: `t${i}`, loc: `tl${i}`, kind: 'unplaced', age: 60, locName: 'Unplaced' }),
    );
    const { stub } = rangeAwareHoldings([...head, ...tail]);

    const r = await new ExceptionsService(ctxFor(stub.client)).list();

    expect(r.truncatedRules).toEqual(
      expect.arrayContaining([
        'orphaned_stock',
        'stale_staging',
        'long_unplaced',
        'label_mismatch',
      ]),
    );
    // Each rule is named ONCE even when the source cap and the per-rule cap
    // both fire, so the page cannot render a duplicated warning.
    expect(new Set(r.truncatedRules).size).toBe(r.truncatedRules.length);
  });

  it('orders by a stable key so a row cannot land on two pages or none', async () => {
    // fetchAllRows' documented contract: without a deterministic sort the
    // window boundaries shift under concurrent writes and the accumulated set
    // is corrupt — silently, and differently on every load.
    const { stub } = rangeAwareHoldings([holding({ kind: 'rack' })]);
    await new ExceptionsService(ctxFor(stub.client)).list();
    const chain = stub.chains.get('item_stock_levels.select') ?? [];
    const args = stub.chainArgs.get('item_stock_levels.select') ?? [];
    expect(chain).toContain('order');
    expect(args[chain.indexOf('order')]![0]).toBe('id');
  });

  it('warehouse scoping survives pagination — every page keeps the filter', async () => {
    // A filter applied to page 1 only would leak another warehouse's stock
    // into an auditor's page from page 2 onward (pattern #10: a refetch must
    // repeat EVERY filter the first read applied).
    mockAccess.mockResolvedValue({
      hasAllAccess: false,
      readableIds: ['wh-1'],
      writableIds: [],
    });
    const rows = Array.from({ length: 1050 }, (_, i) =>
      holding({ item: `x${i}`, loc: `xl${i}`, kind: 'rack', locName: 'Rack 1-A' }),
    );
    const { stub } = rangeAwareHoldings(rows);
    await new ExceptionsService(ctxFor(stub.client)).list();
    const all = stub.chainsAll.get('item_stock_levels.select') ?? [];
    expect(all.length).toBeGreaterThanOrEqual(2);
    for (const chain of all) expect(chain).toContain('in');
  });
});
