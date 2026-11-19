import { isRedirectError } from 'next/dist/client/components/redirect-error';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reportError } from '@/lib/error-reporter';

/**
 * Server Actions when the organization's authenticator policy was not read:
 * the organization row came back hidden from the member, or with a value that
 * is not a policy.
 *
 * The member is held to the strictest policy, so nothing is let through that
 * it would refuse. But whether set-up is owed is not known, so a member with
 * no verified authenticator is told their access could not be checked and to
 * try again, never sent to set up an authenticator, and nothing is written:
 *   - from a page that is not open before set-up (the schedule page, the team
 *     page), the context itself refuses (requireOrgContext());
 *   - from the profile page, which is open before set-up, the service gate
 *     refuses (mfaGateError), where it says set-up when the policy was read.
 * A factor whose enrolment was never confirmed counts as none. A policy that
 * was read keeps the set-up answer. A verified authenticator at aal2 writes,
 * in every state.
 *
 * Everything below the Supabase client is real (session, request cache, the
 * gates, withContext, the services, the actions' mappings); only the network
 * is faked, and it records every write. get_request_context() gives no
 * usable answer, so the organization row is read on its own. Outside a
 * render React `cache()` is a pass-through, which is the Server Action case.
 */

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock('@/server/services/audit', () => ({ audit: vi.fn(async () => undefined) }));

const state = vi.hoisted(() => ({
  /** The page the action was posted from (the proxy-set `x-pathname`). */
  page: '/dashboard/schedule',
  role: 'manager' as 'owner' | 'manager' | 'staff',
  /** What the organizations read answers. */
  organizations: { data: null, error: null } as { data: unknown; error: unknown },
  factors: [] as Array<{ status: string }>,
  aal: 'aal1' as 'aal1' | 'aal2',
  /** Every write the client was asked for. */
  writes: [] as string[],
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(
    async () =>
      new Headers({
        'x-stockpilot-user-id': 'u1',
        'x-stockpilot-user-email': 'u1@example.com',
        'x-pathname': state.page,
      }),
  ),
  cookies: vi.fn(async () => ({ get: () => undefined, getAll: () => [], set: () => {} })),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'not found' } }),
    from: (table: string) => {
      const answer = (): { data: unknown; error: unknown } => {
        switch (table) {
          case 'user_profiles':
            return {
              error: null,
              data: {
                id: 'u1',
                email: 'u1@example.com',
                full_name: 'Una One',
                avatar_url: null,
                default_organization_id: 'A',
                disabled_at: null,
              },
            };
          case 'organization_members':
            return {
              error: null,
              data: [
                {
                  organization_id: 'A',
                  role: state.role,
                  organizations: { id: 'A', name: 'Org A', logo_url: null },
                },
              ],
            };
          case 'role_permission_overrides':
          case 'user_permission_overrides':
            return { data: [], error: null };
          case 'organizations':
            return state.organizations;
          case 'organization_modules':
            return { data: [{ module_id: 'schedule' }], error: null };
          case 'notification_preferences':
            return { data: null, error: null };
          case 'schedule_events':
            return {
              error: null,
              data: {
                id: 'ev-1',
                organization_id: 'A',
                title: 'Example pickup',
                starts_at: '2026-12-01T17:00:00Z',
                ends_at: null,
                all_day: false,
                status: 'scheduled',
                created_by: null,
              },
            };
          default:
            throw new Error(`unexpected table ${table}`);
        }
      };
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'not', 'is', 'neq', 'order', 'limit', 'in']) {
        builder[m] = () => builder;
      }
      for (const m of ['insert', 'update', 'upsert', 'delete']) {
        builder[m] = () => {
          state.writes.push(`${table}.${m}`);
          return builder;
        };
      }
      builder.maybeSingle = async () => answer();
      builder.single = async () => answer();
      builder.then = (ok: (v: unknown) => unknown) => ok(answer());
      return builder;
    },
    auth: {
      getClaims: async () => ({
        data: { claims: { sub: 'u1', aal: state.aal } },
        error: null,
      }),
      getSession: async () => ({
        data: { session: { access_token: 'stored.token' } },
        error: null,
      }),
      getUser: async () => ({
        data: { user: { id: 'u1', email: 'u1@example.com', factors: state.factors } },
        error: null,
      }),
    },
  }),
}));

import type { CreateScheduleEventInput } from '@stockpilot/core';

import { NOTIFICATION_PREF_KEYS } from '@/lib/notification-prefs';

import { updateNotificationPreferencesAction } from './notification-preferences';
import { updateProfileNameAction } from './profile';
import { createScheduleEventAction } from './schedule';

const TRY_AGAIN = 'Your access could not be checked. Please try again.';
const SET_UP = '/dashboard/settings/security?enroll=1';

const UNREAD = {
  'a hidden row': { data: null, error: null },
  'a value that is not a policy': { data: { mfa_policy: 'not_a_policy' }, error: null },
} as const;
const UNREAD_STATES = Object.keys(UNREAD) as Array<keyof typeof UNREAD>;
const READ_ALL_REQUIRED = { data: { mfa_policy: 'all_required' }, error: null };
const READ_OPTIONAL = { data: { mfa_policy: 'optional' }, error: null };

const EVENT: CreateScheduleEventInput = {
  title: 'Example pickup',
  startsAt: '2026-12-01T17:00:00Z',
  allDay: false,
  status: 'scheduled',
};
/** Each state the policy was not read in, with no authenticator and with an unverified one only. */
const UNREAD_NO_AUTHENTICATOR = UNREAD_STATES.flatMap((s) =>
  (['none', 'unverified only'] as const).map((f) => [s, f] as const),
);

/**
 * 'aal2 token, none left': a token that says aal2 (a code was entered) while
 * the member's own list has no verified factor any more.
 */
type Factors = 'none' | 'unverified only' | 'verified at aal2' | 'aal2 token, none left';
const FACTORS: Factors[] = ['none', 'unverified only', 'verified at aal2'];

function arrange(organizations: { data: unknown; error: unknown }, factors: Factors, page: string) {
  state.organizations = organizations;
  state.page = page;
  state.factors =
    factors === 'none' || factors === 'aal2 token, none left'
      ? []
      : factors === 'unverified only'
        ? [{ status: 'unverified' }]
        : [{ status: 'verified' }];
  state.aal =
    factors === 'verified at aal2' || factors === 'aal2 token, none left' ? 'aal2' : 'aal1';
}

/** The redirect the action ended in (Next's own redirect error), or null when it answered. */
async function outcome<T>(run: () => Promise<T>): Promise<{ redirect: string } | { answer: T }> {
  try {
    return { answer: await run() };
  } catch (e) {
    if (!isRedirectError(e)) throw e;
    return { redirect: String(e.digest.split(';')[2]) };
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  state.role = 'manager';
  state.writes = [];
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('an action from a page that is not open before set-up (create a schedule event)', () => {
  it.each(UNREAD_NO_AUTHENTICATOR)(
    '%s, %s: the try-again sentence, reported once as a warning, and nothing written',
    async (unread, factors) => {
      arrange(UNREAD[unread], factors, '/dashboard/schedule');
      const res = await outcome(() => createScheduleEventAction(EVENT));
      expect(res).toEqual({
        answer: { ok: false, error: { code: 'internal_error', message: TRY_AGAIN } },
      });
      expect(JSON.stringify(res)).not.toMatch(/authenticator|enroll|MFA|security/i);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(vi.mocked(reportError).mock.calls[0]![0]).toMatchObject({
        name: 'OrganizationRowUnavailableError',
      });
      expect(vi.mocked(reportError).mock.calls[0]![1]).toMatchObject({ level: 'warning' });
      expect(state.writes).toEqual([]);
    },
  );

  it.each(['none', 'unverified only'] as const)(
    'a policy that was read and requires an authenticator, %s: sent to set-up, nothing written',
    async (factors) => {
      arrange(READ_ALL_REQUIRED, factors, '/dashboard/schedule');
      expect(await outcome(() => createScheduleEventAction(EVENT))).toEqual({ redirect: SET_UP });
      expect(state.writes).toEqual([]);
      expect(reportError).not.toHaveBeenCalled();
    },
  );

  it.each([...UNREAD_STATES, 'a policy that was read'] as const)(
    '%s, verified at aal2: the event is written',
    async (row) => {
      arrange(
        row === 'a policy that was read' ? READ_ALL_REQUIRED : UNREAD[row],
        'verified at aal2',
        '/dashboard/schedule',
      );
      expect(await outcome(() => createScheduleEventAction(EVENT))).toEqual({
        answer: { ok: true, data: { id: 'ev-1' } },
      });
      expect(state.writes).toEqual(['schedule_events.insert']);
    },
  );

  it('a policy that was read and asks nothing of this member: the event is written', async () => {
    arrange(READ_OPTIONAL, 'none', '/dashboard/schedule');
    expect(await outcome(() => createScheduleEventAction(EVENT))).toEqual({
      answer: { ok: true, data: { id: 'ev-1' } },
    });
    expect(state.writes).toEqual(['schedule_events.insert']);
  });
});

describe('an action from the profile page, open before set-up (change the name)', () => {
  const PROFILE = '/dashboard/settings/profile';

  it.each(UNREAD_NO_AUTHENTICATOR)(
    '%s, %s: the try-again sentence from the service gate, and nothing written',
    async (unread, factors) => {
      arrange(UNREAD[unread], factors, PROFILE);
      const res = await outcome(() => updateProfileNameAction({ fullName: 'Una Two' }));
      expect(res).toEqual({
        answer: { ok: false, error: { code: 'internal_error', message: TRY_AGAIN } },
      });
      expect(state.writes).toEqual([]);
      expect(vi.mocked(reportError).mock.calls[0]![0]).toMatchObject({
        name: 'OrganizationRowUnavailableError',
      });
    },
  );

  it.each(['none', 'unverified only'] as const)(
    'a policy that was read and requires an authenticator, %s: the set-up answer, nothing written',
    async (factors) => {
      arrange(READ_ALL_REQUIRED, factors, PROFILE);
      const res = await outcome(() => updateProfileNameAction({ fullName: 'Una Two' }));
      expect(res).toEqual({
        answer: {
          ok: false,
          error: {
            code: 'forbidden',
            message:
              'Multi-factor authentication required. Enroll in MFA before performing this action.',
            details: { reason: 'mfa_required' },
          },
        },
      });
      expect(state.writes).toEqual([]);
    },
  );

  it.each(
    FACTORS.filter((f) => f !== 'verified at aal2').flatMap((f) =>
      UNREAD_STATES.map((s) => [s, f] as const),
    ),
  )(
    '%s, %s, from a page that is not open: the context refuses first, the same sentence',
    async (unread, factors) => {
      arrange(UNREAD[unread], factors, '/dashboard/team');
      expect(await outcome(() => updateProfileNameAction({ fullName: 'Una Two' }))).toEqual({
        answer: { ok: false, error: { code: 'internal_error', message: TRY_AGAIN } },
      });
      expect(state.writes).toEqual([]);
    },
  );

  it.each([...UNREAD_STATES, 'a policy that was read'] as const)(
    '%s, verified at aal2: the name is written',
    async (row) => {
      arrange(
        row === 'a policy that was read' ? READ_ALL_REQUIRED : UNREAD[row],
        'verified at aal2',
        PROFILE,
      );
      expect(await outcome(() => updateProfileNameAction({ fullName: 'Una Two' }))).toEqual({
        answer: { ok: true, data: undefined },
      });
      expect(state.writes).toEqual(['user_profiles.update']);
    },
  );
});

/**
 * An action that asks requireOrgContext() and nothing more before it writes
 * (the member's own notification preferences: no service gate after the
 * context). Only the context's own rule (lib/auth/step-up-gate.ts) stands
 * between a member whose policy was not read and the write.
 */
describe('an action refused by the context alone (change notification preferences)', () => {
  const PAGE = '/dashboard/settings/notifications';
  const PATCH = { [NOTIFICATION_PREF_KEYS[0]!]: false };
  const WRITTEN = { answer: { ok: true, data: { changed: 1 } } };
  const TRY_AGAIN_ANSWER = {
    answer: { ok: false, error: { code: 'internal_error', message: TRY_AGAIN } },
  };

  it.each([
    ...UNREAD_NO_AUTHENTICATOR,
    ...UNREAD_STATES.map((s) => [s, 'aal2 token, none left'] as const),
  ])('%s, %s: the try-again sentence, and nothing written', async (unread, factors) => {
    arrange(UNREAD[unread], factors, PAGE);
    expect(await outcome(() => updateNotificationPreferencesAction(PATCH))).toEqual(
      TRY_AGAIN_ANSWER,
    );
    expect(state.writes).toEqual([]);
    expect(vi.mocked(reportError).mock.calls[0]![0]).toMatchObject({
      name: 'OrganizationRowUnavailableError',
    });
  });

  it.each(['none', 'unverified only'] as const)(
    'a policy that was read and requires an authenticator, %s: sent to set-up, nothing written',
    async (factors) => {
      arrange(READ_ALL_REQUIRED, factors, PAGE);
      expect(await outcome(() => updateNotificationPreferencesAction(PATCH))).toEqual({
        redirect: SET_UP,
      });
      expect(state.writes).toEqual([]);
    },
  );

  it.each([...UNREAD_STATES, 'a policy that was read'] as const)(
    '%s, verified at aal2: written',
    async (row) => {
      arrange(
        row === 'a policy that was read' ? READ_ALL_REQUIRED : UNREAD[row],
        'verified at aal2',
        PAGE,
      );
      expect(await outcome(() => updateNotificationPreferencesAction(PATCH))).toEqual(WRITTEN);
      expect(state.writes).toEqual(['notification_preferences.upsert']);
    },
  );

  it('a policy that was read, an aal2 token with no verified factor left: the context answers from the token, written', async () => {
    arrange(READ_ALL_REQUIRED, 'aal2 token, none left', PAGE);
    expect(await outcome(() => updateNotificationPreferencesAction(PATCH))).toEqual(WRITTEN);
    expect(state.writes).toEqual(['notification_preferences.upsert']);
  });

  it('a policy that was read and asks nothing of this member: written', async () => {
    arrange(READ_OPTIONAL, 'none', PAGE);
    expect(await outcome(() => updateNotificationPreferencesAction(PATCH))).toEqual(WRITTEN);
    expect(state.writes).toEqual(['notification_preferences.upsert']);
  });
});
