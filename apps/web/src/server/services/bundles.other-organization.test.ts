// Security invariant (S39, listed in scripts/security-test.sh): a write named by
// a row id never runs on a row of another organization.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeSupabaseStub().client }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

import { audit } from './audit';
import { BundlesService } from './bundles';
import { invalidateInventoryListAfterWrite } from './lib/inventory-list-cache';

/**
 * S39: a kit of organization B, saved, assembled or handed out from a page
 * left open after the person switched to organization A.
 *
 *   - Save: the kit row's update is filtered to A and matched nothing, but the
 *     component rows were upserted and deleted by bundle_id alone, which the
 *     component write policy admits for a manager of B. B's kit was rewritten,
 *     A's audit log recorded it, and only then did the scoped re-read refuse.
 *   - Assemble and hand out: assertWarehouseAccess passes a manager by role
 *     without asking whose warehouse it is, and the ledger functions decide on
 *     the kit's own organization, so B's stock moved while the audit row and
 *     the cache invalidation went to A.
 *
 * The kit is now read in A first; a miss refuses before anything is written.
 */

const KIT_ID = '00000000-0000-4000-8000-0000000000b1';
const ITEM_1 = '11111111-1111-4111-8111-111111111111';
const ITEM_2 = '22222222-2222-4222-8222-222222222222';
const WAREHOUSE_ID = 'wh-b';

const B_KIT = {
  id: KIT_ID,
  organization_id: 'org-B',
  name: 'Example kit',
  phantom_item_id: null,
  preassembly_enabled: true,
  is_active: true,
};

function stubFor() {
  return makeSupabaseStub({
    'bundles.select': servedLikePostgrest([B_KIT]),
    'bundle_components.select': (call) =>
      // The save's read-back asks for item_id; get() embeds the item.
      call.args[0]?.[0] === 'item_id'
        ? { data: [{ item_id: ITEM_1 }, { item_id: ITEM_2 }], error: null }
        : { data: [], error: null },
    'bundle_components.insert': { data: null, error: null },
    'bundle_components.delete': { data: null, error: null },
    'bundles.update': { data: null, error: null },
    'rpc:assemble_bundle': {
      data: [{ phantom_item_id: 'phantom-1', phantom_qty: 2 }],
      error: null,
    },
    'rpc:distribute_bundle': { data: 'dist-1', error: null },
  });
}

function svc(
  stub: ReturnType<typeof makeSupabaseStub>,
  org: string,
  opts: { role?: 'manager' | 'staff'; permissions?: ReadonlySet<string> } = {},
) {
  return new BundlesService(
    makeServiceContext(stub.client, {
      organizationId: org,
      role: opts.role ?? 'manager',
      ...(opts.permissions ? { permissions: opts.permissions } : {}),
    }),
  );
}

const SAVE = {
  name: 'Example kit',
  preassemblyEnabled: true,
  components: [
    { itemId: ITEM_1, quantity: 1 },
    { itemId: ITEM_2, quantity: 2 },
  ],
};

function expectKitReadInA(stub: ReturnType<typeof makeSupabaseStub>) {
  expect(stub.chainArgsAll.get('bundles.select')?.[0]).toEqual(
    expect.arrayContaining([
      ['organization_id', 'org-A'],
      ['id', KIT_ID],
    ]),
  );
}

beforeEach(() => vi.clearAllMocks());

describe('update: a kit of another organization is not found, and nothing is written', () => {
  it('saving a kit that is not in A writes no kit row, no component and no audit row', async () => {
    const stub = stubFor();

    await expect(svc(stub, 'org-A').update(KIT_ID, SAVE)).rejects.toMatchObject({
      code: 'not_found',
      message: 'Bundle not found',
    });

    expectKitReadInA(stub);
    expect(stub.chains.get('bundles.update')).toBeUndefined();
    expect(stub.chains.get('bundle_components.insert')).toBeUndefined();
    expect(stub.chains.get('bundle_components.delete')).toBeUndefined();
    expect(audit).not.toHaveBeenCalled();
  });

  it('refuses a rename alone the same way', async () => {
    const stub = stubFor();

    await expect(svc(stub, 'org-A').update(KIT_ID, { name: 'Renamed kit' })).rejects.toMatchObject({
      code: 'not_found',
      message: 'Bundle not found',
    });

    expect(stub.chains.get('bundles.update')).toBeUndefined();
    expect(audit).not.toHaveBeenCalled();
  });

  it('working in B, the save writes the components and is recorded in B', async () => {
    const stub = stubFor();

    await svc(stub, 'org-B').update(KIT_ID, SAVE);

    expect(stub.chains.get('bundle_components.insert')?.[0]).toBe('upsert');
    expect(stub.chains.get('bundle_components.delete')).toBeDefined();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'bundle.updated', entityId: KIT_ID }),
      expect.objectContaining({ organizationId: 'org-B' }),
    );
  });
});

describe('assemble and distribute: a kit of another organization is not found', () => {
  it('a manager of A assembling a kit that is not in A', async () => {
    const stub = stubFor();

    await expect(svc(stub, 'org-A').assemble(KIT_ID, 2, WAREHOUSE_ID)).rejects.toMatchObject({
      code: 'not_found',
      message: 'Bundle not found',
    });

    expectKitReadInA(stub);
    expect(stub.rpcCalls).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
    expect(invalidateInventoryListAfterWrite).not.toHaveBeenCalled();
  });

  it('a manager of A handing out a kit that is not in A', async () => {
    const stub = stubFor();

    await expect(
      svc(stub, 'org-A').distribute(KIT_ID, { quantity: 1, warehouseId: WAREHOUSE_ID }),
    ).rejects.toMatchObject({ code: 'not_found', message: 'Bundle not found' });

    expectKitReadInA(stub);
    expect(stub.rpcCalls).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
    expect(invalidateInventoryListAfterWrite).not.toHaveBeenCalled();
  });

  it('answers not found before the warehouse check, so the answer does not depend on who asks', async () => {
    // Staff assigned to no warehouse: the warehouse check alone would refuse
    // them as forbidden. The kit is not in A, which is the answer for everyone.
    const stub = stubFor();
    const distributor = new Set(['bundles:read', 'bundles:distribute']);

    await expect(
      svc(stub, 'org-A', { role: 'staff', permissions: distributor }).distribute(KIT_ID, {
        quantity: 1,
        warehouseId: WAREHOUSE_ID,
      }),
    ).rejects.toMatchObject({ code: 'not_found', message: 'Bundle not found' });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('working in B, assembling and handing out run once each and are recorded in B', async () => {
    const stub = stubFor();
    const kits = svc(stub, 'org-B');

    await kits.assemble(KIT_ID, 2, WAREHOUSE_ID);
    await kits.distribute(KIT_ID, { quantity: 1, warehouseId: WAREHOUSE_ID });

    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['assemble_bundle', 'distribute_bundle']);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'bundle.assembled', entityId: KIT_ID }),
      expect.objectContaining({ organizationId: 'org-B' }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'bundle.distributed' }),
      expect.objectContaining({ organizationId: 'org-B' }),
    );
    expect(invalidateInventoryListAfterWrite).toHaveBeenCalledWith('org-B', 'bundle.distribute');
  });
});
