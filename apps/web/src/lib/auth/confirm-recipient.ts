import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The signed recipient reference `r` on an emailed confirmation link (docket
 * S25, INV-E5). Pure: node:crypto only, no env, no `server-only`, so the perf
 * harness (tests/perf/auth.setup.ts) signs with this very code. The app signs
 * and checks through lib/auth/confirm-link.ts, which supplies the key.
 *
 * WHY. An emailed link is a bearer credential that does not say whose account
 * it opens. Any page can send a browser to /auth/confirm with a link it holds
 * for its own account (a reset link for its own address is one form away),
 * and the person's press then signs that browser in to that account. `r`
 * names the account, in a value only our server can write, so the page can
 * show that account's address before anyone presses.
 *
 * THE VALUE: `v1.<user id>.<issued>.<tag>`, about 94 characters.
 *   - user id: the account GoTrue made the link for, a lowercase UUID;
 *   - issued: whole UTC seconds since 1970, when the link was built;
 *   - tag: base64url without padding (43 characters) of HMAC-SHA256 under the
 *     recipient key, over `auth-confirm:recipient:v1:<type>:<token hash>:<user
 *     id>:<issued>`. The type and the token hash are signed but not carried:
 *     the link carries them already, so `r` holds for that one link, as that
 *     type (a recovery link relabelled as a sign-in link fails), and no part
 *     can contain `:` (the types are a fixed list, a token hash is
 *     [A-Za-z0-9_-], a UUID and digits), so no two inputs share a signed text.
 *   - recipient key: HMAC-SHA256 keyed with the trimmed service key, over the
 *     fixed label `stockpilot:auth-confirm-recipient-key:v1`. Derived rather
 *     than a new setting: a forgotten setting would stop every reset, invite
 *     and email-change email, and the service key already exists wherever a
 *     link can be minted. Only its holders, who can mint links anyway, can
 *     sign; the derived key is never the service key itself.
 *
 * THE ISSUE TIME bounds the value: GoTrue expires the token itself after
 * mailer_otp_exp (3600 s in production, server/services/email-change.ts), so
 * a value issued more than CONFIRM_LINK_MAX_AGE_S ago, or more than
 * CONFIRM_RECIPIENT_FUTURE_SKEW_S ahead of this clock, is stale. Without it a
 * leaked old URL (browser history on a shared computer, a proxy log) would
 * show an account's address forever, and every replay of it would cost a
 * lookup. Only a value whose tag checks out is ever called stale, so only a
 * link we signed can be told apart from a forged one.
 *
 * Fail closed: with no key nothing is signed and nothing verifies. Nothing
 * here throws, whatever it is handed.
 */

/** The types /auth/confirm sends links for (its ALLOWED_TYPES). */
export const CONFIRM_RECIPIENT_TYPES = ['recovery', 'invite', 'magiclink', 'email_change'] as const;
export type ConfirmRecipientType = (typeof CONFIRM_RECIPIENT_TYPES)[number];

/** Production mailer_otp_exp (3600 s) plus five minutes. */
export const CONFIRM_LINK_MAX_AGE_S = 3900;
/** How far ahead of this clock an issue time may be (another server's clock). */
export const CONFIRM_RECIPIENT_FUTURE_SKEW_S = 300;

const KEY_LABEL = 'stockpilot:auth-confirm-recipient-key:v1';
const SIGNED_PREFIX = 'auth-confirm:recipient:v1';
const VERSION = 'v1';

/** The longest value checked at all: about 94 characters today, never past 128. */
const MAX_LENGTH = 128;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** GoTrue's hashed token is a sha224 in hex; our email-change hash is too. */
const TOKEN_HASH_RE = /^[A-Za-z0-9_-]{16,128}$/;
const ISSUED_RE = /^[0-9]{1,12}$/;
/** 32 bytes of HMAC-SHA256 in base64url without padding. */
const TAG_RE = /^[A-Za-z0-9_-]{43}$/;

export interface ConfirmRecipientClaim {
  type: string;
  tokenHash: string;
  userId: string;
  /** Whole UTC seconds since 1970. */
  issued: number;
}

/**
 * What a value is, for one link (type and token hash), judged at a time:
 *   valid    signed by us for this link, within its time: the account;
 *   stale    signed by us for this link, outside its time;
 *   invalid  anything else.
 */
export type ConfirmRecipientVerdict =
  { status: 'valid'; userId: string; issued: number } | { status: 'stale' } | { status: 'invalid' };

const INVALID: ConfirmRecipientVerdict = Object.freeze({ status: 'invalid' as const });
const STALE: ConfirmRecipientVerdict = Object.freeze({ status: 'stale' as const });

function isRecipientType(value: unknown): value is ConfirmRecipientType {
  return (CONFIRM_RECIPIENT_TYPES as readonly unknown[]).includes(value);
}

function recipientKey(serviceRoleKey: unknown): Buffer | null {
  const key = typeof serviceRoleKey === 'string' ? serviceRoleKey.trim() : '';
  if (!key) return null;
  return createHmac('sha256', key).update(KEY_LABEL).digest();
}

function tagFor(
  key: Buffer,
  type: string,
  tokenHash: string,
  userId: string,
  issued: string,
): Buffer {
  return createHmac('sha256', key)
    .update(`${SIGNED_PREFIX}:${type}:${tokenHash}:${userId}:${issued}`)
    .digest();
}

/**
 * The `r` value for one link, or null when it cannot be signed: no key, a type
 * the route does not send, a token hash outside GoTrue's shape, a user id that
 * is not a UUID, or an issue time that is not a whole positive number of
 * seconds. A builder that gets null sends no link.
 */
export function signConfirmRecipient(
  serviceRoleKey: string,
  claim: ConfirmRecipientClaim,
): string | null {
  try {
    const key = recipientKey(serviceRoleKey);
    if (!key || !claim || typeof claim !== 'object') return null;
    const { type, tokenHash, issued } = claim;
    const userId = typeof claim.userId === 'string' ? claim.userId.toLowerCase() : '';
    if (
      !isRecipientType(type) ||
      typeof tokenHash !== 'string' ||
      !TOKEN_HASH_RE.test(tokenHash) ||
      !UUID_RE.test(userId) ||
      typeof issued !== 'number' ||
      !Number.isSafeInteger(issued) ||
      issued <= 0 ||
      !ISSUED_RE.test(String(issued))
    ) {
      return null;
    }
    const tag = tagFor(key, type, tokenHash, userId, String(issued)).toString('base64url');
    return `${VERSION}.${userId}.${issued}.${tag}`;
  } catch {
    return null;
  }
}

/**
 * Checks `r` for one link (its type and token hash) at `now`. In order, all
 * pure computation: the shape (length, four parts, the version, a UUID,
 * digits, 43 base64url characters), the type, the token hash, the key, the
 * tag in constant time, then the age. Never throws.
 */
export function checkConfirmRecipient(
  serviceRoleKey: string,
  args: { type: string; tokenHash: string; r: string; now: Date },
): ConfirmRecipientVerdict {
  try {
    const { type, tokenHash, r, now } = args ?? ({} as typeof args);
    if (typeof r !== 'string' || r.length === 0 || r.length > MAX_LENGTH) return INVALID;
    const parts = r.split('.');
    if (parts.length !== 4) return INVALID;
    const [version, userId, issued, tag] = parts as [string, string, string, string];
    if (
      version !== VERSION ||
      !UUID_RE.test(userId) ||
      !ISSUED_RE.test(issued) ||
      !TAG_RE.test(tag)
    ) {
      return INVALID;
    }
    if (!isRecipientType(type)) return INVALID;
    if (typeof tokenHash !== 'string' || !TOKEN_HASH_RE.test(tokenHash)) return INVALID;
    const key = recipientKey(serviceRoleKey);
    if (!key) return INVALID;
    const expected = tagFor(key, type, tokenHash, userId, issued);
    const provided = Buffer.from(tag, 'base64url');
    // TAG_RE admits 43 characters whose last one carries 2 spare bits, so
    // also compare the text: only the one spelling our signer writes passes.
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(expected, provided) ||
      expected.toString('base64url') !== tag
    ) {
      return INVALID;
    }

    // Signed by us for this link from here on.
    const issuedAt = Number(issued);
    const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
    if (!Number.isFinite(nowMs)) return INVALID;
    const nowSeconds = Math.floor(nowMs / 1000);
    if (
      issuedAt - nowSeconds > CONFIRM_RECIPIENT_FUTURE_SKEW_S ||
      nowSeconds - issuedAt > CONFIRM_LINK_MAX_AGE_S
    ) {
      return STALE;
    }
    return { status: 'valid', userId, issued: issuedAt };
  } catch {
    return INVALID;
  }
}
