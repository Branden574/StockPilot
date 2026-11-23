import 'server-only';

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { env } from '@/lib/env';

/**
 * The passkey bridge's secret, sealed for public.passkey_bridges (plan 2.3).
 *
 * The bridge is a hidden authenticator factor at Supabase Auth; the server
 * answers it only after a passkey of the same account passed its check. Its
 * secret is kept here sealed with AES-256-GCM under a key of its OWN
 * (PASSKEY_BRIDGE_KEY_V1, later _V2): 32 random bytes, base64, never derived
 * from any other secret (review finding 1: the service-role key changed twice
 * in 2026 at times nobody chose). Each row names its key version; two
 * versions can be read at once, and a row sealed with an older one is sealed
 * again with the newest on its next use (a rotation changes ciphertext only).
 *
 * Stored form: `v<n>.<iv>.<ciphertext>.<tag>`, base64url, 12-byte IV, 16-byte
 * tag; 0475's check ties the prefix to the row's key_version. The AAD is
 * `passkey-bridge:v<n>:<account id>:<factor id>`, so a ciphertext moved to
 * another row, account or version does not open.
 *
 * Nothing here logs, throws on bad input or returns a key. No key, or not the
 * key a row names: the secret cannot be opened (null), and passkeys are
 * neither offered nor accepted (as with the kill switch off).
 */

/** Key versions this build reads, and the setting each comes from. */
const KEY_SETTINGS = [
  [1, 'PASSKEY_BRIDGE_KEY_V1'],
  [2, 'PASSKEY_BRIDGE_KEY_V2'],
] as const;

export type BridgeKeys = ReadonlyMap<number, Buffer>;

export interface SealedBridgeSecret {
  ciphertext: string;
  keyVersion: number;
}

/** Where a sealed secret belongs: its account and its factor. */
export interface BridgeSecretOwner {
  userId: string;
  factorId: string;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const STORED_RE = /^v([0-9]{1,3})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{16,200})\.([A-Za-z0-9_-]{22})$/;

/** A key setting as 32 bytes, or null (unset, not base64, or not 32 bytes long). */
export function keyFromSetting(value: string | undefined): Buffer | null {
  const text = (value ?? '').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64');
  return bytes.length === KEY_BYTES ? bytes : null;
}

/** The keys this server holds, read fresh on every call. Never logged. */
export function bridgeKeysFromEnv(): BridgeKeys {
  const keys = new Map<number, Buffer>();
  const settings: Record<string, string> = {
    PASSKEY_BRIDGE_KEY_V1: env.PASSKEY_BRIDGE_KEY_V1,
    PASSKEY_BRIDGE_KEY_V2: env.PASSKEY_BRIDGE_KEY_V2,
  };
  for (const [version, name] of KEY_SETTINGS) {
    const key = keyFromSetting(settings[name]);
    if (key) keys.set(version, key);
  }
  return keys;
}

/** The newest key version held, or null with no key. */
export function newestKeyVersion(keys: BridgeKeys): number | null {
  let newest: number | null = null;
  for (const version of keys.keys()) {
    if (newest === null || version > newest) newest = version;
  }
  return newest;
}

function aadOf(version: number, owner: BridgeSecretOwner): Buffer {
  return Buffer.from(`passkey-bridge:v${version}:${owner.userId}:${owner.factorId}`, 'utf8');
}

/** Seals `secret` with the newest key, or null with no key. */
export function sealBridgeSecret(
  secret: string,
  owner: BridgeSecretOwner,
  keys: BridgeKeys,
): SealedBridgeSecret | null {
  const version = newestKeyVersion(keys);
  const key = version === null ? undefined : keys.get(version);
  if (version === null || !key || !secret) return null;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadOf(version, owner));
  const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: `v${version}.${iv.toString('base64url')}.${body.toString('base64url')}.${tag.toString('base64url')}`,
    keyVersion: version,
  };
}

/**
 * Opens a stored secret, or null: a damaged or moved ciphertext, a prefix
 * that does not match the row's version, or a key this server does not hold.
 * Never throws.
 */
export function openBridgeSecret(
  stored: SealedBridgeSecret,
  owner: BridgeSecretOwner,
  keys: BridgeKeys,
): string | null {
  try {
    const m = STORED_RE.exec(stored.ciphertext);
    if (!m) return null;
    const version = Number(m[1]);
    if (version !== stored.keyVersion) return null;
    const key = keys.get(version);
    if (!key) return null;
    const iv = Buffer.from(m[2]!, 'base64url');
    const body = Buffer.from(m[3]!, 'base64url');
    const tag = Buffer.from(m[4]!, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aadOf(version, owner));
    decipher.setAuthTag(tag);
    const secret = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    return secret.length > 0 ? secret : null;
  } catch {
    return null;
  }
}

/** Whether a row sealed with `keyVersion` should be sealed again with a newer key. */
export function needsNewerKey(keyVersion: number, keys: BridgeKeys): boolean {
  const newest = newestKeyVersion(keys);
  return newest !== null && keyVersion < newest;
}
