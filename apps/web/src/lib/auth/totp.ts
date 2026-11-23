import 'server-only';

import { createHmac } from 'node:crypto';

/**
 * RFC 6238 time-based codes (HMAC-SHA-1, 30-second steps, 6 digits), the
 * kind Supabase Auth checks for a TOTP factor. Used only to answer the
 * passkey bridge after a passkey passed (server/security/passkeys.ts); the
 * code and the secret never leave the function that computes them, and
 * nothing here logs.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 to bytes, or null for a character outside the alphabet. */
export function base32Decode(text: string): Buffer | null {
  const clean = text.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = BASE32.indexOf(ch);
    if (index < 0) return null;
    value = ((value << 5) | index) >>> 0;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code of `key` for the 30-second step that holds `unixSeconds`. */
export function totpAt(key: Buffer, unixSeconds: number, digits = 6): string {
  const counter = Math.floor(unixSeconds / 30);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * The 6-digit code of a base32 secret, `stepOffset` steps from now (0: this
 * step, 1: the next one). Null when the secret does not decode.
 */
export function totpCodeFromBase32(secret: string, nowMs: number, stepOffset = 0): string | null {
  const key = base32Decode(secret);
  if (!key || key.length === 0) return null;
  return totpAt(key, nowMs / 1000 + stepOffset * 30);
}
