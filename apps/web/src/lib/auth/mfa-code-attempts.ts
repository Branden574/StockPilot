import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { headers } from 'next/headers';

import { SESSION_ENDED_NOTICE } from '@/lib/auth/auth-page-notices';
import { clientIpFromHeaders } from '@/lib/client-ip';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { classifyMfaCodeError, type MfaCodeOutcome } from '@/server/actions/auth-error-classify';
import { emitAuthAudit } from '@/server/services/auth-audit';

/**
 * The web's authenticator code checks: the sign-in code at /signin/mfa and the
 * step-up modal (server/actions/mfa.ts challengeFactorAction), and the reset's
 * code step (server/actions/auth.ts completePasswordResetAction). The
 * set-up's code (server/actions/mfa.ts verifyEnrollmentAction) answers with
 * the same words, chosen by how GoTrue answered (S31).
 *
 * ONE BUDGET, TWO BUCKETS. Every well-formed code press, before GoTrue is
 * asked, on all three paths together, is checked in two buckets, in this
 * order:
 *   - `mfa-code:<account>:<address>`, 10 per 15 minutes: the pace of one
 *     person at one place. Every press counts here once;
 *   - `mfa-code-account:<account>`, 20 per hour at any address: the ceiling of
 *     the account, so code attempts from many addresses stop there too. Only
 *     a press the first bucket allowed is asked here, and counts once.
 * The press goes ahead only when both allow it, and the refusal is the same
 * either way. The limiter checks and counts in one step (increment_rate_limit,
 * migration 0048), so a bucket cannot be read without counting the press:
 * that is why the account bucket is never asked for a press the address
 * bucket refused. A malformed code and the reset's press that only asks for
 * the code spend nothing. GoTrue's own limit cannot tell people apart here:
 * these calls reach it from this server, never from the person's network. The
 * account is the verified one (the session's verified claims, or the reset's
 * first account read), never a value from the input.
 *
 * The trade-off of the account bucket: it is shared by every address, so
 * presses that are not the account holder's count toward it too, but only
 * presses that one address allowed. Presses from one place past its 10 in 15
 * minutes never reach GoTrue and never spend the account's hour, so spending
 * it takes 20 allowed presses: several places, or one place across more than
 * one 15-minute window. Only a session past the password (or a reset link)
 * reaches a code press, and the pause it brings, the reset's code step
 * included, lasts at most an hour. The hourly security monitor reports refused
 * codes on one account from 5 in an hour (server/security/monitors.ts
 * detectRefusedCodeBursts), well before the account bucket is spent. Both are
 * closed, as every auth front door: a limiter that cannot answer refuses (the
 * address bucket's failure refuses without asking the account bucket).
 *
 * ROWS ONLY FOR A CODE GOTRUE JUDGED WRONG. mfa.code_refused is written only
 * for GoTrue's wrong-code answer (classifyMfaCodeError's `refused`), never for
 * an answer that did not judge the code (no answer, a rate limit, a gone
 * session, an unknown answer). It names the account and has no organization:
 * not shown to the organization's admins, and never counted as the person's
 * own last action (0351). Never the code, GoTrue's message or the factor id.
 *
 * Server code only: the words live here, not in a 'use server' module.
 */

/** Code attempts per account and client address in one window. */
export const MFA_CODE_ATTEMPT_LIMIT = 10;
/** The window of the account-and-address bucket. */
export const MFA_CODE_ATTEMPT_WINDOW_MS = 15 * 60_000;
/** Code attempts per account, at any address, in one window. */
export const MFA_CODE_ACCOUNT_LIMIT = 20;
/** The window of the account bucket. */
export const MFA_CODE_ACCOUNT_WINDOW_MS = 60 * 60_000;

/** GoTrue judged the code wrong. The reset's words before this budget. */
export const MFA_CODE_REFUSED =
  'That code is not valid. Check your authenticator app and try again.';
/** This account's budget of code attempts at this address is spent. */
export const MFA_CODE_BUDGET_SPENT = 'Too many code attempts. Wait a few minutes and try again.';
/** GoTrue's own rate limit answered. */
export const MFA_CODE_GOTRUE_LIMITED =
  'Too many code checks right now. Wait a minute and try again.';
/** GoTrue did not judge the code: no answer, or an answer this does not know. */
export const MFA_CODE_NOT_CHECKED = 'Could not check your code just now. Try again.';
/** The challenge itself could not be started. */
export const MFA_CHALLENGE_NOT_STARTED =
  'Could not start the authenticator check. Please try again.';
/** The session is gone (the sign-in card's words for it). */
export const MFA_SESSION_ENDED = SESSION_ENDED_NOTICE.text;
/** Authenticator set-up: the factor id is not the open set-up of this account. */
export const MFA_SETUP_NOT_OPEN = 'This authenticator set-up is no longer open. Start again.';
/** Authenticator set-up: the account's factor list could not be read. */
export const MFA_SETUP_UNREADABLE = 'Could not check your authenticator set-up. Try again.';

/** Where a code was checked, as the row records it. */
export type MfaCodePath = 'challenge' | 'password_reset';

/**
 * Spends one code attempt of `userId`: first in the bucket of the account at
 * this request's client address, then, only when that bucket allowed it, in
 * the account's own bucket. True only when both allow the attempt.
 */
export async function allowMfaCodeAttempt(userId: string): Promise<boolean> {
  const ip = clientIpFromHeaders(await headers());
  // checkRateLimit never throws: in closed mode a limiter that cannot answer
  // comes back as not allowed. One after the other, never together: a press
  // refused at this address (or whose address bucket cannot answer) must not
  // reach the account bucket, or presses from one place that never reach
  // GoTrue would spend the hour of the account at every address.
  const atAddress = await checkRateLimit(
    `mfa-code:${userId}:${ip}`,
    MFA_CODE_ATTEMPT_LIMIT,
    MFA_CODE_ATTEMPT_WINDOW_MS,
    'closed',
  );
  if (!atAddress.allowed) return false;
  const account = await checkRateLimit(
    `mfa-code-account:${userId}`,
    MFA_CODE_ACCOUNT_LIMIT,
    MFA_CODE_ACCOUNT_WINDOW_MS,
    'closed',
  );
  return account.allowed;
}

/**
 * The mfa.code_refused row for a code GoTrue judged wrong. `sessionAal` is the
 * verified level of the session on the challenge path (a step-up runs at aal2,
 * a sign-in at aal1, and a step-up from aal1 is expected); the reset's path
 * has none.
 */
export async function recordRefusedMfaCode(params: {
  userId: string;
  path: MfaCodePath;
  sessionAal?: 'aal1' | 'aal2' | null;
  gotrueCode: string | null;
}): Promise<void> {
  await emitAuthAudit({
    event: 'mfa.code_refused',
    userId: params.userId,
    organizationId: null,
    extra: {
      path: params.path,
      ...(params.sessionAal !== undefined ? { session_aal: params.sessionAal } : {}),
      gotrue_code: params.gotrueCode,
    },
  });
}

/**
 * Signs this browser's session out here only (scope 'local': GoTrue ends this
 * one session and the account's other sessions stay), for a session that
 * turned out to hold another account than the one a code press was checked
 * for. auth-js removes the stored session (the auth cookies) even when GoTrue
 * does not answer. Never throws: the press is refused either way.
 */
export async function signOutThisSession(supabase: MfaClient): Promise<void> {
  try {
    await supabase.auth.signOut({ scope: 'local' });
  } catch {
    // Refused below whatever happened here.
  }
}

/** The result of one code check, for the caller's own words. */
export type MfaCodeCheck =
  | { kind: 'verified' }
  | { kind: 'budget_spent' }
  | { kind: 'challenge_failed'; outcome: MfaCodeOutcome }
  | { kind: 'verify_failed'; outcome: MfaCodeOutcome };

/** The slice of a Supabase client a code check uses. */
type MfaClient = Pick<SupabaseClient, 'auth'>;

/**
 * One code press, in this order: the budget, the challenge, the verify, the
 * classification of GoTrue's answer, and a row for a refused code only. An
 * answer this does not know is reported (its name, code and status only) so
 * a change in GoTrue's answers shows on the first day.
 */
export async function checkMfaCode(
  supabase: MfaClient,
  params: {
    userId: string;
    factorId: string;
    code: string;
    path: MfaCodePath;
    sessionAal?: 'aal1' | 'aal2' | null;
  },
): Promise<MfaCodeCheck> {
  if (!(await allowMfaCodeAttempt(params.userId))) return { kind: 'budget_spent' };

  const { data: challenge, error: chErr } = await supabase.auth.mfa.challenge({
    factorId: params.factorId,
  });
  if (chErr || !challenge) {
    return { kind: 'challenge_failed', outcome: classifyMfaCodeError(chErr) };
  }
  const { error: vErr } = await supabase.auth.mfa.verify({
    factorId: params.factorId,
    challengeId: challenge.id,
    code: params.code,
  });
  if (!vErr) return { kind: 'verified' };

  const outcome = classifyMfaCodeError(vErr);
  if (outcome === 'refused') {
    await recordRefusedMfaCode({
      userId: params.userId,
      path: params.path,
      ...(params.sessionAal !== undefined ? { sessionAal: params.sessionAal } : {}),
      gotrueCode: typeof vErr.code === 'string' ? vErr.code : null,
    });
  } else if (outcome === 'unchecked') {
    void reportError(new Error('Authenticator code check got an answer it does not know'), {
      tag: 'mfa.verify_unclassified',
      level: 'warning',
      extra: {
        name: typeof vErr.name === 'string' ? vErr.name : null,
        code: typeof vErr.code === 'string' ? vErr.code : null,
        status: typeof vErr.status === 'number' ? vErr.status : null,
      },
    });
  }
  return { kind: 'verify_failed', outcome };
}
