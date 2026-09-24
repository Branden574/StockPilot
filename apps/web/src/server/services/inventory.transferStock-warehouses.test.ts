import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * transfer_stock (0365) refuses a move below manager unless BOTH locations are
 * in warehouses the caller can write, raising a bare 42501 'forbidden'. The
 * service now checks the same thing first, so the caller is told why and no
 * round-trip is spent on a move that cannot happen.
 *
 * The real assertWarehouseAccess runs here; only the access list it reads
 * (getWarehouseAccess) is stubbed, so the refusal is decided by the same rule
 * the rest of the app uses.
 */
const { access } = vi.hoisted(() => ({
  access: {
    current: {
      readableIds: ['wh-a'],
      writableIds: ['wh-a'],
      hasAllAccess: false,
      primaryWarehouseId: 'wh-a',
    },
  },
}));
vi.mock('@/lib/auth/warehouse', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/warehouse')>()),
  getWarehouseAccess: vi.fn(async () => access.current),
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));

import { InventoryService, TRANSFER_WAREHOUSE_WRITE_REFUSED } from './inventory';

const INPUT = {
  itemId: '11111111-1111-1111-1111-111111111111',
  fromLocationId: 'loc-a',
  toLocationId: 'loc-b',
  quantity: 2,
};

function build(
  role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
  locations: { data: unknown; error: { message: string } | null },
  rpc: { data: unknown; error: { message: string; code?: string } | null } = {
    data: { ok: true },
    error: null,
  },
) {
  const stub = makeSupabaseStub({
    'locations.select': locations,
    'rpc:transfer_stock': rpc,
  });
  const svc = new InventoryService(makeServiceContext(stub.client, { role }));
  return { stub, svc };
}

const bothInA = {
  data: [
    { id: 'loc-a', warehouse_id: 'wh-a' },
    { id: 'loc-b', warehouse_id: 'wh-a' },
  ],
  error: null,
};
const intoB = {
  data: [
    { id: 'loc-a', warehouse_id: 'wh-a' },
    { id: 'loc-b', warehouse_id: 'wh-b' },
  ],
  error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  access.current = {
    readableIds: ['wh-a'],
    writableIds: ['wh-a'],
    hasAllAccess: false,
    primaryWarehouseId: 'wh-a',
  };
});

describe('InventoryService.transferStock — warehouse write access below manager', () => {
  it('refuses staff moving stock INTO a warehouse they cannot write, before any rpc call', async () => {
    const { stub, svc } = build('staff', intoB);
    await expect(svc.transferStock(INPUT)).rejects.toMatchObject({
      code: 'forbidden',
      message: TRANSFER_WAREHOUSE_WRITE_REFUSED,
    });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('refuses staff moving stock OUT of a warehouse they cannot write', async () => {
    const { stub, svc } = build('staff', {
      data: [
        { id: 'loc-a', warehouse_id: 'wh-b' },
        { id: 'loc-b', warehouse_id: 'wh-a' },
      ],
      error: null,
    });
    await expect(svc.transferStock(INPUT)).rejects.toMatchObject({ code: 'forbidden' });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('lets staff move stock between locations in a warehouse they work in', async () => {
    const { stub, svc } = build('staff', bothInA);
    await svc.transferStock(INPUT);
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['transfer_stock']);
    // The location read is scoped to the caller's org and names both ends.
    const args = stub.chainArgs.get('locations.select') ?? [];
    expect(args).toContainEqual(['organization_id', 'org-test']);
    expect(args).toContainEqual(['id', ['loc-a', 'loc-b']]);
  });

  it('fails a failed location read as internal_error, never as "nothing to check"', async () => {
    const { stub, svc } = build('staff', { data: null, error: { message: 'connection reset' } });
    await expect(svc.transferStock(INPUT)).rejects.toMatchObject({ code: 'internal_error' });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('leaves an org-level location (no warehouse) to the RPC', async () => {
    const { stub, svc } = build('staff', {
      data: [
        { id: 'loc-a', warehouse_id: 'wh-a' },
        { id: 'loc-b', warehouse_id: null },
      ],
      error: null,
    });
    await svc.transferStock(INPUT);
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['transfer_stock']);
  });

  it.each(['manager', 'admin', 'owner'] as const)(
    'role %s bypasses the check: no location read, straight to the RPC',
    async (role) => {
      const { stub, svc } = build(role, intoB);
      await svc.transferStock(INPUT);
      expect(stub.fromCalls).not.toContain('locations');
      expect(stub.rpcCalls.map((c) => c.name)).toEqual(['transfer_stock']);
    },
  );

  it("still maps the RPC's own 'forbidden' when the app check passes", async () => {
    const { stub, svc } = build('staff', bothInA, {
      data: null,
      error: { message: 'forbidden', code: '42501' },
    });
    await expect(svc.transferStock(INPUT)).rejects.toMatchObject({
      code: 'forbidden',
      message: 'Permission denied',
    });
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['transfer_stock']);
  });
});
