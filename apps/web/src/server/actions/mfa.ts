'use server';

import { revalidatePath, updateTag } from 'next/cache';
import { z } from 'zod';

import { audit } from '@/server/services/audit';
import { assertCurrentAal2, ServiceError, withContext } from '@/server/services/context';
import { dispatchEvent } from '@/server/services/integration-events';
import { requireOrgContext, requireSession } from '@/lib/auth/session';
import { verifyPasswordSideChannel } from '@/lib/auth/verify-password';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { createClient } from '@/lib/supabase/server';

import { err, ok, type ActionResult } from '@stockpilot/core';

/**
 * Begin TOTP enrollment for the current user. Supabase issues an unverified
 * factor row + QR code; the user must call verifyEnrollmentAction with a code
 * from their authenticator app to activate it.
 */
export async function enrollFactorAction(): Promise<
  ActionResult<{ factorId: string; qrCode: string; secret: string; uri: string }>
> {
  try {
    await requireSession();
    const supabase = await createClient();

    // Clean up any prior unverified factors so listFactors stays tidy.
    const { data: existing } = await supabase.auth.mfa.listFactors();
    for (const f of existing?.all ?? []) {
      if (f.status !== 'verified') {
        await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
    }

    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: `StockPilot · ${new Date().toISOString().slice(0, 10)}`,
    });
    if (error || !data) {
      return err('internal_error', error?.message ?? 'Failed to enroll factor');
    }
    if (data.type !== 'totp') {
      return err('internal_error', 'Unexpected factor type from Supabase');
    }
    return ok({
      factorId: data.id,
      qrCode: data.totp.qr_code,
      secret: data.totp.secret,
      uri: data.totp.uri,
    });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    // Don't console.error raw exception — Supabase auth errors can
    // include factor IDs and challenge tokens. Funnel through the
    // error reporter (which scrubs) and return a generic error.
    void reportError(e, { tag: 'mfa.action' });
    return err('internal_error', 'MFA action failed');
  }
}

const verifyEnrollmentSchema = z.object({
  factorId: z.string().min(1),
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
  password: z.string().min(1, 'Confirm your password').max(128),
});

/**
 * Confirms a freshly enrolled factor. After this succeeds the factor becomes
 * `verified` and counts toward the user's AAL2.
 *
 * Password re-confirm is MANDATORY (SP-066). It is validated out-of-band so a
 * stolen mid-enrollment session cookie alone can't finish enrolling an
 * attacker-controlled factor. It used to be `.optional()` "for client-rollout
 * safety" and the check sat behind `if (parsed.data.password)` — so a direct
 * POST of this Server Action that simply OMITTED the field skipped both the
 * rate limit and the password check and still got the factor verified. That
 * let a thief holding an AAL1 cookie enroll their own authenticator, after
 * which the dashboard's enrolled-user hard gate ((dashboard)/layout.tsx, HI-6)
 * bounces the real owner to /signin/mfa forever — they have no recovery codes
 * and are locked out, while the attacker holds an AAL2-capable session.
 * Required now: every caller must prove the account password. The only caller
 * is components/settings/mfa-enrollment.tsx, which already always sends it
 * (and blocks client-side without it). Same hole, same fix as the sibling
 * consumeMfaRecoveryCodeAction in mfa-recovery.ts.
 */
export async function verifyEnrollmentAction(input: {
  factorId: string;
  code: string;
  password: string;
}): Promise<ActionResult<void>> {
  const parsed = verifyEnrollmentSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const session = await requireSession();
    const supabase = await createClient();

    // No `if (parsed.data.password)` wrapper: the schema now REQUIRES the
    // password, so this gate is unconditional and a caller can no longer skip
    // the rate limit + password proof by omitting the field (SP-066).
    const rl = await checkRateLimit(
      `mfa-enroll-verify:${session.userId}`,
      5,
      15 * 60_000,
      'closed',
    );
    if (!rl.allowed) {
      return err(
        'validation_error',
        'Too many enrollment confirmations. Try again in a few minutes.',
      );
    }
    const pwRes = await verifyPasswordSideChannel(session.email, parsed.data.password);
    if (!pwRes.ok) {
      return err(
        pwRes.reason === 'invalid_password' ? 'forbidden' : 'internal_error',
        pwRes.message,
      );
    }

    const { data: challenge, error: chErr } = await supabase.auth.mfa.challenge({
      factorId: parsed.data.factorId,
    });
    if (chErr || !challenge) {
      return err('internal_error', chErr?.message ?? 'Failed to challenge factor');
    }
    const { error: vErr } = await supabase.auth.mfa.verify({
      factorId: parsed.data.factorId,
      challengeId: challenge.id,
      code: parsed.data.code,
    });
    if (vErr) {
      return err('validation_error', vErr.message ?? 'Invalid code');
    }
    await audit({
      event: 'mfa.enrolled',
      entityType: 'user',
      entityId: session.userId,
      extra: { factorId: parsed.data.factorId },
    });
    revalidatePath('/dashboard/settings/security');
    return ok(undefined);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    // Don't console.error raw exception — Supabase auth errors can
    // include factor IDs and challenge tokens. Funnel through the
    // error reporter (which scrubs) and return a generic error.
    void reportError(e, { tag: 'mfa.action' });
    return err('internal_error', 'MFA action failed');
  }
}

const unenrollSchema = z.object({ factorId: z.string().min(1) });

export async function unenrollFactorAction(input: {
  factorId: string;
}): Promise<ActionResult<void>> {
  const parsed = unenrollSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', 'Invalid factor');
  }
  try {
    const session = await requireSession();
    const supabase = await createClient();

    // AAL2 step-up gate: removing a TOTP factor weakens the account's
    // security posture. The session MUST currently satisfy AAL2 (i.e.
    // the user completed the TOTP challenge this session) before they
    // can disable it. Without this gate, a stolen AAL1-only session
    // (eg. cookie theft from a still-AAL1 device) could strip MFA off
    // an account whose enrolled factor the attacker doesn't own.
    const svcCtx = await withContext();
    await assertCurrentAal2(svcCtx);

    // Block disabling if the user's org policy requires MFA.
    const ctx = await requireOrgContext();
    const { data: orgRow } = await supabase
      .from('organizations')
      .select('mfa_policy')
      .eq('id', ctx.organizationId)
      .maybeSingle();
    const policy = (orgRow?.mfa_policy as string | undefined) ?? 'optional';
    const role = ctx.role;
    const required =
      policy === 'all_required' ||
      (policy === 'admins_required' && (role === 'owner' || role === 'admin'));
    if (required) {
      return err(
        'forbidden',
        'Your organization requires MFA. Ask an admin to lower the policy before disabling.',
      );
    }

    const { error } = await supabase.auth.mfa.unenroll({ factorId: parsed.data.factorId });
    if (error) return err('internal_error', error.message);
    await audit({
      event: 'mfa.unenrolled',
      entityType: 'user',
      entityId: session.userId,
      extra: { factorId: parsed.data.factorId },
    });
    // Security feed: weakening an account's auth posture is exactly what a
    // #security channel exists for. Best-effort, off the response path.
    void dispatchEvent(ctx.organizationId, 'security.mfa_unenrolled', {
      email: session.email,
    });
    revalidatePath('/dashboard/settings/security');
    return ok(undefined);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    // Don't console.error raw exception — Supabase auth errors can
    // include factor IDs and challenge tokens. Funnel through the
    // error reporter (which scrubs) and return a generic error.
    void reportError(e, { tag: 'mfa.action' });
    return err('internal_error', 'MFA action failed');
  }
}

/**
 * Sign-in challenge: user already has password session at AAL1, supplies the
 * 6-digit code to upgrade to AAL2.
 */
const signInChallengeSchema = z.object({
  factorId: z.string().min(1),
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

export async function challengeFactorAction(input: {
  factorId: string;
  code: string;
}): Promise<ActionResult<void>> {
  const parsed = signInChallengeSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid code');
  }
  try {
    const supabase = await createClient();
    const { data: challenge, error: chErr } = await supabase.auth.mfa.challenge({
      factorId: parsed.data.factorId,
    });
    if (chErr || !challenge) {
      return err('internal_error', chErr?.message ?? 'Failed to start challenge');
    }
    const { error: vErr } = await supabase.auth.mfa.verify({
      factorId: parsed.data.factorId,
      challengeId: challenge.id,
      code: parsed.data.code,
    });
    if (vErr) return err('validation_error', vErr.message ?? 'Invalid code');
    return ok(undefined);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    // Don't console.error raw exception — Supabase auth errors can
    // include factor IDs and challenge tokens. Funnel through the
    // error reporter (which scrubs) and return a generic error.
    void reportError(e, { tag: 'mfa.action' });
    return err('internal_error', 'MFA action failed');
  }
}

const policySchema = z.object({
  policy: z.enum(['optional', 'admins_required', 'all_required']),
});

export async function setOrgMfaPolicyAction(input: {
  policy: 'optional' | 'admins_required' | 'all_required';
}): Promise<ActionResult<void>> {
  const parsed = policySchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid policy');
  try {
    const ctx = await requireOrgContext();
    if (ctx.role !== 'owner' && ctx.role !== 'admin') {
      return err('forbidden', 'Only admins can change the MFA policy.');
    }
    // AAL2 step-up: an admin changing the org-wide MFA policy is a
    // security-critical mutation (a malicious admin lowering policy
    // from `all_required` to `optional` opens the door to phishing
    // weaker accounts). Require the calling admin to have completed
    // their MFA challenge this session.
    const svcCtx = await withContext();
    await assertCurrentAal2(svcCtx);
    const supabase = await createClient();
    const { data: prev } = await supabase
      .from('organizations')
      .select('mfa_policy')
      .eq('id', ctx.organizationId)
      .maybeSingle();
    const { data: updated, error } = await supabase
      .from('organizations')
      .update({ mfa_policy: parsed.data.policy })
      .eq('id', ctx.organizationId)
      .select('id')
      .maybeSingle();
    if (error) return err('internal_error', error.message);
    // Fail CLOSED: a 0-row update means RLS blocked the write (stale/removed
    // admin) — never audit + report a policy change (incl. a downgrade) that
    // didn't actually land.
    if (!updated) {
      return err('internal_error', 'MFA policy did not persist (0 rows updated).');
    }
    await audit({
      event: 'organization.mfa_policy.changed',
      entityType: 'organization',
      entityId: ctx.organizationId,
      before: { mfa_policy: prev?.mfa_policy ?? null },
      after: { mfa_policy: parsed.data.policy },
    });
    // Security feed: org-wide auth-policy changes are forensic-relevant.
    void dispatchEvent(ctx.organizationId, 'security.mfa_policy_changed', {
      from: (prev?.mfa_policy as string | null) ?? 'optional',
      to: parsed.data.policy,
    });
    // Invalidate the cached org row (lib/dashboard/cached-org.ts) so
    // the new policy takes effect immediately for the MFA banner +
    // hard-gate on the next dashboard nav. Static cross-org tag.
    updateTag('dashboard-org');
    revalidatePath('/dashboard', 'layout');
    return ok(undefined);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    // Don't console.error raw exception — Supabase auth errors can
    // include factor IDs and challenge tokens. Funnel through the
    // error reporter (which scrubs) and return a generic error.
    void reportError(e, { tag: 'mfa.action' });
    return err('internal_error', 'MFA action failed');
  }
}
