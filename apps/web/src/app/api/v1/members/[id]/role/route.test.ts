import { beforeEach, describe, expect, it, vi } from 'vitest';

import { contextUnavailableBody } from '@stockpilot/core';

import { AccountStatusUnavailableError } from '@/lib/auth/account-status';
import { withApiContext } from '@/lib/auth/api-context';
import { PermissionsUnavailableError } from '@/lib/auth/effective-permissions';
import { MembershipUnavailableError } from '@/lib/auth/membership-unavailable';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError } from '@/server/services/context';
import { TeamService } from '@/server/services/team';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { PATCH } from './route';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/server/services/team', () => ({ TeamService: vi.fn() }));

/**
 * Security invariant: PATCH /api/v1/members/[id]/role changes a member's role
 * through TeamService.updateMemberRole and nothing else.
 *
 * The route builds its context with withApiContext (cookie or Bearer), through
 * the API context gate, so the service runs as the caller: its permission
 * check, the organization's authenticator rule, the owner and own-row
 * refusals, the audit row and the security event are the Team page's own. A
 * context that could not be built because the caller's access could not be
 * read answers the gate's 503 before any work. The route adds the id and body
 * checks and a per-account rate limit, and answers the service's refusal with
 * its code, its words and its reason. The body's role is one of admin,
 * manager, staff and viewer: 'owner' is refused as a bad body.
 */

const MEMBER = '5a1b2c3d-0000-4000-8000-00000000000a';

function ctx() {
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'admin' as const,
    supabase: makeSupabaseStub({}).client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<never>(),
  };
}

function request(opts: { id?: string; body?: unknown; raw?: string } = {}) {
  const id = opts.id ?? MEMBER;
  return {
    req: new Request(`https://test.local/api/v1/members/${id}/role`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: opts.raw ?? JSON.stringify(opts.body ?? { role: 'manager' }),
    }) as unknown as Parameters<typeof PATCH>[0],
    params: { params: Promise.resolve({ id }) },
  };
}

function mockService(impl: () => Promise<unknown> = async () => undefined) {
  const updateMemberRole = vi.fn(impl);
  vi.mocked(TeamService).mockImplementation(function () {
    return { updateMemberRole } as unknown as InstanceType<typeof TeamService>;
  });
  return updateMemberRole;
}

describe('PATCH /api/v1/members/[id]/role', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(withApiContext).mockResolvedValue(ctx());
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
    });
  });

  it('answers 401 without a context, and makes no service', async () => {
    vi.mocked(withApiContext).mockResolvedValue(null);
    const call = mockService();
    const { req, params } = request();
    const res = await PATCH(req, params);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
    expect(TeamService).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    ['the account status', () => new AccountStatusUnavailableError()],
    ['the membership', () => new MembershipUnavailableError()],
    ['the permissions', () => new PermissionsUnavailableError()],
  ])(
    'answers the 503 a caller may send again when %s could not be read, before any work',
    async (_what, make) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(withApiContext).mockRejectedValue(make());
      const call = mockService();
      const { req, params } = request();
      const res = await PATCH(req, params);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual(contextUnavailableBody());
      expect(res.headers.get('Retry-After')).toBe('5');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(checkRateLimit).not.toHaveBeenCalled();
      expect(TeamService).not.toHaveBeenCalled();
      expect(call).not.toHaveBeenCalled();
    },
  );

  it('any other failure of the context step is thrown again, unanswered', async () => {
    const failed = new Error('the context step failed another way');
    vi.mocked(withApiContext).mockRejectedValue(failed);
    const call = mockService();
    const { req, params } = request();
    await expect(PATCH(req, params)).rejects.toBe(failed);
    expect(call).not.toHaveBeenCalled();
  });

  it('hands withApiContext the request it was given', async () => {
    mockService();
    const { req, params } = request();
    await PATCH(req, params);
    expect(withApiContext).toHaveBeenCalledWith(req);
  });

  it('answers 400 for an id that is not a uuid, before the service', async () => {
    const call = mockService();
    const { req, params } = request({ id: 'not-a-member-id' });
    const res = await PATCH(req, params);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'validation_error',
      message: 'That member id is not valid.',
    });
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    ['a body that is not JSON', { raw: '{not json' }],
    ['no role', { body: {} }],
    ['a role that does not exist', { body: { role: 'superuser' } }],
    ["the role 'owner', which moves by transfer only", { body: { role: 'owner' } }],
    ['a role that is not text', { body: { role: 3 } }],
  ])('answers 400 for %s, before the service', async (_label, opts) => {
    const call = mockService();
    const { req, params } = request(opts);
    const res = await PATCH(req, params);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation_error');
    expect(call).not.toHaveBeenCalled();
  });

  it('calls the service once, with the route context, the member id and the role', async () => {
    const context = ctx();
    vi.mocked(withApiContext).mockResolvedValue(context);
    const call = mockService();
    const { req, params } = request({ body: { role: 'staff' } });
    const res = await PATCH(req, params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, role: 'staff' });
    expect(TeamService).toHaveBeenCalledTimes(1);
    expect(vi.mocked(TeamService).mock.calls[0]![0]).toBe(context);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(MEMBER, 'staff');
    expect(checkRateLimit).toHaveBeenCalledWith('member-role:u-1', 30, 60_000);
  });

  it('accepts an upper-case id and hands the service the lower-case one', async () => {
    const call = mockService();
    const { req, params } = request({ id: MEMBER.toUpperCase() });
    const res = await PATCH(req, params);
    expect(res.status).toBe(200);
    expect(call).toHaveBeenCalledWith(MEMBER, 'manager');
  });

  it("a bad role, 'owner' included, is answered in words that name the four roles", async () => {
    const call = mockService();
    for (const role of ['owner', 'superuser']) {
      const { req, params } = request({ body: { role } });
      const res = await PATCH(req, params);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'validation_error',
        message: 'Choose a role: admin, manager, staff or viewer.',
      });
    }
    expect(call).not.toHaveBeenCalled();
  });

  it.each(['admin', 'manager', 'staff', 'viewer'] as const)(
    'the role %s reaches the service',
    async (role) => {
      const call = mockService();
      const { req, params } = request({ body: { role } });
      const res = await PATCH(req, params);
      expect(res.status).toBe(200);
      expect(call).toHaveBeenCalledWith(MEMBER, role);
    },
  );

  it.each([
    ['forbidden', 403, 'Missing permission: members:update_role'],
    ['not_found', 404, 'Member not found'],
    ['conflict', 409, 'Member not found or already changed.'],
  ] as const)('a %s from the service is %i with its words', async (code, status, message) => {
    mockService(async () => {
      throw new ServiceError(code, message);
    });
    const { req, params } = request();
    const res = await PATCH(req, params);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: code, message });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('the authenticator refusal keeps its reason for the caller to act on', async () => {
    mockService(async () => {
      throw new ServiceError(
        'forbidden',
        'Re-authenticate with MFA before performing this action.',
        {
          reason: 'aal2_required',
        },
      );
    });
    const { req, params } = request();
    const res = await PATCH(req, params);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'forbidden',
      message: 'Re-authenticate with MFA before performing this action.',
      details: { reason: 'aal2_required' },
    });
  });

  it("a write the database refused answers the service's fixed sentence, never the database's text, and is reported", async () => {
    const refused = new ServiceError(
      'internal_error',
      'new row violates row-level security policy for table "organization_members"',
      { hint: 'organization_members_update' },
    );
    mockService(async () => {
      throw refused;
    });
    const { req, params } = request();
    const res = await PATCH(req, params);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: 'internal_error',
      message: 'An internal error occurred. Please try again.',
    });
    expect(text).not.toContain('row-level security');
    expect(text).not.toContain('organization_members_update');
    expect(reportError).toHaveBeenCalledWith(refused, {
      tag: 'api.v1.members.role',
      organizationId: 'org-1',
    });
  });

  it('an unexpected error answers the fixed sentence, never its own text, and is reported', async () => {
    const err = new Error('relation "organization_members" does not exist');
    mockService(async () => {
      throw err;
    });
    const { req, params } = request();
    const res = await PATCH(req, params);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: 'internal_error',
      message: 'Something went wrong. Please try again.',
    });
    expect(text).not.toContain('does not exist');
    expect(reportError).toHaveBeenCalledWith(err, {
      tag: 'api.v1.members.role',
      organizationId: 'org-1',
    });
  });

  it('answers 429 with Retry-After when the account is over its limit, before the service', async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      count: 31,
      resetAt: Date.now() + 30_000,
    });
    const call = mockService();
    const { req, params } = request();
    const res = await PATCH(req, params);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect((await res.json()).error).toBe('rate_limited');
    expect(call).not.toHaveBeenCalled();
  });
});
