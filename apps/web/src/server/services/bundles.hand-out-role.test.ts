// Security invariant (listed in scripts/security-test.sh): a kit is handed out
// only by a member whose role the database accepts for it, and the app says
// so before anything is read or written.

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * distribute_bundle reads the kit with SELECT ... FOR UPDATE, which the
 * bundles_update policy's USING filters to managers and above, and then asks
 * has_org_role(org, 'manager') itself. So the database refuses every caller
 * below manager, whatever they hold; staff hold bundles:distribute by default.
 *
 *   - BundlesService.distribute() refuses a caller below manager with one
 *     plain sentence (forbidden), after the module and the permission and
 *     before anything is read or written: no kit read, no warehouse check, no
 *     function call, no audit row, no cache invalidation.
 *   - The website action and POST /api/v1/bundles/[id]/distribute answer it as
 *     their forbidden answer (the route: 403 with the sentence and nothing else).
 *   - An owner, an admin and a manager hand out as they do without it, and a
 *     manager whose bundles:distribute is revoked gets the permission answer.
 *   - The rule is the one the bundle page and the phone use to offer
 *     Distribute (canDistributeBundles), for every role.
 */

const h = vi.hoisted(() => ({ withContext: vi.fn() }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
vi.mock('@/server/loaders/inventory-list', () => ({
  revalidateInventoryList: vi.fn(),
  revalidateInventoryListForCurrentOrg: vi.fn(async () => undefined),
}));
vi.mock('@/lib/auth/warehouse', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/warehouse')>()),
  assertWarehouseAccess: vi.fn(async () => undefined),
}));
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('./context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./context')>()),
  withContext: h.withContext,
}));

import {
  canDistributeBundles,
  effectivePermissions,
  type Permission,
  type Role,
} from '@stockpilot/core';

import { POST } from '@/app/api/v1/bundles/[id]/distribute/route';
import { withApiContext } from '@/lib/auth/api-context';
import { assertWarehouseAccess } from '@/lib/auth/warehouse';
import { distributeBundleAction } from '@/server/actions/bundles';
import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

import { audit } from './audit';
import { BundlesService, KIT_HAND_OUT_MANAGER_ONLY } from './bundles';
import { ServiceError } from './context';
import { invalidateInventoryListAfterWrite } from './lib/inventory-list-cache';

const KIT = '5e5e5e5e-0000-4000-8000-000000000201';
const WAREHOUSE = '6f6f6f6f-0000-4000-8000-000000000202';
const SENTENCE = 'Only a manager can hand out a kit. Ask a manager to hand this one out.';

function stubFor() {
  return makeSupabaseStub({
    'bundles.select': servedLikePostgrest([{ id: KIT, organization_id: 'org-test' }]),
    'rpc:distribute_bundle': { data: 'dist-1', error: null },
  });
}

function contextFor(
  stub: ReturnType<typeof makeSupabaseStub>,
  role: Role,
  permissions: ReadonlySet<Permission> = effectivePermissions(role),
) {
  return makeServiceContext(stub.client, { role, permissions });
}

function expectNothingReadOrWritten(stub: ReturnType<typeof makeSupabaseStub>) {
  expect(stub.fromCalls).toEqual([]);
  expect(stub.rpcCalls).toEqual([]);
  expect(assertWarehouseAccess).not.toHaveBeenCalled();
  expect(audit).not.toHaveBeenCalled();
  expect(invalidateInventoryListAfterWrite).not.toHaveBeenCalled();
}

const auditEvents = () => vi.mocked(audit).mock.calls.map((c) => (c[0] as { event: string }).event);

beforeEach(() => vi.clearAllMocks());

describe('BundlesService.distribute: the role the database accepts', () => {
  it('the sentence is the one people read', () => {
    expect(KIT_HAND_OUT_MANAGER_ONLY).toBe(SENTENCE);
  });

  it('staff with the default permissions are refused with the sentence, before anything is read or written', async () => {
    expect(effectivePermissions('staff').has('bundles:distribute')).toBe(true);
    const stub = stubFor();
    const err = await new BundlesService(contextFor(stub, 'staff'))
      .distribute(KIT, { quantity: 2, warehouseId: WAREHOUSE })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(err).toMatchObject({ code: 'forbidden', message: SENTENCE });
    expectNothingReadOrWritten(stub);
  });

  it('a viewer granted bundles:distribute is refused the same way', async () => {
    const granted = effectivePermissions('viewer', [
      { permission: 'bundles:distribute', granted: true },
    ]);
    const stub = stubFor();
    await expect(
      new BundlesService(contextFor(stub, 'viewer', granted)).distribute(KIT, {
        quantity: 1,
        warehouseId: WAREHOUSE,
      }),
    ).rejects.toMatchObject({ code: 'forbidden', message: SENTENCE });
    expectNothingReadOrWritten(stub);
  });

  it('staff without bundles:distribute get the permission answer', async () => {
    const revoked = effectivePermissions('staff', [
      { permission: 'bundles:distribute', granted: false },
    ]);
    const stub = stubFor();
    await expect(
      new BundlesService(contextFor(stub, 'staff', revoked)).distribute(KIT, {
        quantity: 1,
        warehouseId: WAREHOUSE,
      }),
    ).rejects.toMatchObject({
      code: 'forbidden',
      message: 'Missing permission: bundles:distribute',
    });
    expectNothingReadOrWritten(stub);
  });

  it('a manager whose bundles:distribute is revoked gets the permission answer, not the role sentence', async () => {
    const revoked = effectivePermissions('manager', [
      { permission: 'bundles:distribute', granted: false },
    ]);
    const stub = stubFor();
    await expect(
      new BundlesService(contextFor(stub, 'manager', revoked)).distribute(KIT, {
        quantity: 1,
        warehouseId: WAREHOUSE,
      }),
    ).rejects.toMatchObject({
      code: 'forbidden',
      message: 'Missing permission: bundles:distribute',
    });
    expectNothingReadOrWritten(stub);
  });

  it.each(['owner', 'admin', 'manager'] as const)(
    'a %s hands the kit out: the kit read, the warehouse check, one call and the audit row',
    async (role) => {
      const stub = stubFor();
      const out = await new BundlesService(contextFor(stub, role)).distribute(KIT, {
        quantity: 2,
        warehouseId: WAREHOUSE,
      });
      expect(out).toEqual({ distributionId: 'dist-1' });
      expect(stub.fromCalls).toContain('bundles');
      expect(assertWarehouseAccess).toHaveBeenCalledWith(WAREHOUSE, 'write', expect.anything());
      expect(stub.rpcCalls).toEqual([
        expect.objectContaining({
          name: 'distribute_bundle',
          args: expect.objectContaining({
            p_bundle_id: KIT,
            p_quantity: 2,
            p_warehouse_id: WAREHOUSE,
          }),
        }),
      ]);
      expect(auditEvents()).toEqual(['bundle.distributed']);
    },
  );

  it('is refused by role exactly where the bundle page and the phone do not offer Distribute', async () => {
    for (const role of ['owner', 'admin', 'manager', 'staff', 'viewer'] as const) {
      const permissions = effectivePermissions(role, [
        { permission: 'bundles:distribute', granted: true },
      ]);
      const stub = stubFor();
      const result = await new BundlesService(contextFor(stub, role, permissions))
        .distribute(KIT, { quantity: 1, warehouseId: WAREHOUSE })
        .then(
          () => 'handed out',
          (e: unknown) => (e as Error).message,
        );
      expect(result, role).toBe(
        canDistributeBundles({ role, permissions }) ? 'handed out' : SENTENCE,
      );
    }
  });
});

describe('the website action', () => {
  it('answers forbidden with the sentence for staff, and refreshes nothing', async () => {
    const stub = stubFor();
    h.withContext.mockResolvedValue(contextFor(stub, 'staff'));
    const res = await distributeBundleAction({ id: KIT, quantity: 2, warehouseId: WAREHOUSE });
    expect(res).toEqual({ ok: false, error: { code: 'forbidden', message: SENTENCE } });
    expectNothingReadOrWritten(stub);
  });

  it('answers ok for a manager', async () => {
    const stub = stubFor();
    h.withContext.mockResolvedValue(contextFor(stub, 'manager'));
    const res = await distributeBundleAction({ id: KIT, quantity: 2, warehouseId: WAREHOUSE });
    expect(res).toEqual({ ok: true, data: { distributionId: 'dist-1' } });
    expect(stub.rpcCalls).toHaveLength(1);
  });
});

describe('POST /api/v1/bundles/[id]/distribute', () => {
  function request(body: unknown) {
    return new Request(`https://test.local/api/v1/bundles/${KIT}/distribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as Parameters<typeof POST>[0];
  }
  const params = { params: Promise.resolve({ id: KIT }) };
  const KEY = '7f1d3c2a-0000-4000-8000-000000000203';

  it('answers 403 forbidden with the sentence for staff: a final refusal the phone shows and never sends again', async () => {
    const stub = stubFor();
    vi.mocked(withApiContext).mockResolvedValueOnce(contextFor(stub, 'staff') as never);
    const res = await POST(
      request({ quantity: 2, warehouseId: WAREHOUSE, idempotencyKey: KEY }),
      params,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', message: SENTENCE });
    expectNothingReadOrWritten(stub);
  });

  it('answers 200 with the distribution for a manager', async () => {
    const stub = stubFor();
    vi.mocked(withApiContext).mockResolvedValueOnce(contextFor(stub, 'manager') as never);
    const res = await POST(request({ quantity: 2, warehouseId: WAREHOUSE }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ distributionId: 'dist-1' });
  });
});
