import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  ACCOUNT_DELETE_CODE_TTL_S,
  checkAccountDeleteCode,
  newAccountDeleteCode,
  signAccountDeleteChallenge,
} from '@/lib/auth/account-delete-code';
import { isUserNotFound } from '@/lib/auth/gotrue-user-not-found';
import { verifyPasswordSideChannel } from '@/lib/auth/verify-password';
import { renderAccountDeleteCodeEmail } from '@/lib/email/es/families/security';
import { sendEmail } from '@/lib/email/resend';
import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';

import { stepUpOwed } from '@stockpilot/core';

/**
 * How a person confirms deleting their own account, on the web and the phone.
 *
 *  - An account with a verified authenticator: the session must be at aal2
 *    (the code was entered). No password is asked.
 *  - An account with no verified authenticator, read now by its id (whatever
 *    level the session claims): its current password, or a six-digit code
 *    emailed to its current address (lib/auth/account-delete-code.ts). Either
 *    one confirms the deletion whatever the organization's authenticator
 *    policy says: a person must be able to leave.
 *
 * The password is checked on a separate client that keeps no session
 * (verifyPasswordSideChannel), so the caller's session is untouched. Neither
 * the password nor the code is logged, reported, or put in an audit row, an
 * error or a URL.
 *
 * LIMITS. Each is per account, shared by the web and the phone, and closed (a
 * limiter that cannot answer refuses): checking a password, sending a code,
 * and checking a code, five each per fifteen minutes. A try is counted before
 * it is checked.
 */

type AdminClient = Pick<SupabaseClient, 'auth'>;

export const ACCOUNT_DELETE_CREDENTIAL_LIMIT = 5;
export const ACCOUNT_DELETE_CREDENTIAL_WINDOW_MS = 15 * 60_000;

export function accountDeletePasswordKey(userId: string): string {
  return `account-delete-password:${userId}`;
}
export function accountDeleteCodeSendKey(userId: string): string {
  return `account-delete-code-send:${userId}`;
}
export function accountDeleteCodeCheckKey(userId: string): string {
  return `account-delete-code-check:${userId}`;
}

/** The longest password this check sends on (the sign-up limit is far below). */
const MAX_PASSWORD_LENGTH = 1024;

/**
 * Plain sentences, in @stockpilot/core (account/delete-account-copy.ts) with
 * the dialog's words and the phone's reading of these answers. They never say
 * whether an account has a password.
 */
export {
  ACCOUNT_DELETE_AAL2_COPY,
  ACCOUNT_DELETE_CODE_NOT_OFFERED_COPY,
  ACCOUNT_DELETE_CODE_REFUSED_COPY,
  ACCOUNT_DELETE_CODE_SEND_FAILED_COPY,
  ACCOUNT_DELETE_CODE_SEND_PAUSED_COPY,
  ACCOUNT_DELETE_CODE_SENT_COPY,
  ACCOUNT_DELETE_CREDENTIAL_CHECK_FAILED_COPY,
  ACCOUNT_DELETE_CREDENTIAL_PAUSED_COPY,
  ACCOUNT_DELETE_CREDENTIAL_REQUIRED_COPY,
  ACCOUNT_DELETE_PASSWORD_REFUSED_COPY,
} from '@stockpilot/core';

/** What the caller sent to confirm: the password, or the emailed code with its challenge. */
export interface DeletionCredentialInput {
  password?: unknown;
  code?: unknown;
  challenge?: unknown;
}

/** Which confirmation the request carries, read from its shape only. */
export function deletionCredentialSupplied(
  input: DeletionCredentialInput,
): 'password' | 'code' | null {
  if (typeof input.password === 'string' && input.password.length > 0) return 'password';
  if (
    (typeof input.code === 'string' && input.code.length > 0) ||
    (typeof input.challenge === 'string' && input.challenge.length > 0)
  ) {
    return 'code';
  }
  return null;
}

/** How a deletion was confirmed. */
export type DeletionConfirmedBy = 'authenticator' | 'password' | 'emailed_code';

export type DeletionCredentialResult =
  | { ok: true; by: DeletionConfirmedBy }
  | {
      ok: false;
      /**
       *  - aal2_required: the account has an authenticator and the session is not at aal2;
       *  - credential_required: no authenticator, and no password or code was sent;
       *  - password_refused / code_refused: wrong, expired, or not this account's;
       *  - rate_limited: too many tries in the window (or the limiter could not answer);
       *  - check_failed: the factors or the password could not be checked: try again;
       *  - gone: the account no longer exists.
       */
      kind:
        | 'aal2_required'
        | 'credential_required'
        | 'password_refused'
        | 'code_refused'
        | 'rate_limited'
        | 'check_failed'
        | 'gone';
    };

type FactorsRead =
  | { kind: 'ok'; factors: Array<{ status?: string | null }> }
  | { kind: 'gone' }
  | { kind: 'failed' };

/** The account's own factors, read by its id with the service role. Never throws. */
export async function readFactorsById(admin: AdminClient, userId: string): Promise<FactorsRead> {
  try {
    const { data, error } = await admin.auth.admin.mfa.listFactors({ userId });
    if (isUserNotFound(error)) return { kind: 'gone' };
    if (error || !data) {
      void reportError(new Error(error?.message || 'listFactors returned no data'), {
        tag: 'account.delete.factors_unreadable',
        level: 'warning',
      });
      return { kind: 'failed' };
    }
    return { kind: 'ok', factors: (data.factors ?? []) as Array<{ status?: string | null }> };
  } catch (e) {
    void reportError(e instanceof Error ? e : new Error(String(e)), {
      tag: 'account.delete.factors_unreadable',
      level: 'warning',
    });
    return { kind: 'failed' };
  }
}

/** Whether the account has a verified authenticator (core stepUpOwed's own test). */
export function hasVerifiedFactor(factors: Array<{ status?: string | null }>): boolean {
  return stepUpOwed(factors, null);
}

/** The verified level of the caller's session for the account; null is not aal2. */
export type SessionLevelReader = () => Promise<string | null | undefined>;

async function readLevelSafely(read: SessionLevelReader): Promise<string | null> {
  try {
    return (await read()) ?? null;
  } catch {
    // Unreadable: not aal2 (fail closed).
    return null;
  }
}

async function allow(key: string): Promise<boolean> {
  const rl = await checkRateLimit(
    key,
    ACCOUNT_DELETE_CREDENTIAL_LIMIT,
    ACCOUNT_DELETE_CREDENTIAL_WINDOW_MS,
    'closed',
  );
  return rl.allowed;
}

/**
 * Decides whether this request confirms deleting `userId`'s account (rule in
 * the header). `email` is the account's current verified address (never the
 * editable profile column, never a pending new address); `readLevel` answers
 * the verified level of the caller's session for this account (null counts as
 * not aal2), and is asked only for an account with an authenticator. Never
 * throws.
 */
export async function confirmDeletionCredential(args: {
  admin: AdminClient;
  userId: string;
  email: string | null;
  readLevel: SessionLevelReader;
  input: DeletionCredentialInput;
  now?: Date;
}): Promise<DeletionCredentialResult> {
  const { admin, userId, email, input } = args;
  const read = await readFactorsById(admin, userId);
  if (read.kind === 'gone') return { ok: false, kind: 'gone' };
  if (read.kind === 'failed') return { ok: false, kind: 'check_failed' };

  if (hasVerifiedFactor(read.factors)) {
    return stepUpOwed(read.factors, await readLevelSafely(args.readLevel))
      ? { ok: false, kind: 'aal2_required' }
      : { ok: true, by: 'authenticator' };
  }

  const supplied = deletionCredentialSupplied(input);
  if (supplied === null) return { ok: false, kind: 'credential_required' };

  try {
    if (supplied === 'password') {
      if (!(await allow(accountDeletePasswordKey(userId))))
        return { ok: false, kind: 'rate_limited' };
      const password = input.password as string;
      if (!email || password.length > MAX_PASSWORD_LENGTH) {
        return { ok: false, kind: 'password_refused' };
      }
      const pw = await verifyPasswordSideChannel(email, password, userId);
      if (pw.ok) return { ok: true, by: 'password' };
      return {
        ok: false,
        kind: pw.reason === 'internal_error' ? 'check_failed' : 'password_refused',
      };
    }

    if (!(await allow(accountDeleteCodeCheckKey(userId))))
      return { ok: false, kind: 'rate_limited' };
    const verdict = checkAccountDeleteCode(env.SUPABASE_SERVICE_ROLE_KEY, {
      challenge: input.challenge,
      code: input.code,
      userId,
      email,
      now: args.now ?? new Date(),
    });
    return verdict === 'valid'
      ? { ok: true, by: 'emailed_code' }
      : { ok: false, kind: 'code_refused' };
  } catch (e) {
    // Never the password, the code or the challenge: a fixed tag only.
    void reportError(e instanceof Error ? e : new Error(String(e)), {
      tag: 'account.delete.credential_check_failed',
    });
    return { ok: false, kind: 'check_failed' };
  }
}

/**
 * The greeting's first name: the first word of the account's profile name,
 * the name the profile action sanitises and every other security email uses
 * (services/email-change.ts), read by the account id with the service role.
 * None when it is empty or cannot be read: the email then says "Hi". Never
 * throws.
 */
async function profileFirstName(
  admin: Pick<SupabaseClient, 'from'>,
  userId: string,
): Promise<string | null> {
  try {
    const { data, error } = await admin
      .from('user_profiles')
      .select('full_name')
      .eq('id', userId)
      .maybeSingle();
    if (error) return null;
    const fullName =
      ((data as { full_name?: unknown } | null)?.full_name as string | null)?.trim() ?? '';
    return fullName ? fullName.split(/\s+/)[0]! : null;
  } catch {
    return null;
  }
}

export type DeletionCodeSendResult =
  | { ok: true; challenge: string; expiresAt: number }
  | {
      ok: false;
      /**
       *  - not_offered: the account has an authenticator (its code confirms instead);
       *  - rate_limited: too many codes sent in the window;
       *  - send_failed: the factors or the address could not be read, the code could not be
       *    signed, or the email did not go (the service refused it, or there is no email key);
       *  - gone: the account no longer exists.
       */
      kind: 'not_offered' | 'rate_limited' | 'send_failed' | 'gone';
    };

/**
 * Emails a new deletion code to `userId`'s current verified address and
 * answers the challenge that goes with it. Only for an account with no
 * verified authenticator. Never throws; the code never leaves this function
 * except in the email.
 */
export async function sendDeletionCode(args: {
  admin: Pick<SupabaseClient, 'auth' | 'from'>;
  userId: string;
  now?: Date;
}): Promise<DeletionCodeSendResult> {
  const { admin, userId } = args;
  const read = await readFactorsById(admin, userId);
  if (read.kind === 'gone') return { ok: false, kind: 'gone' };
  if (read.kind === 'failed') return { ok: false, kind: 'send_failed' };
  if (hasVerifiedFactor(read.factors)) return { ok: false, kind: 'not_offered' };

  if (!(await allow(accountDeleteCodeSendKey(userId)))) return { ok: false, kind: 'rate_limited' };

  try {
    // The account's current address from GoTrue, by its id: never the
    // profile column the person can edit, never a pending new address.
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (isUserNotFound(error)) return { ok: false, kind: 'gone' };
    const email = data?.user?.email ?? null;
    if (error || !email) {
      void reportError(new Error(error?.message || 'no sign-in address for the deletion code'), {
        tag: 'account.delete.code_address_unreadable',
        level: 'warning',
      });
      return { ok: false, kind: 'send_failed' };
    }

    const code = newAccountDeleteCode();
    const signed = signAccountDeleteChallenge(env.SUPABASE_SERVICE_ROLE_KEY, {
      userId,
      email,
      code,
      now: args.now ?? new Date(),
    });
    if (!signed) {
      void reportError(new Error('a deletion code could not be signed'), {
        tag: 'account.delete.code_unsigned',
      });
      return { ok: false, kind: 'send_failed' };
    }

    const message = renderAccountDeleteCodeEmail({
      email,
      code,
      codeExpiry: `${ACCOUNT_DELETE_CODE_TTL_S / 60} minutes`,
      firstName: await profileFirstName(admin, userId),
      appUrl: env.NEXT_PUBLIC_APP_URL,
    });
    const sent = await sendEmail({
      to: email,
      subject: message.subject,
      html: message.html,
      text: message.text,
      from: message.from,
    });
    // An email the service did not accept, or a deployment with no email key
    // (sendEmail then sends nothing and answers ok with the id 'dryrun'):
    // reported, never with the code or the address, and answered send_failed,
    // so the person is told no code is coming (try again, or the password).
    // The caller is signed in as the account and the address is its own, so
    // saying so tells nobody anything new. The send was counted above; the
    // code-check limit is not touched.
    if (!sent.ok || sent.id === 'dryrun') {
      void reportError(
        new Error(
          sent.ok
            ? 'the deletion code email was not sent: no email key'
            : 'the deletion code email was not accepted',
        ),
        { tag: 'account.delete.code_send_failed', level: 'warning' },
      );
      return { ok: false, kind: 'send_failed' };
    }
    return { ok: true, challenge: signed.challenge, expiresAt: signed.expiresAt };
  } catch (e) {
    void reportError(e instanceof Error ? e : new Error(String(e)), {
      tag: 'account.delete.code_send_failed',
      level: 'warning',
    });
    return { ok: false, kind: 'send_failed' };
  }
}

/**
 * The last check right before the delete: the account's factors, read again
 * by its id, still agree with how this request was confirmed. A verified
 * authenticator needs the session at aal2 (`readLevel`). No verified authenticator needs the
 * password or the emailed code checked in this request, unless the caller
 * passes `allowUnconfirmedWithoutFactor`.
 *
 * On success it answers which branch held, and that is what the audit row
 * records (never what the request carried): a verified authenticator at aal2
 * is 'authenticator' whatever else the body held; no authenticator is the
 * password or the code checked in this request, or 'none': no password or
 * code was sent with the request. Never throws.
 */
export async function deletionCredentialStillHeld(args: {
  admin: AdminClient;
  userId: string;
  readLevel: SessionLevelReader;
  confirmedBy: DeletionConfirmedBy | null;
  allowUnconfirmedWithoutFactor?: boolean;
}): Promise<
  | { ok: true; by: DeletionConfirmedBy | 'none' }
  | { ok: false; kind: 'aal2_required' | 'credential_required' | 'check_failed' | 'gone' }
> {
  const read = await readFactorsById(args.admin, args.userId);
  if (read.kind === 'gone') return { ok: false, kind: 'gone' };
  if (read.kind === 'failed') return { ok: false, kind: 'check_failed' };
  if (hasVerifiedFactor(read.factors)) {
    return stepUpOwed(read.factors, await readLevelSafely(args.readLevel))
      ? { ok: false, kind: 'aal2_required' }
      : { ok: true, by: 'authenticator' };
  }
  if (args.confirmedBy === 'password' || args.confirmedBy === 'emailed_code') {
    return { ok: true, by: args.confirmedBy };
  }
  if (args.allowUnconfirmedWithoutFactor) return { ok: true, by: 'none' };
  return { ok: false, kind: 'credential_required' };
}
