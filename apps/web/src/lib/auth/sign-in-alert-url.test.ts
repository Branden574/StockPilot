import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The deployment's own "This was not me" link (part 3): written with the
 * service key, at this app's address, and checked with the same key. With no
 * key no link is written (the alert email then goes without the button) and
 * none verifies. Every id is made up; the signing value is a dull one under a
 * neutral name (src/test/secret-shaped-fixtures.guard.test.ts).
 */

const envState = vi.hoisted(() => {
  const SIGNING_INPUT = 'test-only-signing-input';
  return {
    NEXT_PUBLIC_APP_URL: 'https://app.example.test/',
    SUPABASE_SERVICE_ROLE_KEY: SIGNING_INPUT as string | undefined,
  };
});
vi.mock('@/lib/env', () => ({ env: envState }));
const INITIAL_ENV = { ...envState };

import { signSignInAlertLink } from './sign-in-alert-link';
import { SIGN_IN_ALERT_PATH, signInAlertLinkUrl, verifySignInAlertLink } from './sign-in-alert-url';

const ALERT = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const USER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-20T15:30:00Z');

beforeEach(() => {
  Object.assign(envState, INITIAL_ENV);
});

describe('signInAlertLinkUrl', () => {
  it('writes /sign-in-alert?a=<alert>&i=<day>&t=<tag> at the app address', () => {
    const url = signInAlertLinkUrl({ alertId: ALERT, userId: USER, now: NOW });
    const tag = signSignInAlertLink(INITIAL_ENV.SUPABASE_SERVICE_ROLE_KEY!, {
      alertId: ALERT,
      userId: USER,
      issuedDay: '20261120',
    });
    expect(SIGN_IN_ALERT_PATH).toBe('/sign-in-alert');
    expect(url).toBe(`https://app.example.test/sign-in-alert?a=${ALERT}&i=20261120&t=${tag}`);
    // The account is signed, never carried.
    expect(url).not.toContain(USER);
  });

  it('writes no link without a key, or for an id that is not one', () => {
    envState.SUPABASE_SERVICE_ROLE_KEY = undefined;
    expect(signInAlertLinkUrl({ alertId: ALERT, userId: USER, now: NOW })).toBeNull();
    envState.SUPABASE_SERVICE_ROLE_KEY = INITIAL_ENV.SUPABASE_SERVICE_ROLE_KEY;
    expect(signInAlertLinkUrl({ alertId: 'not-an-id', userId: USER, now: NOW })).toBeNull();
  });
});

describe('verifySignInAlertLink', () => {
  it('checks a link written here, with the same key', () => {
    const url = new URL(signInAlertLinkUrl({ alertId: ALERT, userId: USER, now: NOW })!);
    const args = {
      alertId: url.searchParams.get('a')!,
      issuedDay: url.searchParams.get('i')!,
      tag: url.searchParams.get('t')!,
      userId: USER,
      now: NOW,
    };
    expect(verifySignInAlertLink(args)).toBe('valid');
    envState.SUPABASE_SERVICE_ROLE_KEY = 'a-different-test-value';
    expect(verifySignInAlertLink(args)).toBe('invalid');
    envState.SUPABASE_SERVICE_ROLE_KEY = undefined;
    expect(verifySignInAlertLink(args)).toBe('invalid');
  });
});
