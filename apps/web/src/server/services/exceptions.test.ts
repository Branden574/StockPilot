import { beforeEach, describe, expect, it, vi } from 'vitest';

import { describeOccurrence, type ExceptionRule } from '@stockpilot/core';

import { makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

import { type ServiceContext } from './context';
import { ExceptionsService, HOLDINGS_SOURCE_CAP, type SyncEvaluation } from './exceptions';
import { buildSystemContext, type SystemServiceContext } from './lib/system-context';

/**
 * The evaluator behind the stored Exception Center (F1-1). These tests moved
 * here from the reader-scoped `list()` that the sync replaced: the rules are
 * the same, but the output is what exceptions_sync applies — present, hold,
 * and which rules are complete — and it runs only as the system.
 */

const ORG = 'org-test';
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

type Results = Parameters<typeof makeSupabaseStub>[0];

function holding(o: {
  item?: string;
  name?: string;
  bin?: string | null;
  loc?: string;
  locName?: string;
  kind?: string | null;
  deleted?: string | null;
  qty?: number;
  /** Days since the holding went positive (positive_since). */
  age?: number | null;
  /** Days since the row was last written (updated_at); the evaluator must
   *  ignore it. */
  touched?: number;
}) {
  return {
    id: `isl-${o.item ?? 'i1'}-${o.loc ?? 'l1'}`,
    quantity: o.qty ?? 5,
    positive_since: o.age === null ? null : daysAgo(o.age ?? 0),
    updated_at: daysAgo(o.touched ?? 0),
    item_id: o.item ?? 'i1',
    location_id: o.loc ?? 'l1',
    inventory_items: { name: o.name ?? 'A book', sku: 'SKU-1', bin_location: o.bin ?? null },
    locations: {
      id: o.loc ?? 'l1',
      name: o.locName ?? 'Rack 1-A',
      kind: o.kind === undefined ? 'rack' : o.kind,
      warehouse_id: 'wh-1',
      deleted_at: o.deleted ?? null,
    },
  };
}

/** A stub admin client, and the SYSTEM context built from it the only way one
 *  can be built: through buildSystemContext. */
async function systemFor(results: Results): Promise<{
  ctx: SystemServiceContext;
  stub: ReturnType<typeof makeSupabaseStub>;
}> {
  const stub = makeSupabaseStub({
    'organization_members.select': { data: [{ user_id: 'u-owner', role: 'owner' }], error: null },
    'organization_modules.select': { data: [], error: null },
    ...results,
  });
  const ctx = await buildSystemContext(stub.client, ORG);
  if (!ctx) throw new Error('fixture: no system context');
  return { ctx, stub };
}

async function evaluate(opts: {
  holdings?: unknown[];
  reservations?: unknown[];
  items?: unknown[];
}): Promise<SyncEvaluation> {
  const { ctx } = await systemFor({
    'item_stock_levels.select': { data: opts.holdings ?? [], error: null },
    'stock_reservations.select': { data: opts.reservations ?? [], error: null },
    'inventory_items.select': { data: opts.items ?? [], error: null },
  });
  return ExceptionsService.evaluateForSync(ctx);
}

const rules = (e: SyncEvaluation) => e.present.map((p) => p.rule);
const details = (e: SyncEvaluation, rule: ExceptionRule) =>
  e.present
    .filter((p) => p.rule === rule)
    .map((p) => describeOccurrence(p.rule, p.facts, { conditionSince: p.conditionSince }).detail);

beforeEach(() => {
  reportError.mockClear();
});

describe('evaluateForSync — only the system evaluates', () => {
  it('refuses a reader-scoped context, even one cast to the branded type', async () => {
    // A reader's evaluation sees a subset of the org; synced, it would resolve
    // every occurrence outside the reader's warehouses. Mutation caught:
    // dropping the runtime check (the type alone does not stop a cast).
    const stub = makeSupabaseStub({});
    const readerCtx = {
      supabase: stub.client,
      organizationId: ORG,
      userId: 'u-reader',
      role: 'admin',
      permissions: new Set(['items:read']),
      mfaRequired: false,
      mfaSatisfied: true,
      enabledModules: new Set(),
    } as unknown as ServiceContext;
    await expect(
      ExceptionsService.evaluateForSync(readerCtx as unknown as SystemServiceContext),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(stub.fromCalls).toEqual([]);
  });

  it('refuses a spread copy of a real system context', async () => {
    const { ctx } = await systemFor({});
    const copy = { ...ctx } as SystemServiceContext;
    await expect(ExceptionsService.evaluateForSync(copy)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('every read filters organization_id to the org — the only tenant boundary under service role', async () => {
    // Enough data that EVERY read runs: holdings, reservations and the item
    // lookup. Mutation caught: removing any one `.eq('organization_id', …)`.
    const { ctx, stub } = await systemFor({
      'item_stock_levels.select': { data: [holding({ kind: 'staging', age: 9 })], error: null },
      'stock_reservations.select': { data: [{ item_id: 'i1', quantity: 9 }], error: null },
      'inventory_items.select': {
        data: [{ id: 'i1', name: 'Book', sku: 'S', warehouse_id: 'wh-1', quantity_on_hand: 1 }],
        error: null,
      },
    });
    stub.chainsAll.clear();
    stub.chainArgsAll.clear();
    await ExceptionsService.evaluateForSync(ctx);

    const tables = [...stub.chainsAll.keys()].sort();
    expect(tables).toEqual([
      'inventory_items.select',
      'item_stock_levels.select',
      'stock_reservations.select',
    ]);
    for (const key of tables) {
      const chains = stub.chainsAll.get(key)!;
      const args = stub.chainArgsAll.get(key)!;
      chains.forEach((chain, i) => {
        const orgFilter = chain.some(
          (m, j) => m === 'eq' && args[i]![j]![0] === 'organization_id' && args[i]![j]![1] === ORG,
        );
        expect(orgFilter, `${key} read #${i + 1} has no organization_id filter`).toBe(true);
      });
    }
  });

  it('takes evaluatedAt immediately BEFORE the first read', async () => {
    let firstReadAt: number | null = null;
    const before = Date.now();
    const { ctx } = await systemFor({
      'item_stock_levels.select': () => {
        firstReadAt ??= Date.now();
        return { data: [], error: null };
      },
    });
    const res = await ExceptionsService.evaluateForSync(ctx);
    const at = Date.parse(res.evaluatedAt);
    expect(at).toBeGreaterThanOrEqual(before - 1);
    expect(firstReadAt).not.toBeNull();
    expect(at).toBeLessThanOrEqual(firstReadAt!);
  });
});

describe('evaluateForSync — identity', () => {
  it('holding rules carry the holding location; item-level rules carry none', async () => {
    const e = await evaluate({
      holdings: [
        holding({ item: 'a', loc: 'la', kind: 'staging', age: 9, locName: 'Staging' }),
        holding({ item: 'b', loc: 'lb', bin: '99-Z', locName: '12-A', kind: 'rack' }),
      ],
      reservations: [{ item_id: 'c', quantity: 5 }],
      items: [{ id: 'c', name: 'Oversold', sku: 'S', warehouse_id: 'wh-9', quantity_on_hand: 1 }],
    });
    const byRule = Object.fromEntries(e.present.map((p) => [p.rule, p]));
    expect(byRule.stale_staging).toMatchObject({ itemId: 'a', locationId: 'la', warehouseId: 'wh-1' });
    expect(byRule.label_mismatch).toMatchObject({ itemId: 'b', locationId: null });
    expect(byRule.over_reserved).toMatchObject({ itemId: 'c', locationId: null, warehouseId: 'wh-9' });
  });

  it('facts hold numbers and names only', async () => {
    const e = await evaluate({
      holdings: [holding({ kind: 'unplaced', age: 40, qty: 12, locName: 'Unplaced', name: 'Atlas' })],
    });
    expect(e.present[0]!.facts).toEqual({
      itemName: 'Atlas',
      sku: 'SKU-1',
      units: 12,
      locationName: 'Unplaced',
      locationKind: 'unplaced',
    });
  });

  it('numbers new rows critical first, deterministically', async () => {
    const e = await evaluate({
      holdings: [
        holding({ item: 'z', loc: 'lz', kind: 'staging', age: 9, name: 'Zebra' }),
        holding({ item: 'y', loc: 'ly', deleted: daysAgo(1), name: 'Yak' }),
      ],
      reservations: [{ item_id: 'x', quantity: 5 }],
      items: [{ id: 'x', name: 'Xylophone', sku: 'S', warehouse_id: null, quantity_on_hand: 0 }],
    });
    expect(rules(e)).toEqual(['orphaned_stock', 'over_reserved', 'stale_staging']);
  });
});

describe('evaluateForSync — severity precedence', () => {
  it('an ARCHIVED staging bucket is an orphan, not a stale put-away', async () => {
    // Both rules match the same row. The more severe reading has to win, or a
    // critical condition renders under a warning heading and gets triaged last.
    const e = await evaluate({
      holdings: [holding({ kind: 'staging', deleted: daysAgo(1), age: 40, locName: 'Staging' })],
    });
    expect(rules(e)).toEqual(['orphaned_stock']);
  });
});

describe('evaluateForSync — ages come from positive_since', () => {
  it('does not report staging that is still being worked', async () => {
    const e = await evaluate({ holdings: [holding({ kind: 'staging', age: 2 })] });
    expect(e.present).toEqual([]);
    expect(e.hold).toEqual([]);
  });

  it('reports staging past a week, with its condition start', async () => {
    const h = holding({ kind: 'staging', age: 9, qty: 12 });
    const e = await evaluate({ holdings: [h] });
    expect(rules(e)).toEqual(['stale_staging']);
    expect(e.present[0]!.conditionSince).toBe(h.positive_since);
    expect(details(e, 'stale_staging')).toEqual(['in Staging for at least 9 days']);
  });

  it('a Staging holding topped up yesterday still ages from when it went positive', async () => {
    // THE STAGING AGE BUG: updated_at moves on every write, so a holding
    // topped up weekly never reached seven days. Mutation caught: aging by
    // updated_at again.
    const e = await evaluate({ holdings: [holding({ kind: 'staging', age: 20, touched: 1 })] });
    expect(rules(e)).toEqual(['stale_staging']);
  });

  it('an old row that only recently went positive is not stale', async () => {
    const e = await evaluate({ holdings: [holding({ kind: 'staging', age: 1, touched: 90 })] });
    expect(e.present).toEqual([]);
  });

  it('unplaced has a longer fuse than staging', async () => {
    const short = await evaluate({ holdings: [holding({ kind: 'unplaced', age: 9 })] });
    expect(short.present).toEqual([]);
    const long = await evaluate({ holdings: [holding({ kind: 'unplaced', age: 55 })] });
    expect(rules(long)).toEqual(['long_unplaced']);
    expect(details(long, 'long_unplaced')).toEqual(['unplaced for at least 55 days']);
  });

  it('a positive holding with no positive_since is HELD, never guessed', async () => {
    // It can neither open (age unknown) nor resolve an existing row.
    const e = await evaluate({
      holdings: [
        holding({ item: 'a', loc: 'la', kind: 'staging', age: null }),
        holding({ item: 'b', loc: 'lb', kind: 'unplaced', age: null }),
      ],
    });
    expect(e.present).toEqual([]);
    expect(e.hold).toEqual([
      { rule: 'stale_staging', itemId: 'a', locationId: 'la' },
      { rule: 'long_unplaced', itemId: 'b', locationId: 'lb' },
    ]);
    expect(e.completeRules).toContain('stale_staging');
  });
});

describe('evaluateForSync — label mismatch', () => {
  it('does NOT flag a composite label whose rack half matches', async () => {
    const e = await evaluate({
      holdings: [holding({ bin: '41-C · grayBIN', locName: '41-C', kind: 'rack' })],
    });
    expect(e.present).toEqual([]);
  });

  it('flags a label naming a rack that holds none of the stock', async () => {
    const e = await evaluate({
      holdings: [holding({ bin: '38-C', locName: '38-B', kind: 'rack', name: 'The distance between us' })],
    });
    expect(rules(e)).toEqual(['label_mismatch']);
    expect(e.present[0]!.facts).toMatchObject({ label: '38-C', stockOn: ['38-B'] });
    expect(details(e, 'label_mismatch')).toEqual(['labelled 38-C, stock is on 38-B']);
  });

  it('compares case-insensitively — production holds both "42-c" and "42-C"', async () => {
    const e = await evaluate({
      holdings: [holding({ bin: '42-c · grayBIN', locName: '42-C', kind: 'rack' })],
    });
    expect(e.present).toEqual([]);
  });

  it('a labelled item with stock but no rack holding is HELD, not reported twice or resolved', async () => {
    // Its stock is all in Unplaced, reported under its own rule. The label
    // cannot be checked, which is not the same as "the label is fine": an open
    // label occurrence must survive the stock passing through Unplaced.
    // Mutation caught: treating not-applicable as absent.
    const e = await evaluate({
      holdings: [holding({ bin: '38-C', kind: 'unplaced', age: 55, locName: 'Unplaced' })],
    });
    expect(rules(e)).toEqual(['long_unplaced']);
    expect(e.hold).toEqual([{ rule: 'label_mismatch', itemId: 'i1', locationId: null }]);
  });

  it('an empty label is absent, not held, so clearing the label resolves the row', async () => {
    const e = await evaluate({
      holdings: [
        holding({ item: 'a', loc: 'la', bin: '', locName: '1-A' }),
        holding({ item: 'b', loc: 'lb', bin: ' · grayBIN', kind: 'unplaced', age: 1 }),
      ],
    });
    expect(e.present).toEqual([]);
    expect(e.hold).toEqual([]);
  });

  it('reports an item once even when it is split across racks, naming both', async () => {
    const e = await evaluate({
      holdings: [
        holding({ item: 'i9', bin: '99-Z', loc: 'a', locName: '12-A', kind: 'rack' }),
        holding({ item: 'i9', bin: '99-Z', loc: 'b', locName: '12-B', kind: 'rack' }),
      ],
    });
    expect(rules(e)).toEqual(['label_mismatch']);
    expect(details(e, 'label_mismatch')).toEqual(['labelled 99-Z, stock is on 12-A, 12-B']);
  });
});

describe('evaluateForSync — label mismatch: a crate SITS ON a rack', () => {
  it('does NOT flag a book in a crate that sits on its labelled rack', async () => {
    const e = await evaluate({
      holdings: [holding({ bin: '43-B · Gray #5', locName: 'Gray #5 on rack 43-B', kind: 'crate' })],
    });
    expect(e.present).toEqual([]);
  });

  it('does NOT flag a crate on the rack when the label is the bare rack', async () => {
    const e = await evaluate({
      holdings: [holding({ bin: '38-B', locName: 'Blue #0 on rack 38-B', kind: 'crate' })],
    });
    expect(e.present).toEqual([]);
  });

  it('does NOT flag spaced and unspaced spellings of the same rack, either way round', async () => {
    const a = await evaluate({ holdings: [holding({ bin: '22 - B', locName: '22-B', kind: 'rack' })] });
    expect(a.present).toEqual([]);
    const b = await evaluate({
      holdings: [holding({ bin: '22-B · grayBIN', locName: '22 - B', kind: 'rack' })],
    });
    expect(b.present).toEqual([]);
  });

  it('still flags a genuinely different rack, and names the rack the crate is on', async () => {
    const e = await evaluate({
      holdings: [
        holding({ item: 'i7', bin: '40-C', loc: 'a', locName: '39-C', kind: 'rack' }),
        holding({ item: 'i7', bin: '40-C', loc: 'b', locName: 'Blue on rack 39-C', kind: 'crate' }),
      ],
    });
    expect(details(e, 'label_mismatch')).toEqual(['labelled 40-C, stock is on 39-C']);
  });

  it('flags a crate label whose crate sits on a DIFFERENT rack', async () => {
    const e = await evaluate({
      holdings: [holding({ bin: '43-C · Gray #BIN', locName: 'Gray #BIN on rack 43-B', kind: 'crate' })],
    });
    expect(details(e, 'label_mismatch')).toEqual(['labelled 43-C, stock is on 43-B']);
  });

  it('flags a label that is only a substring of the rack the crate sits on', async () => {
    const e = await evaluate({
      holdings: [holding({ bin: '3-B', locName: 'Gray #5 on rack 43-B', kind: 'crate' })],
    });
    expect(rules(e)).toEqual(['label_mismatch']);
  });

  it('flags a position-less crate against a rack label, naming the crate', async () => {
    const e = await evaluate({
      holdings: [holding({ bin: '41-C', locName: 'Blue Shelf', kind: 'crate' })],
    });
    expect(details(e, 'label_mismatch')).toEqual(['labelled 41-C, stock is on Blue Shelf']);
  });

  it('names a legacy spaced rack and a crate on it as ONE rack, in canonical form', async () => {
    const e = await evaluate({
      holdings: [
        holding({ item: 'i8', bin: '40-C', loc: 'a', locName: '22 - B', kind: 'rack' }),
        holding({ item: 'i8', bin: '40-C', loc: 'b', locName: 'Blue on rack 22-B', kind: 'crate' }),
      ],
    });
    expect(details(e, 'label_mismatch')).toEqual(['labelled 40-C, stock is on 22-B']);
  });

  it('a crate-name label is compared as the rack it names', async () => {
    const same = await evaluate({
      holdings: [holding({ bin: 'Blue #0 on rack 38-B', locName: '38-B', kind: 'rack' })],
    });
    expect(same.present).toEqual([]);
    const crateOnSame = await evaluate({
      holdings: [holding({ bin: 'Blue #0 on rack 38-B', locName: 'Gray #BIN on rack 38-B', kind: 'crate' })],
    });
    expect(crateOnSame.present).toEqual([]);
    const other = await evaluate({
      holdings: [holding({ bin: 'Blue #0 on rack 38-B', locName: '39-B', kind: 'rack' })],
    });
    expect(details(other, 'label_mismatch')).toEqual(['labelled 38-B, stock is on 39-B']);
  });
});

describe('evaluateForSync — over-reserved', () => {
  it('reports only when promises exceed stock, summing reservations', async () => {
    const e = await evaluate({
      reservations: [
        { item_id: 'i1', quantity: 8 },
        { item_id: 'i1', quantity: 6 },
        { item_id: 'i2', quantity: 3 },
      ],
      items: [
        { id: 'i1', name: 'Oversold book', sku: 'S1', warehouse_id: null, quantity_on_hand: 10 },
        { id: 'i2', name: 'Fine book', sku: 'S2', warehouse_id: null, quantity_on_hand: 50 },
      ],
    });
    expect(rules(e)).toEqual(['over_reserved']);
    expect(e.present[0]!.facts).toEqual({ itemName: 'Oversold book', sku: 'S1', promised: 14, onHand: 10 });
    expect(details(e, 'over_reserved')).toEqual(['14 promised, 10 on hand']);
  });

  it('exactly promised out is normal and is not reported', async () => {
    const e = await evaluate({
      reservations: [{ item_id: 'i1', quantity: 10 }],
      items: [{ id: 'i1', name: 'Book', sku: 'S1', warehouse_id: null, quantity_on_hand: 10 }],
    });
    expect(e.present).toEqual([]);
    expect(e.completeRules).toContain('over_reserved');
  });
});

describe('evaluateForSync — uncapped, and complete only when it can vouch', () => {
  it('emits EVERY finding: 150 rows of one rule are all present', async () => {
    // A row past a display cap would read as absent and be RESOLVED by the
    // sync. Mutation caught: restoring PER_RULE_CAP (100).
    const many = Array.from({ length: 150 }, (_, i) =>
      holding({ item: `i${i}`, loc: `l${i}`, kind: 'unplaced', age: 60, locName: 'Unplaced' }),
    );
    const e = await evaluate({ holdings: many });
    expect(e.present.filter((p) => p.rule === 'long_unplaced')).toHaveLength(150);
    expect(e.truncatedRules).toEqual([]);
    expect(e.completeRules).toContain('long_unplaced');
  });

  it('every rule is complete when every read succeeded', async () => {
    const e = await evaluate({});
    expect(e.completeRules).toEqual([
      'orphaned_stock',
      'over_reserved',
      'stale_staging',
      'long_unplaced',
      'label_mismatch',
    ]);
    expect(e.failedRules).toEqual([]);
    expect(e.truncatedRules).toEqual([]);
  });

  it('a failed group is FAILED and left out of complete; the other group still counts', async () => {
    const { ctx } = await systemFor({
      'item_stock_levels.select': { data: null, error: { message: 'holdings read failed' } },
      'stock_reservations.select': { data: [{ item_id: 'i1', quantity: 3 }], error: null },
      'inventory_items.select': {
        data: [{ id: 'i1', name: 'Book', sku: 'S', warehouse_id: null, quantity_on_hand: 1 }],
        error: null,
      },
    });
    const e = await ExceptionsService.evaluateForSync(ctx);
    expect(e.failedRules).toEqual(['orphaned_stock', 'stale_staging', 'long_unplaced', 'label_mismatch']);
    expect(e.completeRules).toEqual(['over_reserved']);
    expect(rules(e)).toEqual(['over_reserved']);
    const tags = reportError.mock.calls.map((c) => (c as unknown as [Error, { tag: string }])[1].tag);
    expect(tags).toEqual(['exceptions.rule_failed']);
  });
});

describe('evaluateForSync — the SOURCE read is paginated', () => {
  /** Honours `.range(from, to)` and never returns more than max_rows (1000),
   *  including when no `.range()` was asked for at all. */
  function rangeAwareHoldings(rows: unknown[]) {
    const rangeCalls: Array<[number, number]> = [];
    const answer = (call: MockCall) => {
      const i = call.methods.indexOf('range');
      if (i === -1) return { data: rows.slice(0, 1000), error: null };
      const [from, to] = call.args[i] as [number, number];
      rangeCalls.push([from, to]);
      return { data: rows.slice(from, Math.min(to + 1, from + 1000)), error: null };
    };
    return { answer, rangeCalls };
  }

  it('finds exceptions living past the PostgREST 1000-row cap', async () => {
    const head = Array.from({ length: 1000 }, (_, i) =>
      holding({ item: `h${i}`, loc: `hl${i}`, kind: 'rack', locName: 'Rack 1-A' }),
    );
    const tail = Array.from({ length: 50 }, (_, i) =>
      holding({ item: `t${i}`, loc: `tl${i}`, kind: 'unplaced', age: 60, locName: 'Unplaced' }),
    );
    const { answer, rangeCalls } = rangeAwareHoldings([...head, ...tail]);
    const { ctx } = await systemFor({ 'item_stock_levels.select': answer });

    const e = await ExceptionsService.evaluateForSync(ctx);

    expect(e.present.filter((p) => p.rule === 'long_unplaced')).toHaveLength(50);
    expect(e.truncatedRules).toEqual([]);
    expect(rangeCalls).toContainEqual([0, 999]);
    expect(rangeCalls).toContainEqual([1000, 1999]);
  });

  it('a read that hits its ceiling marks all four placement rules truncated and NOT complete', async () => {
    // An occurrence past the ceiling would read as absent and resolve.
    // Mutation caught: leaving the four rules in completeRules.
    const head = Array.from({ length: HOLDINGS_SOURCE_CAP }, (_, i) =>
      holding({ item: `h${i}`, loc: `hl${i}`, kind: 'rack', locName: 'Rack 1-A' }),
    );
    const tail = Array.from({ length: 50 }, (_, i) =>
      holding({ item: `t${i}`, loc: `tl${i}`, kind: 'unplaced', age: 60, locName: 'Unplaced' }),
    );
    const { answer } = rangeAwareHoldings([...head, ...tail]);
    const { ctx } = await systemFor({ 'item_stock_levels.select': answer });

    const e = await ExceptionsService.evaluateForSync(ctx);

    expect(e.truncatedRules).toEqual(['orphaned_stock', 'stale_staging', 'long_unplaced', 'label_mismatch']);
    expect(e.completeRules).toEqual(['over_reserved']);
  });

  it('orders by a stable key so a row cannot land on two pages or none', async () => {
    const { ctx, stub } = await systemFor({
      'item_stock_levels.select': { data: [holding({ kind: 'rack' })], error: null },
    });
    await ExceptionsService.evaluateForSync(ctx);
    const chain = stub.chains.get('item_stock_levels.select') ?? [];
    const args = stub.chainArgs.get('item_stock_levels.select') ?? [];
    expect(chain).toContain('order');
    expect(args[chain.indexOf('order')]![0]).toBe('id');
  });

  it('the org filter survives pagination — every page keeps it', async () => {
    const rows = Array.from({ length: 1050 }, (_, i) =>
      holding({ item: `x${i}`, loc: `xl${i}`, kind: 'rack', locName: 'Rack 1-A' }),
    );
    const { answer } = rangeAwareHoldings(rows);
    const { ctx, stub } = await systemFor({ 'item_stock_levels.select': answer });
    await ExceptionsService.evaluateForSync(ctx);
    const all = stub.chainsAll.get('item_stock_levels.select') ?? [];
    const allArgs = stub.chainArgsAll.get('item_stock_levels.select') ?? [];
    expect(all.length).toBeGreaterThanOrEqual(2);
    all.forEach((chain, i) => {
      const at = chain.indexOf('eq');
      expect(allArgs[i]![at]).toEqual(['organization_id', ORG]);
    });
  });
});
