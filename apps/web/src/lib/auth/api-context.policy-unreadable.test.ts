import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: an organization authenticator policy that cannot be read
 * is answered as the STRICTEST policy ('all_required'), on both API paths
 * (bearer and cookie): never as a lesser policy, and never as something
 * stricter than any policy an organization can have.
 *
 * The read in question is the fallback one: when get_request_context() gives
 * no usable answer, withApiContext reads `organizations.mfa_policy` itself
 * (resolveApiMfaState). That read can come back with an error (postgrest-js
 * resolves a statement timeout or a gateway 5xx as `{ data: null, error }`) or
 * throw (the request never got an answer).
 *
 * The strictest policy is a floor for every other one: a session it lets
 * through, every policy lets through, so holding an unread policy to it never
 * lets through a session the organization's real policy would refuse. And a
 * session it refuses is refused exactly as it would be under that policy:
 *
 *   - a session with an authenticator, at aal2: passes;
 *   - a session with an authenticator, at aal1: refused before anything is
 *     read (the route's own 401); on the reviewed allowlist the context is
 *     built and assertPermission asks for the code (`aal2_required`);
 *   - a session with no authenticator, at either level: `mfa_required`, as on
 *     the pages (services/context.ts resolveMfaState).
 *
 * The readable policies keep their answers: pinned below row by row.
 */

const refs = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  },
}));
vi.mock('@/lib/auth/effective-permissions', () => ({
  loadEffectivePermissions: async () => new Set<string>(['items:read']),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => refs.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => refs.client }));

import { assertPermission, ServiceError } from '@/server/services/context';
import { verifiedSessionAuth } from '@/test/verified-session-stub';

import { withApiContext } from './api-context';

const USER_ID = '77777777-7777-7777-7777-777777777777';
const ORG_ID = '66666666-6666-6666-6666-666666666666';

type ReadablePolicy = 'optional' | 'admins_required' | 'all_required';
/**
 * What the `organizations.mfa_policy` read gives: a stored value; `hidden`, no
 * row (row level security); `error`, an error answer; `throw`, no answer.
 */
type PolicyRead = ReadablePolicy | 'hidden' | 'error' | 'throw';
type Role = 'admin' | 'staff';
type Aal = 'aal1' | 'aal2';
type Path = 'bearer' | 'cookie';

const state = {
  policy: 'optional' as PolicyRead,
  role: 'staff' as Role,
  enrolled: false,
  aal: 'aal1' as Aal,
  calls: [] as string[],
};

/** Minimal PostgREST-shaped fake: chainable, awaitable, and maybeSingle-able. */
function table(single: unknown, list: unknown[] = []) {
  const q: Record<string, unknown> = {};
  const self = () => q;
  for (const k of ['select', 'eq', 'is', 'not', 'in', 'limit', 'order']) q[k] = self;
  q.maybeSingle = async () => ({ data: single, error: null, status: 200 });
  q.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: list, error: null, status: 200 }).then(resolve);
  return q;
}

const row = (r: unknown) => table(r, r ? [r] : []);

/**
 * The `organizations` reads. The policy read answers the way `state.policy`
 * says; the comp flag read (the module set) always answers.
 */
function organizations() {
  let columns = '';
  const q = table(null);
  q.select = (c: string) => {
    columns = c;
    return q;
  };
  q.maybeSingle = async () => {
    if (columns !== 'mfa_policy') {
      return { data: { all_modules_comp: false }, error: null, status: 200 };
    }
    state.calls.push('organizations');
    if (state.policy === 'throw') throw new TypeError('fetch failed');
    if (state.policy === 'error') {
      return {
        data: null,
        error: { code: '57014', message: 'canceling statement due to statement timeout' },
        status: 500,
      };
    }
    if (state.policy === 'hidden') return { data: null, error: null, status: 200 };
    return { data: { mfa_policy: state.policy }, error: null, status: 200 };
  };
  return q;
}

function makeClient() {
  return {
    // The one-round-trip read cannot answer, so the fallback reads run: the
    // only place the policy is read on its own.
    rpc: async () => ({ data: null, error: { code: 'PGRST301' } }),
    from: (name: string) => {
      if (name === 'organizations') return organizations();
      if (name === 'organization_members') return row({ organization_id: ORG_ID, role: state.role });
      if (name === 'user_profiles')
        return row({
          id: USER_ID,
          email: 'person@example.com',
          default_organization_id: ORG_ID,
          disabled_at: null,
        });
      return table(null, []);
    },
    auth: {
      getUser: async () => ({
        data: {
          user: {
            id: USER_ID,
            email: 'person@example.com',
            factors: state.enrolled ? [{ status: 'verified' }] : [],
          },
        },
        error: null,
      }),
      ...verifiedSessionAuth(() => ({ sub: USER_ID, aal: state.aal })),
    },
  };
}

function fakeJwt(aal: Aal): string {
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg({ sub: USER_ID, aal })}.sig`;
}

function request(path: Path): Request {
  return path === 'bearer'
    ? new Request('https://app.test/api/v1/items', {
        headers: { authorization: `Bearer ${fakeJwt(state.aal)}`, 'x-organization-id': ORG_ID },
      })
    : new Request('https://app.test/api/v1/items', {
        headers: { cookie: 'sb-example-auth-token=abc' },
      });
}

/** What the caller gets: the route's 401, a pass, or the gate's reason. */
type Answer = '401' | 'passes' | 'aal2_required' | 'mfa_required';

interface Session {
  role: Role;
  enrolled: boolean;
  aal: Aal;
  /** On the reviewed allowlist (allowStepUpPending): the context is built at aal1. */
  allowlisted?: boolean;
}

async function run(path: Path, policy: PolicyRead, s: Session) {
  state.policy = policy;
  state.role = s.role;
  state.enrolled = s.enrolled;
  state.aal = s.aal;
  state.calls = [];
  refs.client = makeClient();
  return withApiContext(
    request(path),
    s.allowlisted ? { allowStepUpPending: true } : undefined,
  );
}

async function answer(path: Path, policy: PolicyRead, s: Session): Promise<Answer> {
  const ctx = await run(path, policy, s);
  if (!ctx) return '401';
  try {
    assertPermission(ctx, 'items:read');
    return 'passes';
  } catch (e) {
    expect(e).toBeInstanceOf(ServiceError);
    return (e as ServiceError).details?.reason as Answer;
  }
}

const PATHS: Path[] = ['bearer', 'cookie'];
const UNREADABLE: PolicyRead[] = ['error', 'throw'];
const READABLE: ReadablePolicy[] = ['optional', 'admins_required', 'all_required'];

/** Every session shape the context can be asked for. */
const SESSIONS: Session[] = (['admin', 'staff'] as Role[]).flatMap((role) =>
  [false, true].flatMap((enrolled) =>
    (['aal1', 'aal2'] as Aal[]).flatMap((aal) => [
      { role, enrolled, aal },
      ...(enrolled && aal === 'aal1' ? [{ role, enrolled, aal, allowlisted: true }] : []),
    ]),
  ),
);

const label = (s: Session) =>
  `${s.role}, ${s.enrolled ? 'authenticator' : 'no authenticator'}, ${s.aal}${s.allowlisted ? ', allowlisted' : ''}`;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe.each(PATHS)('withApiContext (%s): an unreadable policy is the strictest policy', (path) => {
  describe.each(UNREADABLE)('the policy read gives %s', (read) => {
    it('an aal2 session with an authenticator passes', async () => {
      for (const role of ['admin', 'staff'] as Role[]) {
        const ctx = await run(path, read, { role, enrolled: true, aal: 'aal2' });
        expect(state.calls).toContain('organizations');
        expect(ctx).not.toBeNull();
        expect(ctx?.mfaRequired).toBe(true);
        expect(ctx?.mfaSatisfied).toBe(true);
        expect(ctx?.mfaEnrolled).toBe(true);
        expect(() => assertPermission(ctx!, 'items:read')).not.toThrow();
      }
    });

    it('an aal1 session with an authenticator is refused before any read, and asked for its code on the allowlist', async () => {
      for (const role of ['admin', 'staff'] as Role[]) {
        expect(await run(path, read, { role, enrolled: true, aal: 'aal1' })).toBeNull();
        expect(state.calls).toEqual([]);
        expect(
          await answer(path, read, { role, enrolled: true, aal: 'aal1', allowlisted: true }),
        ).toBe('aal2_required');
      }
    });

    it('a session with no authenticator gets what the strictest policy gives it', async () => {
      for (const role of ['admin', 'staff'] as Role[]) {
        expect(await answer(path, read, { role, enrolled: false, aal: 'aal1' })).toBe(
          'mfa_required',
        );
        expect(await answer(path, read, { role, enrolled: false, aal: 'aal1' })).toBe(
          await answer(path, 'all_required', { role, enrolled: false, aal: 'aal1' }),
        );
      }
    });

    it('every session is answered exactly as all_required and a hidden row answer it', async () => {
      for (const s of SESSIONS) {
        const unread = await run(path, read, s);
        const strictest = await run(path, 'all_required', s);
        const hidden = await run(path, 'hidden', s);
        const triple = (c: typeof unread) =>
          c && { required: c.mfaRequired, satisfied: c.mfaSatisfied, enrolled: c.mfaEnrolled };
        expect(triple(unread), label(s)).toEqual(triple(strictest));
        expect(triple(unread), label(s)).toEqual(triple(hidden));
      }
    });

    it('never lets through a session that any readable policy refuses', async () => {
      for (const s of SESSIONS) {
        if ((await answer(path, read, s)) !== 'passes') continue;
        for (const policy of READABLE) {
          expect(await answer(path, policy, s), `${label(s)} under ${policy}`).toBe('passes');
        }
      }
    });

    it('still logs the failed read', async () => {
      await run(path, read, { role: 'admin', enrolled: true, aal: 'aal2' });
      expect(vi.mocked(console.error)).toHaveBeenCalledWith(
        '[resolveApiMfaState] failed:',
        expect.any(Error),
      );
    });
  });
});

/**
 * The readable policies, row by row. `401` is the step-up refusal
 * (an authenticator, a session at aal1), which comes before the policy read.
 */
const READABLE_ROWS: Array<[PolicyRead, Session, Answer]> = [
  ['optional', { role: 'admin', enrolled: false, aal: 'aal1' }, 'passes'],
  ['optional', { role: 'staff', enrolled: false, aal: 'aal1' }, 'passes'],
  ['optional', { role: 'staff', enrolled: false, aal: 'aal2' }, 'passes'],
  ['optional', { role: 'staff', enrolled: true, aal: 'aal1' }, '401'],
  ['optional', { role: 'staff', enrolled: true, aal: 'aal1', allowlisted: true }, 'aal2_required'],
  ['optional', { role: 'staff', enrolled: true, aal: 'aal2' }, 'passes'],
  ['admins_required', { role: 'admin', enrolled: false, aal: 'aal1' }, 'mfa_required'],
  ['admins_required', { role: 'admin', enrolled: false, aal: 'aal2' }, 'mfa_required'],
  ['admins_required', { role: 'staff', enrolled: false, aal: 'aal1' }, 'passes'],
  ['admins_required', { role: 'staff', enrolled: false, aal: 'aal2' }, 'passes'],
  ['admins_required', { role: 'admin', enrolled: true, aal: 'aal1' }, '401'],
  ['admins_required', { role: 'admin', enrolled: true, aal: 'aal1', allowlisted: true }, 'aal2_required'],
  ['admins_required', { role: 'admin', enrolled: true, aal: 'aal2' }, 'passes'],
  ['all_required', { role: 'admin', enrolled: false, aal: 'aal1' }, 'mfa_required'],
  ['all_required', { role: 'staff', enrolled: false, aal: 'aal1' }, 'mfa_required'],
  ['all_required', { role: 'admin', enrolled: false, aal: 'aal2' }, 'mfa_required'],
  ['all_required', { role: 'staff', enrolled: false, aal: 'aal2' }, 'mfa_required'],
  ['all_required', { role: 'admin', enrolled: true, aal: 'aal2' }, 'passes'],
  ['all_required', { role: 'staff', enrolled: true, aal: 'aal1' }, '401'],
  ['all_required', { role: 'staff', enrolled: true, aal: 'aal1', allowlisted: true }, 'aal2_required'],
  ['all_required', { role: 'staff', enrolled: true, aal: 'aal2' }, 'passes'],
  ['hidden', { role: 'staff', enrolled: false, aal: 'aal1' }, 'mfa_required'],
  ['hidden', { role: 'staff', enrolled: true, aal: 'aal2' }, 'passes'],
];

describe.each(PATHS)('withApiContext (%s): the readable policies keep their answers', (path) => {
  it.each(READABLE_ROWS)('%s, %o -> %s', async (policy, s, expected) => {
    expect(await answer(path, policy, s)).toBe(expected);
  });
});
