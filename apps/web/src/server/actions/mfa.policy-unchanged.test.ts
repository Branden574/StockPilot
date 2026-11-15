import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The organization's authenticator policy (setOrgMfaPolicyAction): a change is
 * one update, one audit row with the old and new policy, and one security
 * event. A save of the policy the organization already has changes nothing:
 * no update, no audit row, no event, no refresh. The admin and the
 * authenticator-code checks come first either way.
 */

const h = vi.hoisted(() => ({
  role: 'admin' as string,
  aal2: null as Error | null,
  read: { data: { mfa_policy: 'optional' } as unknown, error: null as unknown },
  update: { data: { id: 'org-1' } as unknown, error: null as unknown },
  updates: [] as unknown[],
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(async () => ({
    userId: 'user-1',
    email: 'u@example.test',
    fullName: null,
    avatarUrl: null,
    defaultOrganizationId: 'org-1',
  })),
  requireOrgContext: vi.fn(async () => ({
    userId: 'user-1',
    organizationId: 'org-1',
    role: h.role,
  })),
}));
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: vi.fn(async () => ({})),
  assertCurrentAal2: vi.fn(async () => {
    if (h.aal2) throw h.aal2;
  }),
}));
vi.mock('@/lib/auth/verify-password', () => ({
  verifyPasswordSideChannel: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() + 1000 })),
}));
vi.mock('@/server/services/audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/server/services/integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/auth/verified-claims', () => ({
  readVerifiedSessionClaims: vi.fn(async () => null),
  readVerifiedSessionClaimsOf: vi.fn(async () => null),
}));
vi.mock('@/server/services/auth-audit', () => ({ emitAuthAudit: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    from: () => {
      let op = 'select';
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.update = (values: unknown) => {
        op = 'update';
        h.updates.push(values);
        return q;
      };
      q.eq = () => q;
      q.maybeSingle = async () => (op === 'update' ? h.update : h.read);
      return q;
    },
  })),
}));

import { revalidatePath, updateTag } from 'next/cache';

import { audit } from '@/server/services/audit';
import { ServiceError } from '@/server/services/context';
import { dispatchEvent } from '@/server/services/integration-events';

import { setOrgMfaPolicyAction } from './mfa';

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'admin';
  h.aal2 = null;
  h.read = { data: { mfa_policy: 'optional' }, error: null };
  h.update = { data: { id: 'org-1' }, error: null };
  h.updates = [];
});

describe('setOrgMfaPolicyAction', () => {
  it('a new policy is one update, one audit row with the old and new policy, and one security event', async () => {
    h.read = { data: { mfa_policy: 'optional' }, error: null };

    const res = await setOrgMfaPolicyAction({ policy: 'all_required' });

    expect(res).toEqual({ ok: true, data: undefined });
    expect(h.updates).toEqual([{ mfa_policy: 'all_required' }]);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith({
      event: 'organization.mfa_policy.changed',
      entityType: 'organization',
      entityId: 'org-1',
      before: { mfa_policy: 'optional' },
      after: { mfa_policy: 'all_required' },
    });
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchEvent).toHaveBeenCalledWith('org-1', 'security.mfa_policy_changed', {
      from: 'optional',
      to: 'all_required',
    });
    expect(updateTag).toHaveBeenCalledWith('dashboard-org');
  });

  it.each(['optional', 'admins_required', 'all_required'] as const)(
    'a save of the policy the organization already has (%s) changes nothing: no update, no audit row, no event',
    async (policy) => {
      h.read = { data: { mfa_policy: policy }, error: null };

      const res = await setOrgMfaPolicyAction({ policy });

      expect(res).toEqual({ ok: true, data: undefined });
      expect(h.updates).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
      expect(dispatchEvent).not.toHaveBeenCalled();
      expect(updateTag).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it('a current policy that could not be read is not taken for the same one: the update runs', async () => {
    h.read = { data: null, error: { message: 'the read did not answer' } };

    const res = await setOrgMfaPolicyAction({ policy: 'optional' });

    expect(res).toEqual({ ok: true, data: undefined });
    expect(h.updates).toEqual([{ mfa_policy: 'optional' }]);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it('the same policy is still refused for a member who is not an admin', async () => {
    h.role = 'manager';
    h.read = { data: { mfa_policy: 'optional' }, error: null };

    const res = await setOrgMfaPolicyAction({ policy: 'optional' });

    expect(res).toEqual({
      ok: false,
      error: { code: 'forbidden', message: 'Only admins can change the MFA policy.' },
    });
    expect(h.updates).toEqual([]);
  });

  it('the same policy is still refused while the authenticator code is owed', async () => {
    h.aal2 = new ServiceError(
      'forbidden',
      'Re-authenticate with MFA before changing security settings.',
      {
        reason: 'aal2_required',
      },
    );
    h.read = { data: { mfa_policy: 'optional' }, error: null };

    const res = await setOrgMfaPolicyAction({ policy: 'optional' });

    expect(res).toEqual({
      ok: false,
      error: {
        code: 'forbidden',
        message: 'Re-authenticate with MFA before changing security settings.',
      },
    });
    expect(h.updates).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });
});
