/**
 * READER TOLERANCE — the rack filter must find a rack whether the item is
 * stored DECOMPOSED (rack_number "22" + rack_row "B") or COMPOSITE (the whole
 * label "22-B" parked in the number key, row NULL).
 *
 * Incident 2026-07-23: the filter only ever emitted the decomposed predicate,
 * so eight items stamped from three composite racks matched nothing and the
 * Items page said "No items yet" while the Rack column still read "22-B". The
 * data is repaired, but an import, a restored backup, or a writer that skips
 * the parser could mint a composite row again — the filter must degrade to
 * "still finds them", never to blindness.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./context', () => ({
  withContext: vi.fn(),
  ServiceError: class extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
  assertPermission: vi.fn(),
  assertPlanLimit: vi.fn(),
  assertModuleEnabled: vi.fn(),
}));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [] })),
}));

import { buildRackFilterClause, InventoryService } from './inventory';

function makeStub() {
  const filterCalls: Array<[string, string, unknown]> = [];
  const orCalls: string[] = [];
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    select: self,
    eq: self,
    is: self,
    gt: self,
    lte: self,
    order: self,
    range: self,
    in: self,
    not: self,
    filter: (c: string, op: string, v: unknown) => {
      filterCalls.push([c, op, v]);
      return chain;
    },
    or: (expr: string) => {
      orCalls.push(expr);
      return chain;
    },
    then: (cb: (r: { data: unknown; count: number; error: null }) => unknown) =>
      cb({ data: [], count: 0, error: null }),
  });
  return { from: () => chain, _filterCalls: filterCalls, _orCalls: orCalls };
}

function svc(stub: ReturnType<typeof makeStub>) {
  return new InventoryService({
    supabase: stub as never,
    organizationId: 'org-1',
    userId: 'u1',
    email: 'a@b.c',
    role: 'admin',
  } as never);
}

describe('buildRackFilterClause', () => {
  it('non-book "22-B" matches the decomposed pair OR the whole label', () => {
    const clause = buildRackFilterClause('22-B', 'product');
    expect(clause).toEqual({
      kind: 'or',
      expr:
        'and(custom_fields->>rack_number.eq.22,custom_fields->>rack_row.eq.B),' +
        'custom_fields->>rack_number.eq.22-B',
    });
  });

  it('book "38-A" matches the decomposed pair OR the whole label', () => {
    const clause = buildRackFilterClause('38-A', 'book');
    expect(clause).toEqual({
      kind: 'or',
      expr:
        'and(custom_fields->>book_rack_number.eq.38,custom_fields->>book_rack_row.eq.A),' +
        'custom_fields->>book_rack_number.eq.38-A',
    });
  });

  it("itemType 'all' keeps each row matching its OWN key set, both shapes", () => {
    const clause = buildRackFilterClause('22-B', 'all');
    expect(clause.kind).toBe('or');
    const expr = (clause as { expr: string }).expr;
    // book half: decomposed OR composite
    expect(expr).toContain(
      'and(item_type.eq.book,or(and(custom_fields->>book_rack_number.eq.22,custom_fields->>book_rack_row.eq.B),custom_fields->>book_rack_number.eq.22-B))',
    );
    // non-book half: decomposed OR composite
    expect(expr).toContain(
      'and(item_type.neq.book,or(and(custom_fields->>rack_number.eq.22,custom_fields->>rack_row.eq.B),custom_fields->>rack_number.eq.22-B))',
    );
  });

  it('a bare number keeps the simple single-column equality', () => {
    expect(buildRackFilterClause('12', 'book')).toEqual({
      kind: 'eq',
      column: 'custom_fields->>book_rack_number',
      value: '12',
    });
  });

  it('splits a multi-dash rack on the LAST dash', () => {
    const clause = buildRackFilterClause('E2E-RACK-1', 'product');
    const expr = (clause as { expr: string }).expr;
    expect(expr).toContain('custom_fields->>rack_number.eq.E2E-RACK');
    expect(expr).toContain('custom_fields->>rack_row.eq.1');
    // ...and the legacy alternative is the whole label
    expect(expr).toContain('custom_fields->>rack_number.eq.E2E-RACK-1');
  });

  it('emits no predicate for an empty rack', () => {
    expect(buildRackFilterClause('   ', 'product')).toEqual({ kind: 'none' });
    expect(buildRackFilterClause('---', 'product')).toEqual({ kind: 'none' });
  });

  it('strips injection characters — only alphanumerics and the label dash survive', () => {
    const clause = buildRackFilterClause('20),or(deleted_at.not.is.null', 'all');
    const expr = (clause as { expr: string }).expr;
    expect(expr).not.toContain(')or(');
    expect(expr).not.toContain('deleted_at');
    expect(expr).not.toContain('.not.');
    expect(expr).not.toMatch(/[,(]deleted/);
  });
});

describe('InventoryService.list rack filter tolerates a legacy composite row', () => {
  it('non-book: emits the OR with the composite alternative', async () => {
    const stub = makeStub();
    await svc(stub).list({ rack: '22-B', itemType: 'product' });
    expect(stub._orCalls[0]).toContain('custom_fields->>rack_number.eq.22-B');
    // and the decomposed pair is still required together, not as loose ORs
    expect(stub._orCalls[0]).toContain(
      'and(custom_fields->>rack_number.eq.22,custom_fields->>rack_row.eq.B)',
    );
  });

  it('book: emits the OR with the composite alternative', async () => {
    const stub = makeStub();
    await svc(stub).list({ rack: '38-A', itemType: 'book' });
    expect(stub._orCalls[0]).toContain('custom_fields->>book_rack_number.eq.38-A');
  });

  it('bare number still uses the single equality (no behaviour change)', async () => {
    const stub = makeStub();
    await svc(stub).list({ rack: '12', itemType: 'book' });
    expect(stub._filterCalls).toContainEqual([
      'custom_fields->>book_rack_number',
      'eq',
      '12',
    ]);
    expect(stub._orCalls).toHaveLength(0);
  });
});

describe('countExpectedItems rack filter matches list() exactly', () => {
  it('emits the identical tolerant OR', async () => {
    const listStub = makeStub();
    const countStub = makeStub();
    const service = svc(listStub);
    await service.list({ rack: '22-B', itemType: 'product' });
    // The second builder lives on the expected-count path; drive it through
    // the same public surface so the two can never drift apart silently.
    const countSvc = svc(countStub);
    await (
      countSvc as unknown as {
        countExpected: (o: Record<string, unknown>) => Promise<number>;
      }
    ).countExpected({ rack: '22-B', itemType: 'product' });
    expect(countStub._orCalls[0]).toBe(listStub._orCalls[0]);
  });
});
