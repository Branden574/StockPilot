import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./context', () => ({
  withContext: vi.fn(),
  ServiceError: class extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
  assertPermission: vi.fn(),
  assertPlanLimit: vi.fn(),
}));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [] })),
}));

import { InventoryService } from './inventory';

function makeStub() {
  const eqCalls: Array<[string, unknown]> = [];
  const filterCalls: Array<[string, string, unknown]> = [];
  const ilikeCalls: Array<[string, string]> = [];
  const chain: {
    select: () => typeof chain;
    eq: (c: string, v: unknown) => typeof chain;
    filter: (c: string, op: string, v: unknown) => typeof chain;
    ilike: (c: string, v: string) => typeof chain;
    is: () => typeof chain;
    gt: () => typeof chain;
    lte: () => typeof chain;
    order: () => typeof chain;
    range: () => typeof chain;
    in: () => typeof chain;
    or: () => typeof chain;
    then: (cb: (r: { data: unknown; count: number; error: null }) => unknown) => unknown;
  } = {
    select: () => chain,
    eq: (c, v) => {
      eqCalls.push([c, v]);
      return chain;
    },
    filter: (c, op, v) => {
      filterCalls.push([c, op, v]);
      return chain;
    },
    ilike: (c, v) => {
      ilikeCalls.push([c, v]);
      return chain;
    },
    is: () => chain,
    gt: () => chain,
    lte: () => chain,
    order: () => chain,
    range: () => chain,
    in: () => chain,
    or: () => chain,
    then: (cb) => cb({ data: [], count: 0, error: null }),
  };
  return {
    from: () => chain,
    _eqCalls: eqCalls,
    _filterCalls: filterCalls,
    _ilikeCalls: ilikeCalls,
  };
}

describe('InventoryService.list rack filter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('matches custom_fields.rack_number + rack_row for non-book items', async () => {
    const stub = makeStub();
    const svc = new InventoryService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: stub as any,
      organizationId: 'org-1',
      userId: 'u1',
      email: 'a@b.c',
      role: 'admin',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await svc.list({ rack: '20-A', itemType: 'product' });
    const numCall = stub._filterCalls.find(
      (c) => c[0] === 'custom_fields->>rack_number',
    );
    const rowCall = stub._filterCalls.find(
      (c) => c[0] === 'custom_fields->>rack_row',
    );
    expect(numCall).toEqual(['custom_fields->>rack_number', 'eq', '20']);
    expect(rowCall).toEqual(['custom_fields->>rack_row', 'eq', 'A']);
  });

  it('matches book_rack_number on custom_fields for books', async () => {
    const stub = makeStub();
    const svc = new InventoryService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: stub as any,
      organizationId: 'org-1',
      userId: 'u1',
      email: 'a@b.c',
      role: 'admin',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await svc.list({ rack: '38-A', itemType: 'book' });
    const numCall = stub._filterCalls.find(
      (c) => c[0] === 'custom_fields->>book_rack_number',
    );
    const rowCall = stub._filterCalls.find(
      (c) => c[0] === 'custom_fields->>book_rack_row',
    );
    expect(numCall).toEqual(['custom_fields->>book_rack_number', 'eq', '38']);
    expect(rowCall).toEqual(['custom_fields->>book_rack_row', 'eq', 'A']);
  });

  it('matches bare book number when no row suffix is given', async () => {
    const stub = makeStub();
    const svc = new InventoryService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: stub as any,
      organizationId: 'org-1',
      userId: 'u1',
      email: 'a@b.c',
      role: 'admin',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await svc.list({ rack: '12', itemType: 'book' });
    const numCall = stub._filterCalls.find(
      (c) => c[0] === 'custom_fields->>book_rack_number',
    );
    expect(numCall).toEqual(['custom_fields->>book_rack_number', 'eq', '12']);
    expect(
      stub._filterCalls.find((c) => c[0] === 'custom_fields->>book_rack_row'),
    ).toBeUndefined();
  });
});
