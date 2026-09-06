import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authorizePublicApi } from '@/lib/auth/public-api';
import { createAdminClient } from '@/lib/supabase/admin';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { DELETE } from './route';

vi.mock('@/lib/auth/public-api', () => ({ authorizePublicApi: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));

function authOk() {
  vi.mocked(authorizePublicApi).mockResolvedValue({
    ctx: { organizationId: 'org-1', keyId: 'key-1', scopes: ['webhooks:manage'] },
  } as never);
}

/** `integration_endpoints.id` is `uuid primary key` (0169), so PostgREST hands
 *  back a 22P02 parse error — not an empty result — when the path segment is
 *  not a uuid. That is exactly what the stub returns here. */
function adminStub(overrides: Record<string, unknown> = {}) {
  const stub = makeSupabaseStub({
    'integration_endpoints.delete': { data: null, error: null },
    ...overrides,
  });
  vi.mocked(createAdminClient).mockReturnValue(stub.client as never);
  return stub;
}

const BAD_UUID_ERROR = {
  data: null,
  error: { code: '22P02', message: 'invalid input syntax for type uuid: "abc"' },
};

function req(id: string) {
  return new Request(`https://test.local/api/public/v1/hooks/${id}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer sk_live_x' },
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

const VALID_UUID = '3f2b9f1e-6a4c-4f0e-9b2d-8c1a7e5d4c33';

describe('DELETE /api/public/v1/hooks/:id (automation webhook unsubscribe)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('honours the idempotent 200 contract for a malformed (non-uuid) id, without querying', async () => {
    authOk();
    const stub = adminStub({ 'integration_endpoints.delete': BAD_UUID_ERROR });
    const res = await DELETE(req('abc'), params('abc'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Short-circuited before the query: a non-uuid can't match any row anyway.
    expect(stub.fromCalls).not.toContain('integration_endpoints');
    expect(stub.client.from).not.toHaveBeenCalled();
  });

  it('still deletes org-scoped for a valid uuid and returns 200', async () => {
    authOk();
    const stub = adminStub();
    const res = await DELETE(req(VALID_UUID), params(VALID_UUID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(stub.fromCalls).toContain('integration_endpoints');
    const eqArgs = stub.chainArgs.get('integration_endpoints.delete') ?? [];
    expect(eqArgs).toContainEqual(['organization_id', 'org-1']);
    expect(eqArgs).toContainEqual(['id', VALID_UUID]);
    expect(eqArgs).toContainEqual(['type', 'webhook']);
  });

  it('still 500s when a well-formed delete genuinely fails', async () => {
    authOk();
    adminStub({
      'integration_endpoints.delete': {
        data: null,
        error: { code: '08006', message: 'connection failure' },
      },
    });
    const res = await DELETE(req(VALID_UUID), params(VALID_UUID));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error' });
  });

  it('propagates the auth failure response (e.g. missing scope)', async () => {
    const { NextResponse } = await import('next/server');
    vi.mocked(authorizePublicApi).mockResolvedValue({
      res: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    } as never);
    const stub = adminStub();
    const res = await DELETE(req(VALID_UUID), params(VALID_UUID));
    expect(res.status).toBe(403);
    expect(stub.client.from).not.toHaveBeenCalled();
  });
});
