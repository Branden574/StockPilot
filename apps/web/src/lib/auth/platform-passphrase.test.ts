import { describe, expect, it } from 'vitest';

import { hashPassphrase, verifyPassphrase } from './platform-passphrase';

describe('platform-passphrase (org-deletion second factor)', () => {
  it('verifies the correct passphrase and rejects a wrong one', () => {
    const { hash, salt } = hashPassphrase('correct horse battery staple');
    expect(verifyPassphrase('correct horse battery staple', hash, salt)).toBe(true);
    expect(verifyPassphrase('wrong passphrase', hash, salt)).toBe(false);
  });

  it('uses a fresh salt per hash — same passphrase yields different hashes, both verify', () => {
    const a = hashPassphrase('same-secret');
    const b = hashPassphrase('same-secret');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    expect(verifyPassphrase('same-secret', a.hash, a.salt)).toBe(true);
    expect(verifyPassphrase('same-secret', b.hash, b.salt)).toBe(true);
  });

  it('returns false (never throws) for missing/malformed inputs', () => {
    expect(verifyPassphrase('x', null, null)).toBe(false);
    expect(verifyPassphrase('x', undefined, undefined)).toBe(false);
    expect(verifyPassphrase('', 'deadbeef', 'salt')).toBe(false);
    expect(verifyPassphrase('x', 'not-hex-zz', 'salt')).toBe(false);
  });

  it('normalizes unicode (NFKC) so equivalent forms of the same passphrase match', () => {
    // "café" as a single precomposed é vs. e + combining acute accent.
    const { hash, salt } = hashPassphrase('café');
    expect(verifyPassphrase('café', hash, salt)).toBe(true);
  });
});
