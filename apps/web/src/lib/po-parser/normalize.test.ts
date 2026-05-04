import { describe, expect, it } from 'vitest';
import { normalizeUom, parseMoney, parseQty, sha256Hex } from './normalize';

describe('normalizeUom', () => {
  it('uppercases and trims', () => {
    expect(normalizeUom(' ea ')).toBe('EA');
    expect(normalizeUom('Pk')).toBe('PK');
  });
  it('returns null for empty/null', () => {
    expect(normalizeUom('')).toBeNull();
    expect(normalizeUom(null)).toBeNull();
    expect(normalizeUom(undefined)).toBeNull();
  });
});

describe('parseMoney', () => {
  it('strips $ , and parses', () => {
    expect(parseMoney('$1,234.56')).toBeCloseTo(1234.56);
    expect(parseMoney('299.53')).toBeCloseTo(299.53);
  });
  it('handles parens as negative (accounting style)', () => {
    expect(parseMoney('(50.00)')).toBeCloseTo(-50);
  });
  it('returns null for unparseable', () => {
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('N/A')).toBeNull();
    expect(parseMoney(null)).toBeNull();
  });
});

describe('parseQty', () => {
  it('parses integers and decimals', () => {
    expect(parseQty('1')).toBe(1);
    expect(parseQty('2.5')).toBe(2.5);
  });
  it('returns null for unparseable', () => {
    expect(parseQty('')).toBeNull();
    expect(parseQty('abc')).toBeNull();
  });
});

describe('sha256Hex', () => {
  it('returns deterministic 64-char hex for the same buffer', () => {
    const buf = new TextEncoder().encode('hello world');
    const h1 = sha256Hex(buf);
    const h2 = sha256Hex(buf);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});
