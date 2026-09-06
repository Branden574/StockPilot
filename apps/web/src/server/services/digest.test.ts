import { describe, expect, it } from 'vitest';

import { getDigestData } from './digest';

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
  sku: 'HOT',
  name: 'Fast mover',
  quantity_on_hand: 300,
  reorder_point: 500,
  warehouse_id: 'wh-1',
  warehouse: { name: 'DC4' },
};

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

    const payload = await getDigestData(client, 'org-1');

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

    const payload = await getDigestData(client, 'org-1');

    expect(lowStockIds(payload.lowStock)).toContain('hot');
  });

  it('narrows the pull to rows that can qualify instead of scanning every active item', async () => {
    const items = [...Array.from({ length: 5 }, (_, i) => filler(i)), HOT];
    const { itemChains, client } = makeFakeClient(items);

    await getDigestData(client, 'org-1');

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

    const payload = await getDigestData(client, 'org-1');

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

    const payload = await getDigestData(client, 'org-1');

    expect(lowStockIds(payload.lowStock)).toEqual(['mine']);
  });

  it('omits healthy stock', async () => {
    const items = [filler(1, { quantity_on_hand: 50, reorder_point: 10 })];
    const { client } = makeFakeClient(items);

    const payload = await getDigestData(client, 'org-1');

    expect(payload.lowStock).toEqual([]);
  });
});
