import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * The emailed code that confirms deleting an account with no authenticator,
 * and the signed challenge that goes with it. Pure: node:crypto only, no env
 * and no `server-only`, so the tests run this very code. The server signs and
 * checks through server/lib/account-deletion-credential.ts, which supplies the
 * key.
 *
 * HOW IT WORKS. The server picks a six-digit code, emails it to the account's
 * current address, and hands the caller a challenge:
 * `v1.<user id>.<expires>.<nonce>.<tag>`. The tag is HMAC-SHA256, under a key
 * derived from the service key, over the account, a hash of the address the
 * code was sent to, the expiry, the nonce AND the code. The challenge carries
 * no code: without the key, nobody can tell from it which code it holds, so
 * the person must read the email. The server keeps nothing: it checks a
 * code by signing it again with the challenge's own parts.
 *
 *  - user id: the account the code was sent for, lowercase. A
 *    challenge of another account never checks out for this one.
 *  - the address: a SHA-256 of the lowercased address, so a challenge sent to
 *    an address the account no longer has fails.
 *  - expires: whole UTC seconds, ten minutes after it was sent.
 *  - nonce: 16 random bytes, so two challenges for the same code differ.
 *
 * THE KEY: HMAC-SHA256 keyed with the trimmed service key over the fixed label
 * `stockpilot:account-delete-code-key:v1`. Derived, as the emailed links'
 * recipient key is (lib/auth/confirm-recipient.ts), so there is no new
 * setting; the derived key is never the service key itself and differs from
 * every other key derived from it.
 *
 * Fail closed: with no key nothing is signed and nothing checks out. Nothing
 * here throws, whatever it is handed.
 */

/** How long a code works: ten minutes. */
export const ACCOUNT_DELETE_CODE_TTL_S = 10 * 60;
/** How far ahead of this clock an expiry may be (another server's clock). */
const FUTURE_SKEW_S = 5 * 60;

const KEY_LABEL = 'stockpilot:account-delete-code-key:v1';
const SIGNED_PREFIX = 'account-delete:code:v1';
const VERSION = 'v1';

const MAX_LENGTH = 160;
/** An account id: a lowercase UUID in practice; never a `.` or a `:`, which separate the parts. */
const USER_ID_RE = /^[0-9a-z][0-9a-z-]{0,63}$/;
const SECONDS_RE = /^[0-9]{1,12}$/;
/** 16 bytes in base64url without padding. */
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
/** 32 bytes of HMAC-SHA256 in base64url without padding. */
const TAG_RE = /^[A-Za-z0-9_-]{43}$/;
/** Exactly six digits. */
export const ACCOUNT_DELETE_CODE_RE = /^[0-9]{6}$/;

/**
 * What a code is, with its challenge, for one account and address at a time:
 *   valid    the code this challenge was signed for, within its time;
 *   expired  the code this challenge was signed for, past its time;
 *   invalid  anything else: another code, another account, another address,
 *            a challenge we did not sign.
 */
export type AccountDeleteCodeVerdict = 'valid' | 'expired' | 'invalid';

function codeKey(serviceRoleKey: unknown): Buffer | null {
  const key = typeof serviceRoleKey === 'string' ? serviceRoleKey.trim() : '';
  if (!key) return null;
  return createHmac('sha256', key).update(KEY_LABEL).digest();
}

function addressHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

function tagFor(
  key: Buffer,
  userId: string,
  email: string,
  expires: string,
  nonce: string,
  code: string,
): Buffer {
  return createHmac('sha256', key)
    .update(`${SIGNED_PREFIX}:${userId}:${addressHash(email)}:${expires}:${nonce}:${code}`)
    .digest();
}

/** A fresh six-digit code, uniformly drawn (leading zeros kept). */
export function newAccountDeleteCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * The challenge for `code`, sent now to `email` for `userId`; null when it
 * cannot be signed (no key, a user id of another shape, no address, a code
 * that is not six digits). A caller that gets null sends nothing.
 */
export function signAccountDeleteChallenge(
  serviceRoleKey: string,
  args: { userId: string; email: string; code: string; now: Date; nonce?: string },
): { challenge: string; expiresAt: number } | null {
  try {
    const key = codeKey(serviceRoleKey);
    if (!key || !args) return null;
    const userId = typeof args.userId === 'string' ? args.userId.toLowerCase() : '';
    const email = typeof args.email === 'string' ? args.email.trim() : '';
    const { code } = args;
    const nowMs = args.now instanceof Date ? args.now.getTime() : Number.NaN;
    if (
      !USER_ID_RE.test(userId) ||
      !email ||
      typeof code !== 'string' ||
      !ACCOUNT_DELETE_CODE_RE.test(code) ||
      !Number.isFinite(nowMs)
    ) {
      return null;
    }
    const nonce = args.nonce ?? randomBytes(16).toString('base64url');
    if (!NONCE_RE.test(nonce)) return null;
    const expiresAt = Math.floor(nowMs / 1000) + ACCOUNT_DELETE_CODE_TTL_S;
    const expires = String(expiresAt);
    const tag = tagFor(key, userId, email, expires, nonce, code).toString('base64url');
    return { challenge: `${VERSION}.${userId}.${expires}.${nonce}.${tag}`, expiresAt };
  } catch {
    return null;
  }
}

/**
 * Checks `code` against `challenge` for `userId` and `email` at `now`. In
 * order, all pure computation: the shapes, the account, the key, the tag in
 * constant time, then the time. Never throws.
 */
export function checkAccountDeleteCode(
  serviceRoleKey: string,
  args: { challenge: unknown; code: unknown; userId: string; email: string | null; now: Date },
): AccountDeleteCodeVerdict {
  try {
    const { challenge, code, now } = args ?? ({} as typeof args);
    if (typeof challenge !== 'string' || challenge.length === 0 || challenge.length > MAX_LENGTH) {
      return 'invalid';
    }
    if (typeof code !== 'string' || !ACCOUNT_DELETE_CODE_RE.test(code)) return 'invalid';
    const email = typeof args.email === 'string' ? args.email.trim() : '';
    if (!email) return 'invalid';
    const parts = challenge.split('.');
    if (parts.length !== 5) return 'invalid';
    const [version, userId, expires, nonce, tag] = parts as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (
      version !== VERSION ||
      !USER_ID_RE.test(userId) ||
      !SECONDS_RE.test(expires) ||
      !NONCE_RE.test(nonce) ||
      !TAG_RE.test(tag)
    ) {
      return 'invalid';
    }
    if (typeof args.userId !== 'string' || userId !== args.userId.toLowerCase()) return 'invalid';
    const key = codeKey(serviceRoleKey);
    if (!key) return 'invalid';
    const expected = tagFor(key, userId, email, expires, nonce, code);
    const provided = Buffer.from(tag, 'base64url');
    // TAG_RE admits 43 characters whose last one carries 2 spare bits, so
    // also compare the text: only the one spelling the signer writes passes.
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(expected, provided) ||
      expected.toString('base64url') !== tag
    ) {
      return 'invalid';
    }

    const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
    if (!Number.isFinite(nowMs)) return 'invalid';
    const nowSeconds = Math.floor(nowMs / 1000);
    const expiresAt = Number(expires);
    if (nowSeconds >= expiresAt) return 'expired';
    // An expiry further out than one code's life (plus another server's
    // clock) was not written by this signer's rule.
    if (expiresAt - nowSeconds > ACCOUNT_DELETE_CODE_TTL_S + FUTURE_SKEW_S) return 'invalid';
    return 'valid';
  } catch {
    return 'invalid';
  }
}
