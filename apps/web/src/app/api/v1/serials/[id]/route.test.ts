import { revalidatePath } from 'next/cache';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { contextUnavailableBody } from '@stockpilot/core';

import { AccountStatusUnavailableError } from '@/lib/auth/account-status';
import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { audit } from '@/server/services/audit';
import { makeServiceContext, makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

import { DELETE, PATCH } from './route';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));

/**
 * Security invariant: PATCH and DELETE /api/v1/serials/[id] change or remove
 * one serial number through SerialsService.updateSerial and
 * SerialsService.remove, the services the item page calls, and the service
 * writes one `item.serial.updated` or `item.serial.deleted` audit row (entity
 * the item, the number before and after, the serial's id) with the caller's
 * organization and account.
 *
 * The routes build their context with withApiContext, through the API context
 * gate, so items:update, the authenticator rule, the read in the caller's
 * organization and the refusal of a serial number captured at a receipt are
 * the website's own. A refused request writes nothing and no audit row. These
 * run the real service over a recording database client; only the audit
 * writer is a recorder.
 */

const SERIAL = '5e5e5e5e-0000-4000-8000-000000000021';
const ITEM = '1a2b3c4d-0000-4000-8000-000000000022';

let stub: SupabaseStub;

const existing = {
  id: SERIAL,
  item_id: ITEM,
  serial_number: 'SN-100',
  current_status: 'available',
  receipt_line_id: null as string | null,
};

function signIn(
  overrides: Parameters<typeof makeServiceContext>[1] = {},
  results: Parameters<typeof makeSupabaseStub>[0] = {},
) {
  stub = makeSupabaseStub({
    'serial_registry.select': { data: existing, error: null },
    'serial_registry.update': {
      data: { id: SERIAL, item_id: ITEM, serial_number: 'SN-100', current_status: 'damaged' },
      error: null,
    },
    'serial_registry.delete': { data: { id: SERIAL }, error: null },
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

function request(
  method: 'PATCH' | 'DELETE',
  opts: { id?: string; body?: unknown; raw?: string } = {},
) {
  const id = opts.id ?? SERIAL;
  return {
    req: new Request(`https://test.local/api/v1/serials/${id}`, {
      method,
      ...(method === 'PATCH'
        ? {
            headers: { 'content-type': 'application/json' },
            body: opts.raw ?? JSON.stringify(opts.body ?? { status: 'damaged' }),
          }
        : {}),
    }) as unknown as Parameters<typeof PATCH>[0],
    params: { params: Promise.resolve({ id }) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    count: 1,
    resetAt: Date.now() + 60_000,
  });
});

describe('PATCH /api/v1/serials/[id]', () => {
  it('changes the status and writes exactly one item.serial.updated row, as the caller', async () => {
    const ctx = signIn();
    const { req, params } = request('PATCH');
    const res = await PATCH(req, params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      id: SERIAL,
      itemId: ITEM,
      serialNumber: 'SN-100',
      status: 'damaged',
    });
    expect(stub.chainArgs.get('serial_registry.update')![0]).toEqual([
      { current_status: 'damaged' },
    ]);

    expect(audit).toHaveBeenCalledTimes(1);
    const [payload, auditCtx] = vi.mocked(audit).mock.calls[0]!;
    expect(payload).toEqual({
      event: 'item.serial.updated',
      entityType: 'inventory_item',
      entityId: ITEM,
      before: { serialNumber: 'SN-100', status: 'available' },
      after: { serialNumber: 'SN-100', status: 'damaged' },
      extra: { serial_id: SERIAL, from: 'SN-100', to: 'SN-100', receipt_captured: false },
    });
    expect(auditCtx).toBe(ctx);
    expect(checkRateLimit).toHaveBeenCalledWith('serial-change:user-route', 120, 60_000);
    expect(revalidatePath).toHaveBeenCalledWith(`/dashboard/inventory/${ITEM}`);
  });

  it('an upper-case id reaches the service lower-cased', async () => {
    signIn();
    const { req, params } = request('PATCH', { id: SERIAL.toUpperCase() });
    const res = await PATCH(req, params);
    expect(res.status).toBe(200);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({ extra: { serial_id: SERIAL } });
  });

  it.each([
    ['an id that is not a uuid', { id: 'sn-100' }],
    ['a body that is not JSON', { raw: '{not json' }],
    ['nothing to change', { body: {} }],
    ['an unknown status', { body: { status: 'lost' } }],
    ['an empty number', { body: { serialNumber: '' } }],
  ])('answers 400 for %s, with nothing written and no audit row', async (_label, opts) => {
    signIn();
    const { req, params } = request('PATCH', opts);
    const res = await PATCH(req, params);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation_error');
    expect(stub.chainArgs.get('serial_registry.update')).toBeUndefined();
    expect(audit).not.toHaveBeenCalled();
  });

  it('a viewer is refused 403 before any read, with no audit row', async () => {
    signIn({ role: 'viewer' });
    const { req, params } = request('PATCH');
    const res = await PATCH(req, params);
    expect(res.status).toBe(403);
    expect(stub.fromCalls).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it('a serial number not in the caller organization is 404, with no update and no audit row', async () => {
    signIn({}, { 'serial_registry.select': { data: null, error: null } });
    const { req, params } = request('PATCH');
    const res = await PATCH(req, params);
    expect(res.status).toBe(404);
    expect(stub.chainArgs.get('serial_registry.update')).toBeUndefined();
    expect(audit).not.toHaveBeenCalled();
  });

  it('an update that matched no row is 404, with no audit row', async () => {
    signIn({}, { 'serial_registry.update': { data: null, error: null } });
    const { req, params } = request('PATCH');
    const res = await PATCH(req, params);
    expect(res.status).toBe(404);
    expect(audit).not.toHaveBeenCalled();
  });

  it('a number already on the item is 409, with no audit row', async () => {
    signIn(
      {},
      { 'serial_registry.update': { data: null, error: { message: 'duplicate', code: '23505' } } },
    );
    const { req, params } = request('PATCH', { body: { serialNumber: 'SN-200' } });
    const res = await PATCH(req, params);
    expect(res.status).toBe(409);
    expect(audit).not.toHaveBeenCalled();
  });

  it("answers the gate's 503 when the account status could not be read, before any work", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(withApiContext).mockRejectedValue(new AccountStatusUnavailableError());
    const { req, params } = request('PATCH');
    const res = await PATCH(req, params);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(contextUnavailableBody());
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1/serials/[id]', () => {
  it('removes a hand-added serial number and writes exactly one item.serial.deleted row, as the caller', async () => {
    const ctx = signIn();
    const { req, params } = request('DELETE');
    const res = await DELETE(req, params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, itemId: ITEM });
    expect(stub.chains.get('serial_registry.delete')).toBeDefined();

    expect(audit).toHaveBeenCalledTimes(1);
    const [payload, auditCtx] = vi.mocked(audit).mock.calls[0]!;
    expect(payload).toEqual({
      event: 'item.serial.deleted',
      entityType: 'inventory_item',
      entityId: ITEM,
      before: { serialNumber: 'SN-100' },
      extra: { serial_id: SERIAL },
    });
    expect(auditCtx).toBe(ctx);
    expect(checkRateLimit).toHaveBeenCalledWith('serial-change:user-route', 120, 60_000);
  });

  it('a serial number captured at a receipt is refused 409, with nothing removed and no audit row', async () => {
    signIn(
      {},
      {
        'serial_registry.select': {
          data: { ...existing, receipt_line_id: '7a7a7a7a-0000-4000-8000-000000000023' },
          error: null,
        },
      },
    );
    const { req, params } = request('DELETE');
    const res = await DELETE(req, params);
    expect(res.status).toBe(409);
    expect(stub.chains.get('serial_registry.delete')).toBeUndefined();
    expect(audit).not.toHaveBeenCalled();
  });

  it('a delete that matched no row is 404, with no audit row', async () => {
    signIn({}, { 'serial_registry.delete': { data: null, error: null } });
    const { req, params } = request('DELETE');
    const res = await DELETE(req, params);
    expect(res.status).toBe(404);
    expect(audit).not.toHaveBeenCalled();
  });

  it('a viewer is refused 403 before any read, with no audit row', async () => {
    signIn({ role: 'viewer' });
    const { req, params } = request('DELETE');
    const res = await DELETE(req, params);
    expect(res.status).toBe(403);
    expect(stub.fromCalls).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it('answers 400 for an id that is not a uuid, and 401 without a context', async () => {
    signIn();
    const bad = request('DELETE', { id: 'sn-100' });
    expect((await DELETE(bad.req, bad.params)).status).toBe(400);
    vi.mocked(withApiContext).mockResolvedValue(null);
    const out = request('DELETE');
    expect((await DELETE(out.req, out.params)).status).toBe(401);
    expect(audit).not.toHaveBeenCalled();
  });

  it('a delete the database refused answers a fixed sentence, writes no audit row, and is reported', async () => {
    signIn(
      {},
      {
        'serial_registry.delete': {
          data: null,
          error: { message: 'permission denied for table serial_registry' },
        },
      },
    );
    const { req, params } = request('DELETE');
    const res = await DELETE(req, params);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('permission denied');
    expect(audit).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(expect.anything(), {
      tag: 'api.v1.serials.delete',
      organizationId: 'org-route',
    });
  });
});
