import { revalidatePath } from 'next/cache';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { contextUnavailableBody, DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { MembershipUnavailableError } from '@/lib/auth/membership-unavailable';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { audit } from '@/server/services/audit';
import { makeServiceContext, makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

import { PATCH } from './route';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));

/**
 * Security invariant: PATCH /api/v1/customers/[id]/status archives or
 * restores one customer account through CustomersService.setStatus, and the
 * service writes one `organization.updated` audit row (entity the customer,
 * before and after status) with the caller's organization and account.
 *
 * The route builds its context with withApiContext, through the API context
 * gate, so the customer portal module, customers:manage and the authenticator
 * rule are checked by the service before any read. A refused request, and a
 * save of the status the account already has, write nothing and no audit
 * row. These run the real service over a recording database client; only the
 * audit writer is a recorder.
 */

const CUSTOMER = '6c6c6c6c-0000-4000-8000-000000000031';

const ALL_MODULES = new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'b2b_portal' as ModuleId]);

let stub: SupabaseStub;

function signIn(
  overrides: Parameters<typeof makeServiceContext>[1] = {},
  results: Parameters<typeof makeSupabaseStub>[0] = {},
) {
  stub = makeSupabaseStub({
    'customers.select': {
      data: { id: CUSTOMER, name: 'Example Academy', status: 'active' },
      error: null,
    },
    'customers.update': { data: { id: CUSTOMER }, error: null },
    ...results,
  });
  const ctx = makeServiceContext(stub.client, {
    organizationId: 'org-route',
    userId: 'user-route',
    role: 'manager',
    enabledModules: ALL_MODULES,
    ...overrides,
  });
  vi.mocked(withApiContext).mockResolvedValue(ctx as never);
  return ctx;
}

/** Every recorded query on `key` (table.op) is filtered by the caller's
 *  organization: a member of two organizations changes and reads only rows of
 *  the one the request acts in. */
function expectEveryQueryInOrganization(key: string) {
  const chains = stub.chainArgsAll.get(key) ?? [];
  expect(chains.length, key).toBeGreaterThan(0);
  for (const chain of chains) expect(chain, key).toContainEqual(['organization_id', 'org-route']);
}

function request(opts: { id?: string; body?: unknown; raw?: string } = {}) {
  const id = opts.id ?? CUSTOMER;
  return {
    req: new Request(`https://test.local/api/v1/customers/${id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: opts.raw ?? JSON.stringify(opts.body ?? { status: 'archived' }),
    }) as unknown as Parameters<typeof PATCH>[0],
    params: { params: Promise.resolve({ id }) },
  };
}

describe('PATCH /api/v1/customers/[id]/status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
    });
  });

  it('archives the account and writes exactly one organization.updated row, as the caller', async () => {
    const ctx = signIn();
    const { req, params } = request();
    const res = await PATCH(req, params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'archived', changed: true });

    expect(stub.chainArgs.get('customers.update')![0]).toEqual([{ status: 'archived' }]);
    expectEveryQueryInOrganization('customers.select');
    expect(stub.chainsAll.get('customers.update')![0]!.slice(0, 4)).toEqual([
      'update',
      'eq',
      'eq',
      'eq',
    ]);
    expect(stub.chainArgsAll.get('customers.update')![0]!.slice(1, 4)).toEqual([
      ['organization_id', 'org-route'],
      ['id', CUSTOMER],
      ['status', 'active'],
    ]);

    expect(audit).toHaveBeenCalledTimes(1);
    const [payload, auditCtx] = vi.mocked(audit).mock.calls[0]!;
    expect(payload).toEqual({
      event: 'organization.updated',
      entityType: 'customer',
      entityId: CUSTOMER,
      before: { status: 'active' },
      after: { status: 'archived' },
      extra: { action: 'customer_archived', name: 'Example Academy' },
    });
    expect(auditCtx).toBe(ctx);
    expect(checkRateLimit).toHaveBeenCalledWith('customer-status:user-route', 60, 60_000);
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/customers');
  });

  it('restoring an archived account is recorded as customer_restored', async () => {
    signIn(
      {},
      {
        'customers.select': {
          data: { id: CUSTOMER, name: 'Example Academy', status: 'archived' },
          error: null,
        },
      },
    );
    const { req, params } = request({ body: { status: 'active' } });
    const res = await PATCH(req, params);
    expect(res.status).toBe(200);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      before: { status: 'archived' },
      after: { status: 'active' },
      extra: { action: 'customer_restored' },
    });
  });

  it('the status the account already has changes nothing and records nothing', async () => {
    signIn();
    const { req, params } = request({ body: { status: 'active' } });
    const res = await PATCH(req, params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'active', changed: false });
    expectEveryQueryInOrganization('customers.select');
    expect(stub.chainArgs.get('customers.update')).toBeUndefined();
    expect(audit).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('a status changed by someone else in between is 409, with no audit row', async () => {
    signIn({}, { 'customers.update': { data: null, error: null } });
    const { req, params } = request();
    const res = await PATCH(req, params);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('conflict');
    expect(audit).not.toHaveBeenCalled();
  });

  it('an account not in the caller organization is 404, with no update and no audit row', async () => {
    signIn({}, { 'customers.select': { data: null, error: null } });
    const { req, params } = request();
    const res = await PATCH(req, params);
    expect(res.status).toBe(404);
    expect(stub.chainArgs.get('customers.update')).toBeUndefined();
    expect(audit).not.toHaveBeenCalled();
  });

  it('a member without customers:manage is refused 403 before any read, with no audit row', async () => {
    signIn({ role: 'staff' });
    const { req, params } = request();
    const res = await PATCH(req, params);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'forbidden',
      message: 'Missing permission: customers:manage',
    });
    expect(stub.fromCalls).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("the organization's authenticator rule refuses before any read, with no audit row", async () => {
    signIn({ mfaRequired: true, mfaSatisfied: false });
    const { req, params } = request();
    const res = await PATCH(req, params);
    expect(res.status).toBe(403);
    expect((await res.json()).details?.reason).toBe('mfa_required');
    expect(stub.fromCalls).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it('an organization without the customer portal module is refused, with no audit row', async () => {
    signIn({
      enabledModules: new Set<ModuleId>(
        DEFAULT_MODULE_IDS.filter((m) => m !== ('b2b_portal' as ModuleId)),
      ),
    });
    const { req, params } = request();
    const res = await PATCH(req, params);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('module_disabled');
    expect(stub.fromCalls).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it.each([
    ['an id that is not a uuid', { id: 'example-academy' }],
    ['a body that is not JSON', { raw: '{not json' }],
    ['a status that does not exist', { body: { status: 'deleted' } }],
    ['no status', { body: {} }],
  ])('answers 400 for %s, with nothing read and no audit row', async (_label, opts) => {
    signIn();
    const { req, params } = request(opts);
    const res = await PATCH(req, params);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation_error');
    expect(stub.fromCalls).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it('answers 401 without a context, and the 503 when the membership could not be read', async () => {
    vi.mocked(withApiContext).mockResolvedValue(null);
    const out = request();
    expect((await PATCH(out.req, out.params)).status).toBe(401);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(withApiContext).mockRejectedValue(new MembershipUnavailableError());
    const gated = request();
    const res = await PATCH(gated.req, gated.params);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(contextUnavailableBody());
    expect(audit).not.toHaveBeenCalled();
  });

  it('an update the database refused answers a fixed sentence, writes no audit row, and is reported', async () => {
    signIn(
      {},
      {
        'customers.update': {
          data: null,
          error: { message: 'violates row-level security policy for table "customers"' },
        },
      },
    );
    const { req, params } = request();
    const res = await PATCH(req, params);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('row-level security');
    expect(audit).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(expect.anything(), {
      tag: 'api.v1.customers.status',
      organizationId: 'org-route',
    });
  });

  it('answers 429 when the account is over its limit, with nothing read', async () => {
    signIn();
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      count: 61,
      resetAt: Date.now() + 5_000,
    });
    const { req, params } = request();
    const res = await PATCH(req, params);
    expect(res.status).toBe(429);
    expect(stub.fromCalls).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });
});
