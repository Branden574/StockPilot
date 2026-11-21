import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    PASSKEY_LOCAL_ORIGINS: '',
    PASSKEY_BRIDGE_KEY_V1: '',
    PASSKEY_BRIDGE_KEY_V2: '',
  },
}));

import {
  keyFromSetting,
  needsNewerKey,
  newestKeyVersion,
  openBridgeSecret,
  sealBridgeSecret,
  type BridgeKeys,
} from './bridge-secret';
import {
  PRODUCTION_ORIGIN,
  PRODUCTION_RP_ID,
  relyingPartyFor,
  type RelyingPartyInput,
} from './passkey-relying-party';
import {
  authenticationResponseSchema,
  cleanTransports,
  passkeyNameSchema,
  registrationResponseSchema,
} from './passkey-response-schema';
import { base32Decode, totpAt, totpCodeFromBase32 } from './totp';

/**
 * The pure parts of the passkey second step (plan 2.2 to 2.5): the site, the
 * bridge secret's seal, the time-based code and the strict answer shapes.
 * Every key here is made up inside the test.
 */

const madeUpKey = () => randomBytes(32);
const OWNER = { userId: '00000000-0000-4000-8000-00000000a001', factorId: '00000000-0000-4000-8000-00000000f001' };
/** A dull base32 value (the RFC 6238 test key), under a neutral name. */
const SAMPLE_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('the relying party (plan 2.2, review 9.4)', () => {
  const base: RelyingPartyInput = {
    vercel: undefined,
    vercelEnv: undefined,
    supabaseUrl: 'http://127.0.0.1:54321',
    localOrigins: '',
  };

  it('production: the two constants, whatever else is set', () => {
    expect(
      relyingPartyFor({
        vercel: '1',
        vercelEnv: 'production',
        supabaseUrl: 'https://abcdefghijklmnop.supabase.co',
        localOrigins: 'http://localhost:4000',
      }),
    ).toEqual({ rpId: 'stockpilotusa.com', origins: ['https://stockpilotusa.com'] });
    expect(PRODUCTION_RP_ID).toBe('stockpilotusa.com');
    expect(PRODUCTION_ORIGIN).toBe('https://stockpilotusa.com');
  });

  it('a preview, vercel dev, or any deployed environment that is not production: none', () => {
    for (const vercelEnv of ['preview', 'development', undefined]) {
      expect(relyingPartyFor({ ...base, vercel: '1', vercelEnv })).toBeNull();
    }
    expect(relyingPartyFor({ ...base, vercelEnv: 'preview' })).toBeNull();
    expect(relyingPartyFor({ ...base, vercelEnv: 'production' })).toBeNull();
  });

  it('local: localhost only when the Supabase URL is loopback (a machine holding another project gets none)', () => {
    expect(relyingPartyFor(base)).toEqual({ rpId: 'localhost', origins: ['http://localhost:3000'] });
    expect(relyingPartyFor({ ...base, supabaseUrl: 'http://localhost:54321' })?.rpId).toBe('localhost');
    expect(relyingPartyFor({ ...base, supabaseUrl: 'http://[::1]:54321' })?.rpId).toBe('localhost');
    expect(relyingPartyFor({ ...base, supabaseUrl: 'https://abcdefghijklmnop.supabase.co' })).toBeNull();
    expect(relyingPartyFor({ ...base, supabaseUrl: 'not a url' })).toBeNull();
  });

  it('extra local origins only when every one is http://localhost:<port>; otherwise the setting is refused', () => {
    expect(relyingPartyFor({ ...base, localOrigins: 'http://localhost:3400, http://localhost:3001' })?.origins).toEqual([
      'http://localhost:3000',
      'http://localhost:3400',
      'http://localhost:3001',
    ]);
    for (const bad of [
      'https://localhost:3400',
      'http://localhost:3400,https://evil.example',
      'http://127.0.0.1:3400',
      'http://localhost',
      'http://localhost:3400/',
    ]) {
      expect(relyingPartyFor({ ...base, localOrigins: bad })?.origins, bad).toEqual(['http://localhost:3000']);
    }
  });

  it('no setting reaches the production branch: its source reads no process.env in that branch', () => {
    const src = readFileSync(path.join(__dirname, 'passkey-relying-party.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export function relyingPartyFor'), src.indexOf('/** This server'));
    expect(fn).not.toContain('process.env');
    expect(fn).toContain("return { rpId: PRODUCTION_RP_ID, origins: [PRODUCTION_ORIGIN] };");
    expect(src).toContain("export const PRODUCTION_RP_ID = 'stockpilotusa.com';");
    expect(src).toContain("export const PRODUCTION_ORIGIN = 'https://stockpilotusa.com';");
  });
});

describe('the bridge secret (plan 2.3, review finding 1)', () => {
  it('seals with the newest key and opens again for the same row', () => {
    const keys: BridgeKeys = new Map([[1, madeUpKey()]]);
    const sealed = sealBridgeSecret(SAMPLE_BASE32, OWNER, keys)!;
    expect(sealed.keyVersion).toBe(1);
    expect(sealed.ciphertext).toMatch(
      /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16,200}\.[A-Za-z0-9_-]{22}$/,
    );
    expect(sealed.ciphertext).not.toContain(SAMPLE_BASE32);
    expect(openBridgeSecret(sealed, OWNER, keys)).toBe(SAMPLE_BASE32);
  });

  it('a ciphertext moved to another account or factor does not open (AAD)', () => {
    const keys: BridgeKeys = new Map([[1, madeUpKey()]]);
    const sealed = sealBridgeSecret(SAMPLE_BASE32, OWNER, keys)!;
    expect(openBridgeSecret(sealed, { ...OWNER, userId: OWNER.factorId }, keys)).toBeNull();
    expect(openBridgeSecret(sealed, { ...OWNER, factorId: OWNER.userId }, keys)).toBeNull();
  });

  it('a wrong key, a missing version, a prefix that does not match the row, or damage: null, never a throw', () => {
    const k1 = madeUpKey();
    const sealed = sealBridgeSecret(SAMPLE_BASE32, OWNER, new Map([[1, k1]]))!;
    expect(openBridgeSecret(sealed, OWNER, new Map([[1, madeUpKey()]]))).toBeNull();
    expect(openBridgeSecret(sealed, OWNER, new Map([[2, k1]]))).toBeNull();
    expect(openBridgeSecret(sealed, OWNER, new Map())).toBeNull();
    expect(openBridgeSecret({ ...sealed, keyVersion: 2 }, OWNER, new Map([[1, k1], [2, k1]]))).toBeNull();
    const parts = sealed.ciphertext.split('.');
    const flipped = parts[2]!.startsWith('A') ? `B${parts[2]!.slice(1)}` : `A${parts[2]!.slice(1)}`;
    expect(
      openBridgeSecret({ ...sealed, ciphertext: [parts[0], parts[1], flipped, parts[3]].join('.') }, OWNER, new Map([[1, k1]])),
    ).toBeNull();
    for (const junk of ['', 'v1', 'v1.a.b.c', 'x'.repeat(300), `v1.${'A'.repeat(16)}.${'A'.repeat(43)}.${'A'.repeat(22)}`]) {
      expect(() => openBridgeSecret({ ciphertext: junk, keyVersion: 1 }, OWNER, new Map([[1, k1]]))).not.toThrow();
      expect(openBridgeSecret({ ciphertext: junk, keyVersion: 1 }, OWNER, new Map([[1, k1]]))).toBeNull();
    }
  });

  it('two versions are read at once; a row on the older one is due to be sealed again', () => {
    const k1 = madeUpKey();
    const k2 = madeUpKey();
    const old = sealBridgeSecret(SAMPLE_BASE32, OWNER, new Map([[1, k1]]))!;
    const both: BridgeKeys = new Map([[1, k1], [2, k2]]);
    expect(newestKeyVersion(both)).toBe(2);
    expect(openBridgeSecret(old, OWNER, both)).toBe(SAMPLE_BASE32);
    expect(needsNewerKey(old.keyVersion, both)).toBe(true);
    const again = sealBridgeSecret(SAMPLE_BASE32, OWNER, both)!;
    expect(again.keyVersion).toBe(2);
    expect(again.ciphertext.startsWith('v2.')).toBe(true);
    expect(needsNewerKey(again.keyVersion, both)).toBe(false);
  });

  it('no key: nothing is sealed', () => {
    expect(sealBridgeSecret(SAMPLE_BASE32, OWNER, new Map())).toBeNull();
    expect(newestKeyVersion(new Map())).toBeNull();
  });

  it('a key setting counts only as 32 bytes of base64', () => {
    expect(keyFromSetting(madeUpKey().toString('base64'))?.length).toBe(32);
    expect(keyFromSetting(randomBytes(16).toString('base64'))).toBeNull();
    expect(keyFromSetting('not base64 !')).toBeNull();
    expect(keyFromSetting('')).toBeNull();
    expect(keyFromSetting(undefined)).toBeNull();
  });
});

describe('the time-based code (RFC 6238, plan 2.5)', () => {
  const RFC_KEY = Buffer.from('12345678901234567890');
  it('the RFC 6238 appendix B vectors (SHA-1, 8 digits)', () => {
    const vectors: Array<[number, string]> = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [t, want] of vectors) expect(totpAt(RFC_KEY, t, 8), String(t)).toBe(want);
  });

  it('six digits, from the base32 form of the same key, and the next step', () => {
    expect(totpAt(RFC_KEY, 59)).toBe('287082');
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')).toEqual(RFC_KEY);
    expect(totpCodeFromBase32('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000)).toBe('287082');
    expect(totpCodeFromBase32('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000, 1)).toBe(
      totpAt(RFC_KEY, 89),
    );
  });

  it('a secret that does not decode gives no code', () => {
    expect(totpCodeFromBase32('not-base32!', Date.now())).toBeNull();
    expect(totpCodeFromBase32('', Date.now())).toBeNull();
  });
});

describe('the strict answer shapes (plan 2.4)', () => {
  const ID = 'A'.repeat(43);
  const auth = {
    id: ID,
    rawId: ID,
    type: 'public-key',
    response: { clientDataJSON: 'eyJ0', authenticatorData: 'AAAA', signature: 'MEUC', userHandle: 'dXNlcg' },
    clientExtensionResults: {},
    authenticatorAttachment: 'platform',
  };
  const reg = {
    id: ID,
    rawId: ID,
    type: 'public-key',
    response: {
      clientDataJSON: 'eyJ0',
      attestationObject: 'o2Nm',
      transports: ['internal', 'hybrid'],
      publicKeyAlgorithm: -7,
      publicKey: 'MFkw',
      authenticatorData: 'AAAA',
    },
    clientExtensionResults: { credProps: { rk: true } },
  };

  it('accepts what a browser sends', () => {
    expect(authenticationResponseSchema.safeParse(auth).success).toBe(true);
    expect(registrationResponseSchema.safeParse(reg).success).toBe(true);
    const { userHandle: _drop, ...noHandle } = auth.response;
    expect(authenticationResponseSchema.safeParse({ ...auth, response: noHandle }).success).toBe(true);
  });

  it('refuses an unknown key at every level, and a case-variant duplicate', () => {
    expect(authenticationResponseSchema.safeParse({ ...auth, extra: 1 }).success).toBe(false);
    expect(
      authenticationResponseSchema.safeParse({ ...auth, response: { ...auth.response, authenticatordata: 'AAAA' } })
        .success,
    ).toBe(false);
    expect(registrationResponseSchema.safeParse({ ...reg, response: { ...reg.response, AttestationObject: 'x' } }).success).toBe(false);
  });

  it('refuses padding, stray characters, other types and oversize values', () => {
    for (const bad of ['eyJ0=', 'ey J0', 'ey+J0', 'ey/J0', 123, null, 'A'.repeat(4097)]) {
      expect(
        authenticationResponseSchema.safeParse({ ...auth, response: { ...auth.response, clientDataJSON: bad } }).success,
        String(bad).slice(0, 12),
      ).toBe(false);
    }
    expect(authenticationResponseSchema.safeParse({ ...auth, type: 'Public-Key' }).success).toBe(false);
    expect(authenticationResponseSchema.safeParse({ ...auth, id: 'A'.repeat(21), rawId: 'A'.repeat(21) }).success).toBe(false);
    expect(authenticationResponseSchema.safeParse({ ...auth, authenticatorAttachment: 'other' }).success).toBe(false);
    expect(
      registrationResponseSchema.safeParse({ ...reg, response: { ...reg.response, publicKeyAlgorithm: '-7' } }).success,
    ).toBe(false);
  });

  it('a passkey name follows the table rule: no dot, no control character, 60 at most, trimmed', () => {
    expect(passkeyNameSchema.parse("  Work laptop (Sam's) - 2 ")).toBe("Work laptop (Sam's) - 2");
    // Runs of white space (a pasted line break, a tab) become one space.
    expect(passkeyNameSchema.parse('Front\n\tdesk')).toBe('Front desk');
    for (const bad of ['', '   ', 'stockpilotusa.com', 'a\u0007b', '<b>', 'x'.repeat(61), 'name\u200b']) {
      expect(passkeyNameSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('only the seven known transports are kept, each once', () => {
    expect(cleanTransports(['usb', 'internal', 'bogus', 'usb', 'hybrid'])).toEqual(['hybrid', 'internal', 'usb']);
    expect(cleanTransports(undefined)).toEqual([]);
  });
});
