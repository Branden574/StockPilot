import { beforeEach, describe, expect, it, vi } from 'vitest';

import { describeOccurrence, type ExceptionRule } from '@stockpilot/core';

import { makeSupabaseStub, servedLikePostgrest, type MockCall } from '@/test/supabase-mock';

const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

import { type ServiceContext } from './context';
import {
  COUNT_LINES_SOURCE_CAP,
  ExceptionsService,
  HOLDINGS_SOURCE_CAP,
  type SyncEvaluation,
} from './exceptions';
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
  /** The item's warehouse and the location's (default 'wh-1'; null = none). */
  itemWh?: string | null;
  locWh?: string | null;
  sku?: string | null;
}) {
  return {
    id: `isl-${o.item ?? 'i1'}-${o.loc ?? 'l1'}`,
    quantity: o.qty ?? 5,
    positive_since: o.age === null ? null : daysAgo(o.age ?? 0),
    updated_at: daysAgo(o.touched ?? 0),
    item_id: o.item ?? 'i1',
    location_id: o.loc ?? 'l1',
    inventory_items: {
      name: o.name ?? 'A book',
      sku: o.sku === undefined ? 'SKU-1' : o.sku,
      bin_location: o.bin ?? null,
      warehouse_id: o.itemWh === undefined ? 'wh-1' : o.itemWh,
    },
    locations: {
      id: o.loc ?? 'l1',
      name: o.locName ?? 'Rack 1-A',
      kind: o.kind === undefined ? 'rack' : o.kind,
      warehouse_id: o.locWh === undefined ? 'wh-1' : o.locWh,
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

  it('names only racks every reader of the item may see holdings at: its own warehouse, or none', async () => {
    // item_stock_levels_select hides holdings outside the reader's
    // warehouses, and a label row is visible to anyone who can read the item.
    // Mutation caught: listing every rack in the org.
    const e = await evaluate({
      holdings: [
        holding({ item: 'i9', bin: '99-Z', loc: 'a', locName: '12-A', locWh: 'wh-1' }),
        holding({ item: 'i9', bin: '99-Z', loc: 'b', locName: '77-B', locWh: 'wh-other' }),
        holding({ item: 'i9', bin: '99-Z', loc: 'c', locName: '5-C', locWh: null }),
      ],
    });
    expect(rules(e)).toEqual(['label_mismatch']);
    expect(e.present[0]!.facts).toMatchObject({ stockOn: ['12-A', '5-C'] });
    expect(JSON.stringify(e.present[0]!.facts)).not.toContain('77-B');
  });

  it('stock only in another warehouse still compares (a match there is no mismatch), and names nothing', async () => {
    const matchElsewhere = await evaluate({
      holdings: [holding({ item: 'i9', bin: '77-B', loc: 'b', locName: '77-B', locWh: 'wh-other' })],
    });
    expect(matchElsewhere.present).toEqual([]);
    const mismatch = await evaluate({
      holdings: [holding({ item: 'i9', bin: '99-Z', loc: 'b', locName: '77-B', locWh: 'wh-other' })],
    });
    expect(details(mismatch, 'label_mismatch')).toEqual(['labelled 99-Z, which holds none of its stock']);
  });

  it('lists at most ten racks and counts the rest', async () => {
    const e = await evaluate({
      holdings: Array.from({ length: 13 }, (_, i) =>
        holding({ item: 'i9', bin: '99-Z', loc: `l${i}`, locName: `${String(i + 10)}-A` }),
      ),
    });
    const facts = e.present[0]!.facts as { stockOn: string[]; stockOnMore?: number };
    expect(facts.stockOn).toHaveLength(10);
    expect(facts.stockOnMore).toBe(3);
    expect(details(e, 'label_mismatch')[0]).toMatch(/ and 3 more$/);
  });
});

describe('evaluateForSync — facts stay small whatever the names are', () => {
  it('clips a 20,000-character name, SKU, label and location name', async () => {
    // Names have no length limit in the database. An unclipped facts object
    // past 16 KB is stored empty by exceptions_sync (it used to fail the
    // whole org's sync). Mutation caught: copying the names unclipped.
    const huge = 'x'.repeat(20_000);
    const e = await evaluate({
      holdings: [
        holding({ item: 'a', loc: 'la', name: huge, sku: huge, bin: `${huge}-Z`, locName: `${huge}-A` }),
        holding({ item: 'b', loc: 'lb', name: huge, sku: huge, kind: 'staging', locName: huge, age: 30 }),
      ],
      reservations: [{ item_id: 'c', quantity: 9 }],
      items: [{ id: 'c', name: huge, sku: huge, warehouse_id: 'wh-1', quantity_on_hand: 1 }],
    });
    expect(rules(e).sort()).toEqual(['label_mismatch', 'over_reserved', 'stale_staging']);
    for (const p of e.present) {
      const f = p.facts as unknown as Record<string, unknown>;
      expect(JSON.stringify(f).length).toBeLessThan(2_000);
      expect(Array.from(String(f.itemName))).toHaveLength(200);
      expect(String(f.itemName).endsWith('…')).toBe(true);
      if (typeof f.sku === 'string') expect(Array.from(f.sku)).toHaveLength(100);
    }
    const label = e.present.find((p) => p.rule === 'label_mismatch')!.facts as { label: string; stockOn: string[] };
    expect(Array.from(label.label).length).toBeLessThanOrEqual(100);
    for (const r of label.stockOn) expect(Array.from(r).length).toBeLessThanOrEqual(100);
  });

  it('leaves a name at the limit untouched', async () => {
    const e = await evaluate({
      holdings: [holding({ name: 'y'.repeat(200), kind: 'staging', locName: 'Staging', age: 30 })],
    });
    expect((e.present[0]!.facts as { itemName: string }).itemName).toBe('y'.repeat(200));
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
      'count_variance',
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
    expect(e.completeRules).toEqual(['over_reserved', 'count_variance']);
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
    expect(e.completeRules).toEqual(['over_reserved', 'count_variance']);
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

/** One row of _latest_count_lines (0372), for an item counted `completedDaysAgo`. */
function countLine(o: {
  item: string;
  counted?: number | string | null;
  expected?: number | string | null;
  completedDaysAgo?: number | null;
  countable?: boolean;
  countNumber?: number | null;
  location?: string | null;
  ai?: boolean;
  capturedMinutesBeforeWrite?: number | null;
  baselineAt?: string | null;
  countedAt?: string | null;
  name?: string;
}) {
  const completedAt =
    o.completedDaysAgo === null ? null : new Date(Date.now() - (o.completedDaysAgo ?? 1) * DAY).toISOString();
  const countedAt = o.countedAt ?? (completedAt ? new Date(Date.parse(completedAt) - 3_600_000).toISOString() : null);
  const capturedAt =
    o.capturedMinutesBeforeWrite == null || !countedAt
      ? null
      : new Date(Date.parse(countedAt) - o.capturedMinutesBeforeWrite * 60_000).toISOString();
  return {
    item_id: o.item,
    cycle_count_id: `cc-${o.item}`,
    count_number: o.countNumber === undefined ? 24 : o.countNumber,
    scope: 'selection',
    completed_at: completedAt,
    completed_by: 'u-mgr',
    counted_by: 'u-staff',
    counted_at: countedAt,
    captured_at: capturedAt,
    baseline_at: o.baselineAt === undefined ? (capturedAt ?? countedAt) : o.baselineAt,
    expected_quantity: o.expected === undefined ? 10 : o.expected,
    expected_at_start: 10,
    counted_quantity: o.counted === undefined ? 11 : o.counted,
    counted_location_id: o.location ? `loc-${o.item}` : null,
    counted_location_name: o.location ?? null,
    ai_assisted: o.ai ?? false,
    line_warehouse_id: 'wh-1',
    item_name: o.name ?? `Item ${o.item}`,
    item_sku: `SKU-${o.item}`,
    item_warehouse_id: 'wh-1',
    item_countable: o.countable ?? true,
  };
}

async function evaluateCounts(lines: unknown[]) {
  const { ctx, stub } = await systemFor({
    'rpc:_latest_count_lines': servedLikePostgrest(lines as Array<Record<string, unknown>>),
  });
  return { e: await ExceptionsService.evaluateForSync(ctx), stub };
}

const variance = (e: SyncEvaluation) => e.present.filter((p) => p.rule === 'count_variance');
const varianceHold = (e: SyncEvaluation) => e.hold.filter((h) => h.rule === 'count_variance');

describe('evaluateForSync — count_variance (F1-2)', () => {
  it('opens for a non-zero variance in a count completed within 30 days, with the count\'s facts', async () => {
    const { e } = await evaluateCounts([
      countLine({ item: 'a', counted: 11, expected: 10, completedDaysAgo: 2, location: 'Rack 12-A', ai: true }),
    ]);
    const [p] = variance(e);
    expect(p).toMatchObject({ rule: 'count_variance', itemId: 'a', locationId: null, warehouseId: 'wh-1' });
    expect(p!.facts).toEqual({
      itemName: 'Item a',
      sku: 'SKU-a',
      cycleCountId: 'cc-a',
      countNumber: 24,
      observedAt: expect.any(String),
      completedAt: expect.any(String),
      expected: 10,
      counted: 11,
      variance: 1,
      countedLocationName: 'Rack 12-A',
      aiAssisted: true,
      capturedOfflineAt: null,
    });
    expect(describeOccurrence('count_variance', p!.facts).detail).toBe('found +1: counted 11, book 10 (CC-000024)');
    expect(e.completeRules).toContain('count_variance');
  });

  it('the condition started when the counted quantity was observed (baseline, else recorded)', async () => {
    const baseline = '2026-09-20T10:00:00.000Z';
    const { e } = await evaluateCounts([
      countLine({ item: 'a', baselineAt: baseline }),
      countLine({ item: 'b', baselineAt: null, countedAt: '2026-09-21T09:00:00.000Z' }),
    ]);
    const byItem = Object.fromEntries(variance(e).map((p) => [p.itemId, p]));
    expect(byItem.a!.conditionSince).toBe(baseline);
    expect((byItem.a!.facts as { observedAt: string }).observedAt).toBe(baseline);
    expect(byItem.b!.conditionSince).toBe('2026-09-21T09:00:00.000Z');
  });

  it('a count taken offline and synced later carries its capture time; an online record does not', async () => {
    const { e } = await evaluateCounts([
      countLine({ item: 'off', capturedMinutesBeforeWrite: 90 }),
      countLine({ item: 'on', capturedMinutesBeforeWrite: 0 }),
    ]);
    const byItem = Object.fromEntries(variance(e).map((p) => [p.itemId, p.facts as { capturedOfflineAt: string | null }]));
    expect(byItem.off!.capturedOfflineAt).toEqual(expect.any(String));
    expect(byItem.on!.capturedOfflineAt).toBeNull();
  });

  // Mutation caught: opening regardless of age (dropping the window) — 9 old
  // L4L variances would open on day one; or treating old ones as absent, which
  // would RESOLVE an open row just because time passed.
  it('an older variance is HELD: it neither opens nor resolves', async () => {
    const { e } = await evaluateCounts([
      countLine({ item: 'old', completedDaysAgo: 31 }),
      countLine({ item: 'edge', completedDaysAgo: 29 }),
    ]);
    expect(variance(e).map((p) => p.itemId)).toEqual(['edge']);
    expect(varianceHold(e)).toEqual([{ rule: 'count_variance', itemId: 'old', locationId: null }]);
  });

  it('a count that matched the book is absent, so an open row clears — exactly, not approximately', async () => {
    const { e } = await evaluateCounts([
      countLine({ item: 'same', counted: 10, expected: 10 }),
      countLine({ item: 'str', counted: '10.0000', expected: '10' }),
      countLine({ item: 'tiny', counted: 10.1, expected: 10 }),
    ]);
    expect(variance(e).map((p) => p.itemId)).toEqual(['tiny']);
    expect((variance(e)[0]!.facts as { variance: number }).variance).toBe(0.1);
    expect(varianceHold(e)).toEqual([]);
  });

  // Mutation caught: dropping the item_countable filter (rental equipment and
  // kits are never counted, so a recount could never settle them).
  it('rental equipment, kits, archived and deleted items are left out', async () => {
    const { e } = await evaluateCounts([countLine({ item: 'rental', countable: false })]);
    expect(variance(e)).toEqual([]);
    expect(varianceHold(e)).toEqual([]);
  });

  it('a line it cannot read is held, never guessed either way', async () => {
    const { e } = await evaluateCounts([
      countLine({ item: 'nan', counted: 'x' }),
      countLine({ item: 'nodate', completedDaysAgo: null }),
    ]);
    expect(variance(e)).toEqual([]);
    expect(varianceHold(e).map((h) => h.itemId).sort()).toEqual(['nan', 'nodate']);
  });

  it('reads through _latest_count_lines for THIS org only, paged by item_id', async () => {
    const { stub } = await evaluateCounts([countLine({ item: 'a' })]);
    const calls = stub.rpcCalls.filter((c) => c.name === '_latest_count_lines');
    expect(calls).toHaveLength(1);
    // The p_org argument is this read's tenant boundary under the service role.
    expect(calls[0]!.args).toEqual({ p_org: ORG, p_item_ids: null });
  });

  it('emits every variance past the 1000-row page (no per-rule cap)', async () => {
    const lines = Array.from({ length: 1150 }, (_, i) => countLine({ item: `i${String(i).padStart(5, '0')}` }));
    const { e } = await evaluateCounts(lines);
    expect(variance(e)).toHaveLength(1150);
    expect(e.truncatedRules).not.toContain('count_variance');
  });

  it('a read that fails leaves count_variance FAILED and out of complete; the other rules still count', async () => {
    const { ctx } = await systemFor({
      'rpc:_latest_count_lines': { data: null, error: { message: 'boom' } },
    });
    const e = await ExceptionsService.evaluateForSync(ctx);
    expect(e.failedRules).toEqual(['count_variance']);
    expect(e.completeRules).not.toContain('count_variance');
    expect(e.completeRules).toContain('over_reserved');
    const tags = reportError.mock.calls.map((c) => (c as unknown as [Error, { tag: string }])[1].tag);
    expect(tags).toEqual(['exceptions.rule_failed']);
  });

  it('a read that hits its ceiling marks count_variance truncated and NOT complete', async () => {
    const lines = Array.from({ length: COUNT_LINES_SOURCE_CAP + 5 }, (_, i) =>
      countLine({ item: `i${String(i).padStart(6, '0')}`, counted: 10, expected: 10 }),
    );
    const { e } = await evaluateCounts(lines);
    expect(e.truncatedRules).toEqual(['count_variance']);
    expect(e.completeRules).not.toContain('count_variance');
  });
});
