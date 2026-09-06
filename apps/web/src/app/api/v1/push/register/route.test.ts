import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withApiContext } from '@/lib/auth/api-context';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({
  withApiContext: vi.fn(),
}));

vi.mock('@/lib/error-reporter', () => ({
  reportError: vi.fn(async () => {}),
}));

const TOKEN = 'ExponentPushToken[shared-warehouse-ipad-0001]';

function buildCtx(results: Record<string, { data: unknown; error: { message: string } | null }>) {
  const stub = makeSupabaseStub(results);
  return {
    ctx: {
      organizationId: 'org-1',
      userId: 'user-b',
      role: 'staff' as const,
      supabase: stub.client as never,
      mfaRequired: false,
      mfaSatisfied: true,
      enabledModules: new Set<never>(),
    },
    stub,
  };
}

function buildRequest(body: unknown) {
  return new Request('https://test.local/api/v1/push/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

describe('POST /api/v1/push/register', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 without an auth context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await POST(buildRequest({ token: TOKEN, platform: 'ios' }));
    expect(res.status).toBe(401);
  });

  /**
   * REGRESSION (SP-073). The registration used to be a direct
   * `push_tokens.upsert(..., { onConflict: 'token' })` on the USER-authed
   * client. push_tokens carries exactly one policy (push_tokens_self, 0003)
   * — `using (user_id = auth.uid())` — and Postgres evaluates ON CONFLICT DO
   * UPDATE against the EXISTING row's USING expression. On a shared warehouse
   * device the existing row belongs to the previous user, so the statement
   * ERRORS with 42501 (reproduced on local Postgres 2026-09-05) and the route
   * answered 500 while the token stayed bound to the user who left.
   *
   * The rebind now happens inside the 0348 SECURITY DEFINER RPC, so this test
   * pins the route to the RPC — a revert to the raw upsert fails here.
   */
  it('rebinds through the register_push_token RPC instead of a raw self-RLS upsert', async () => {
    const { ctx, stub } = buildCtx({ 'rpc:register_push_token': { data: null, error: null } });
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx);

    const res = await POST(buildRequest({ token: TOKEN, platform: 'ios', deviceId: 'ipad-7' }));

    expect(res.status).toBe(200);
    expect(stub.rpcCalls).toEqual([
      {
        name: 'register_push_token',
        args: { p_token: TOKEN, p_platform: 'ios', p_device_id: 'ipad-7' },
      },
    ]);
    // The raw table write is what RLS refused; it must be gone entirely.
    expect(stub.fromCalls).not.toContain('push_tokens');
  });

  it('passes a null device id through when the app omits one', async () => {
    const { ctx, stub } = buildCtx({ 'rpc:register_push_token': { data: null, error: null } });
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx);

    const res = await POST(buildRequest({ token: TOKEN, platform: 'android' }));

    expect(res.status).toBe(200);
    expect(stub.rpcCalls[0]?.args).toEqual({
      p_token: TOKEN,
      p_platform: 'android',
      p_device_id: null,
    });
  });

  it('reports and 500s when the rebind RPC fails', async () => {
    const { ctx } = buildCtx({
      'rpc:register_push_token': { data: null, error: { message: 'boom' } },
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx);

    const res = await POST(buildRequest({ token: TOKEN, platform: 'web' }));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'internal_error' });
  });

  it('rejects a malformed body before touching the database', async () => {
    const { ctx, stub } = buildCtx({});
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx);

    const res = await POST(buildRequest({ token: 'short', platform: 'ios' }));

    expect(res.status).toBe(400);
    expect(stub.rpcCalls).toEqual([]);
  });
});
