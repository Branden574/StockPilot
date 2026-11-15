import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: on the page path (withContext, behind every dashboard
 * page and Server Action), an organization authenticator policy that cannot
 * be read is answered as the STRICTEST policy ('all_required'), the same as a
 * row that row level security hides: never as a lesser policy, and never as
 * something stricter than any policy an organization can have.
 *
 * The read in question is getOrgRowForRequest, used when the membership that
 * resolved the context did not carry the organization row. It throws on a
 * read error (lib/dashboard/request-cache.ts). The strictest policy is a floor
 * for every other one, so holding the unread policy to it never lets through
 * a session the organization's real policy would refuse:
 *
 *   - a session with an authenticator, at aal2: passes;
 *   - a session with an authenticator, at aal1: asked for its code
 *     (`aal2_required`). requireOrgContext() sends such a session to the code
 *     page before withContext() gets here; it is mocked out below so the gate's
 *     own answer is pinned too;
 *   - a session with no authenticator: `mfa_required`, at any level.
 *
 * An unreadable FACTOR LIST is a different input and keeps its answer: no
 * answer about enrollment at all, so required and unsatisfied, even at aal2.
 */

vi.mock('@/lib/auth/session', () => ({ requireOrgContext: vi.fn() }));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: vi.fn(),
  getMfaFactorsForRequest: vi.fn(),
  getModulesForRequest: vi.fn(),
}));
vi.mock('@/lib/auth/verified-claims', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/verified-claims')>()),
  getVerifiedSessionClaimsForRequest: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => ({})) }));

import { requireOrgContext } from '@/lib/auth/session';
import { getVerifiedSessionClaimsForRequest } from '@/lib/auth/verified-claims';
import {
  getMfaFactorsForRequest,
  getModulesForRequest,
  getOrgRowForRequest,
  type OrgRow,
} from '@/lib/dashboard/request-cache';

import { assertPermission, ServiceError, withContext } from './context';

import type { ModuleId } from '@stockpilot/core';

const USER_ID = 'user-page-1';

type ReadablePolicy = 'optional' | 'admins_required' | 'all_required';
/**
 * What the organization row read gives: a stored value; `hidden`, no row (row
 * level security); `rejects`, the read error getOrgRowForRequest throws;
 * `throws`, a reader that throws before it returns a promise.
 */
type PolicyRead = ReadablePolicy | 'hidden' | 'rejects' | 'throws';
type Role = 'admin' | 'staff';
type Aal = 'aal1' | 'aal2';

interface Session {
  role: Role;
  enrolled: boolean;
  aal: Aal;
}

const orgRow = (mfa_policy: ReadablePolicy): OrgRow => ({
  terminology: null,
  mfa_policy,
  logo_url: null,
  timezone: null,
  nav_overrides: null,
  dashboard_layout: null,
  order_status_config: null,
});

// withContext is React cache()d: a distinct organization per call keeps every
// call its own.
let seq = 0;

async function run(policy: PolicyRead, s: Session) {
  const organizationId = `org-page-${++seq}`;
  vi.mocked(requireOrgContext).mockResolvedValue({
    userId: USER_ID,
    email: 'person@example.com',
    fullName: null,
    avatarUrl: null,
    defaultOrganizationId: organizationId,
    organizationId,
    organizationName: 'Example Co',
    role: s.role,
  } as never);
  vi.mocked(getOrgRowForRequest).mockImplementation(((): Promise<OrgRow | null> => {
    if (policy === 'throws') throw new Error('getOrgRowForRequest: unreadable');
    if (policy === 'rejects') {
      return Promise.reject(
        new Error('getOrgRowForRequest: canceling statement due to statement timeout'),
      );
    }
    if (policy === 'hidden') return Promise.resolve(null);
    return Promise.resolve(orgRow(policy));
  }) as never);
  vi.mocked(getMfaFactorsForRequest).mockResolvedValue({
    userId: USER_ID,
    factors: s.enrolled ? [{ status: 'verified' }] : [],
  });
  vi.mocked(getModulesForRequest).mockResolvedValue(new Set<ModuleId>());
  vi.mocked(getVerifiedSessionClaimsForRequest).mockResolvedValue({
    userId: USER_ID,
    sessionId: 'session-1',
    aal: s.aal,
    amr: [],
    email: 'person@example.com',
  });
  return withContext();
}

type Answer = 'passes' | 'aal2_required' | 'mfa_required';

async function answer(policy: PolicyRead, s: Session): Promise<Answer> {
  const ctx = await run(policy, s);
  try {
    assertPermission({ ...ctx, permissions: new Set(['items:read']) }, 'items:read');
    return 'passes';
  } catch (e) {
    expect(e).toBeInstanceOf(ServiceError);
    return (e as ServiceError).details?.reason as Answer;
  }
}

const UNREADABLE: PolicyRead[] = ['rejects', 'throws'];
const READABLE: ReadablePolicy[] = ['optional', 'admins_required', 'all_required'];
const SESSIONS: Session[] = (['admin', 'staff'] as Role[]).flatMap((role) =>
  [false, true].flatMap((enrolled) =>
    (['aal1', 'aal2'] as Aal[]).map((aal) => ({ role, enrolled, aal })),
  ),
);
const label = (s: Session) =>
  `${s.role}, ${s.enrolled ? 'authenticator' : 'no authenticator'}, ${s.aal}`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe.each(UNREADABLE)('withContext: the organization row read %s', (read) => {
  it('an aal2 session with an authenticator passes', async () => {
    for (const role of ['admin', 'staff'] as Role[]) {
      const ctx = await run(read, { role, enrolled: true, aal: 'aal2' });
      expect(getOrgRowForRequest).toHaveBeenCalled();
      expect(ctx.mfaRequired).toBe(true);
      expect(ctx.mfaSatisfied).toBe(true);
      expect(ctx.mfaEnrolled).toBe(true);
      expect(await answer(read, { role, enrolled: true, aal: 'aal2' })).toBe('passes');
    }
  });

  it('an aal1 session with an authenticator is asked for its code', async () => {
    for (const role of ['admin', 'staff'] as Role[]) {
      expect(await answer(read, { role, enrolled: true, aal: 'aal1' })).toBe('aal2_required');
    }
  });

  it('a session with no authenticator gets what the strictest policy gives it', async () => {
    for (const role of ['admin', 'staff'] as Role[]) {
      for (const aal of ['aal1', 'aal2'] as Aal[]) {
        const s = { role, enrolled: false, aal };
        expect(await answer(read, s), label(s)).toBe('mfa_required');
        expect(await answer(read, s), label(s)).toBe(await answer('all_required', s));
      }
    }
  });

  it('every session is answered exactly as all_required and a hidden row answer it', async () => {
    const triple = (c: Awaited<ReturnType<typeof withContext>>) => ({
      required: c.mfaRequired,
      satisfied: c.mfaSatisfied,
      enrolled: c.mfaEnrolled,
    });
    for (const s of SESSIONS) {
      const unread = triple(await run(read, s));
      expect(unread, label(s)).toEqual(triple(await run('all_required', s)));
      expect(unread, label(s)).toEqual(triple(await run('hidden', s)));
    }
  });

  it('never lets through a session that any readable policy refuses', async () => {
    for (const s of SESSIONS) {
      if ((await answer(read, s)) !== 'passes') continue;
      for (const policy of READABLE) {
        expect(await answer(policy, s), `${label(s)} under ${policy}`).toBe('passes');
      }
    }
  });

  it('still logs the failed read', async () => {
    await run(read, { role: 'admin', enrolled: true, aal: 'aal2' });
    expect(vi.mocked(console.error)).toHaveBeenCalledWith(
      '[resolveMfaState] failed:',
      expect.any(Error),
    );
  });

  it('an unreadable factor list alongside it keeps its own answer: required and unsatisfied, even at aal2', async () => {
    const s = { role: 'admin' as Role, enrolled: true, aal: 'aal2' as Aal };
    const organizationId = `org-page-${++seq}`;
    vi.mocked(requireOrgContext).mockResolvedValue({
      userId: USER_ID,
      email: 'person@example.com',
      fullName: null,
      avatarUrl: null,
      defaultOrganizationId: organizationId,
      organizationId,
      organizationName: 'Example Co',
      role: s.role,
    } as never);
    vi.mocked(getOrgRowForRequest).mockRejectedValue(new Error('getOrgRowForRequest: unreadable'));
    vi.mocked(getMfaFactorsForRequest).mockRejectedValue(
      new Error('getMfaFactorsForRequest: unreadable'),
    );
    vi.mocked(getModulesForRequest).mockResolvedValue(new Set<ModuleId>());
    vi.mocked(getVerifiedSessionClaimsForRequest).mockResolvedValue({
      userId: USER_ID,
      sessionId: 'session-1',
      aal: 'aal2',
      amr: [],
      email: 'person@example.com',
    });
    const ctx = await withContext();
    expect(ctx.mfaRequired).toBe(true);
    expect(ctx.mfaSatisfied).toBe(false);
    expect(ctx.mfaEnrolled).toBe(false);
  });
});

/** The readable policies, row by row: unchanged. */
const READABLE_ROWS: Array<[PolicyRead, Session, Answer]> = [
  ['optional', { role: 'admin', enrolled: false, aal: 'aal1' }, 'passes'],
  ['optional', { role: 'staff', enrolled: false, aal: 'aal2' }, 'passes'],
  ['optional', { role: 'staff', enrolled: true, aal: 'aal1' }, 'aal2_required'],
  ['optional', { role: 'staff', enrolled: true, aal: 'aal2' }, 'passes'],
  ['admins_required', { role: 'admin', enrolled: false, aal: 'aal1' }, 'mfa_required'],
  ['admins_required', { role: 'admin', enrolled: false, aal: 'aal2' }, 'mfa_required'],
  ['admins_required', { role: 'staff', enrolled: false, aal: 'aal1' }, 'passes'],
  ['admins_required', { role: 'admin', enrolled: true, aal: 'aal1' }, 'aal2_required'],
  ['admins_required', { role: 'admin', enrolled: true, aal: 'aal2' }, 'passes'],
  ['all_required', { role: 'staff', enrolled: false, aal: 'aal1' }, 'mfa_required'],
  ['all_required', { role: 'staff', enrolled: false, aal: 'aal2' }, 'mfa_required'],
  ['all_required', { role: 'staff', enrolled: true, aal: 'aal1' }, 'aal2_required'],
  ['all_required', { role: 'staff', enrolled: true, aal: 'aal2' }, 'passes'],
  ['hidden', { role: 'staff', enrolled: false, aal: 'aal1' }, 'mfa_required'],
  ['hidden', { role: 'staff', enrolled: true, aal: 'aal2' }, 'passes'],
];

describe('withContext: the readable policies keep their answers', () => {
  it.each(READABLE_ROWS)('%s, %o -> %s', async (policy, s, expected) => {
    expect(await answer(policy, s)).toBe(expected);
  });
});
