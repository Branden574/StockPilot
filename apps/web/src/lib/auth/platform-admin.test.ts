import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  currentUserIsPlatformAdminFromRequestHeader,
  isPlatformAdmin,
  mfaAssertionAgeFromAmr,
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

describe('mfaAssertionAgeFromAmr (#8 fresh platform step-up)', () => {
  const NOW = 1_700_000_000;

  it('returns the age since the latest totp assertion (ignores password)', () => {
    const amr = [
      { method: 'password', timestamp: NOW - 3600 },
      { method: 'totp', timestamp: NOW - 120 },
    ];
    expect(mfaAssertionAgeFromAmr(amr, NOW)).toBe(120);
  });

  it('uses the most recent of multiple MFA assertions', () => {
    const amr = [
      { method: 'totp', timestamp: NOW - 600 },
      { method: 'totp', timestamp: NOW - 60 },
    ];
    expect(mfaAssertionAgeFromAmr(amr, NOW)).toBe(60);
  });

  it('returns null when there is no second-factor assertion (password only)', () => {
    expect(mfaAssertionAgeFromAmr([{ method: 'password', timestamp: NOW - 10 }], NOW)).toBeNull();
  });

  it('returns null when amr is absent', () => {
    expect(mfaAssertionAgeFromAmr(undefined, NOW)).toBeNull();
  });

  it('returns null on a malformed claim (fail-closed)', () => {
    expect(mfaAssertionAgeFromAmr('totp', NOW)).toBeNull();
    // RFC 8176's bare-string form carries no timestamp, so no age.
    expect(mfaAssertionAgeFromAmr(['password', 'totp'], NOW)).toBeNull();
    expect(mfaAssertionAgeFromAmr([null, { method: 'totp', timestamp: 'x' }], NOW)).toBeNull();
  });
});
