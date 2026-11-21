import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The place and the keyed source hash of the security-events record
 * (lib/client-ip.ts clientPlaceFromHeaders, clientSourceHash).
 *
 *   - the place is read only on Vercel, the same trust rule as the address;
 *     a country is two capital letters, a city is percent-decoded, trimmed,
 *     free of control characters and at most 80 characters, else null;
 *   - the hash is HMAC-SHA256 of the address under a day key derived from
 *     CRON_SECRET: the same address on the same UTC day hashes the same,
 *     another day or another secret differs, no secret or no IP literal is
 *     null, and the hash never contains the address.
 *
 * Addresses are from the documentation ranges (RFC 5737, RFC 3849).
 */

const h = vi.hoisted(() => ({ env: { CRON_SECRET: 'test-cron-secret' } as { CRON_SECRET?: string } }));
vi.mock('@/lib/env', () => ({
  get env() {
    return h.env;
  },
}));

import { clientPlaceFromHeaders, clientSourceHash } from './client-ip';

const bag = (values: Record<string, string>) => new Headers(values);
const DAY = new Date('2026-11-21T10:15:00Z');
const SAME_DAY_LATER = new Date('2026-11-21T23:59:59Z');
const NEXT_DAY = new Date('2026-11-22T00:00:01Z');

beforeEach(() => {
  h.env = { CRON_SECRET: 'test-cron-secret' };
  vi.stubEnv('VERCEL', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('clientPlaceFromHeaders', () => {
  it('on Vercel: the country and the percent-decoded city', () => {
    expect(
      clientPlaceFromHeaders(
        bag({ 'x-vercel-ip-country': 'DE', 'x-vercel-ip-city': 'Frankfurt%20am%20Main' }),
      ),
    ).toEqual({ country: 'DE', city: 'Frankfurt am Main' });
    expect(
      clientPlaceFromHeaders(bag({ 'x-vercel-ip-country': 'BR', 'x-vercel-ip-city': 'S%C3%A3o%20Paulo' })),
    ).toEqual({ country: 'BR', city: 'São Paulo' });
  });

  it('off Vercel: no place, whatever the request sends', () => {
    vi.stubEnv('VERCEL', '');
    expect(
      clientPlaceFromHeaders(bag({ 'x-vercel-ip-country': 'DE', 'x-vercel-ip-city': 'Berlin' })),
    ).toEqual({ country: null, city: null });
  });

  it('no headers: no place', () => {
    expect(clientPlaceFromHeaders(bag({}))).toEqual({ country: null, city: null });
  });

  it.each([['de'], ['DEU'], ['D'], ['1A'], ['XX,YY'], ['']])(
    'a country that is not two capital letters (%j) is null; the city stays',
    (country) => {
      expect(
        clientPlaceFromHeaders(bag({ 'x-vercel-ip-country': country, 'x-vercel-ip-city': 'Berlin' })),
      ).toEqual({ country: null, city: 'Berlin' });
    },
  );

  it.each([
    ['malformed percent-encoding', '%E0%A4%A'],
    ['a lone percent sign', 'Berlin%'],
    ['only spaces', '%20%20'],
    ['a control character', 'Ber%0Alin'],
    ['a NUL', 'Ber%00lin'],
    ['DEL', 'Ber%7Flin'],
    ['a C1 control', 'Ber%C2%85lin'],
    ['a line separator', 'Ber%E2%80%A8lin'],
    ['a right-to-left override', '%E2%80%AEnilreB'],
    ['81 characters', 'a'.repeat(81)],
  ])('a city with %s is null; the country stays', (_what, city) => {
    expect(
      clientPlaceFromHeaders(bag({ 'x-vercel-ip-country': 'DE', 'x-vercel-ip-city': city })),
    ).toEqual({ country: 'DE', city: null });
  });

  it('a city is trimmed, and 80 characters (code points, as the database counts) is kept', () => {
    expect(clientPlaceFromHeaders(bag({ 'x-vercel-ip-city': '%20Leipzig%20' })).city).toBe('Leipzig');
    expect(clientPlaceFromHeaders(bag({ 'x-vercel-ip-city': 'a'.repeat(80) })).city).toBe(
      'a'.repeat(80),
    );
    // 80 characters outside the BMP: 160 UTF-16 units, still 80 characters.
    const wide = encodeURIComponent('\u{1D49C}'.repeat(80));
    expect(clientPlaceFromHeaders(bag({ 'x-vercel-ip-city': wide })).city).toBe(
      '\u{1D49C}'.repeat(80),
    );
  });
});

describe('clientSourceHash', () => {
  const at = (address: string) => bag({ 'x-forwarded-for': `${address}, 10.0.0.1` });

  it('is 32 hex, the documented construction', () => {
    const dayKey = createHmac('sha256', 'test-cron-secret')
      .update('security-events/source/v1/2026-11-21')
      .digest();
    const expected = createHmac('sha256', dayKey).update('203.0.113.7').digest('hex').slice(0, 32);
    const hash = clientSourceHash(at('203.0.113.7'), DAY);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).toBe(expected);
  });

  it('the same address on the same UTC day hashes the same', () => {
    expect(clientSourceHash(at('203.0.113.7'), DAY)).toBe(
      clientSourceHash(at('203.0.113.7'), SAME_DAY_LATER),
    );
  });

  it('another day, another address or another secret hashes differently', () => {
    const base = clientSourceHash(at('203.0.113.7'), DAY);
    expect(clientSourceHash(at('203.0.113.7'), NEXT_DAY)).not.toBe(base);
    expect(clientSourceHash(at('203.0.113.8'), DAY)).not.toBe(base);
    h.env = { CRON_SECRET: 'another-secret' };
    expect(clientSourceHash(at('203.0.113.7'), DAY)).not.toBe(base);
  });

  it('an IPv6 address hashes the same in either case', () => {
    expect(clientSourceHash(at('2001:DB8::5'), DAY)).toBe(clientSourceHash(at('2001:db8::5'), DAY));
  });

  it('never contains the address, in any form', () => {
    for (const address of ['203.0.113.7', '2001:db8::5']) {
      const hash = clientSourceHash(at(address), DAY)!;
      expect(hash).not.toContain(address);
      expect(hash).not.toContain(address.replace(/[.:]/g, ''));
      expect(hash).not.toContain(Buffer.from(address).toString('hex'));
    }
  });

  it('no secret: null', () => {
    h.env = { CRON_SECRET: '' };
    expect(clientSourceHash(at('203.0.113.7'), DAY)).toBeNull();
    h.env = {};
    expect(clientSourceHash(at('203.0.113.7'), DAY)).toBeNull();
  });

  it('no IP literal: null (the limiter bucket, a malformed header, a zone id)', () => {
    expect(clientSourceHash(bag({}), DAY)).toBeNull();
    expect(clientSourceHash(at('not-an-address'), DAY)).toBeNull();
    expect(clientSourceHash(at('fe80::1%eth0'), DAY)).toBeNull();
  });

  it('follows the address rule: off Vercel x-forwarded-for is not read', () => {
    vi.stubEnv('VERCEL', '');
    expect(clientSourceHash(at('203.0.113.7'), DAY)).toBeNull();
    expect(clientSourceHash(bag({ 'x-real-ip': '198.51.100.2' }), DAY)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('an invalid date: null, never a throw', () => {
    expect(clientSourceHash(at('203.0.113.7'), new Date('nope'))).toBeNull();
  });
});
