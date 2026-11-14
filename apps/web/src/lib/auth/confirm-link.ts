import 'server-only';

import { isUserNotFound } from '@/lib/auth/gotrue-user-not-found';
import { env } from '@/lib/env';
import { createAdminClient } from '@/lib/supabase/admin';

import {
  checkConfirmRecipient,
  signConfirmRecipient,
  type ConfirmRecipientVerdict,
} from './confirm-recipient';

/**
 * The one place an /auth/confirm link is written, and where the route checks
 * the account a link names (docket S25, INV-E5).
 *
 * Every link the app emails (password reset, the QA recovery link, a new
 * workspace owner's invite, the portal invite and its sign-in fallback, both
 * email-change links) carries `r`: the user id GoTrue returned with the token,
 * signed by us over the link's type, its token hash and the time it was built
 * (lib/auth/confirm-recipient.ts). /auth/confirm checks it on GET and POST,
 * and before anyone presses shows that account's address, which it looks up
 * here. confirm-landing.test.ts fails when any other file writes such a link.
 *
 * The signing key is derived from SUPABASE_SERVICE_ROLE_KEY (env.ts trims
 * it), the key every builder already needs to mint the token. With no key no
 * link is written, and the builder sends nothing.
 */

export type ConfirmLinkRequest = {
  tokenHash: string;
  /** The id GoTrue returned with the token: the account the link is for. */
  userId: string | null | undefined;
  /** When the link is built (its issue time); now by default. */
  now?: Date;
} & (
  | {
      type: 'recovery' | 'invite' | 'magiclink';
      /** One of the type's landings in lib/auth/confirm-landing.ts. */
      next: string;
    }
  | {
      /** The route fixes where an email change lands, so it carries no next. */
      type: 'email_change';
    }
);

/**
 * The link, or null when it cannot be signed (no key, a user id that is not a
 * UUID, or a token hash outside GoTrue's shape). A builder that gets null
 * sends nothing: every link the app sends names its account.
 */
export function confirmLinkUrl(link: ConfirmLinkRequest): string | null {
  const now = link.now ?? new Date();
  const r = signConfirmRecipient(env.SUPABASE_SERVICE_ROLE_KEY, {
    type: link.type,
    tokenHash: link.tokenHash,
    userId: link.userId ?? '',
    issued: Math.floor(now.getTime() / 1000),
  });
  if (!r) return null;
  const next = link.type === 'email_change' ? '' : `&next=${encodeURIComponent(link.next)}`;
  return `${env.NEXT_PUBLIC_APP_URL}/auth/confirm?token_hash=${encodeURIComponent(link.tokenHash)}&type=${link.type}${next}&r=${encodeURIComponent(r)}`;
}

/** Checks a link's `r` with this deployment's key (see checkConfirmRecipient). Never throws. */
export function verifyConfirmRecipient(args: {
  type: string;
  tokenHash: string;
  r: string;
  now?: Date;
}): ConfirmRecipientVerdict {
  return checkConfirmRecipient(env.SUPABASE_SERVICE_ROLE_KEY, {
    type: args.type,
    tokenHash: args.tokenHash,
    r: args.r,
    now: args.now ?? new Date(),
  });
}

/** How long the page waits for GoTrue before it says "try again". */
export const CONFIRM_RECIPIENT_LOOKUP_TIMEOUT_MS = 5000;

/**
 * The account a signed link is for, read from GoTrue with the service client:
 *   found   its sign-in address, the new one an email change is waiting on
 *           (null when none) and when GoTrue recorded that change's latest
 *           request (email_change_sent_at, in ms; null when it gives none or
 *           one that cannot be read as a date);
 *   gone    GoTrue answered 404 user_not_found (lib/auth/gotrue-user-not-found,
 *           the one reading account deletion uses), the account has no address,
 *           or it is disabled (banned_until in the future,
 *           server/services/platform/account-status.ts): the link cannot be
 *           used, so the page answers as for an expired one;
 *   failed  any other answer, or none within the time limit.
 * Shaped like readAuthEmail (server/lib/account-deletion.ts). Never throws,
 * and never returns GoTrue's message, which can carry the id.
 */
export type ConfirmRecipientAccount =
  | { kind: 'found'; email: string; newEmail: string | null; emailChangeSentAt: number | null }
  | { kind: 'gone' }
  | { kind: 'failed'; reason: 'error' | 'timeout' };

/**
 * How far past an email-change link's issue time GoTrue's record of the
 * latest request may fall and still be the request that link was built for.
 * mintEmailChangeLinks signs after GoTrue has stored the request, so only the
 * two servers' clocks and the issue time's whole seconds can put GoTrue's time
 * later, by far less than this. A request to another address takes longer than
 * this: it needs that address and the current password typed again (a resend
 * can come sooner, but names the same addresses).
 */
export const EMAIL_CHANGE_REQUEST_SKEW_S = 5;

/**
 * The new address an email-change link may name, or null when GoTrue no
 * longer holds the change the link was sent for (docket S25 review):
 *   - nothing is pending: the change was completed or cancelled;
 *   - GoTrue's latest request is later than the link (by more than
 *     EMAIL_CHANGE_REQUEST_SKEW_S): the change was asked for again, to
 *     another address or the same one, or resent, and GoTrue keeps one pending
 *     change, so this link's token is gone (server/services/email-change.ts).
 * The page then shows the expired answer and no address: the account's
 * addresses are no longer the ones the link was sent for, and a link sent to a
 * mistyped address must not show its holder the address the person meant.
 *   - GoTrue gives no request time for the pending change, or one that cannot
 *     be read (emailChangeRequestTimeMissing): without it no link can be told
 *     apart from a later request's, so none is taken as the live one.
 * GoTrue stores the request time with the pending address (and the cancel
 * clears both), so the last case is not expected; the route reports it
 * (auth.email_change_request_time_missing), so a change in what GoTrue
 * returns shows up as a report.
 */
export function pendingEmailChangeFor(
  account: { newEmail: string | null; emailChangeSentAt: number | null },
  issued: number,
): string | null {
  if (!account.newEmail) return null;
  const sentAt = account.emailChangeSentAt;
  // Pending with no readable request time (emailChangeRequestTimeMissing).
  if (sentAt === null) return null;
  if (sentAt / 1000 > issued + EMAIL_CHANGE_REQUEST_SKEW_S) return null;
  return account.newEmail;
}

/**
 * An email change is pending but GoTrue gave no readable time for its request
 * (readRecipient reads a missing or unreadable one as null).
 */
export function emailChangeRequestTimeMissing(account: {
  newEmail: string | null;
  emailChangeSentAt: number | null;
}): boolean {
  return Boolean(account.newEmail) && account.emailChangeSentAt === null;
}

/**
 * GoTrue's email_change_sent_at in ms, or null when it is missing or is not a
 * date written as one (GoTrue writes RFC 3339). A bare number, or a string
 * Date.parse would stretch into some year, is not read as a time.
 */
function requestTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}[T ]/.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

async function readRecipient(userId: string, now: Date): Promise<ConfirmRecipientAccount> {
  try {
    const { data, error } = await createAdminClient().auth.admin.getUserById(userId);
    if (error)
      return isUserNotFound(error) ? { kind: 'gone' } : { kind: 'failed', reason: 'error' };
    const user = data?.user;
    if (!user) return { kind: 'failed', reason: 'error' };
    const email = typeof user.email === 'string' ? user.email.trim() : '';
    if (!email) return { kind: 'gone' };
    const bannedUntil = Date.parse(user.banned_until ?? '');
    if (Number.isFinite(bannedUntil) && bannedUntil > now.getTime()) return { kind: 'gone' };
    const pending = typeof user.new_email === 'string' ? user.new_email.trim() : '';
    return {
      kind: 'found',
      email,
      newEmail: pending || null,
      emailChangeSentAt: requestTime(user.email_change_sent_at),
    };
  } catch {
    return { kind: 'failed', reason: 'error' };
  }
}

export async function lookUpConfirmRecipient(
  userId: string,
  now: Date = new Date(),
): Promise<ConfirmRecipientAccount> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ConfirmRecipientAccount>((resolve) => {
    timer = setTimeout(
      () => resolve({ kind: 'failed', reason: 'timeout' }),
      CONFIRM_RECIPIENT_LOOKUP_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([readRecipient(userId, now), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
