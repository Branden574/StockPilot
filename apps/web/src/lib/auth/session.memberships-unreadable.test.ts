import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { RequestContextBundle } from '@/lib/auth/request-context-bundle';

/**
 * A membership list that cannot be read is not "no workspace".
 *
 * Without an answer from get_request_context() the session loader reads the
 * profile and the memberships itself (the legacy reads). PostgREST answers a
 * failed read as { data: null, error }, and the loader used to take that null
 * as an empty list: a caller asking "which workspaces does this person belong
 * to?" could not tell "none" from "could not read". readSessionMemberships()
 * says which it was; getSessionMemberships() and every page keep their answer.
 */

const state = vi.hoisted(() => ({
  /** The identity header the proxy forwards ('' = none). */
  headerUserId: 'u1',
  /** What the legacy membership read answers. */
  members: { data: null as unknown, error: null as { code: string; message: string } | null },
  /** A confirmed get_request_context() answer, or null for no answer. */
  confirmedBundle: null as RequestContextBundle | null,
}));

const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));
vi.mock('next/headers', () => ({
  headers: vi.fn(async () =>
    state.headerUserId
      ? new Headers({
          'x-stockpilot-user-id': state.headerUserId,
          'x-stockpilot-user-email': 'u1@example.com',
        })
      : new Headers(),
  ),
  cookies: vi.fn(async () => ({ get: () => undefined, set: () => {}, delete: () => {} })),
}));
vi.mock('@/lib/auth/effective-permissions', () => ({
  loadEffectivePermissions: vi.fn(async () => new Set<string>()),
}));
vi.mock('@/lib/auth/request-context-bundle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/request-context-bundle')>();
  return {
    ...actual,
    resolveRequestContext: vi.fn(async () =>
      state.confirmedBundle
        ? { identity: 'confirmed' as const, bundle: state.confirmedBundle }
        : actual.resolveRequestContext(),
    ),
  };
});

const TIMEOUT_MESSAGE = 'canceling statement due to statement timeout';

const profileRow = {
  id: 'u1',
  email: 'u1@example.com',
  full_name: 'Example Person',
  avatar_url: null,
  default_organization_id: 'org-B',
  disabled_at: null,
};
const memberRow = {
  organization_id: 'org-B',
  role: 'staff',
  organizations: { id: 'org-B', name: 'Org B', logo_url: null },
};

// No rpc on this client: get_request_context() throws inside its own try and
// gives no answer, so the cookie session is verified (getUser) and the legacy
// reads run.
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'u1', email: 'u1@example.com' } }, error: null }),
    },
    from: (table: string) => {
      const result = table === 'user_profiles' ? { data: profileRow, error: null } : state.members;
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'not', 'is', 'order', 'limit']) {
        builder[m] = () => builder;
      }
      builder.maybeSingle = async () => result;
      builder.single = async () => result;
      builder.then = (res: (v: unknown) => unknown) => res(result);
      return builder;
    },
  }),
}));

let warn: MockInstance<Console['warn']>;

beforeEach(() => {
  vi.clearAllMocks();
  state.headerUserId = 'u1';
  state.members = { data: [], error: null };
  state.confirmedBundle = null;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

function failTheMembershipRead() {
  state.members = { data: null, error: { code: '57014', message: TIMEOUT_MESSAGE } };
}

describe('readSessionMemberships: a membership list that cannot be read is not "no workspace"', () => {
  it('a failed membership read answers { ok: false }', async () => {
    failTheMembershipRead();
    const { readSessionMemberships } = await import('./session');
    expect(await readSessionMemberships()).toEqual({ ok: false });
  });

  it('a read with no rows answers an empty list', async () => {
    const { readSessionMemberships } = await import('./session');
    expect(await readSessionMemberships()).toEqual({ ok: true, memberships: [] });
  });

  it('a read with one row answers that membership', async () => {
    state.members = { data: [memberRow], error: null };
    const { readSessionMemberships } = await import('./session');
    expect(await readSessionMemberships()).toEqual({
      ok: true,
      memberships: [{ organizationId: 'org-B', role: 'staff', name: 'Org B', logoUrl: null }],
    });
  });

  it('an answer from get_request_context() with no memberships is an empty list, never unreadable', async () => {
    failTheMembershipRead(); // never reached: the bundle answers
    state.confirmedBundle = {
      profile: profileRow,
      memberships: [],
    } as unknown as RequestContextBundle;
    const { readSessionMemberships } = await import('./session');
    expect(await readSessionMemberships()).toEqual({ ok: true, memberships: [] });
  });

  it('no identity header (signed out) is an empty list', async () => {
    failTheMembershipRead(); // never reached: no session
    state.headerUserId = '';
    const { readSessionMemberships } = await import('./session');
    expect(await readSessionMemberships()).toEqual({ ok: true, memberships: [] });
  });

  it('logs the failed read with its code only, never the message', async () => {
    failTheMembershipRead();
    const { readSessionMemberships } = await import('./session');
    await readSessionMemberships();
    const line = warn.mock.calls.find((args) => args[0] === '[session] membership read failed:');
    expect(line).toEqual(['[session] membership read failed:', '57014']);
    for (const args of warn.mock.calls) {
      for (const arg of args) expect(String(arg)).not.toContain(TIMEOUT_MESSAGE);
    }
  });
});

describe('a failed membership read: the other session helpers answer as before', () => {
  it('requireOrgContext() still sends the person to /onboarding', async () => {
    failTheMembershipRead();
    const { requireOrgContext } = await import('./session');
    await expect(requireOrgContext()).rejects.toThrow('REDIRECT:/onboarding');
  });

  it('getSessionMemberships() still answers an empty list (the dashboard switcher)', async () => {
    failTheMembershipRead();
    const { getSessionMemberships } = await import('./session');
    expect(await getSessionMemberships()).toEqual([]);
  });

  it("getServerSession() still answers the profile's session", async () => {
    failTheMembershipRead();
    const { getServerSession } = await import('./session');
    expect(await getServerSession()).toEqual({
      userId: 'u1',
      email: 'u1@example.com',
      fullName: 'Example Person',
      avatarUrl: null,
      defaultOrganizationId: 'org-B',
    });
  });
});
