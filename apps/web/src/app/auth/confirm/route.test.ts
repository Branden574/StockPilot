// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NextRequest } from 'next/server';

// /auth/confirm is the endpoint for auth-email links (password reset,
// platform invites). Contract pinned here:
//   1. GET must NEVER consume the one-time token — email security
//      scanners prefetch links within seconds of delivery (observed in
//      prod: a recovery token eaten by a GET 28s after send). GET renders
//      a click-through form; only POST verifies.
//   2. POST verifies via auth.verifyOtp and redirects to the sanitized
//      `next` path; failures land recovery users on /reset?error=link_expired.

const verifyOtp = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { verifyOtp } }),
}));
const completeEmailChange = vi.fn(async (_args: { userId: string }) => ({
  email: 'new@example.com',
  notifiedPreviousEmail: 'old@example.com',
}));
vi.mock('@/server/services/email-change', () => ({
  completeEmailChange: (args: { userId: string }) => completeEmailChange(args),
  EMAIL_CHANGE_RETURN_PATH: '/dashboard/settings/profile',
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

import { GET, POST } from './route';

const BASE = 'https://app.example.com';

function getReq(qs: string): NextRequest {
  return new NextRequest(`${BASE}/auth/confirm?${qs}`);
}

function postReq(fields: Record<string, string>): NextRequest {
  const form = new URLSearchParams(fields);
  return new NextRequest(`${BASE}/auth/confirm`, {
    method: 'POST',
    body: form.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
}

describe('GET /auth/confirm', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the click-through page WITHOUT consuming the token', async () => {
    const res = await GET(getReq('token_hash=abc123&type=recovery&next=%2Freset%2Fcomplete'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('form method="post"');
    expect(html).toContain('abc123');
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('redirects invalid types to signin without rendering a form', async () => {
    // 'magiclink' used to be the invalid-type example here, but dd83437c
    // (2026-07-09, B2B portal adversarial review) added it to ALLOWED_TYPES
    // as the existing-user re-invite fallback — it now legitimately renders
    // the click-through form (see the test above). Use a type this route
    // genuinely never allowlists instead.
    // 'email_change' joined the allowlist on 2026-08-25 (verified email
    // change, mig 0345); 'signup' is a real EmailOtpType this route never
    // sends and never accepts.
    const res = await GET(getReq('token_hash=abc&type=signup&next=%2Fdashboard'));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${BASE}/signin?error=auth_callback_failed`);
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('redirects a missing token to the reset form for recovery type', async () => {
    const res = await GET(getReq('type=recovery'));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${BASE}/reset?error=link_expired`);
  });
});

describe('POST /auth/confirm', () => {
  beforeEach(() => vi.clearAllMocks());

  it('verifies the token and redirects to the sanitized next path', async () => {
    verifyOtp.mockResolvedValue({ error: null });
    const res = await POST(
      postReq({ token_hash: 'abc123', type: 'recovery', next: '/reset/complete' }),
    );
    expect(verifyOtp).toHaveBeenCalledWith({ type: 'recovery', token_hash: 'abc123' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${BASE}/reset/complete`);
  });

  it('sends expired/used recovery tokens to /reset with the notice param', async () => {
    verifyOtp.mockResolvedValue({ error: { message: 'Token has expired or is invalid' } });
    const res = await POST(postReq({ token_hash: 'stale', type: 'recovery', next: '/reset/complete' }));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${BASE}/reset?error=link_expired`);
  });

  it('neutralizes protocol-relative next paths', async () => {
    verifyOtp.mockResolvedValue({ error: null });
    const res = await POST(postReq({ token_hash: 'abc', type: 'recovery', next: '//evil.com' }));
    expect(res.headers.get('location')).toBe(`${BASE}/dashboard`);
  });

  it('rejects disallowed types without calling verifyOtp', async () => {
    const res = await POST(postReq({ token_hash: 'abc', type: 'signup', next: '/x' }));
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(res.status).toBe(303);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// EMAIL CHANGE (type=email_change, mig 0345). Production runs secure email
// change: two links, one per address, and GoTrue applies the change only when
// BOTH have been verified. Measured 2026-08-25: the first verifyOtp returns no
// session and changes nothing; the second returns a session for the account.
// ─────────────────────────────────────────────────────────────────────────
describe('/auth/confirm — email_change', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET renders the click-through form for an email_change token without consuming it', async () => {
    const res = await GET(getReq('token_hash=ec123&type=email_change'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Confirm your email change');
    expect(html).toContain('form method="post"');
    expect(html).toContain('ec123');
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('FIRST confirmation (no session returned) renders "one to go" and completes nothing', async () => {
    verifyOtp.mockResolvedValue({ data: { user: null, session: null }, error: null });
    const res = await POST(postReq({ token_hash: 'side-a', type: 'email_change' }));
    expect(verifyOtp).toHaveBeenCalledWith({ type: 'email_change', token_hash: 'side-a' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('One confirmation done');
    expect(html).toContain('/dashboard/settings/profile');
    expect(completeEmailChange).not.toHaveBeenCalled();
  });

  it('SECOND confirmation (session returned) completes the change and lands on Profile', async () => {
    verifyOtp.mockResolvedValue({
      data: { user: { id: 'u-1' }, session: { user: { id: 'u-1', email: 'new@example.com' } } },
      error: null,
    });
    const res = await POST(postReq({ token_hash: 'side-b', type: 'email_change' }));
    expect(completeEmailChange).toHaveBeenCalledWith({ userId: 'u-1' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${BASE}/dashboard/settings/profile?emailChanged=1`);
  });

  it('IGNORES next for email_change — the destination is hard-coded', async () => {
    verifyOtp.mockResolvedValue({
      data: { user: { id: 'u-1' }, session: { user: { id: 'u-1' } } },
      error: null,
    });
    const res = await POST(
      postReq({ token_hash: 'side-b', type: 'email_change', next: '/dashboard/orders' }),
    );
    expect(res.headers.get('location')).toBe(`${BASE}/dashboard/settings/profile?emailChanged=1`);
  });

  it('an expired/used/tampered email_change link gets its own page, never the /signin bounce, and mutates nothing', async () => {
    verifyOtp.mockResolvedValue({ data: { user: null, session: null }, error: { message: 'Token has expired or is invalid' } });
    const res = await POST(postReq({ token_hash: 'stale', type: 'email_change' }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('expired or was already used');
    expect(html).toContain('Nothing about your account has changed');
    expect(completeEmailChange).not.toHaveBeenCalled();
  });

  it('a completion hook failure never blocks the redirect (best-effort notify)', async () => {
    verifyOtp.mockResolvedValue({
      data: { user: { id: 'u-1' }, session: { user: { id: 'u-1' } } },
      error: null,
    });
    completeEmailChange.mockRejectedValueOnce(new Error('resend down'));
    const res = await POST(postReq({ token_hash: 'side-b', type: 'email_change' }));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${BASE}/dashboard/settings/profile?emailChanged=1`);
  });
});
