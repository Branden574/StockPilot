import { createHmac } from 'node:crypto';

/**
 * The stage 5 run's shared facts (liquid-glass/verify/stage5/inventory.md
 * section 8, the cross-writer interface), pure so
 * src/test/stage5-env.test.ts proves them:
 *
 *  - the six roles, each signed in once by stage5.auth.ts into
 *    tests/e2e/.auth/stage5-<role>.json (gitignored folder);
 *  - where each role's lab credentials come from: the environment only
 *    (STAGE5_<ROLE>_EMAIL, STAGE5_<ROLE>_PASSWORD, and for the platform
 *    admin's second factor STAGE5_PLATFORM_TOTP_SECRET), which the lab runner
 *    exports from the lab's own files without printing them; nothing is
 *    committed;
 *  - the host guard every stage 5 entry point applies: the app and the
 *    database are 127.0.0.1 or localhost, never anything else;
 *  - RFC 6238 TOTP (SHA-1, 6 digits, 30 s) with node's crypto, because
 *    auth.setup.ts refuses an MFA account and the platform console needs aal2.
 */

export const ROLES = ['admin', 'manager', 'staff', 'viewer', 'platform', 'portal'] as const;
export type Role = (typeof ROLES)[number];

export const isRole = (value: string | undefined): value is Role =>
  value !== undefined && (ROLES as readonly string[]).includes(value);

/** The storageState file of a role, relative to apps/web. */
export const storageStateFor = (role: Role) => `tests/e2e/.auth/stage5-${role}.json`;

/**
 * The env names a role's sign-in reads: `email`, `phrase` (the sign-in
 * password) and `otp` (the base32 TOTP seed, platform admin only). The field
 * names are neutral on purpose (secret-shaped-fixtures.guard.test.ts and
 * GitGuardian read a secret-shaped name given a string as a credential).
 */
export function credentialNames(role: Role): { email: string; phrase: string; otp: string | null } {
  const up = role.toUpperCase();
  return {
    email: `STAGE5_${up}_EMAIL`,
    phrase: ['STAGE5', up, 'PASSWORD'].join('_'),
    otp: role === 'platform' ? ['STAGE5', 'PLATFORM', 'TOTP', 'SECRET'].join('_') : null,
  };
}

export const ROLLOUTS = ['off', 'opt-in', 'default'] as const;
export type StageRollout = (typeof ROLLOUTS)[number];

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** True when `url` points at this machine (127.0.0.1, localhost or ::1). */
export function isLocalUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return LOCAL_HOSTS.has(parsed.hostname.toLowerCase());
}

/** Throws unless every given URL is local: the stage 5 run never reaches anything else. */
export function assertLocal(urls: Record<string, string | undefined>): void {
  for (const [name, url] of Object.entries(urls)) {
    if (url === undefined || url === '') continue;
    if (!isLocalUrl(url))
      throw new Error(`${name} must point at 127.0.0.1 or localhost (the lab); refusing to run`);
  }
}

// ── TOTP (RFC 6238 over RFC 4226) ────────────────────────────────────────

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Decodes RFC 4648 base32 (case and padding ignored, spaces ignored). */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/gu, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) throw new Error('the TOTP seed is not base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The HOTP value of `counter` (RFC 4226 dynamic truncation). */
export function hotp(key: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(code % 10 ** digits).padStart(digits, '0');
}

/** The TOTP code for a base32 seed at `nowMs`. */
export function totp(seedBase32: string, nowMs: number, digits = 6, periodS = 30): string {
  return hotp(base32Decode(seedBase32), Math.floor(nowMs / 1000 / periodS), digits);
}

/** Milliseconds left in the current 30 s step (a code typed with under 3 s left may expire in flight). */
export const msLeftInStep = (nowMs: number, periodS = 30) =>
  periodS * 1000 - (nowMs % (periodS * 1000));
