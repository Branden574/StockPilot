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
 * code step (server/actions/auth.ts completePasswordResetAction).
 *
 * ONE BUDGET, PER ACCOUNT AND CLIENT ADDRESS. Every well-formed code press
 * spends one attempt of `mfa-code:<account>:<address>`, 10 per 15 minutes,
 * before GoTrue is asked, on all three paths together; a malformed code and the
 * reset's press that only asks for the code spend nothing. GoTrue's own limit
 * cannot tell people apart here: these calls reach it from this server, never
 * from the person's network. The account is the verified one (the session's
 * verified claims, or the reset's first account read), never a value from the
 * input. The address is part of the key on purpose: keyed on the account alone,
 * anyone holding the password could keep spending the budget and pause every
 * web code check of the account, the reset included, which is how a person
 * gets back in. Closed, as every auth front door: a limiter that cannot answer
 * refuses.
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
/** The window of the code budget. */
export const MFA_CODE_ATTEMPT_WINDOW_MS = 15 * 60_000;

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
 * Spends one code attempt of `userId` at this request's client address.
 * True when the attempt may go ahead.
 */
export async function allowMfaCodeAttempt(userId: string): Promise<boolean> {
  const ip = clientIpFromHeaders(await headers());
  const rl = await checkRateLimit(
    `mfa-code:${userId}:${ip}`,
    MFA_CODE_ATTEMPT_LIMIT,
    MFA_CODE_ATTEMPT_WINDOW_MS,
    'closed',
  );
  return rl.allowed;
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
