// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The password-guessing detector helpers (server/security/account-events.ts):
 *
 *   - the organization of a typed sign-in email: an exact match on the
 *     lower-cased address in user_profiles (never a pattern match), a live
 *     account only, exactly one row, then resolveDefaultOrgAndRole; anything
 *     else is no organization, and nothing throws;
 *   - recordSignInBlocked and recordAccountCodeBlocked look the organization
 *     up AFTER the response: they register their work with after() and read
 *     nothing before it runs, so a refusal takes the same time for an email
 *     that is an account and one that is not.
 */

const h = vi.hoisted(() => ({
  after: vi.fn(),
  resolve: vi.fn(),
  profiles: { data: [] as unknown[] | null, error: null as unknown },
  calls: [] as Array<[string, ...unknown[]]>,
  throwOnFrom: false,
}));

vi.mock('next/server', () => ({ after: h.after }));
vi.mock('@/server/services/auth-audit', () => ({
  resolveDefaultOrgAndRole: h.resolve,
  emitAuthAudit: vi.fn(),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (h.throwOnFrom) throw new Error('down');
      h.calls.push(['from', table]);
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is', 'ilike', 'like', 'limit']) {
        chain[m] = (...args: unknown[]) => {
          h.calls.push([m, ...args]);
          return chain;
        };
      }
      chain.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
        Promise.resolve({ data: h.profiles.data, error: h.profiles.error }).then(ok, bad);
      return chain;
    },
  }),
}));

import { recordSecurityEvent } from '@/server/security/events';

import {
  organizationForSignInEmail,
  recordAccountCodeBlocked,
  recordSignInBlocked,
} from './account-events';

const ORG = '5eed0000-0001-4000-8000-000000000001';
const USER = '5eed0000-0002-4000-8000-000000000001';
const request = new Headers({ 'x-forwarded-for': '203.0.113.7' });

/** The work registered with after(), run as the platform would after the response. */
async function runAfterResponse() {
  for (const [task] of h.after.mock.calls) await (task as () => Promise<unknown>)();
}

beforeEach(() => {
  h.after.mockReset();
  h.resolve.mockReset();
  h.resolve.mockResolvedValue({ organizationId: ORG, role: 'staff' });
  h.profiles = { data: [{ id: USER }], error: null };
  h.calls = [];
  h.throwOnFrom = false;
});

describe('organizationForSignInEmail', () => {
  it('an exact match on the lower-cased address, a live account, at most two rows', async () => {
    await expect(organizationForSignInEmail('  Ada.Lovelace@Example.COM ')).resolves.toBe(ORG);
    expect(h.calls).toEqual([
      ['from', 'user_profiles'],
      ['select', 'id'],
      ['eq', 'email', 'ada.lovelace@example.com'],
      ['is', 'deleted_at', null],
      ['limit', 2],
    ]);
    expect(h.calls.some(([m]) => m === 'ilike' || m === 'like')).toBe(false);
    expect(h.resolve).toHaveBeenCalledWith(USER);
  });

  it('an unknown email has no organization', async () => {
    h.profiles = { data: [], error: null };
    await expect(organizationForSignInEmail('nobody@example.com')).resolves.toBeNull();
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it('two rows answering one address: no organization, nothing guessed', async () => {
    h.profiles = { data: [{ id: USER }, { id: 'another' }], error: null };
    await expect(organizationForSignInEmail('ada@example.com')).resolves.toBeNull();
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it('a read that fails or throws, or an empty email, is no organization, never a throw', async () => {
    h.profiles = { data: null, error: { code: '57014' } };
    await expect(organizationForSignInEmail('ada@example.com')).resolves.toBeNull();
    h.throwOnFrom = true;
    await expect(organizationForSignInEmail('ada@example.com')).resolves.toBeNull();
    h.throwOnFrom = false;
    h.calls = [];
    await expect(organizationForSignInEmail('   ')).resolves.toBeNull();
    expect(h.calls).toEqual([]);
  });

  it('an account in no organization: the resolver’s null', async () => {
    h.resolve.mockResolvedValue({ organizationId: null, role: null });
    await expect(organizationForSignInEmail('ada@example.com')).resolves.toBeNull();
  });
});

describe('recordSignInBlocked', () => {
  it('reads nothing before the response; after it, records in the email’s organization', async () => {
    recordSignInBlocked('wrong_password', 'ada@example.com', request);
    expect(h.after).toHaveBeenCalledTimes(1);
    expect(h.calls).toEqual([]);
    expect(h.resolve).not.toHaveBeenCalled();
    expect(recordSecurityEvent).not.toHaveBeenCalled();

    await runAfterResponse();
    expect(recordSecurityEvent).toHaveBeenCalledTimes(1);
    expect(recordSecurityEvent).toHaveBeenCalledWith(
      {
        category: 'password_guessing',
        outcome: 'blocked',
        reason: 'wrong_password',
        source: 'web',
        organizationId: ORG,
      },
      request,
    );
  });

  it('an unknown email: recorded with no organization', async () => {
    h.profiles = { data: [], error: null };
    recordSignInBlocked('sign_in_paused', 'nobody@example.com', request);
    await runAfterResponse();
    expect(recordSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'sign_in_paused', organizationId: null }),
      request,
    );
  });
});

describe('recordAccountCodeBlocked', () => {
  it('reads nothing before the response; after it, records in the account’s organization', async () => {
    recordAccountCodeBlocked('wrong_code', USER, request);
    expect(h.resolve).not.toHaveBeenCalled();
    expect(recordSecurityEvent).not.toHaveBeenCalled();
    await runAfterResponse();
    expect(h.resolve).toHaveBeenCalledWith(USER);
    expect(recordSecurityEvent).toHaveBeenCalledWith(
      {
        category: 'password_guessing',
        outcome: 'blocked',
        reason: 'wrong_code',
        source: 'web',
        organizationId: ORG,
      },
      request,
    );
  });
});
