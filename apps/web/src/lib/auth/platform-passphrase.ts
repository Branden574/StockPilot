import 'server-only';

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Hash + verify the platform org-deletion passphrase. Unlike API keys (192-bit
 * random → SHA-256 is fine), this is a HUMAN-chosen secret, so it needs a slow,
 * salted KDF to resist offline brute-force if the settings row ever leaks.
 * scrypt is a memory-hard KDF built into Node — no new dependency.
 */

const KEYLEN = 64;

/** Returns a fresh random salt + the scrypt hash (both hex). */
export function hashPassphrase(passphrase: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(passphrase.normalize('NFKC'), salt, KEYLEN).toString('hex');
  return { hash, salt };
}

/** Timing-safe verify. False for any missing/malformed input (never throws). */
export function verifyPassphrase(
  passphrase: string,
  hash: string | null | undefined,
  salt: string | null | undefined,
): boolean {
  if (!passphrase || !hash || !salt) return false;
  try {
    const computed = scryptSync(passphrase.normalize('NFKC'), salt, KEYLEN);
    const stored = Buffer.from(hash, 'hex');
    if (computed.length !== stored.length) return false;
    return timingSafeEqual(computed, stored);
  } catch {
    return false;
  }
}
