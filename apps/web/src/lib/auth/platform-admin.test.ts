import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  currentUserIsPlatformAdminFromRequestHeader,
  isPlatformAdmin,
  mfaAssertionAgeFromToken,
} from './platform-admin';

/**
 * Mutable header bag driving the mocked `next/headers`. Each test sets the
 * exact headers "the middleware forwarded" — the mock never invents any.
 */
let requestHeaders: Headers;
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => requestHeaders),
}));

vi.mock('@/lib/env', () => ({
  env: {
    STOCKPILOT_PLATFORM_ADMIN_EMAILS: 'root@example.com,ops@example.com',
    NEXT_PUBLIC_SUPABASE_URL: 'https://test.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
  },
}));

/** Build a JWT-shaped string whose payload carries the given `amr` claim. */
function tokenWithAmr(amr: unknown): string {
  const payload = Buffer.from(JSON.stringify({ amr }), 'utf8').toString('base64url');
  return `header.${payload}.sig`;
}

describe('currentUserIsPlatformAdminFromRequestHeader (P1d link-visibility trust chain)', () => {
  beforeEach(() => {
    requestHeaders = new Headers();
  });

  it('returns true when the middleware-verified email header is allowlisted', async () => {
    requestHeaders.set('x-stockpilot-user-email', 'root@example.com');
    await expect(currentUserIsPlatformAdminFromRequestHeader()).resolves.toBe(true);
  });

  it('returns false for a non-allowlisted verified email', async () => {
    requestHeaders.set('x-stockpilot-user-email', 'member@example.com');
    await expect(currentUserIsPlatformAdminFromRequestHeader()).resolves.toBe(false);
  });

  it('fails closed when the header is absent (middleware deletes it for anon requests)', async () => {
    await expect(currentUserIsPlatformAdminFromRequestHeader()).resolves.toBe(false);
  });

  it('fails closed on an empty header value', async () => {
    requestHeaders.set('x-stockpilot-user-email', '');
    await expect(currentUserIsPlatformAdminFromRequestHeader()).resolves.toBe(false);
  });
});

describe('isPlatformAdmin allowlist matching', () => {
  it('matches case-insensitively after trimming', () => {
    expect(isPlatformAdmin('  Root@Example.com ')).toBe(true);
  });

  it('rejects null/undefined/non-members', () => {
    expect(isPlatformAdmin(null)).toBe(false);
    expect(isPlatformAdmin(undefined)).toBe(false);
    expect(isPlatformAdmin('evil@example.com')).toBe(false);
  });
});

describe('mfaAssertionAgeFromToken (#8 fresh platform step-up)', () => {
  const NOW = 1_700_000_000;

  it('returns the age since the latest totp assertion (ignores password)', () => {
    const t = tokenWithAmr([
      { method: 'password', timestamp: NOW - 3600 },
      { method: 'totp', timestamp: NOW - 120 },
    ]);
    expect(mfaAssertionAgeFromToken(t, NOW)).toBe(120);
  });

  it('uses the most recent of multiple MFA assertions', () => {
    const t = tokenWithAmr([
      { method: 'totp', timestamp: NOW - 600 },
      { method: 'totp', timestamp: NOW - 60 },
    ]);
    expect(mfaAssertionAgeFromToken(t, NOW)).toBe(60);
  });

  it('returns null when there is no second-factor assertion (password only)', () => {
    const t = tokenWithAmr([{ method: 'password', timestamp: NOW - 10 }]);
    expect(mfaAssertionAgeFromToken(t, NOW)).toBeNull();
  });

  it('returns null when amr is absent', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'x' }), 'utf8').toString('base64url');
    expect(mfaAssertionAgeFromToken(`h.${payload}.s`, NOW)).toBeNull();
  });

  it('returns null on a malformed token (fail-closed)', () => {
    expect(mfaAssertionAgeFromToken('not-a-jwt', NOW)).toBeNull();
    expect(mfaAssertionAgeFromToken('', NOW)).toBeNull();
  });
});
