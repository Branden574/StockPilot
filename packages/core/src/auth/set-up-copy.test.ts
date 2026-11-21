import { describe, expect, it } from 'vitest';

import {
  AUTHENTICATOR_CHECK_RESULT_COPY,
  AUTHENTICATOR_CHECK_UNAVAILABLE_COPY,
  AUTHENTICATOR_SET_UP_HOLD_COPY,
  AUTHENTICATOR_SET_UP_OWED_COPY,
  AUTHENTICATOR_SET_UP_PAGE,
  AUTHENTICATOR_SET_UP_TITLE,
  AUTHENTICATOR_SET_UP_URL,
  authenticatorSetUpHoldBody,
} from './set-up-copy';

/** The set-up address and the words a member who must set up an authenticator first reads. */
describe('the set-up address', () => {
  it('is the security settings page with the enroll parameter', () => {
    expect(AUTHENTICATOR_SET_UP_PAGE).toBe('/dashboard/settings/security');
    expect(AUTHENTICATOR_SET_UP_URL).toBe('/dashboard/settings/security?enroll=1');
  });
});

describe('the set-up words', () => {
  it('the title and the refusal sentence', () => {
    expect(AUTHENTICATOR_SET_UP_TITLE).toBe('Set up an authenticator to continue');
    expect(AUTHENTICATOR_SET_UP_OWED_COPY).toBe(
      'Your organization requires an authenticator for your account. Set one up on the website, then try again.',
    );
  });

  it('the holding screen names the organization and who the policy asks', () => {
    expect(authenticatorSetUpHoldBody('Example Org', 'all_required')).toBe(
      'Example Org asks everyone to use an authenticator app. Set one up on the website, then come back to this app.',
    );
    expect(authenticatorSetUpHoldBody('Example Org', 'admins_required')).toBe(
      'Example Org asks owners and admins to use an authenticator app. Set one up on the website, then come back to this app.',
    );
  });

  it('with no usable name it says "Your organization"', () => {
    for (const name of [null, undefined, '', '   ']) {
      expect(authenticatorSetUpHoldBody(name, 'all_required')).toBe(
        'Your organization asks everyone to use an authenticator app. Set one up on the website, then come back to this app.',
      );
    }
    expect(authenticatorSetUpHoldBody('  Example Org  ', 'admins_required')).toMatch(
      /^Example Org asks /,
    );
  });

  it('the actions', () => {
    expect(AUTHENTICATOR_SET_UP_HOLD_COPY).toEqual({
      setUpOnWebsite: 'Set up on the website',
      setUpOnWebsiteHint: 'Opens the website',
      checkAgain: 'Check again',
      switchWorkspace: 'Switch workspace',
      unnamedWorkspace: 'Workspace',
      signOut: 'Sign out',
      deleteAccount: 'Delete my account',
    });
  });

  it('the could-not-check screen: its own heading and a body that claims nothing about the member', () => {
    expect(AUTHENTICATOR_CHECK_UNAVAILABLE_COPY).toEqual({
      title: 'Your access could not be checked',
      body: 'Your access could not be checked just now. Try again in a moment.',
    });
    for (const s of Object.values(AUTHENTICATOR_CHECK_UNAVAILABLE_COPY)) {
      expect(s).not.toMatch(/set up|authenticator|changed/i);
    }
  });

  it('the line after Check again', () => {
    expect(AUTHENTICATOR_CHECK_RESULT_COPY).toEqual({
      checked: 'Checked just now.',
      noAnswer: 'Could not check. Try again.',
    });
  });

  it('say "authenticator", never MFA, 2FA, two-factor or multi-factor; no exclamation mark or emoji', () => {
    const all = [
      ...Object.values(AUTHENTICATOR_CHECK_UNAVAILABLE_COPY),
      ...Object.values(AUTHENTICATOR_CHECK_RESULT_COPY),
      AUTHENTICATOR_SET_UP_TITLE,
      AUTHENTICATOR_SET_UP_OWED_COPY,
      authenticatorSetUpHoldBody('Example Org', 'all_required'),
      authenticatorSetUpHoldBody(null, 'admins_required'),
      ...Object.values(AUTHENTICATOR_SET_UP_HOLD_COPY),
    ];
    for (const s of all) {
      expect(s).not.toMatch(/\bMFA\b|\b2FA\b|two-factor|multi-factor/i);
      expect(s).not.toContain('!');
      expect(s).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});
