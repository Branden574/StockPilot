import { describe, it, expect, vi } from 'vitest';

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

function buildScopedChain(rows: unknown[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    not: () => chain,
    then: (cb: (r: { data: unknown; error: null }) => unknown) =>
      cb({ data: rows, error: null }),
  };
  return chain;
}

describe('InventoryService.listDistinctRacks', () => {
  it('returns combined "{number}-{row}" labels for items scope', async () => {
    const rows = [
      { custom_fields: { rack_number: '20', rack_row: 'A' } },
      { custom_fields: { rack_number: '5', rack_row: 'B' } },
      { custom_fields: { rack_number: '20', rack_row: 'A' } },
      { custom_fields: { rack_number: '12' } },
      { custom_fields: null },
    ];
    const chain = buildScopedChain(rows);
    const svc = new InventoryService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: { from: () => chain } as any,
      organizationId: 'org-1',
      userId: 'u1',
      email: 'a@b.c',
      role: 'admin',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const out = await svc.listDistinctRacks({ scope: 'items' });
    expect(out).toEqual(['12', '20-A', '5-B']);
  });

  it('returns combined "{number}-{row}" labels for books scope', async () => {
    const rows = [
      { custom_fields: { book_rack_number: '38', book_rack_row: 'A' } },
      { custom_fields: { book_rack_number: '38', book_rack_row: 'A' } },
      { custom_fields: { book_rack_number: '12' } },
      { custom_fields: {} },
    ];
    const chain = buildScopedChain(rows);
    const svc = new InventoryService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: { from: () => chain } as any,
      organizationId: 'org-1',
      userId: 'u1',
      email: 'a@b.c',
      role: 'admin',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const out = await svc.listDistinctRacks({ scope: 'books' });
    expect(out).toEqual(['12', '38-A']);
  });
});
