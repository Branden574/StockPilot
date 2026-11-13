import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * acceptInviteAction hands the service's alreadyMember answer to the invite
 * page's button, which then says the person is already a member instead of
 * welcoming them (services/team.accept-invite-existing-member.test.ts pins
 * that the membership is left as it was).
 */

const accept = vi.hoisted(() => ({
  result: { organizationId: 'org-1', alreadyMember: false } as {
    organizationId: string;
    alreadyMember: boolean;
  },
}));

vi.mock('@/server/services/team', () => ({
  TeamService: { forCurrentUser: vi.fn() },
  acceptInviteWithToken: vi.fn(async () => accept.result),
}));
vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(async () => ({
    userId: 'member-user',
    email: 'member.person@example.test',
    fullName: null,
    avatarUrl: null,
    defaultOrganizationId: 'org-1',
  })),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { acceptInviteWithToken } from '@/server/services/team';

import { acceptInviteAction } from './team';

// A dull value under a neutral name (secret scanners fire on a token-shaped
// name holding a random-looking string); the schema wants 20 to 120 characters.
const INVITE_REF = 'invite_ref_' + 'a'.repeat(16);

beforeEach(() => vi.clearAllMocks());

describe('acceptInviteAction', () => {
  it('says when the person was already a member', async () => {
    accept.result = { organizationId: 'org-1', alreadyMember: true };
    const res = await acceptInviteAction({ token: INVITE_REF });
    expect(acceptInviteWithToken).toHaveBeenCalledWith(INVITE_REF, 'member-user');
    expect(res).toEqual({ ok: true, data: { organizationId: 'org-1', alreadyMember: true } });
  });

  it('says so too when the membership was just made', async () => {
    accept.result = { organizationId: 'org-1', alreadyMember: false };
    const res = await acceptInviteAction({ token: INVITE_REF });
    expect(res).toEqual({ ok: true, data: { organizationId: 'org-1', alreadyMember: false } });
  });
});
