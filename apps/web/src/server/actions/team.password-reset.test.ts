import { beforeEach, describe, expect, it, vi } from 'vitest';

// sendMemberPasswordResetAction must resolve the target from the caller's
// OWN org membership (never a client-supplied email — a recovery link is an
// account-takeover primitive), then mint + send through the shared
// sendPasswordResetEmail helper (admin.generateLink → our /auth/confirm URL
// → Resend). The Supabase built-in mailer (resetPasswordForEmail) is capped
// at ~2 emails/hour project-wide and must never be reintroduced.

const generateLink = vi.fn();
const sendEmail = vi.fn();
const checkRateLimit = vi.fn();
const auditMock = vi.fn();

// Mutable role so the permission-gate test can demote the caller (mirrors
// custom-fields.test.ts). `permissions` is intentionally omitted from the
// ctx so the REAL assertPermission falls back to static role defaults.
const sessionState = {
  role: 'owner' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
};

type MaybeSingleResult = { data: Record<string, unknown> | null; error: { message: string } | null };

const dbState: { member: MaybeSingleResult; profile: MaybeSingleResult } = {
  member: { data: null, error: null },
  profile: { data: null, error: null },
};

function queryChain(result: () => MaybeSingleResult) {
  const q: Record<string, unknown> = {};
  q.select = vi.fn(() => q);
  q.eq = vi.fn(() => q);
  q.maybeSingle = vi.fn(async () => result());
  return q;
}

const ctxSupabase = {
  from: vi.fn((table: string) =>
    table === 'organization_members'
      ? queryChain(() => dbState.member)
      : queryChain(() => dbState.profile),
  ),
};

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimit(...args),
}));
vi.mock('@/lib/email/resend', () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ auth: { admin: { generateLink } } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({ requireSession: vi.fn() }));
vi.mock('@/lib/auth/verify-password', () => ({ verifyPasswordSideChannel: vi.fn() }));
vi.mock('@/server/services/audit', () => ({
  audit: (...args: unknown[]) => auditMock(...args),
}));
vi.mock('@/server/services/team', () => ({
  TeamService: { forCurrentUser: vi.fn() },
  acceptInviteWithToken: vi.fn(),
}));
vi.mock('@/server/services/context', async () => {
  const actual = await vi.importActual<typeof import('@/server/services/context')>(
    '@/server/services/context',
  );
  return {
    ...actual,
    withContext: vi.fn(async () => ({
      organizationId: 'org-1',
      userId: 'admin-1',
      role: sessionState.role,
      supabase: ctxSupabase,
      mfaRequired: false,
      mfaSatisfied: true,
      enabledModules: new Set(),
    })),
  };
});

import { sendMemberPasswordResetAction } from './team';

const TARGET = '22222222-2222-2222-2222-222222222222';

describe('sendMemberPasswordResetAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'owner';
    dbState.member = {
      data: { user_id: TARGET, accepted_at: '2026-01-01T00:00:00Z' },
      error: null,
    };
    dbState.profile = { data: { email: 'Member@Example.com' }, error: null };
    checkRateLimit.mockResolvedValue({ allowed: true });
    sendEmail.mockResolvedValue({ ok: true });
    generateLink.mockResolvedValue({
      data: {
        user: { id: TARGET },
        properties: { action_link: 'https://sb/verify?token=abc', hashed_token: 'hash123' },
      },
      error: null,
    });
  });

  it('denies a non-manager (manager lacks members:invite) and never touches the DB or mailer', async () => {
    sessionState.role = 'manager';

    const res = await sendMemberPasswordResetAction(TARGET);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('forbidden');
    expect(ctxSupabase.from).not.toHaveBeenCalled();
    expect(generateLink).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('errors not_found for a target outside the org and sends NO email', async () => {
    dbState.member = { data: null, error: null };

    const res = await sendMemberPasswordResetAction(TARGET);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('not_found');
    expect(generateLink).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('errors for a member who has not accepted their invite and sends NO email', async () => {
    dbState.member = { data: { user_id: TARGET, accepted_at: null }, error: null };

    const res = await sendMemberPasswordResetAction(TARGET);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('validation_error');
    expect(generateLink).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('happy path: mints a recovery link and emails OUR /auth/confirm URL, then audits', async () => {
    const res = await sendMemberPasswordResetAction(TARGET);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.email).toBe('Member@Example.com');

    expect(generateLink).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'recovery', email: 'Member@Example.com' }),
    );
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const msg = sendEmail.mock.calls[0]![0] as {
      to: string;
      html: string;
      text: string;
      from?: string;
    };
    expect(msg.to).toBe('Member@Example.com');
    // MUST be our server-verified confirm route — the raw action_link hands
    // the session back in a URL fragment and bounces users to /signin.
    // (HTML entity-escapes the query &; text carries it raw.)
    expect(msg.html).toContain('/auth/confirm?token_hash=hash123&amp;type=recovery');
    expect(msg.text).toContain('/auth/confirm?token_hash=hash123&type=recovery');
    expect(msg.html).not.toContain('https://sb/verify');
    // es registry sender for the security family.
    expect(msg.from).toBe('StockPilot Security <security@stockpilotusa.com>');

    // Same key family + budget as the self-serve form so an admin can't
    // blast a member past the public rate limit.
    expect(checkRateLimit).toHaveBeenCalledWith(
      'pwreset-req:member@example.com',
      3,
      15 * 60_000,
      'closed',
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'member.password_reset_sent',
        entityType: 'user',
        entityId: TARGET,
      }),
      expect.anything(),
    );
  });

  it('surfaces rate_limited to the admin and sends NO email', async () => {
    checkRateLimit.mockResolvedValue({ allowed: false });

    const res = await sendMemberPasswordResetAction(TARGET);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('rate_limited');
    expect(generateLink).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('surfaces a real send failure (unlike the anti-enumeration public form)', async () => {
    sendEmail.mockResolvedValue({ ok: false, error: 'resend down' });

    const res = await sendMemberPasswordResetAction(TARGET);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('internal_error');
      expect(res.error.message).toContain('check Resend');
    }
    expect(auditMock).not.toHaveBeenCalled();
  });
});
