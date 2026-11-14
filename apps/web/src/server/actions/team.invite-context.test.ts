import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Docket S74 (web). inviteMemberAction builds the REAL TeamService with the
 * context withContext() resolved, and the invitation email names the
 * organization of that same context. Only TeamService.prototype.invite is
 * replaced (to see the context the service holds), never the class.
 */

const ORG_CONTEXT = '68686868-6868-4868-8868-686868686868';
const ORG_DEFAULT = '79797979-7979-4979-8979-797979797979';

const h = vi.hoisted(() => ({
  names: {} as Record<string, string>,
  /** The exact object withContext() handed out. */
  ctx: null as null | Record<string, unknown>,
}));

function fakeClient() {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: (_col: string, id: string) => ({
          maybeSingle: async () => ({
            data: table === 'organizations' && h.names[id] ? { name: h.names[id] } : null,
            error: null,
          }),
        }),
      }),
    }),
  };
}

vi.mock('@/lib/env', () => ({ env: { NEXT_PUBLIC_APP_URL: 'https://app.example.com' } }));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => fakeClient()) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => fakeClient()) }));
vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(async () => ({
    userId: 'inviter-user',
    email: 'inviter@example.com',
    fullName: 'Casey Inviter',
    avatarUrl: null,
    defaultOrganizationId: ORG_DEFAULT,
  })),
}));
vi.mock('@/server/services/context', () => {
  class ServiceError extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    ServiceError,
    withContext: vi.fn(async () => {
      h.ctx = {
        organizationId: ORG_CONTEXT,
        userId: 'inviter-user',
        role: 'admin',
        supabase: fakeClient(),
      };
      return h.ctx;
    }),
    assertPermission: vi.fn(),
    assertRoleUnchanged: vi.fn(),
    assertCurrentAal2: vi.fn(),
  };
});
vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => {}),
  insertAuditRowReported: vi.fn(async () => true),
}));
vi.mock('@/server/services/integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/server/services/platform/sessions', () => ({ revokeAllSessionsForUser: vi.fn() }));
vi.mock('@/lib/email/resend', () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/lib/auth/password-reset-email', () => ({ sendPasswordResetEmail: vi.fn() }));
vi.mock('@/lib/auth/verify-password', () => ({ verifyPasswordSideChannel: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { TeamService } from '@/server/services/team';

import { inviteMemberAction } from './team';

const seen: Array<{ ctx: unknown; params: Record<string, unknown> }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  seen.length = 0;
  h.ctx = null;
  h.names = { [ORG_CONTEXT]: 'Harbor Supply', [ORG_DEFAULT]: 'Ridge Depot' };
  vi.spyOn(TeamService.prototype, 'invite').mockImplementation(async function (
    this: unknown,
    params: Parameters<TeamService['invite']>[0],
  ) {
    seen.push({ ctx: (this as { ctx: unknown }).ctx, params: params as unknown as Record<string, unknown> });
    return { acceptUrl: 'https://app.example.com/i/x' } as Awaited<ReturnType<TeamService['invite']>>;
  });
});

describe('inviteMemberAction runs the real TeamService on the resolved context', () => {
  it('the service holds the context withContext() returned, and the email names that organization', async () => {
    const res = await inviteMemberAction({ email: 'new.person@example.com', role: 'staff' });
    expect(res.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(h.ctx).not.toBeNull();
    // The very object withContext() resolved, not a second context.
    expect(seen[0]!.ctx).toBe(h.ctx);
    expect((seen[0]!.ctx as { organizationId: string }).organizationId).toBe(ORG_CONTEXT);
    expect(seen[0]!.params).toMatchObject({ organizationName: 'Harbor Supply' });
  });
});
