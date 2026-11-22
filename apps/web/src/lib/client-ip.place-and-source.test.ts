import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The place and the keyed source hash of the security-events record
 * (lib/client-ip.ts clientPlaceFromHeaders, clientSourceHash).
 *
 *   - the place is read only on Vercel, the same trust rule as the address;
 *     a country is two capital letters, a city is percent-decoded, trimmed,
 *     free of control characters and at most 80 characters, else null;
 *   - the hash is HMAC-SHA256 of the source under a day key derived from
 *     CRON_SECRET: the same source on the same UTC day hashes the same,
 *     another day or another secret differs, no secret or no IP literal is
 *     null, and the hash never contains the address;
 *   - the source is the whole address for IPv4 (an IPv4-mapped IPv6 address
 *     is its IPv4 address) and the first 64 bits for IPv6, whatever way the
 *     address is written; an address that does not parse gives no hash.
 *
 * Addresses are from the documentation ranges (RFC 5737, RFC 3849).
 */

const h = vi.hoisted(() => ({ env: { CRON_SECRET: 'test-cron-secret' } as { CRON_SECRET?: string } }));
vi.mock('@/lib/env', () => ({
  get env() {
    return h.env;
  },
}));

import { clientPlaceFromHeaders, clientSourceHash, placeOnlyHeaders } from './client-ip';

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

  describe('IPv6: one source is the first 64 bits (a customer\u2019s /64), not one address', () => {
    const base = () => clientSourceHash(at('2001:db8:1:2::1'), DAY);

    it('is the documented construction over the /64', () => {
      const dayKey = createHmac('sha256', 'test-cron-secret')
        .update('security-events/source/v1/2026-11-21')
        .digest();
      const expected = createHmac('sha256', dayKey).update('2001:db8:1:2::/64').digest('hex').slice(0, 32);
      expect(base()).toBe(expected);
    });

    it.each([
      ['another address of the same /64', '2001:db8:1:2::2'],
      ['every later bit different', '2001:db8:1:2:aaaa:bbbb:cccc:dddd'],
      ['written in full, with leading zeros', '2001:0db8:0001:0002:0000:0000:0000:0001'],
      ['capital letters', '2001:DB8:1:2::ABCD'],
      ['zero compression after the prefix', '2001:db8:1:2::'],
      ['zero compression in the middle', '2001:db8:1:2:0:5::9'],
      ['in brackets', '[2001:db8:1:2::7]'],
      ['in brackets with a port', '[2001:db8:1:2::7]:443'],
      ['with a zone id', '2001:db8:1:2::7%eth0'],
      ['in brackets with a zone id', '[2001:db8:1:2::7%25eth0]'],
      ['an embedded dotted tail', '2001:db8:1:2::192.0.2.33'],
    ])('%s hashes the same: %s', (_what, address) => {
      expect(clientSourceHash(at(address), DAY)).toBe(base());
    });

    it.each([
      ['the next /64', '2001:db8:1:3::1'],
      ['another site', '2001:db8:2:2::1'],
      ['the 64th bit differs', '2001:db8:1:8002::1'],
    ])('%s hashes differently: %s', (_what, address) => {
      const hash = clientSourceHash(at(address), DAY);
      expect(hash).toMatch(/^[0-9a-f]{32}$/);
      expect(hash).not.toBe(base());
    });

    it('zero compression is expanded where it stands', () => {
      // 2001:db8::1 is 2001:db8:0:0:0:0:0:1: the /64 2001:db8:0:0.
      const zero = clientSourceHash(at('2001:db8::1'), DAY);
      expect(clientSourceHash(at('2001:db8:0:0:5::9'), DAY)).toBe(zero);
      expect(clientSourceHash(at('2001:db8:0:0::'), DAY)).toBe(zero);
      expect(clientSourceHash(at('2001:db8::'), DAY)).toBe(zero);
      // 2001:db8::1:0:0:0:1 is 2001:db8:0:1:0:0:0:1: another /64.
      expect(clientSourceHash(at('2001:db8::1:0:0:0:1'), DAY)).not.toBe(zero);
      expect(clientSourceHash(at('2001:db8::1:0:0:0:1'), DAY)).toBe(
        clientSourceHash(at('2001:db8:0:1::9'), DAY),
      );
      // A compression that stands for one group only.
      expect(clientSourceHash(at('2001:db8:1::3:4:5:6'), DAY)).toBe(
        clientSourceHash(at('2001:db8:1:0:2::'), DAY),
      );
    });
  });

  describe('IPv4: the whole address', () => {
    it('two addresses of one network are two sources', () => {
      expect(clientSourceHash(at('192.0.2.7'), DAY)).not.toBe(clientSourceHash(at('192.0.2.8'), DAY));
    });

    it.each([
      ['dotted', '::ffff:192.0.2.7'],
      ['in hex groups', '::ffff:c000:207'],
      ['capital letters', '::FFFF:192.0.2.7'],
      ['written in full', '0:0:0:0:0:ffff:192.0.2.7'],
      ['in brackets', '[::ffff:192.0.2.7]'],
    ])('an IPv4-mapped IPv6 address (%s) is its IPv4 address: %s', (_what, address) => {
      expect(clientSourceHash(at(address), DAY)).toBe(clientSourceHash(at('192.0.2.7'), DAY));
    });

    it('a mapped address is not hashed as a /64 (which every mapped address would share)', () => {
      expect(clientSourceHash(at('::ffff:192.0.2.7'), DAY)).not.toBe(
        clientSourceHash(at('::ffff:198.51.100.7'), DAY),
      );
    });
  });

  it.each([
    ['three colons', '2001:db8:::1'],
    ['two compressions', '2001:db8::1::2'],
    ['nine groups', '2001:db8:1:2:3:4:5:6:7'],
    ['a compression that stands for no group', '2001:db8:1::2:3:4:5:6'],
    ['a leading zero in an IPv4 number', '192.0.2.07'],
    ['seven groups and no compression', '2001:db8:1:2:3:4:5'],
    ['a group of five digits', '2001:db8:10000::1'],
    ['a letter that is not hex', '2001:db8:g::1'],
    ['an opening bracket alone', '[2001:db8::1'],
    ['a closing bracket alone', '2001:db8::1]'],
    ['brackets around nothing', '[]'],
    ['brackets and something that is not a port', '[2001:db8::1]x'],
    ['a zone id and no address', '%eth0'],
    ['an empty zone id', '2001:db8::1%'],
    ['a dotted tail out of range', '::ffff:192.0.2.256'],
    ['an IPv4 address out of range', '192.0.2.256'],
    ['an IPv4 address with a port', '192.0.2.7:8080'],
    ['an IPv4 address in brackets', '[192.0.2.7]'],
    ['three numbers', '192.0.2'],
    ['a name', 'gateway.example.com'],
  ])('an address that does not parse (%s) gives no hash: %j', (_what, address) => {
    expect(clientSourceHash(at(address), DAY)).toBeNull();
  });

  it('never contains the address, in any form', () => {
    for (const address of ['203.0.113.7', '2001:db8::5', '2001:db8:1:2::9']) {
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

  it('no IP literal: null (the limiter bucket, a malformed header)', () => {
    expect(clientSourceHash(bag({}), DAY)).toBeNull();
    expect(clientSourceHash(at('not-an-address'), DAY)).toBeNull();
    expect(clientSourceHash(at('unknown'), DAY)).toBeNull();
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

describe('placeOnlyHeaders (part 3, sign-in alerts)', () => {
  beforeEach(() => {
    vi.stubEnv('VERCEL', '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a place already read reads back the same through clientPlaceFromHeaders', () => {
    expect(clientPlaceFromHeaders(placeOnlyHeaders({ country: 'BR', city: 'São Paulo' }))).toEqual({
      country: 'BR',
      city: 'São Paulo',
    });
    expect(clientPlaceFromHeaders(placeOnlyHeaders({ country: 'MX', city: null }))).toEqual({
      country: 'MX',
      city: null,
    });
    expect(clientPlaceFromHeaders(placeOnlyHeaders({ country: null, city: null }))).toEqual({
      country: null,
      city: null,
    });
  });

  it('names no address, so there is no source hash, and nothing else', () => {
    const headers = placeOnlyHeaders({ country: 'MX', city: 'Tijuana' });
    expect(clientSourceHash(headers)).toBeNull();
    for (const name of ['x-forwarded-for', 'x-real-ip', 'user-agent', 'cookie']) {
      expect(headers.get(name)).toBeNull();
    }
  });

  it('off Vercel it reads as no place, like every other place there', () => {
    vi.stubEnv('VERCEL', '');
    expect(clientPlaceFromHeaders(placeOnlyHeaders({ country: 'MX', city: 'Tijuana' }))).toEqual({
      country: null,
      city: null,
    });
  });
});
