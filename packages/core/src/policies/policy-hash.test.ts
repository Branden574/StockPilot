import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  POLICY_TEXT_HASH_RE,
  policyHashInput,
  policyTextHash,
  sha256Hex,
  utf8Bytes,
} from './policy-hash';

const nodeSha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('SHA-256', () => {
  it('gives the published test vectors (FIPS 180-4 examples)', () => {
    expect(sha256Hex(utf8Bytes(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(utf8Bytes('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex(utf8Bytes('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(sha256Hex(utf8Bytes('a'.repeat(1000000)))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('agrees with Node for every length around the block edges', () => {
    for (let n = 0; n <= 200; n += 1) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 31 + n) & 0xff);
      expect(sha256Hex(b), String(n)).toBe(nodeSha(b));
    }
  });
});

describe('UTF-8', () => {
  it('writes every plane as TextEncoder does, a lone surrogate as U+FFFD', () => {
    const enc = new TextEncoder();
    for (const s of [
      '',
      'a',
      'é',
      'e\u0301',
      '€',
      '中文',
      '\u{1F600}',
      '\u{10FFFF}',
      'a\ud800b',
      '\udc00',
      'x\ud83d',
    ]) {
      expect(Array.from(utf8Bytes(s)), JSON.stringify(s)).toEqual(Array.from(enc.encode(s)));
    }
  });
});

describe('the hash of a version', () => {
  it('is SHA-256 of the title, two line feeds and the body, as 64 lower-case hex digits', () => {
    expect(policyHashInput('T', 'B')).toBe('T\n\nB');
    const title = 'Smoke policy';
    const body = '# Heading\nA line.\n\n- one\n- two';
    // The same value the database gave for this made-up version (0482, the dev loop's smoke run).
    expect(policyTextHash(title, body)).toBe(
      '12a02b3a7236cb1ea4d72b177819ae0b14d29ef9ed9ca567134a31a320e8ebe3',
    );
    expect(policyTextHash(title, body)).toBe(
      nodeSha(new TextEncoder().encode(`${title}\n\n${body}`)),
    );
    expect(policyTextHash(title, body)).toMatch(POLICY_TEXT_HASH_RE);
  });

  it('changes with any character of the title or the body', () => {
    const base = policyTextHash('Data handling', 'Keep only what the work needs.');
    expect(policyTextHash('Data handling.', 'Keep only what the work needs.')).not.toBe(base);
    expect(policyTextHash('Data handling', 'Keep only what the work needs')).not.toBe(base);
    expect(policyTextHash('Data handling\n\nKeep', 'only what the work needs.')).not.toBe(base);
  });

  it('agrees with Node for non-ASCII words', () => {
    const title = 'Política de datos — “borrador”';
    const body = '# Sección\nNiño, café, 中文, \u{1F600}.\n\n- uno';
    expect(policyTextHash(title, body)).toBe(
      nodeSha(new TextEncoder().encode(`${title}\n\n${body}`)),
    );
  });
});
