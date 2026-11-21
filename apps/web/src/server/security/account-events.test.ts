// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The password-guessing detector helpers (server/security/account-events.ts):
 *
 *   - the organization of a typed sign-in email: an exact match on the
 *     lower-cased address in user_profiles (never a pattern match), a live
 *     account only, exactly one row, then resolveDefaultOrgAndRole; anything
 *     else is no organization, and nothing throws;
 *   - the answer for an email is remembered for 60 seconds in this instance,
 *     under a SHA-256 of the lower-cased address (never the address), at most
 *     500 of them, the oldest dropped first; a read that failed is not
 *     remembered;
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

import * as accountEvents from './account-events';
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

/** How many times user_profiles was read. */
const profileReads = () => h.calls.filter(([m, table]) => m === 'from' && table === 'user_profiles').length;

beforeEach(() => {
  vi.useRealTimers();
  accountEvents.__resetSignInOrganizationCacheForTests();
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

describe('organizationForSignInEmail: the same email is not looked up again within 60 seconds', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-11-21T10:15:00Z') });
  });

  it('a second refusal for the same email reads nothing', async () => {
    await expect(organizationForSignInEmail('ada@example.com')).resolves.toBe(ORG);
    await expect(organizationForSignInEmail('ada@example.com')).resolves.toBe(ORG);
    await expect(organizationForSignInEmail('  ADA@Example.com ')).resolves.toBe(ORG);
    expect(profileReads()).toBe(1);
    expect(h.resolve).toHaveBeenCalledTimes(1);
  });

  it('an email that is no account is remembered as none, and is not read again either', async () => {
    h.profiles = { data: [], error: null };
    await expect(organizationForSignInEmail('nobody@example.com')).resolves.toBeNull();
    await expect(organizationForSignInEmail('nobody@example.com')).resolves.toBeNull();
    expect(profileReads()).toBe(1);
  });

  it('an account in no organization is remembered as none', async () => {
    h.resolve.mockResolvedValue({ organizationId: null, role: null });
    await expect(organizationForSignInEmail('ada@example.com')).resolves.toBeNull();
    await expect(organizationForSignInEmail('ada@example.com')).resolves.toBeNull();
    expect(profileReads()).toBe(1);
    expect(h.resolve).toHaveBeenCalledTimes(1);
  });

  it('after 60 seconds it is looked up again', async () => {
    await organizationForSignInEmail('ada@example.com');
    vi.advanceTimersByTime(59_999);
    await organizationForSignInEmail('ada@example.com');
    expect(profileReads()).toBe(1);
    vi.advanceTimersByTime(1);
    h.resolve.mockResolvedValue({ organizationId: null, role: null });
    await expect(organizationForSignInEmail('ada@example.com')).resolves.toBeNull();
    expect(profileReads()).toBe(2);
  });

  it('refusals for one email that arrive together share one lookup', async () => {
    const answers = await Promise.all(
      Array.from({ length: 20 }, () => organizationForSignInEmail('ada@example.com')),
    );
    expect(answers).toEqual(Array.from({ length: 20 }, () => ORG));
    expect(profileReads()).toBe(1);
  });

  it('a read that failed is not remembered: the next refusal reads again', async () => {
    h.profiles = { data: null, error: { code: '57014' } };
    await expect(organizationForSignInEmail('ada@example.com')).resolves.toBeNull();
    h.throwOnFrom = true;
    await expect(organizationForSignInEmail('ada@example.com')).resolves.toBeNull();
    h.throwOnFrom = false;
    h.profiles = { data: [{ id: USER }], error: null };
    h.resolve.mockRejectedValueOnce(new Error('down'));
    await expect(organizationForSignInEmail('ada@example.com')).resolves.toBeNull();
    await expect(organizationForSignInEmail('ada@example.com')).resolves.toBe(ORG);
    await expect(organizationForSignInEmail('ada@example.com')).resolves.toBe(ORG);
    // Two failed reads, one thrown resolver, one that answered; the last is from memory.
    expect(profileReads()).toBe(3);
  });

  it('holds at most 500 emails, and drops the oldest first', async () => {
    for (let i = 0; i < 500; i++) await organizationForSignInEmail(`member-${i}@example.com`);
    expect(profileReads()).toBe(500);
    expect(accountEvents.__signInOrganizationCacheKeysForTests()).toHaveLength(500);

    // One more: the first is dropped, the second is still remembered.
    await organizationForSignInEmail('member-500@example.com');
    expect(accountEvents.__signInOrganizationCacheKeysForTests()).toHaveLength(500);
    await organizationForSignInEmail('member-1@example.com');
    expect(profileReads()).toBe(501);
    await organizationForSignInEmail('member-0@example.com');
    expect(profileReads()).toBe(502);
    expect(accountEvents.__signInOrganizationCacheKeysForTests()).toHaveLength(500);
  });

  it('never holds an email: every key is a SHA-256 of the lower-cased address', async () => {
    await organizationForSignInEmail('Ada.Lovelace@Example.com');
    await organizationForSignInEmail('nobody@example.com');
    const keys = accountEvents.__signInOrganizationCacheKeysForTests();
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(key).toMatch(/^[0-9a-f]{64}$/);
    const { createHash } = await import('node:crypto');
    expect(keys[0]).toBe(createHash('sha256').update('ada.lovelace@example.com').digest('hex'));
    expect(JSON.stringify(keys)).not.toMatch(/ada|lovelace|example|@/i);
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

describe('a sign-in refused for a reason that is not a wrong password', () => {
  it('is recorded after the response with NO organization: the email is never looked up', async () => {
    recordSignInBlocked('sign_in_refused_other', 'ada@example.com', request);
    expect(h.after).toHaveBeenCalledTimes(1);
    expect(recordSecurityEvent).not.toHaveBeenCalled();

    await runAfterResponse();
    // An organization does not see, for instance, that the platform disabled
    // one of its accounts: nothing about the email is read at all.
    expect(h.calls).toEqual([]);
    expect(h.resolve).not.toHaveBeenCalled();
    expect(recordSecurityEvent).toHaveBeenCalledTimes(1);
    expect(recordSecurityEvent).toHaveBeenCalledWith(
      {
        category: 'password_guessing',
        outcome: 'blocked',
        reason: 'sign_in_refused_other',
        source: 'web',
        organizationId: null,
      },
      request,
    );
  });

  it('remembers nothing about the email either', async () => {
    recordSignInBlocked('sign_in_refused_other', 'ada@example.com', request);
    await runAfterResponse();
    expect(accountEvents.__signInOrganizationCacheKeysForTests()).toEqual([]);
  });
});

describe('recordSignInBlocked and the memory of the last lookups', () => {
  it('a remembered email is still only used after the response, and still reads nothing before it', async () => {
    recordSignInBlocked('wrong_password', 'ada@example.com', request);
    await runAfterResponse();
    expect(profileReads()).toBe(1);
    h.after.mockReset();
    vi.mocked(recordSecurityEvent).mockClear();

    recordSignInBlocked('sign_in_paused', 'ada@example.com', request);
    expect(h.after).toHaveBeenCalledTimes(1);
    expect(recordSecurityEvent).not.toHaveBeenCalled();
    await runAfterResponse();
    expect(profileReads()).toBe(1);
    expect(recordSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'sign_in_paused', organizationId: ORG }),
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

describe("a signed-in member's refused current password and refused set-up code", () => {
  it.each([['wrong_current_password'], ['wrong_setup_code']] as const)(
    "%s: reads nothing before the response; after it, records in the account's organization",
    async (reason) => {
      recordAccountCodeBlocked(reason, USER, request);
      expect(h.after).toHaveBeenCalledTimes(1);
      expect(h.resolve).not.toHaveBeenCalled();
      expect(h.calls).toEqual([]);
      expect(recordSecurityEvent).not.toHaveBeenCalled();
      await runAfterResponse();
      expect(h.resolve).toHaveBeenCalledWith(USER);
      expect(recordSecurityEvent).toHaveBeenCalledTimes(1);
      expect(recordSecurityEvent).toHaveBeenCalledWith(
        {
          category: 'password_guessing',
          outcome: 'blocked',
          reason,
          source: 'web',
          organizationId: ORG,
        },
        request,
      );
    },
  );

  it('an account with no organization: recorded with none, never a throw', async () => {
    h.resolve.mockResolvedValue({ organizationId: null, role: null });
    recordAccountCodeBlocked('wrong_current_password', USER, null);
    await runAfterResponse();
    expect(recordSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'wrong_current_password', organizationId: null }),
      null,
    );
  });

  it('a lookup that throws drops the event and never reaches the caller', async () => {
    h.resolve.mockRejectedValue(new Error('down'));
    expect(() => recordAccountCodeBlocked('wrong_setup_code', USER, request)).not.toThrow();
    await expect(runAfterResponse()).resolves.toBeUndefined();
    expect(recordSecurityEvent).not.toHaveBeenCalled();
  });
});
