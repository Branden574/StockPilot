import { revalidatePath } from 'next/cache';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { contextUnavailableBody } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { PermissionsUnavailableError } from '@/lib/auth/effective-permissions';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { audit } from '@/server/services/audit';
import { makeServiceContext, makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

import { POST } from './route';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));

/**
 * Security invariant: POST /api/v1/items/[id]/serials registers serial
 * numbers through SerialsService.add, the service the item page calls, and
 * the service writes one `item.serials.added` audit row (entity the item, the
 * warehouse, the count) with the caller's organization and account.
 *
 * The route builds its context with withApiContext, through the API context
 * gate, so items:update, the authenticator rule and the item and warehouse
 * reads in the caller's organization are the website's own. A refused
 * request inserts nothing and writes no audit row. These run the real
 * service over a recording database client; only the audit writer is a
 * recorder.
 */

const ITEM = '1a2b3c4d-0000-4000-8000-000000000011';
const WAREHOUSE = '3c1d2e4f-0000-4000-8000-000000000012';

let stub: SupabaseStub;

function signIn(
  overrides: Parameters<typeof makeServiceContext>[1] = {},
  results: Parameters<typeof makeSupabaseStub>[0] = {},
) {
  stub = makeSupabaseStub({
    'inventory_items.select': { data: { id: ITEM }, error: null },
    'warehouses.select': { data: { id: WAREHOUSE }, error: null },
    'serial_registry.select': { data: [], error: null },
    'serial_registry.insert': { data: null, error: null },
    ...results,
  });
  const ctx = makeServiceContext(stub.client, {
    organizationId: 'org-route',
    userId: 'user-route',
    role: 'staff',
    ...overrides,
  });
  vi.mocked(withApiContext).mockResolvedValue(ctx as never);
  return ctx;
}

function request(opts: { id?: string; body?: unknown; raw?: string } = {}) {
  const id = opts.id ?? ITEM;
  return {
    req: new Request(`https://test.local/api/v1/items/${id}/serials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body:
        opts.raw ??
        JSON.stringify(opts.body ?? { warehouseId: WAREHOUSE, serials: ['SN-1', ' SN-2 '] }),
    }) as unknown as Parameters<typeof POST>[0],
    params: { params: Promise.resolve({ id }) },
  };
}

describe('POST /api/v1/items/[id]/serials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
    });
  });

  it('inserts the serial numbers and writes exactly one item.serials.added row, as the caller', async () => {
    const ctx = signIn();
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, added: 2 });

    const rows = stub.chainArgs.get('serial_registry.insert')![0]![0] as Array<
      Record<string, unknown>
    >;
    expect(rows.map((r) => r.serial_number)).toEqual(['SN-1', 'SN-2']);
    for (const row of rows) {
      expect(row).toMatchObject({
        organization_id: 'org-route',
        item_id: ITEM,
        warehouse_id: WAREHOUSE,
        current_status: 'available',
        receipt_line_id: null,
      });
    }

    expect(audit).toHaveBeenCalledTimes(1);
    const [payload, auditCtx] = vi.mocked(audit).mock.calls[0]!;
    expect(payload).toEqual({
      event: 'item.serials.added',
      entityType: 'inventory_item',
      entityId: ITEM,
      warehouseId: WAREHOUSE,
      extra: { count: 2 },
    });
    expect(auditCtx).toBe(ctx);
    expect(checkRateLimit).toHaveBeenCalledWith('item-serials-add:user-route', 60, 60_000);
    expect(revalidatePath).toHaveBeenCalledWith(`/dashboard/inventory/${ITEM}`);
  });

  it('accepts upper-case ids and records the lower-case ones', async () => {
    signIn();
    const { req, params } = request({
      id: ITEM.toUpperCase(),
      body: { warehouseId: WAREHOUSE.toUpperCase(), serials: ['SN-1'] },
    });
    const res = await POST(req, params);
    expect(res.status).toBe(201);
    const rows = stub.chainArgs.get('serial_registry.insert')![0]![0] as Array<
      Record<string, unknown>
    >;
    expect(rows[0]).toMatchObject({ item_id: ITEM, warehouse_id: WAREHOUSE });
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      entityId: ITEM,
      warehouseId: WAREHOUSE,
    });
  });

  it('answers 401 without a context, with nothing written', async () => {
    vi.mocked(withApiContext).mockResolvedValue(null);
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(401);
    expect(audit).not.toHaveBeenCalled();
  });

  it("answers the gate's 503 when the caller's permissions could not be read, before any work", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(withApiContext).mockRejectedValue(new PermissionsUnavailableError());
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(contextUnavailableBody());
    expect(audit).not.toHaveBeenCalled();
  });

  it.each([
    ['an item id that is not a uuid', { id: 'not-an-item' }],
    ['a body that is not JSON', { raw: '{not json' }],
    ['no serial numbers', { body: { warehouseId: WAREHOUSE, serials: [] } }],
    ['a warehouse id that is not a uuid', { body: { warehouseId: 'main', serials: ['SN-1'] } }],
    ['only blank lines', { body: { warehouseId: WAREHOUSE, serials: ['  ', ''] } }],
  ])('answers 400 for %s, with nothing inserted and no audit row', async (_label, opts) => {
    signIn();
    const { req, params } = request(opts);
    const res = await POST(req, params);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation_error');
    expect(stub.chainArgs.get('serial_registry.insert')).toBeUndefined();
    expect(audit).not.toHaveBeenCalled();
  });

  it('a viewer (no items:update) is refused 403, with nothing read and no audit row', async () => {
    signIn({ role: 'viewer' });
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'forbidden',
      message: 'Missing permission: items:update',
    });
    expect(stub.fromCalls).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("the organization's authenticator rule refuses before any read, with no audit row", async () => {
    signIn({ mfaRequired: true, mfaSatisfied: false });
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(403);
    expect((await res.json()).details?.reason).toEqual(expect.any(String));
    expect(stub.fromCalls).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it('an item not in the caller organization is 404, with nothing inserted and no audit row', async () => {
    signIn({}, { 'inventory_items.select': { data: null, error: null } });
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(404);
    expect(stub.chainArgs.get('serial_registry.insert')).toBeUndefined();
    expect(audit).not.toHaveBeenCalled();
  });

  it('a serial number already on the item is 409 by name, with nothing inserted and no audit row', async () => {
    signIn({}, { 'serial_registry.select': { data: [{ serial_number: 'SN-1' }], error: null } });
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('conflict');
    expect(body.message).toContain('SN-1');
    expect(body.details).toEqual({ duplicates: ['SN-1'] });
    expect(stub.chainArgs.get('serial_registry.insert')).toBeUndefined();
    expect(audit).not.toHaveBeenCalled();
  });

  it('an insert the database refused answers a fixed sentence, writes no audit row, and is reported', async () => {
    signIn(
      {},
      {
        'serial_registry.insert': {
          data: null,
          error: { message: 'violates row-level security policy' },
        },
      },
    );
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('row-level security');
    expect(audit).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(expect.anything(), {
      tag: 'api.v1.items.serials.add',
      organizationId: 'org-route',
    });
  });

  it('answers 429 when the account is over its limit, with nothing written', async () => {
    signIn();
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      count: 61,
      resetAt: Date.now() + 5_000,
    });
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(429);
    expect(stub.fromCalls).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });
});
