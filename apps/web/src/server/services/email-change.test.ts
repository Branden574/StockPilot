import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The verified email-change service. What these tests PROVE (each was
 * mutation-checked against the implementation):
 *   * the new-side link carries sha224(newEmail + otp) — the value GoTrue
 *     STORES — and never the hashed_token generateLink returns for that side;
 *   * the current address is still canonical after a request: nothing writes
 *     user_profiles, and the unverified address gets exactly one message;
 *   * the refusal order: same-address → rate limit → MFA step-up → password
 *     → duplicate, each stopping before the next spends anything;
 *   * reconcile is idempotent and complete() tells the OLD address once.
 */

const generateLink = vi.fn();
const getUserById = vi.fn();
const rpc = vi.fn();
const checkRateLimit = vi.fn();
const verifyPasswordSideChannel = vi.fn();
const sendEmail = vi.fn();

// A tiny table store so from().select()/update()/insert() behave.
const tables: Record<string, Record<string, unknown> | null> = {};
const auditRows: { metadata: Record<string, unknown>; created_at: string }[] = [];
const updates: { table: string; payload: Record<string, unknown> }[] = [];
const inserts: { table: string; payload: Record<string, unknown> }[] = [];

function fromStub(table: string) {
  return {
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: tables[table] ?? null, error: null }),
        eq: () => ({
          order: () => ({ limit: async () => ({ data: auditRows, error: null }) }),
        }),
      }),
    }),
    update: (payload: Record<string, unknown>) => ({
      eq: async () => {
        updates.push({ table, payload });
        if (table === 'user_profiles' && tables.user_profiles) {
          tables.user_profiles = { ...tables.user_profiles, ...payload };
        }
        return { error: null };
      },
    }),
    insert: async (payload: Record<string, unknown>) => {
      inserts.push({ table, payload });
      return { error: null };
    },
  };
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    auth: { admin: { generateLink, getUserById } },
    from: (table: string) => fromStub(table),
    rpc,
  }),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimit(...args),
}));
vi.mock('@/lib/auth/verify-password', () => ({
  verifyPasswordSideChannel: (...args: unknown[]) => verifyPasswordSideChannel(...args),
}));
vi.mock('@/lib/email/resend', () => ({
  sendEmail: (args: unknown) => sendEmail(args),
}));
vi.mock('@/lib/env', () => ({
  env: { NEXT_PUBLIC_APP_URL: 'https://app.example.com' },
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

import {
  cancelEmailChange,
  completeEmailChange,
  getEmailChangeStatus,
  mintEmailChangeLinks,
  reconcileProfileEmail,
  requestEmailChange,
  resendEmailChange,
} from './email-change';

const USER_ID = 'u-1';
const OLD = 'old@example.com';
const NEW = 'new@example.com';
const OTP_NEW = '12345678';
const sha224 = (s: string) => createHash('sha224').update(s).digest('hex');

function authUser(overrides: Record<string, unknown> = {}) {
  return { data: { user: { id: USER_ID, email: OLD, ...overrides } }, error: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(tables)) delete tables[k];
  auditRows.length = 0;
  updates.length = 0;
  inserts.length = 0;

  tables.user_profiles = {
    email: OLD,
    default_organization_id: 'org-1',
    full_name: 'Dana Keeler',
    disabled_at: null,
    deleted_at: null,
  };
  getUserById.mockResolvedValue(authUser());
  checkRateLimit.mockResolvedValue({ allowed: true });
  verifyPasswordSideChannel.mockResolvedValue({ ok: true });
  sendEmail.mockResolvedValue({ ok: true, id: 'msg' });
  rpc.mockImplementation(async (name: string) => {
    if (name === 'auth_user_exists_by_email') return { data: false, error: null };
    if (name === 'cancel_pending_email_change') return { data: true, error: null };
    return { data: null, error: { message: `unexpected rpc ${name}` } };
  });
  generateLink.mockImplementation(async (params: { type: string }) => {
    if (params.type === 'email_change_current') {
      return { data: { properties: { hashed_token: 'CURRENT-HASH', email_otp: '00000000' } }, error: null };
    }
    // The GoTrue bug: the returned hash is computed with the CURRENT email.
    return {
      data: { properties: { hashed_token: sha224(`${OLD}${OTP_NEW}`), email_otp: OTP_NEW } },
      error: null,
    };
  });
});

const REQUEST = {
  userId: USER_ID,
  newEmail: NEW,
  currentPassword: 'test-only-current-password',
  mfa: { enrolled: false, aal2: false },
  source: 'web' as const,
};

describe('mintEmailChangeLinks — the GoTrue new-side hash bug', () => {
  it('builds the new-side link from sha224(newEmail + otp), NOT the returned hashed_token', async () => {
    const links = await mintEmailChangeLinks(OLD, NEW);
    const expectedNew = sha224(`${NEW}${OTP_NEW}`);
    expect(links.newUrl).toBe(
      `https://app.example.com/auth/confirm?token_hash=${expectedNew}&type=email_change`,
    );
    // The returned value (sha224(OLD + otp)) must not appear anywhere.
    expect(links.newUrl).not.toContain(sha224(`${OLD}${OTP_NEW}`));
    expect(links.currentUrl).toBe(
      'https://app.example.com/auth/confirm?token_hash=CURRENT-HASH&type=email_change',
    );
    // No `next` on either: the route hard-codes its destination.
    expect(links.newUrl).not.toContain('next=');
    expect(links.currentUrl).not.toContain('next=');
  });

  it('mints both sides with the CURRENT email as `email` and the target as `newEmail`', async () => {
    await mintEmailChangeLinks(OLD, NEW);
    expect(generateLink).toHaveBeenCalledTimes(2);
    expect(generateLink).toHaveBeenNthCalledWith(1, { type: 'email_change_current', email: OLD, newEmail: NEW });
    expect(generateLink).toHaveBeenNthCalledWith(2, { type: 'email_change_new', email: OLD, newEmail: NEW });
  });
});

describe('requestEmailChange — the happy path leaves the current address canonical', () => {
  it('sends one link to each address, writes nothing to the profile, and audits the request', async () => {
    const res = await requestEmailChange(REQUEST);
    expect(res.pendingEmail).toBe(NEW);
    expect(new Date(res.expiresAt).getTime() - new Date(res.sentAt).getTime()).toBe(60 * 60 * 1000);

    expect(sendEmail).toHaveBeenCalledTimes(2);
    const byTo = Object.fromEntries(
      sendEmail.mock.calls.map((c) => [c[0].to, c[0] as { subject: string; html: string; text: string }]),
    );
    expect(byTo[NEW]!.subject).toBe('Confirm your new StockPilot email');
    expect(byTo[NEW]!.text).toContain(`token_hash=${sha224(`${NEW}${OTP_NEW}`)}`);
    expect(byTo[OLD]!.subject).toBe(`Approve changing your StockPilot email to ${NEW}`);
    expect(byTo[OLD]!.text).toContain('token_hash=CURRENT-HASH');
    // The new address must never receive the current-side (approval) token.
    expect(byTo[NEW]!.html).not.toContain('CURRENT-HASH');

    // THE canonical-until-verified guarantee: no profile write of any kind.
    expect(updates.filter((u) => u.table === 'user_profiles')).toHaveLength(0);
    expect(tables.user_profiles!.email).toBe(OLD);

    const audit = inserts.find((i) => i.table === 'audit_logs');
    expect(audit?.payload).toMatchObject({
      user_id: USER_ID,
      organization_id: 'org-1',
      event: 'user.email.change_requested',
      metadata: expect.objectContaining({ from: OLD, to: NEW, source: 'web' }),
    });
  });

  it('normalises the target (trim + lowercase) before anything is compared or minted', async () => {
    const res = await requestEmailChange({ ...REQUEST, newEmail: '  New@Example.COM ' });
    expect(res.pendingEmail).toBe(NEW);
    expect(generateLink).toHaveBeenNthCalledWith(1, expect.objectContaining({ newEmail: NEW }));
  });
});

describe('requestEmailChange — refusal order (each stops before the next spends anything)', () => {
  it('same address (any case) is a validation error that spends NO rate-limit budget', async () => {
    await expect(requestEmailChange({ ...REQUEST, newEmail: 'OLD@example.com' })).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(generateLink).not.toHaveBeenCalled();
  });

  it('rate limit (user OR target) refuses BEFORE the password is checked — no password oracle', async () => {
    checkRateLimit.mockImplementation(async (key: string) => ({ allowed: !key.startsWith('emailchange-target:') }));
    await expect(requestEmailChange(REQUEST)).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'rate_limited' },
    });
    expect(verifyPasswordSideChannel).not.toHaveBeenCalled();
    expect(generateLink).not.toHaveBeenCalled();
    // Both keys are closed-mode and keyed as designed.
    expect(checkRateLimit).toHaveBeenCalledWith(`emailchange:${USER_ID}`, 3, 15 * 60_000, 'closed');
    expect(checkRateLimit).toHaveBeenCalledWith(`emailchange-target:${NEW}`, 3, 15 * 60_000, 'closed');
  });

  it('an enrolled user at AAL1 gets aal2_required before the password is even tried', async () => {
    await expect(
      requestEmailChange({ ...REQUEST, mfa: { enrolled: true, aal2: false } }),
    ).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'aal2_required' } });
    expect(verifyPasswordSideChannel).not.toHaveBeenCalled();
    expect(generateLink).not.toHaveBeenCalled();
  });

  it('an enrolled user at AAL2 proceeds', async () => {
    await expect(requestEmailChange({ ...REQUEST, mfa: { enrolled: true, aal2: true } })).resolves.toMatchObject({
      pendingEmail: NEW,
    });
  });

  it('a wrong password is refused and mints nothing', async () => {
    verifyPasswordSideChannel.mockResolvedValue({ ok: false, reason: 'invalid_password', message: 'Password is incorrect.' });
    await expect(requestEmailChange(REQUEST)).rejects.toMatchObject({ code: 'forbidden' });
    expect(generateLink).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('a target already registered is refused with a generic message, and nothing is minted or sent', async () => {
    rpc.mockImplementation(async (name: string) =>
      name === 'auth_user_exists_by_email' ? { data: true, error: null } : { data: null, error: null },
    );
    await expect(requestEmailChange(REQUEST)).rejects.toMatchObject({
      code: 'conflict',
      message: 'This email address cannot be used.',
    });
    expect(generateLink).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  /**
   * SP-101. The refusal above answers a question ("does this address have an
   * account?") that a signed-in user is not otherwise entitled to ask, and
   * concealing the answer is not achievable here (see the service header).
   * The mitigation we CAN offer is that every probe leaves a trail: the
   * refusal writes the same audit event as a real request, tagged with the
   * outcome, so repeated `target_exists` rows from one user are visible to an
   * operator. Before this, the exists branch threw before writeAudit and the
   * probe was completely invisible.
   */
  it('audits the refused duplicate target so enumeration attempts are detectable', async () => {
    rpc.mockImplementation(async (name: string) =>
      name === 'auth_user_exists_by_email' ? { data: true, error: null } : { data: null, error: null },
    );
    await expect(requestEmailChange(REQUEST)).rejects.toMatchObject({ code: 'conflict' });

    const audit = inserts.filter((i) => i.table === 'audit_logs');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.payload).toMatchObject({
      user_id: USER_ID,
      organization_id: 'org-1',
      event: 'user.email.change_requested',
      metadata: expect.objectContaining({
        from: OLD,
        to: NEW,
        source: 'web',
        outcome: 'target_exists',
      }),
    });
    // The refusal is still a refusal: nothing minted, nothing mailed.
    expect(generateLink).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('tags the delivered request with outcome "sent" so the two audit rows are distinguishable', async () => {
    await requestEmailChange(REQUEST);
    expect(inserts.find((i) => i.table === 'audit_logs')?.payload).toMatchObject({
      event: 'user.email.change_requested',
      metadata: expect.objectContaining({ outcome: 'sent' }),
    });
  });

  it('a disabled or tombstoned account is refused before any budget is spent', async () => {
    tables.user_profiles = { ...tables.user_profiles!, disabled_at: '2026-08-01T00:00:00Z' };
    await expect(requestEmailChange(REQUEST)).rejects.toMatchObject({ code: 'forbidden' });
    tables.user_profiles = { ...tables.user_profiles!, disabled_at: null, deleted_at: '2026-08-01T00:00:00Z' };
    await expect(requestEmailChange(REQUEST)).rejects.toMatchObject({ code: 'forbidden' });
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(generateLink).not.toHaveBeenCalled();
  });

  it('a failed delivery to EITHER address is an error (both confirmations are required)', async () => {
    sendEmail.mockImplementation(async (args: { to: string }) => ({ ok: args.to !== OLD }));
    await expect(requestEmailChange(REQUEST)).rejects.toMatchObject({ code: 'internal_error' });
  });
});

describe('getEmailChangeStatus / resend / cancel', () => {
  it('reports pending state straight from GoTrue, with a one-hour expiry', async () => {
    const sentAt = new Date(Date.now() - 5 * 60_000).toISOString();
    getUserById.mockResolvedValue(authUser({ new_email: NEW, email_change_sent_at: sentAt }));
    const s = await getEmailChangeStatus(USER_ID);
    expect(s).toMatchObject({ email: OLD, pendingEmail: NEW, sentAt, expired: false });
    expect(new Date(s.expiresAt!).getTime() - new Date(sentAt).getTime()).toBe(60 * 60 * 1000);
  });

  it('marks a change whose links are older than an hour as expired', async () => {
    const sentAt = new Date(Date.now() - 61 * 60_000).toISOString();
    getUserById.mockResolvedValue(authUser({ new_email: NEW, email_change_sent_at: sentAt }));
    expect((await getEmailChangeStatus(USER_ID)).expired).toBe(true);
  });

  it('resend re-mints for the address GoTrue holds — never one supplied by the caller', async () => {
    getUserById.mockResolvedValue(authUser({ new_email: NEW, email_change_sent_at: new Date().toISOString() }));
    const r = await resendEmailChange({ userId: USER_ID, mfa: { enrolled: false, aal2: false }, source: 'web' });
    expect(r.pendingEmail).toBe(NEW);
    expect(generateLink).toHaveBeenNthCalledWith(1, { type: 'email_change_current', email: OLD, newEmail: NEW });
    expect(checkRateLimit).toHaveBeenCalledWith(`emailchange-resend:${USER_ID}`, 3, 15 * 60_000, 'closed');
    expect(inserts.find((i) => i.table === 'audit_logs')?.payload).toMatchObject({ event: 'user.email.change_resent' });
  });

  it('resend with nothing pending is not_found and mints nothing', async () => {
    await expect(
      resendEmailChange({ userId: USER_ID, mfa: { enrolled: false, aal2: false }, source: 'web' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(generateLink).not.toHaveBeenCalled();
  });

  it('cancel calls the service-role RPC for this user and audits it', async () => {
    getUserById.mockResolvedValue(authUser({ new_email: NEW, email_change_sent_at: new Date().toISOString() }));
    const r = await cancelEmailChange({ userId: USER_ID, source: 'web' });
    expect(r.cancelled).toBe(true);
    expect(rpc).toHaveBeenCalledWith('cancel_pending_email_change', { p_user_id: USER_ID });
    expect(inserts.find((i) => i.table === 'audit_logs')?.payload).toMatchObject({
      event: 'user.email.change_cancelled',
      metadata: expect.objectContaining({ to: NEW }),
    });
  });
});

describe('reconcileProfileEmail — idempotent repair of the projection', () => {
  it('writes the auth email when the projection lags, and audits once', async () => {
    getUserById.mockResolvedValue(authUser({ email: NEW }));
    tables.user_profiles = { ...tables.user_profiles!, email: OLD };
    const r = await reconcileProfileEmail(USER_ID);
    expect(r).toMatchObject({ changed: true, email: NEW, previous: OLD });
    expect(updates).toEqual([{ table: 'user_profiles', payload: { email: NEW } }]);
    expect(inserts.filter((i) => i.payload.event === 'user.email.changed')).toHaveLength(1);
  });

  it('does nothing when the two already agree (case-insensitively)', async () => {
    getUserById.mockResolvedValue(authUser({ email: 'Old@Example.com' }));
    const r = await reconcileProfileEmail(USER_ID);
    expect(r.changed).toBe(false);
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it('running it five times produces one write and one audit row', async () => {
    getUserById.mockResolvedValue(authUser({ email: NEW }));
    for (let i = 0; i < 5; i++) await reconcileProfileEmail(USER_ID);
    expect(updates).toHaveLength(1);
    expect(inserts.filter((i) => i.payload.event === 'user.email.changed')).toHaveLength(1);
  });
});

describe('completeEmailChange — tells the OLD address, once', () => {
  it('sends the changed-notice to the previous address from the fresh audit row', async () => {
    getUserById.mockResolvedValue(authUser({ email: NEW }));
    tables.user_profiles = { ...tables.user_profiles!, email: NEW };
    auditRows.push({ metadata: { before: OLD, after: NEW }, created_at: new Date().toISOString() });
    const r = await completeEmailChange({ userId: USER_ID });
    expect(r).toEqual({ email: NEW, notifiedPreviousEmail: OLD });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const sent = sendEmail.mock.calls[0]![0] as { to: string; subject: string; text: string };
    expect(sent.to).toBe(OLD);
    expect(sent.subject).toBe('Your StockPilot email was changed');
    expect(sent.text).toContain(NEW);
  });

  it('does NOT re-alarm the old address for a stale change surfaced later', async () => {
    getUserById.mockResolvedValue(authUser({ email: NEW }));
    tables.user_profiles = { ...tables.user_profiles!, email: NEW };
    auditRows.push({ metadata: { before: OLD, after: NEW }, created_at: new Date(Date.now() - 60 * 60_000).toISOString() });
    const r = await completeEmailChange({ userId: USER_ID });
    expect(r.notifiedPreviousEmail).toBeNull();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
