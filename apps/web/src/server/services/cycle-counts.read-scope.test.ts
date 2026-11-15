// Which cycle counts a member reads: one rule (lib/auth/count-read-scope.ts)
// behind the count list (listPage: the web list and GET /api/v1/cycle-counts)
// and the count itself (getDetailPage: the web count page; get: the count
// sheet and variance report). The phone's sync applies the same rule in
// app/api/v1/mobile/snapshot/route.count-scope.test.ts, and a count's linked
// exceptions in
// app/api/v1/cycle-counts/[id]/exceptions/route.count-read-scope.test.ts.
//
//   - managers and above, and members with every warehouse: every count;
//   - anyone else: a count in a warehouse they can read, and a count with no
//     warehouse only when it is assigned to them;
//   - a member with no readable warehouse: none.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/auth/warehouse', () => {
  class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  }
  const getWarehouseAccess = vi.fn();
  return {
    getWarehouseAccess,
    // The real rule for a read, from the same access answer: every warehouse,
    // or one of the readable ones.
    assertWarehouseAccess: vi.fn(async (warehouseId: string) => {
      const access = await getWarehouseAccess();
      if (access.hasAllAccess || access.readableIds.includes(warehouseId)) return;
      throw new ForbiddenError('No access to that warehouse.');
    }),
    forcedWarehouseId: vi.fn(async () => null),
    ForbiddenError,
  };
});

vi.mock('@/lib/dashboard/cached-org', () => ({
  getCachedOrgTimezone: vi.fn(async () => 'America/Los_Angeles'),
}));

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    userId: 'user-test',
    organizationId: 'org-test',
    role: 'admin',
  })),
}));

import { getWarehouseAccess } from '@/lib/auth/warehouse';

import { CycleCountsService } from './cycle-counts';

const ME = 'u-dana';
const SOMEONE_ELSE = 'u-lee';

/** A member limited to these warehouses. A viewer writes to none of them. */
function limitedTo(readable: string[], writable: string[] = readable) {
  vi.mocked(getWarehouseAccess).mockResolvedValue({
    readableIds: readable,
    writableIds: writable,
    hasAllAccess: false,
    primaryWarehouseId: readable[0] ?? null,
  });
}

function everyWarehouseMember() {
  vi.mocked(getWarehouseAccess).mockResolvedValue({
    readableIds: ['wh-a'],
    writableIds: ['wh-a'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  });
}

function accessUnreadable() {
  vi.mocked(getWarehouseAccess).mockResolvedValue({
    readableIds: [],
    writableIds: [],
    hasAllAccess: false,
    primaryWarehouseId: null,
    unreadable: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  limitedTo(['wh-a']);
});

type Caller = Parameters<typeof makeServiceContext>[1];

const STAFF: Caller = { role: 'staff', userId: ME };
const AUDITOR: Caller = {
  role: 'viewer',
  userId: ME,
  permissions: new Set(['cycle_counts:read']),
};

/** A service over one count header, with one line behind it. */
function svcOver(header: Record<string, unknown>, caller: Caller = STAFF) {
  const stub = makeSupabaseStub({
    'cycle_counts.select': {
      data: {
        id: 'cc-1',
        organization_id: 'org-test',
        status: 'in_progress',
        warehouse_id: null,
        assigned_to: null,
        ...header,
      },
      error: null,
    },
    'cycle_count_lines.select': {
      data: [
        {
          id: 'l-1',
          cycle_count_id: 'cc-1',
          item_id: 'it-1',
          warehouse_id: 'wh-b',
          expected_quantity: 4,
          counted_quantity: null,
          item: { id: 'it-1', name: 'Sample item', sku: 'SAMPLE-1', unit_of_measure: 'ea' },
        },
      ],
      error: null,
    },
    'rpc:cycle_count_lines_page': {
      data: [
        {
          id: 'l-1',
          cycle_count_id: 'cc-1',
          item_id: 'it-1',
          warehouse_id: 'wh-b',
          expected_quantity: '4.0000',
          counted_quantity: null,
          item_name: 'Sample item',
          item_sku: 'SAMPLE-1',
          item_uom: 'ea',
          item_barcode: null,
          full_count: 1,
        },
      ],
      error: null,
    },
    'rpc:cycle_count_summary': {
      data: [{ total: 1, counted: 0, variance_count: 0, net_delta: '0' }],
      error: null,
    },
    'inventory_items.select': { data: [], error: null },
  });
  const svc = new CycleCountsService(makeServiceContext(stub.client, caller));
  return { stub, svc };
}

/** Both readers of one count: the page (getDetailPage) and the sheet (get). */
const READERS: Array<[string, (svc: CycleCountsService) => Promise<{ lines: unknown[] }>]> = [
  ['getDetailPage', (svc) => svc.getDetailPage('cc-1')],
  ['get', (svc) => svc.get('cc-1')],
];

/** No line of the count was read, by table or by function. */
function expectNoLineRead(stub: ReturnType<typeof makeSupabaseStub>) {
  expect(stub.fromCalls).not.toContain('cycle_count_lines');
  expect(stub.rpcCalls.map((c) => c.name)).toEqual([]);
}

describe.each(READERS)('%s: a member limited to some warehouses', (_name, read) => {
  it('reads a count in a warehouse they can read', async () => {
    const { svc } = svcOver({ warehouse_id: 'wh-a' });
    await expect(read(svc)).resolves.toMatchObject({ lines: [{ id: 'l-1' }] });
  });

  it('a read-only member reads a count in a warehouse they can read', async () => {
    limitedTo(['wh-a'], []);
    const { svc } = svcOver({ warehouse_id: 'wh-a' }, AUDITOR);
    await expect(read(svc)).resolves.toMatchObject({ lines: [{ id: 'l-1' }] });
  });

  it('a count in another warehouse is not found, and no line is read', async () => {
    const { stub, svc } = svcOver({ warehouse_id: 'wh-b' });
    await expect(read(svc)).rejects.toMatchObject({ code: 'not_found' });
    expectNoLineRead(stub);
  });

  it('a count in another warehouse is not found even when it is assigned to them', async () => {
    const { stub, svc } = svcOver({ warehouse_id: 'wh-b', assigned_to: ME });
    await expect(read(svc)).rejects.toMatchObject({ code: 'not_found' });
    expectNoLineRead(stub);
  });

  it('reads a count with no warehouse that is assigned to them', async () => {
    const { svc } = svcOver({ warehouse_id: null, assigned_to: ME });
    await expect(read(svc)).resolves.toMatchObject({ lines: [{ id: 'l-1' }] });
  });

  it('a count with no warehouse that is assigned to nobody is not found, and no line is read', async () => {
    const { stub, svc } = svcOver({ warehouse_id: null, assigned_to: null });
    await expect(read(svc)).rejects.toMatchObject({ code: 'not_found' });
    expectNoLineRead(stub);
  });

  it('a count with no warehouse that is assigned to someone else is not found, and no line is read', async () => {
    const { stub, svc } = svcOver({ warehouse_id: null, assigned_to: SOMEONE_ELSE });
    await expect(read(svc)).rejects.toMatchObject({ code: 'not_found' });
    expectNoLineRead(stub);
  });

  it('a member with no readable warehouse finds no count, their own assignment included', async () => {
    limitedTo([]);
    for (const header of [
      { warehouse_id: null, assigned_to: ME },
      { warehouse_id: null, assigned_to: null },
      { warehouse_id: 'wh-a', assigned_to: ME },
    ]) {
      const { stub, svc } = svcOver(header);
      await expect(read(svc), JSON.stringify(header)).rejects.toMatchObject({ code: 'not_found' });
      expectNoLineRead(stub);
    }
  });

  it('answers the same words for every count it does not show', async () => {
    const messages = new Set<string>();
    for (const header of [
      { warehouse_id: 'wh-b' },
      { warehouse_id: null, assigned_to: null },
      { warehouse_id: null, assigned_to: SOMEONE_ELSE },
    ]) {
      const { svc } = svcOver(header);
      await read(svc).catch((e: Error) => messages.add(e.message));
    }
    expect([...messages]).toEqual(['Cycle count not found']);
  });

  it('warehouse access that could not be read is an error to try again, never a count and never "not found"', async () => {
    accessUnreadable();
    for (const header of [
      { warehouse_id: null, assigned_to: ME },
      { warehouse_id: 'wh-a' },
    ]) {
      const { stub, svc } = svcOver(header);
      await expect(read(svc), JSON.stringify(header)).rejects.toMatchObject({
        code: 'internal_error',
      });
      expectNoLineRead(stub);
    }
  });
});

describe.each(READERS)('%s: members who see every warehouse', (_name, read) => {
  const HEADERS = [
    { warehouse_id: 'wh-b' },
    { warehouse_id: null, assigned_to: null },
    { warehouse_id: null, assigned_to: SOMEONE_ELSE },
  ];

  it.each(['owner', 'admin', 'manager'] as const)(
    '%s reads every count, and no warehouse access read is made to decide it',
    async (role) => {
      // The role decides; were the access read, it would say every warehouse.
      everyWarehouseMember();
      for (const header of HEADERS) {
        const { svc } = svcOver(header, { role, userId: ME });
        await expect(read(svc), JSON.stringify(header)).resolves.toMatchObject({
          lines: [{ id: 'l-1' }],
        });
      }
      expect(getWarehouseAccess).not.toHaveBeenCalled();
    },
  );

  it('a staff member with every warehouse reads every count', async () => {
    everyWarehouseMember();
    for (const header of HEADERS) {
      const { svc } = svcOver(header);
      await expect(read(svc), JSON.stringify(header)).resolves.toMatchObject({
        lines: [{ id: 'l-1' }],
      });
    }
  });
});

describe('listPage: the same rule, handed to the list function as its warehouse list', () => {
  function listSvc(caller: Caller) {
    const stub = makeSupabaseStub({ 'rpc:cycle_counts_page': { data: [], error: null } });
    const svc = new CycleCountsService(makeServiceContext(stub.client, caller));
    const scope = () =>
      (
        stub.rpcCalls.find((c) => c.name === 'cycle_counts_page')?.args as
          | Record<string, unknown>
          | undefined
      )?.p_scope_warehouse_ids;
    return { stub, svc, scope };
  }

  it('a staff member is narrowed to the warehouses they can read', async () => {
    limitedTo(['wh-a', 'wh-c']);
    const { svc, scope } = listSvc(STAFF);
    await svc.listPage();
    expect(scope()).toEqual(['wh-a', 'wh-c']);
  });

  it('a read-only member lists the counts of the warehouses they can read', async () => {
    limitedTo(['wh-a'], []);
    const { svc, scope } = listSvc(AUDITOR);
    await svc.listPage();
    expect(scope()).toEqual(['wh-a']);
  });

  it('a member with no readable warehouse lists nothing, and the list function is not called', async () => {
    limitedTo([]);
    const { stub, svc } = listSvc(STAFF);
    const res = await svc.listPage({}, { includeSummary: true });
    expect(res.items).toEqual([]);
    expect(res.total).toBe(0);
    expect(res.summary).toMatchObject({ inProgress: 0, startedToday: 0 });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('a manager is not narrowed', async () => {
    const { svc, scope } = listSvc({ role: 'manager', userId: ME });
    await svc.listPage();
    expect(scope()).toBeNull();
    expect(getWarehouseAccess).not.toHaveBeenCalled();
  });

  it('a staff member with every warehouse is not narrowed', async () => {
    everyWarehouseMember();
    const { svc, scope } = listSvc(STAFF);
    await svc.listPage();
    expect(scope()).toBeNull();
  });
});
