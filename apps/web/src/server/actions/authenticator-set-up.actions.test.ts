// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Server Actions for a member who must set up an authenticator first: an
 * owner or admin with no verified factor under admins_required (the same
 * holds for everyone under all_required).
 *
 * The page an action is made from is the proxy-set path. From the security
 * page and the profile page, the actions on them run: setting up an
 * authenticator, switching organization, and the profile's own actions,
 * which reach their own authenticator check, except deleting the account,
 * which the account's password (or an emailed code) confirms, so it
 * completes before set-up. From any other page, an action
 * that builds on the member's context is answered with the redirect to
 * set-up, and reads and writes nothing.
 *
 * Through the REAL session loader, gates and withContext(); only the network
 * is faked. next/navigation is the real one: the redirect is Next's own
 * control-flow error, which each action's catch lets through.
 */

vi.mock('next/headers', async () => {
  const f = await import('@/test/step-up-session-fixture');
  return {
    headers: async () => f.fixtureHeaders(),
    cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/lib/supabase/server', async () => {
  const f = await import('@/test/step-up-session-fixture');
  return {
    createClient: async () => {
      const client = f.fixtureClient();
      return {
        ...client,
        // The organization switch's own reads and write: the membership it
        // switches to, and the profile's active organization.
        from: (table: string) => {
          if (table !== 'organization_members' && table !== 'user_profiles') {
            return client.from(table);
          }
          f.world.calls.push(`from:${table}`);
          const builder: Record<string, unknown> = {};
          for (const m of ['select', 'eq', 'not', 'update']) builder[m] = () => builder;
          builder.maybeSingle = async () => ({ data: { organization_id: f.ORG_2 }, error: null });
          builder.then = (res: (v: unknown) => unknown) => res({ data: null, error: null });
          return builder;
        },
      };
    },
  };
});
vi.mock('@/lib/error-reporter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/error-reporter')>()),
  reportError: vi.fn(async () => {}),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 4 })),
}));
// Account deletion: the account's own factors and address by its id, the
// password check on its separate client, and the database's dry run and the
// delete. Only the network is faked; the action's own rule is real.
const deletion = vi.hoisted(() => ({
  deleteUser: vi.fn(async (_id: string) => ({ error: null })),
}));
vi.mock('@/lib/supabase/admin', async () => {
  const f = await import('@/test/step-up-session-fixture');
  return {
    createAdminClient: () => ({
      auth: {
        admin: {
          getUserById: async (id: string) => ({
            data: { user: { id, email: f.EMAIL } },
            error: null,
          }),
          deleteUser: deletion.deleteUser,
          mfa: {
            listFactors: async () => ({
              data: {
                factors: f.world.factors.map((x, i) => ({
                  id: `f${i}`,
                  factor_type: 'totp',
                  ...x,
                })),
              },
              error: null,
            }),
          },
        },
      },
    }),
  };
});
vi.mock('@/lib/auth/verify-password', () => ({
  verifyPasswordSideChannel: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/server/lib/account-deletion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/lib/account-deletion')>()),
  soleOwnedOrganizationsWithMembers: vi.fn(async () => ({ ok: true, organizations: [] })),
  checkAccountDeletable: vi.fn(async () => ({ ok: true })),
  readDeletionReviewFacts: vi.fn(async () => ({
    createdStillActive: null,
    soloPaidOrganizationIds: [],
  })),
  reportDeletionReviewFacts: vi.fn(),
  removeAvatarObjects: vi.fn(async () => {}),
  auditAccountDeleted: vi.fn(async () => {}),
}));

import { ORG, ORG_2, USER, resetWorld, world } from '@/test/step-up-session-fixture';

import { enrollFactorAction } from './mfa';
import { updateNotificationPreferencesAction } from './notification-preferences';
import { switchOrganizationAction } from './org-switcher';
import { deleteOwnAccountAction, updateProfileNameAction } from './profile';

const SECURITY = '/dashboard/settings/security';
const PROFILE = '/dashboard/settings/profile';
const OTHER_PAGE = '/dashboard/inventory';

/** Next's redirect error for the set-up page (its digest names the destination). */
const toSetUp = {
  digest: expect.stringMatching(/^NEXT_REDIRECT;[a-z]+;\/dashboard\/settings\/security\?enroll=1;/),
};
const tableCalls = () => world.calls.filter((c) => c.startsWith('from:'));

beforeEach(() => {
  resetWorld();
  deletion.deleteUser.mockClear();
  world.policy = 'admins_required';
  world.role = 'admin';
  world.orgs = [ORG, ORG_2];
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('from the security page', () => {
  beforeEach(() => {
    world.pathname = SECURITY;
  });

  it('starting to set up an authenticator runs', async () => {
    expect(await enrollFactorAction()).toEqual({
      ok: true,
      data: { factorId: 'factor-new', qrCode: 'qr', secret: 'secret', uri: 'otpauth://example' },
    });
  });

  it('switching organization runs: the membership is checked and the profile written', async () => {
    expect(await switchOrganizationAction({ organizationId: ORG_2 })).toEqual({
      ok: true,
      data: undefined,
    });
    expect(tableCalls()).toEqual(['from:organization_members', 'from:user_profiles']);
  });
});

describe('from the profile page', () => {
  beforeEach(() => {
    world.pathname = PROFILE;
  });

  it('a profile action is not sent away: it reaches its own authenticator check, which answers that one is required', async () => {
    const result = await updateProfileNameAction({ fullName: 'Pat Example' });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'forbidden',
        details: expect.objectContaining({ reason: 'mfa_required' }),
      }),
    });
    expect(tableCalls()).toEqual([]);
  });

  it('deleting the account is the one profile action that runs: with the password, the account is deleted', async () => {
    const result = await deleteOwnAccountAction({
      confirm: 'DELETE',
      password: 'example-password-1',
    });
    expect(result).toEqual({ ok: true, data: undefined });
    expect(deletion.deleteUser).toHaveBeenCalledWith(USER);
  });

  it('deleting the account without a password or a code asks for one, not for set-up, and deletes nothing', async () => {
    const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'forbidden',
        details: expect.objectContaining({ reason: 'credential_required' }),
      }),
    });
    expect(deletion.deleteUser).not.toHaveBeenCalled();
  });
});

describe('from any other page', () => {
  beforeEach(() => {
    world.pathname = OTHER_PAGE;
  });

  it('switching organization is answered with the redirect to set-up, and nothing is read or written', async () => {
    await expect(switchOrganizationAction({ organizationId: ORG_2 })).rejects.toMatchObject(
      toSetUp,
    );
    expect(tableCalls()).toEqual([]);
  });

  it('an action that asks requireOrgContext() directly is answered with the redirect, and nothing is written', async () => {
    await expect(
      updateNotificationPreferencesAction({ push_low_stock: false }),
    ).rejects.toMatchObject(toSetUp);
    expect(tableCalls()).toEqual([]);
  });

  it('starting to set up an authenticator still runs: it asks for the session only', async () => {
    expect((await enrollFactorAction()).ok).toBe(true);
  });

  it('a manager in the same organization is not affected: the switch runs', async () => {
    world.role = 'manager';
    expect((await switchOrganizationAction({ organizationId: ORG_2 })).ok).toBe(true);
  });
});
