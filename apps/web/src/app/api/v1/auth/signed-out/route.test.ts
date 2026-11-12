import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

/**
 * Security invariant: a phone's sign-out signs the account's other devices
 * out at once, names only the sessions it ended on the public channel (never
 * the session that asked, which is still live), and is in the Audit log once
 * per session with a hashed session reference (S5, plans/S5.md 3.4 step 11;
 * integrator decision 2026-11-01: no live session id on the public channel).
 *
 * THE DEFECT. The phone's sign-out was a GoTrue global logout only: it wrote
 * no user.signed_out row, and the other devices kept working on their access
 * tokens for up to an hour, because nothing told their listeners.
 *
 * The order matters: revoke first, then broadcast. The web listener asks
 * GoTrue before it signs a tab out, so a broadcast ahead of the revoke would
 * be ignored; and only a revoke that answered without error has ended the
 * sessions the broadcast names.
 */

const h = vi.hoisted(() => ({
  withApiContext: vi.fn(),
  readVerifiedTokenClaims: vi.fn(),
  emitAuthAudit: vi.fn(async (_p: Record<string, unknown>) => undefined),
  broadcastToChannel: vi.fn(async (..._a: unknown[]) => undefined),
  reportError: vi.fn(async (..._a: unknown[]) => undefined),
  rpc: vi.fn(),
  log: [] as string[],
  listed: [] as Array<{ id: string }>,
  listError: null as unknown,
  revokeError: null as unknown,
  revoked: 2,
  buckets: new Map<string, number>(),
}));

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: h.withApiContext }));
vi.mock('@/lib/auth/verified-claims', () => ({
  readVerifiedTokenClaims: h.readVerifiedTokenClaims,
}));
vi.mock('@/server/services/auth-audit', () => ({ emitAuthAudit: h.emitAuthAudit }));
vi.mock('@/lib/realtime/broadcast', () => ({
  broadcastToChannel: async (...a: unknown[]) => {
    h.log.push('broadcast');
    return h.broadcastToChannel(...a);
  },
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: h.reportError }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async (key: string, limit: number, windowMs: number) => {
    const count = (h.buckets.get(key) ?? 0) + 1;
    h.buckets.set(key, count);
    return { allowed: count <= limit, count, resetAt: Date.now() + windowMs };
  }),
}));

import { POST } from './route';

const USER = '11111111-1111-4111-8111-111111111111';
const ORG = '44444444-4444-4444-8444-444444444444';
const SESSION = '22222222-2222-4222-8222-222222222222';
const OTHER_A = '55555555-5555-4555-8555-555555555555';
const OTHER_B = '66666666-6666-4666-8666-666666666666';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function ctx() {
  return {
    organizationId: ORG,
    userId: USER,
    role: 'staff',
    permissions: undefined,
    supabase: { auth: {}, rpc: (...a: unknown[]) => h.rpc(...a) },
    mfaRequired: false,
    mfaSatisfied: true,
    mfaEnrolled: false,
    enabledModules: new Set<ModuleId>(),
  };
}

function claims(over: Record<string, unknown> = {}) {
  return {
    userId: USER,
    sessionId: SESSION,
    aal: 'aal2',
    amr: [],
    email: 'member@example.com',
    ...over,
  };
}

function req(headers: Record<string, string> = { authorization: 'Bearer token-1' }) {
  return new Request('http://localhost/api/v1/auth/signed-out', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{}',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.log.length = 0;
  h.buckets.clear();
  h.listed = [{ id: OTHER_A }, { id: SESSION }, { id: OTHER_B }];
  h.listError = null;
  h.revokeError = null;
  h.revoked = 2;
  h.withApiContext.mockResolvedValue(ctx());
  h.readVerifiedTokenClaims.mockResolvedValue(claims());
  h.rpc.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
    h.log.push(args ? `${name}(${JSON.stringify(args)})` : name);
    if (name === 'list_my_sessions')
      return { data: h.listError ? null : h.listed, error: h.listError };
    if (name === 'revoke_my_other_sessions') {
      return { data: h.revokeError ? null : h.revoked, error: h.revokeError };
    }
    throw new Error(`unexpected rpc ${name}`);
  });
});

describe('POST /api/v1/auth/signed-out — who may sign other devices out', () => {
  it('a cookie session (no bearer token): 401; nothing revoked, broadcast or written', async () => {
    expect((await POST(req({}))).status).toBe(401);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.broadcastToChannel).not.toHaveBeenCalled();
    expect(h.emitAuthAudit).not.toHaveBeenCalled();
  });

  it('withApiContext answers null: 401', async () => {
    h.withApiContext.mockResolvedValue(null);
    expect((await POST(req())).status).toBe(401);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('claims that cannot be verified, or name another account: 401', async () => {
    h.readVerifiedTokenClaims.mockResolvedValueOnce(null);
    expect((await POST(req())).status).toBe(401);
    h.readVerifiedTokenClaims.mockResolvedValueOnce(
      claims({ userId: '99999999-9999-4999-8999-999999999999' }),
    );
    expect((await POST(req())).status).toBe(401);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.readVerifiedTokenClaims).toHaveBeenCalledWith(expect.anything(), 'token-1');
  });
});

describe('POST /api/v1/auth/signed-out — the other devices', () => {
  it('lists, revokes every session but the verified one, then broadcasts the ended ids (never this session)', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.log).toEqual([
      'list_my_sessions',
      `revoke_my_other_sessions(${JSON.stringify({ p_keep_session_id: SESSION })})`,
      'broadcast',
    ]);
    expect(h.broadcastToChannel).toHaveBeenCalledTimes(1);
    expect(h.broadcastToChannel).toHaveBeenCalledWith(`user:${USER}:sessions`, 'revoked', {
      sessionIds: [OTHER_A, OTHER_B],
    });
    expect(JSON.stringify(h.broadcastToChannel.mock.calls)).not.toContain(SESSION);
    expect(JSON.stringify(h.broadcastToChannel.mock.calls)).not.toContain('keepId');
  });

  it('a revoke that answered an error: no broadcast (nothing it names was ended)', async () => {
    h.revokeError = { code: '57014', message: 'canceling statement due to statement timeout' };
    expect((await POST(req())).status).toBe(200);
    expect(h.broadcastToChannel).not.toHaveBeenCalled();
    expect(h.emitAuthAudit.mock.calls[0]![0]).toMatchObject({
      extra: { others_revoked: null, revoke_error: '57014' },
    });
    expect(h.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'auth.signed_out' }),
    );
  });

  it('a list that could not be read: the revoke still runs, nothing is broadcast, and it is reported', async () => {
    h.listError = { code: 'PGRST000', message: 'connection refused' };
    expect((await POST(req())).status).toBe(200);
    expect(h.log).toEqual([
      'list_my_sessions',
      `revoke_my_other_sessions(${JSON.stringify({ p_keep_session_id: SESSION })})`,
    ]);
    expect(h.broadcastToChannel).not.toHaveBeenCalled();
    expect(h.reportError).toHaveBeenCalledTimes(1);
  });

  it('no other session listed: nothing to broadcast', async () => {
    h.listed = [{ id: SESSION }];
    h.revoked = 0;
    await POST(req());
    expect(h.broadcastToChannel).not.toHaveBeenCalled();
    expect(h.emitAuthAudit.mock.calls[0]![0]).toMatchObject({ extra: { others_revoked: 0 } });
  });

  it('a token with no session id: neither call is made (revoke_my_other_sessions(null) ends EVERY session), and the row says so', async () => {
    h.readVerifiedTokenClaims.mockResolvedValue(claims({ sessionId: null }));
    expect((await POST(req())).status).toBe(200);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.broadcastToChannel).not.toHaveBeenCalled();
    expect(h.emitAuthAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        extra: expect.objectContaining({
          revoke_skipped: true,
          session_ref: null,
          others_revoked: null,
        }),
      }),
    );
  });

  it('a token with no session id has nothing to count its row once by: its rows are held to the account’s 30 an hour', async () => {
    h.readVerifiedTokenClaims.mockResolvedValue(claims({ sessionId: null }));
    for (let i = 0; i < 31; i += 1) expect((await POST(req())).status).toBe(200);
    expect(h.emitAuthAudit).toHaveBeenCalledTimes(30);
    expect([...h.buckets.keys()]).toEqual([`auth-note:user:${USER}`]);
  });

  it('an AAL1 token is accepted (GoTrue’s own logout and revoke_my_other_sessions already accept one)', async () => {
    h.readVerifiedTokenClaims.mockResolvedValue(claims({ aal: 'aal1' }));
    expect((await POST(req())).status).toBe(200);
    expect(h.broadcastToChannel).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/v1/auth/signed-out — the row', () => {
  it('one user.signed_out row: client mobile, scope global, how many others were revoked, a session reference and never the session id', async () => {
    await POST(req());
    expect(h.emitAuthAudit).toHaveBeenCalledTimes(1);
    expect(h.emitAuthAudit).toHaveBeenCalledWith({
      event: 'user.signed_out',
      userId: USER,
      organizationId: ORG,
      extra: {
        client: 'mobile',
        scope: 'global',
        email: 'member@example.com',
        session_ref: sha256(SESSION).slice(0, 16),
        others_revoked: 2,
        revoke_error: null,
        revoke_skipped: false,
      },
    });
    expect(JSON.stringify(h.emitAuthAudit.mock.calls)).not.toContain(SESSION);
  });

  it('once per session: a second note revokes again (harmless) but writes no second row', async () => {
    await POST(req());
    await POST(req());
    expect(h.emitAuthAudit).toHaveBeenCalledTimes(1);
    expect([...h.buckets.keys()]).toContain(`auth-note:out:${sha256(SESSION)}`);
  });

  it('an unexpected failure answers the fixed sentence and is reported (S16)', async () => {
    h.withApiContext.mockRejectedValue(new Error('account status unreadable'));
    const res = await POST(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'internal_error',
      message: 'Something went wrong. Please try again.',
    });
  });
});
