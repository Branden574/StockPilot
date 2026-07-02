'use server';

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { after } from 'next/server';

import { noteLoginDevice } from '@/lib/auth/login-device';
import { sendPasswordResetEmail } from '@/lib/auth/password-reset-email';
import { env } from '@/lib/env';
import { broadcastToChannel } from '@/lib/realtime/broadcast';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { REMEMBER_SESSION_COOKIE, rememberPreferenceOptions } from '@/lib/supabase/session-cookies';
import { audit, type AuditEvent } from '@/server/services/audit';

import {
  changePasswordSchema,
  completePasswordResetSchema,
  err,
  ok,
  requestPasswordResetSchema,
  signInSchema,
  type ActionResult,
  type ChangePasswordInput,
  type CompletePasswordResetInput,
  type Database,
  type RequestPasswordResetInput,
  type SignInInput,
  type SignUpInput,
} from '@stockpilot/core';

/**
 * Best-effort client-IP extraction from request headers. Used as a
 * secondary rate-limit key on unauthenticated flows so an attacker can't
 * fan out across many email addresses from one host. `next/headers` is
 * async in Next 16.
 */
async function getClientIp(): Promise<string> {
  const h = await headers();
  return (
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    h.get('x-real-ip') ??
    'unknown'
  );
}

/**
 * Writes an auth-lifecycle audit row directly via the admin client.
 *
 * The standard `audit()` helper requires a ServiceContext, and its
 * `withContext()` fallback throws NEXT_REDIRECT for org-less callers —
 * which would corrupt the control flow of a sign-in (no resolved org
 * yet) or a sign-in-failure (no authenticated user). This direct helper
 * writes the event with whatever attribution we have, tags IP/UA from
 * the request headers, and never throws.
 *
 * organization_id and user_id are both nullable on audit_logs (see
 * migration 0002_inventory.sql), so a sign-in-failure with both null
 * is still a valid forensic row.
 */
async function emitAuthAudit(params: {
  event: AuditEvent;
  userId?: string | null;
  organizationId?: string | null;
  extra?: Record<string, unknown>;
}): Promise<void> {
  try {
    const h = await headers();
    const ip =
      h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;
    const userAgent = h.get('user-agent') ?? null;

    const admin = createAdminClient();
    await admin.from('audit_logs').insert({
      organization_id: params.organizationId ?? null,
      user_id: params.userId ?? null,
      event: params.event,
      ip,
      user_agent: userAgent,
      metadata: {
        entity_type: 'user',
        entity_id: params.userId ?? null,
        warehouse_id: null,
        before: null,
        after: null,
        reason: null,
        ...(params.extra ?? {}),
      },
    });
  } catch (e) {
    // Best-effort — never let a logging failure break an auth action.
    void reportError(e, {
      tag: 'audit.auth_emit_failed',
      level: 'warning',
      extra: { event: params.event },
    });
  }
}

/**
 * Resolves a user's default organization + role for audit attribution
 * and ServiceContext construction. Returns nulls if the lookup fails —
 * the audit row is still written (organization_id is nullable). Uses
 * the admin client because the user may be on a freshly-issued or
 * recovery session with limited RLS context.
 */
async function resolveDefaultOrgAndRole(
  userId: string,
): Promise<{ organizationId: string | null; role: string | null }> {
  try {
    const admin = createAdminClient();
    const { data: profile } = await admin
      .from('user_profiles')
      .select('default_organization_id')
      .eq('id', userId)
      .maybeSingle();
    const defaultOrgId =
      (profile as { default_organization_id: string | null } | null)
        ?.default_organization_id ?? null;

    if (defaultOrgId) {
      const { data: member } = await admin
        .from('organization_members')
        .select('organization_id, role')
        .eq('user_id', userId)
        .eq('organization_id', defaultOrgId)
        .not('accepted_at', 'is', null)
        .maybeSingle();
      const row = member as { organization_id: string; role: string } | null;
      if (row) return { organizationId: row.organization_id, role: row.role };
    }

    const { data: anyMember } = await admin
      .from('organization_members')
      .select('organization_id, role')
      .eq('user_id', userId)
      .not('accepted_at', 'is', null)
      .limit(1)
      .maybeSingle();
    const row = anyMember as { organization_id: string; role: string } | null;
    return {
      organizationId: row?.organization_id ?? null,
      role: row?.role ?? null,
    };
  } catch {
    return { organizationId: null, role: null };
  }
}

/**
 * Public self-signup is disabled — this is an internal-company tool.
 * Account creation happens via the invite-acceptance flow only.
 *
 * The function is kept exported (rather than deleted) so the existing
 * /signup page can render a "request access from your admin" notice
 * without import errors during the migration. Returns a forbidden error
 * if anything actually invokes it.
 */
 
export async function signUpAction(
  _input: SignUpInput,
): Promise<ActionResult<{ requiresEmailConfirm: boolean }>> {
  return err(
    'forbidden',
    'Public sign-up is disabled. Ask your administrator to send you an invite.',
  );
}

export async function signInAction(input: SignInInput): Promise<ActionResult<{ next: string }>> {
  const parsed = signInSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }

  // Rate-limit dual-keyed on email AND IP. 5/min/email blocks single-
  // account brute force; 30/min/ip stops a single host from fanning out
  // across many email addresses. Both gates run 'closed' — a DB outage
  // must NOT unlock unlimited attempts on the unauthenticated front
  // door. Return the typed `rate_limited` error (don't throw) so the
  // sign-in form can toast a clean message.
  const emailKey = parsed.data.email.toLowerCase();
  const ip = await getClientIp();
  const emailRl = await checkRateLimit(`signin:${emailKey}`, 5, 60_000, 'closed');
  if (!emailRl.allowed) {
    return err('rate_limited', 'Too many sign-in attempts. Try again in a minute.');
  }
  const ipRl = await checkRateLimit(`signin-ip:${ip}`, 30, 60_000, 'closed');
  if (!ipRl.allowed) {
    return err('rate_limited', 'Too many sign-in attempts. Try again in a minute.');
  }

  const supabase = await createClient({ rememberSession: parsed.data.rememberMe });
  const { data: signInData, error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error) {
    // Distinguish Supabase's auth rate-limit from a credential
    // mismatch — they have very different remediation. Supabase
    // returns HTTP 429 + `code: 'over_*_rate_limit'` when its
    // per-IP-per-window cap fires (e.g. a whole office signing
    // in from one NAT'd IP at the same time). Surfacing this
    // as "Invalid email or password" was actively misleading
    // and sent users on a wild-goose chase resetting passwords.
    //
    // The status check is the canonical signal (Supabase docs);
    // the code check is belt-and-suspenders for newer SDK
    // versions that may surface the code without the status.
    const errAny = error as unknown as {
      status?: number;
      code?: string;
      message?: string;
    };
    const isRateLimit =
      errAny.status === 429 ||
      (typeof errAny.code === 'string' && /rate.?limit/i.test(errAny.code));

    await emitAuthAudit({
      event: 'user.sign_in_failed',
      userId: null,
      organizationId: null,
      extra: {
        email: parsed.data.email,
        reason: isRateLimit ? 'supabase_rate_limited' : 'invalid_credentials',
      },
    });
    if (isRateLimit) {
      return err(
        'rate_limited',
        'Sign-in is temporarily throttled for this network. Wait a couple of minutes and try again.',
      );
    }
    return err('unauthenticated', 'Invalid email or password');
  }

  const cookieStore = await cookies();
  cookieStore.set(
    REMEMBER_SESSION_COOKIE,
    parsed.data.rememberMe ? '1' : '0',
    rememberPreferenceOptions(parsed.data.rememberMe),
  );

  // If the user has any verified MFA factors, the password sign-in only
  // brings them to AAL1. They must complete the TOTP challenge to reach
  // AAL2 and access the dashboard.
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  const nextPath =
    aal && aal.currentLevel === 'aal1' && aal.nextLevel === 'aal2'
      ? '/signin/mfa'
      : '/dashboard';

  // Audit successful sign-in. Resolve org + role best-effort for
  // attribution — these are nullable on audit_logs so a brand-new user
  // (no membership) still gets a row.
  const userId = signInData.user?.id ?? null;
  let organizationId: string | null = null;
  let role: string | null = null;
  if (userId) {
    const resolved = await resolveDefaultOrgAndRole(userId);
    organizationId = resolved.organizationId;
    role = resolved.role;
  }
  await emitAuthAudit({
    event: 'user.signed_in',
    userId,
    organizationId,
    extra: {
      email: parsed.data.email,
      role,
      remember: parsed.data.rememberMe,
      mfa_required: nextPath === '/signin/mfa',
    },
  });

  // New-device sign-in alert. Runs AFTER the response (`after`) so it adds zero
  // latency to the login round-trip. Best-effort: emails only for a new device
  // on an account that already has known devices (first device = silent
  // baseline). Fires here on the password step — i.e. even before TOTP — so a
  // stolen password used from a new device still alerts the real owner.
  if (userId) {
    const ua = (await headers()).get('user-agent');
    after(() => noteLoginDevice({ userId, email: parsed.data.email, userAgent: ua, ip }));
  }

  return ok({ next: nextPath });
}

export async function signOutAction(): Promise<void> {
  const supabase = await createClient();

  // Snapshot the user BEFORE signOut so we still have a userId to
  // attribute the audit row to. Best-effort: a missing user just yields
  // a null-attributed row, which is fine on the sign-out path.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // scope: 'global' revokes ALL refresh tokens for the user across
  // every device + tab. Default ('local') only kills the calling
  // tab's token, leaving other browser tabs and the mobile app
  // alive until natural expiry (~1h). For an internal enterprise
  // tool, "Sign out" should mean "log me out everywhere."
  await supabase.auth.signOut({ scope: 'global' });
  // The revoke above only kills REFRESH tokens — devices coast on their
  // current access token for up to ~1h ("signed out on web, phone still
  // let me in", owner-observed 2026-07-02). The broadcast makes every
  // device's session-revocation listener sign out locally within ~1s.
  // keepId:null targets ALL sessions (see use-session-revocation.ts).
  if (user) {
    await broadcastToChannel(`user:${user.id}:sessions`, 'revoked', { keepId: null });
  }
  const cookieStore = await cookies();
  cookieStore.delete(REMEMBER_SESSION_COOKIE);

  if (user) {
    const { organizationId } = await resolveDefaultOrgAndRole(user.id);
    await emitAuthAudit({
      event: 'user.signed_out',
      userId: user.id,
      organizationId,
      extra: { email: user.email ?? null, scope: 'global' },
    });
  }

  redirect('/');
}

export async function requestPasswordResetAction(
  input: RequestPasswordResetInput,
): Promise<ActionResult<{ ok: true }>> {
  const parsed = requestPasswordResetSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid email');

  // 3 requests / 15 min / email. Closed mode — a DB outage must NOT
  // unlock unlimited reset-email blasts (which would spam the user
  // and burn through Resend quota). Same generic ok() return on rate
  // hit to keep account-enumeration resistance.
  const emailKey = parsed.data.email.toLowerCase();
  const rl = await checkRateLimit(`pwreset-req:${emailKey}`, 3, 15 * 60_000, 'closed');
  if (!rl.allowed) {
    return ok({ ok: true });
  }

  // Mint + send via the shared helper (admin.generateLink → our
  // /auth/confirm URL → Resend; see sendPasswordResetEmail for the WHY on
  // both). The result is IGNORED on purpose: every failure (unknown email,
  // link or send error) must produce the same generic ok() — account-
  // enumeration resistance.
  await sendPasswordResetEmail(parsed.data.email);

  // Audit reset requests (email only; looking the user up to attach an id
  // would leak account-enumeration signal back to the caller). user_id
  // stays null.
  await emitAuthAudit({
    event: 'user.password.reset_requested',
    userId: null,
    organizationId: null,
    extra: { email: parsed.data.email },
  });

  // Always return ok to avoid account enumeration.
  return ok({ ok: true });
}

export async function completePasswordResetAction(
  input: CompletePasswordResetInput,
): Promise<ActionResult<{ next: string }>> {
  const parsed = completePasswordResetSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }

  // 5 completes / 15 min / ip. Closed mode — the user is briefly
  // authenticated by the recovery token at this point, but the
  // endpoint is still effectively unauthenticated front door.
  const ip = await getClientIp();
  const rl = await checkRateLimit(`pwreset-complete:${ip}`, 5, 15 * 60_000, 'closed');
  if (!rl.allowed) {
    return err('rate_limited', 'Too many attempts. Try again in a few minutes.');
  }

  const supabase = await createClient();

  // Snapshot the user BEFORE updateUser/signOut so we can attribute the
  // audit row to a real userId even after the global signOut.
  const {
    data: { user: preUser },
  } = await supabase.auth.getUser();

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) return err('internal_error', error.message);

  // SECURITY: after an email-recovery password update, force a fresh
  // sign-in rather than auto-elevating the recovery session into the
  // dashboard. The recovery link is the only factor that's been verified
  // here — an attacker who intercepted a reset link could otherwise
  // pivot straight into the account. scope: 'global' also kills every
  // other live session for this user across all devices so a leaked
  // legitimate session is forcibly evicted.
  await supabase.auth.signOut({ scope: 'global' });
  // Evict live devices NOW, not at access-token expiry (≤1h): the whole
  // point of resetting a password is that existing sessions may be in
  // hostile hands. Same broadcast contract as device management.
  if (preUser) {
    await broadcastToChannel(`user:${preUser.id}:sessions`, 'revoked', { keepId: null });
  }

  // Audit the successful recovery-based reset.
  if (preUser) {
    const { organizationId } = await resolveDefaultOrgAndRole(preUser.id);
    await emitAuthAudit({
      event: 'user.password.reset_completed',
      userId: preUser.id,
      organizationId,
      extra: { email: preUser.email ?? null },
    });
  }

  // Redirect to /signin. The sign-in form's existing success toast
  // ("Password updated.") still fires from the consumer page.
  return ok({ next: '/signin?reset=success' });
}

/**
 * Change the signed-in user's password. Re-authenticates with the current
 * password before applying the new one.
 *
 * Why we DON'T call signInWithPassword on the SSR client to verify the
 * current password: that rotates the cookie session, and a fresh
 * password-only sign-in is AAL1 even if the user was at AAL2. For
 * MFA-enabled accounts Supabase requires AAL2 on the calling session
 * to update the password, so the subsequent updateUser() fails with
 * "AAL2 session is required to update email or password when MFA is
 * enabled." The fix: verify the current password against an isolated,
 * in-memory-only Supabase client so the user's actual session is left
 * untouched (and stays at AAL2 if they have MFA).
 */
export async function changePasswordAction(
  input: ChangePasswordInput,
): Promise<ActionResult<{ ok: true }>> {
  const parsed = changePasswordSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email) {
    return err('unauthenticated', 'Sign in required');
  }

  // 5 attempts / 15 min / user. Closed mode — prevents an authenticated
  // attacker (or stolen-session scenario) from brute-forcing the
  // currentPassword check.
  const rl = await checkRateLimit(`pwchange:${user.id}`, 5, 15 * 60_000, 'closed');
  if (!rl.allowed) {
    return err('rate_limited', 'Too many password-change attempts. Try again in a few minutes.');
  }

  // Side-channel password check — does NOT persist a session anywhere.
  const checkClient = createSupabaseClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
  const { error: pwError } = await checkClient.auth.signInWithPassword({
    email: user.email,
    password: parsed.data.currentPassword,
  });
  if (pwError) {
    return err('forbidden', 'Current password is incorrect');
  }

  // For MFA-enabled accounts, Supabase requires AAL2 on the SSR session
  // to update the password. Surface a clearer error than the generic
  // updateUser() one if the user's session somehow isn't at AAL2.
  const { data: factorsData } = await supabase.auth.mfa.listFactors();
  const hasVerifiedMfa = (factorsData?.totp ?? []).some(
    (f) => f.status === 'verified',
  );
  if (hasVerifiedMfa) {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.currentLevel !== 'aal2') {
      return err(
        'forbidden',
        'Complete the MFA challenge before changing your password. Sign out and sign back in to step up.',
      );
    }
  }

  const { error: updateError } = await supabase.auth.updateUser({
    password: parsed.data.newPassword,
  });
  if (updateError) return err('internal_error', updateError.message);

  // SECURITY: revoke every OTHER live session for this user (mobile,
  // other browsers, stale tabs) but keep the current tab signed in so
  // the in-app password change doesn't bounce the user to /signin.
  // Best-effort — never block the success response on a signOut error.
  try {
    await supabase.auth.signOut({ scope: 'others' });
  } catch (e) {
    console.warn('[changePasswordAction] signOut others failed:', e);
  }

  await audit({
    event: 'user.password.changed',
    entityType: 'user',
    entityId: user.id,
  });

  return ok({ ok: true });
}
