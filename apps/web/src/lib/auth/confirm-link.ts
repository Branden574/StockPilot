import 'server-only';

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
 * UUID, or a token hash outside GoTrue's shape). Never send a link without r:
 * the next release refuses one.
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
 *   found   its sign-in address, and the new one an email change is waiting
 *           on (null when none);
 *   gone    GoTrue answered 404 user_not_found, the account has no address,
 *           or it is disabled (banned_until in the future,
 *           server/services/platform/account-status.ts): the link cannot be
 *           used, so the page answers as for an expired one;
 *   failed  any other answer, or none within the time limit.
 * Shaped like readAuthEmail (server/lib/account-deletion.ts). Never throws,
 * and never returns GoTrue's message, which can carry the id.
 */
export type ConfirmRecipientAccount =
  | { kind: 'found'; email: string; newEmail: string | null }
  | { kind: 'gone' }
  | { kind: 'failed'; reason: 'error' | 'timeout' };

/** GoTrue v2's not-found answer for GET /admin/users/<id> (as account-deletion.ts reads it). */
function isUserNotFound(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const o = e as { status?: unknown; code?: unknown };
  return o.status === 404 && o.code === 'user_not_found';
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
    return { kind: 'found', email, newEmail: pending || null };
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
