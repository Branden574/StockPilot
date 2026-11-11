import { createHmac } from 'node:crypto';

/**
 * A time-based one-time code (RFC 6238, HMAC-SHA1, 30 s steps, 6 digits:
 * what Supabase's TOTP factor and every authenticator app use), for the
 * stage 5 lab specs that sign in a user with two-step sign-in (plan 8.2
 * case 6). The seed comes from the environment only (STAGE5_MFA_TOTP_SECRET,
 * base32 as the enrolment QR code carries it); nothing here is a secret.
 *
 * Node's crypto only, no Playwright import, so the unit test
 * (src/test/stage5a-totp.test.ts) checks it against the RFC's own vectors.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, case and spaces ignored, padding optional. */
export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/gu, '').toUpperCase();
  if (clean === '') throw new Error('An empty base32 seed.');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('A base32 seed holds a character outside A-Z and 2-7.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The HOTP value (RFC 4226) for `counter` with this key. */
export function hotp(key: Buffer, counter: number, digits = 6): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hash = createHmac('sha1', key).update(message).digest();
  const offset = hash[hash.length - 1]! & 0x0f;
  const binary =
    ((hash[offset]! & 0x7f) << 24) |
    (hash[offset + 1]! << 16) |
    (hash[offset + 2]! << 8) |
    hash[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The TOTP code at `atMs` (milliseconds since the epoch) for a base32 seed. */
export function totp(seedBase32: string, atMs: number, digits = 6, stepSeconds = 30): string {
  return hotp(base32Decode(seedBase32), Math.floor(atMs / 1000 / stepSeconds), digits);
}

/**
 * Milliseconds until the current 30 s step ends: a caller with less than a
 * few seconds left waits for the next code, so a code is never typed as it
 * expires.
 */
export function msLeftInStep(atMs: number, stepSeconds = 30): number {
  const step = stepSeconds * 1000;
  return step - (atMs % step);
}
