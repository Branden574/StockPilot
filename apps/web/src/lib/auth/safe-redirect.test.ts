import { describe, expect, it } from 'vitest';

import { DEFAULT_APP_PATH, safeRedirectPath } from './safe-redirect';

describe('safeRedirectPath — same-origin paths are preserved', () => {
  it.each([
    '/dashboard',
    '/dashboard/inventory',
    '/dashboard/purchase-orders/imports',
    '/dashboard/inventory/staging?po=PO-000412',
    '/dashboard/settings/security?mfa=required',
    '/onboarding',
    '/',
  ])('keeps %s', (path) => {
    expect(safeRedirectPath(path)).toBe(path);
  });

  it('keeps a path containing a backslash after the first segment', () => {
    // Only the SECOND character can turn the value into an authority. A
    // backslash deeper in the path is just a path character.
    expect(safeRedirectPath('/dashboard/a\\b')).toBe('/dashboard/a\\b');
  });
});

describe('safeRedirectPath — off-origin destinations are refused', () => {
  it.each([
    ['scheme-relative', '//evil.com'],
    ['scheme-relative with path', '//evil.com/steal'],
    // REGRESSION GUARD. This is the exact vector that auth/callback/route.ts
    // documents as previously exploited, and that sign-in-form.tsx and
    // mfa-challenge-form.tsx both failed to block before they were consolidated
    // onto this helper. Chrome and `curl -L` treat it as protocol-relative.
    ['backslash scheme-relative', '/\\evil.com'],
    ['backslash scheme-relative with path', '/\\evil.com/steal'],
    ['absolute https', 'https://evil.com'],
    ['absolute http', 'http://evil.com'],
    ['protocol-less absolute', 'evil.com'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:text/html,<script>alert(1)</script>'],
    ['double backslash', '\\\\evil.com'],
    ['bare backslash', '\\evil.com'],
    ['relative path', 'dashboard'],
  ])('refuses %s', (_label, value) => {
    expect(safeRedirectPath(value)).toBe(DEFAULT_APP_PATH);
  });

  it.each([
    ['tab', '/\t/evil.com'],
    ['newline', '/\n/evil.com'],
    ['carriage return', '/\r/evil.com'],
    ['tab before backslash', '/\t\\evil.com'],
    ['split scheme', 'ht\ttp://evil.com'],
  ])('refuses %s injection that browsers normalise away', (_label, value) => {
    expect(safeRedirectPath(value)).toBe(DEFAULT_APP_PATH);
  });
});

describe('safeRedirectPath — absent values', () => {
  it.each([null, undefined, ''])('falls back for %p', (value) => {
    expect(safeRedirectPath(value)).toBe(DEFAULT_APP_PATH);
  });

  it('honours an explicit fallback', () => {
    expect(safeRedirectPath(null, '/signin')).toBe('/signin');
    expect(safeRedirectPath('//evil.com', '/signin')).toBe('/signin');
  });

  it('defaults to the canonical app entry', () => {
    expect(DEFAULT_APP_PATH).toBe('/dashboard');
  });
});
