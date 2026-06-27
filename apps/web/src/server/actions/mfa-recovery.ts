'use server';

import { revalidatePath } from 'next/cache';

import { requireSession } from '@/lib/auth/session';
import { verifyPasswordSideChannel } from '@/lib/auth/verify-password';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { ServiceError, assertCurrentAal2, withContext } from '@/server/services/context';

import { err, ok, type ActionResult } from '@stockpilot/core';

/**
 * Generates 10 fresh recovery codes for the current user, wiping any
 * existing ones. Returns the plaintexts — the UI must show them now,
 * because they are unrecoverable after this call.
 */
export async function generateMfaRecoveryCodesAction(): Promise<
  ActionResult<{ codes: string[] }>
> {
  try {
    await requireSession();
    // Block AAL1: this RPC mints fresh PLAINTEXT codes AND wipes the old set, so
    // an attacker with a stolen pre-MFA (AAL1) session could otherwise mint their
    // own recovery codes and use one to strip all MFA. Require a current AAL2
    // session (the user passed their MFA challenge this session) — recovery codes
    // only exist for MFA-enrolled users, who can always step up. Mirrors the
    // unenroll / change-password / set-mfa-policy gates.
    const svcCtx = await withContext();
    await assertCurrentAal2(svcCtx);
    // Rate-limit regeneration: defends against a loop that repeatedly invalidates
    // the user's codes (TOTP-loss lockout). 3 / 15 min is generous for a human.
    const rl = await checkRateLimit(`mfa-recovery-gen:${svcCtx.userId}`, 3, 15 * 60_000, 'closed');
    if (!rl.allowed) {
      return err('validation_error', 'Too many recovery-code regenerations. Wait a few minutes and try again.');
    }
    const supabase = await createClient();
    const { data, error } = await supabase.rpc('generate_mfa_recovery_codes');
    if (error) throw new ServiceError('internal_error', error.message);
    const codes = ((data ?? []) as Array<{ code: string }>).map((r) => r.code);
    revalidatePath('/dashboard/settings/security');
    return ok({ codes });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

/**
 * Returns how many unused recovery codes the user has remaining. Used
 * by the Security page to indicate "you've used N of 10".
 */
export async function getMfaRecoveryCodeStatus(): Promise<{
  total: number;
  unused: number;
}> {
  try {
    const session = await requireSession();
    const supabase = await createClient();
    const [allRes, unusedRes] = await Promise.all([
      supabase
        .from('mfa_recovery_codes')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', session.userId),
      supabase
        .from('mfa_recovery_codes')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', session.userId)
        .is('used_at', null),
    ]);
    return { total: allRes.count ?? 0, unused: unusedRes.count ?? 0 };
  } catch {
    return { total: 0, unused: 0 };
  }
}

/**
 * Used by /signin/mfa when the user can't reach their TOTP device.
 * Verifies one of their unused recovery codes, and on success unenrolls
 * every TOTP factor on the account using the admin client (RLS on
 * auth.mfa requires service-role for this). The user can then sign in
 * normally and re-enroll a fresh device.
 */
export async function consumeMfaRecoveryCodeAction(input: {
  code: string;
  password?: string;
}): Promise<ActionResult<{ unenrolled: number }>> {
  try {
    const session = await requireSession();

    // Rate-limit the recovery-code consume path. Without this an
    // attacker (legitimate AAL1 session) could brute-force-style spam
    // codes to enumerate consumed-vs-not, or burn the user's codes
    // to force a re-enrollment lockout. 5 attempts / 15 minutes is
    // generous for a real user who made a typo and tight enough that
    // brute force is impractical against the 80-bit code space.
    const rl = await checkRateLimit(`mfa-recovery:${session.userId}`, 5, 15 * 60_000);
    if (!rl.allowed) {
      return err(
        'validation_error',
        'Too many recovery-code attempts. Wait a few minutes and try again.',
      );
    }

    // Password re-confirm is MANDATORY. This flow is inherently AAL1 (the user
    // lost their TOTP device, so AAL2 step-up is impossible), so the account
    // password — knowledge a cookie thief lacks — is the ONLY gate stopping a
    // stolen AAL1 session from stripping all MFA. It used to be optional
    // (`if (input.password)`), which let a direct call skip the check entirely.
    if (!input.password) {
      return err('forbidden', 'Your account password is required to use a recovery code.');
    }
    const pwRes = await verifyPasswordSideChannel(session.email, input.password);
    if (!pwRes.ok) {
      return err(
        pwRes.reason === 'invalid_password' ? 'forbidden' : 'internal_error',
        pwRes.message,
      );
    }

    const supabase = await createClient();

    const { data: ok_, error } = await supabase.rpc('consume_mfa_recovery_code', {
      p_code: input.code,
    });
    if (error) throw new ServiceError('internal_error', error.message);
    if (!ok_) return err('validation_error', 'That recovery code is invalid or already used.');

    // Unenroll every TOTP factor for this user via the admin client.
    let admin;
    try {
      admin = createAdminClient();
    } catch {
      return err(
        'internal_error',
        'Server is missing SUPABASE_SERVICE_ROLE_KEY. Recovery cannot complete without it.',
      );
    }

    const { data: factors } = await admin.auth.admin.mfa.listFactors({
      userId: session.userId,
    });
    let unenrolled = 0;
    for (const f of factors?.factors ?? []) {
      // We only deliberately enroll TOTP today; play it safe and only
      // remove totp factors so we don't surprise SSO/SAML setups later.
      if (f.factor_type !== 'totp') continue;
      const r = await admin.auth.admin.mfa.deleteFactor({
        userId: session.userId,
        id: f.id,
      });
      if (!r.error) unenrolled += 1;
    }

    revalidatePath('/dashboard', 'layout');
    return ok({ unenrolled });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
