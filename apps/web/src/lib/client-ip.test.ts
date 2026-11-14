import { afterEach, describe, expect, it, vi } from 'vitest';

import { clientIpForRecord, clientIpFromHeaders, clientIpFromRequest } from './client-ip';

/**
 * The one rule for the caller's address (lib/client-ip.ts): x-forwarded-for
 * only on Vercel, where the platform sets it, else x-real-ip, else the
 * 'unknown' bucket. clientIpForRecord is the same rule for a stored record,
 * with null for anything that is not an IP literal.
 *
 * Addresses are from the documentation ranges (RFC 5737, RFC 3849).
 */

const bag = (values: Record<string, string>) => new Headers(values);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('clientIpFromHeaders / clientIpFromRequest', () => {
  it('on Vercel: the first x-forwarded-for hop', () => {
    vi.stubEnv('VERCEL', '1');
    const h = bag({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'x-real-ip': '198.51.100.2' });
    expect(clientIpFromHeaders(h)).toBe('203.0.113.7');
    expect(
      clientIpFromRequest(new Request('http://localhost/x', { headers: h })),
    ).toBe('203.0.113.7');
  });

  it('off Vercel: x-forwarded-for is not read; x-real-ip, else unknown', () => {
    vi.stubEnv('VERCEL', '');
    expect(
      clientIpFromHeaders(bag({ 'x-forwarded-for': '203.0.113.7', 'x-real-ip': '198.51.100.2' })),
    ).toBe('198.51.100.2');
    expect(clientIpFromHeaders(bag({ 'x-forwarded-for': '203.0.113.7' }))).toBe('unknown');
  });

  it('x-real-ip is trimmed', () => {
    vi.stubEnv('VERCEL', '');
    expect(clientIpFromHeaders(bag({ 'x-real-ip': ' 198.51.100.2 ' }))).toBe('198.51.100.2');
  });
});

describe('clientIpForRecord', () => {
  it('on Vercel: the first x-forwarded-for hop; an IPv6 literal is kept', () => {
    vi.stubEnv('VERCEL', '1');
    expect(clientIpForRecord(bag({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe(
      '203.0.113.7',
    );
    expect(clientIpForRecord(bag({ 'x-forwarded-for': '2001:db8::5' }))).toBe('2001:db8::5');
  });

  it('off Vercel: x-forwarded-for is not read', () => {
    vi.stubEnv('VERCEL', '');
    expect(clientIpForRecord(bag({ 'x-forwarded-for': '203.0.113.7' }))).toBeNull();
    expect(
      clientIpForRecord(bag({ 'x-forwarded-for': '203.0.113.7', 'x-real-ip': '198.51.100.2' })),
    ).toBe('198.51.100.2');
  });

  it('nothing to read, or a value that is not an IP literal: null', () => {
    vi.stubEnv('VERCEL', '1');
    expect(clientIpForRecord(bag({}))).toBeNull();
    expect(clientIpForRecord(bag({ 'x-forwarded-for': 'unknown' }))).toBeNull();
    expect(clientIpForRecord(bag({ 'x-real-ip': 'proxy.example.com' }))).toBeNull();
  });

  it('an IPv6 zone id is null (the inet column refuses it); an IPv4-mapped address is kept', () => {
    vi.stubEnv('VERCEL', '');
    expect(clientIpForRecord(bag({ 'x-real-ip': 'fe80::1%eth0' }))).toBeNull();
    expect(clientIpForRecord(bag({ 'x-real-ip': '::ffff:203.0.113.7' }))).toBe('::ffff:203.0.113.7');
  });
});
