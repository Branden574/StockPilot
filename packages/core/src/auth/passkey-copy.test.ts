import { describe, expect, it } from 'vitest';

import { AUTHENTICATOR_SET_UP_PAGE, PASSKEY_ONLY_NOTICE_COPY } from '../index';

/**
 * The phone's screen for an account whose only second step it cannot take
 * yet (a passkey, plan section 5). The words claim nothing about a passkey,
 * so they stay true for a factor with the reserved bridge name that the
 * server never made (review finding 5), and they send the member to the
 * website's security page, where an authenticator app is added. They make
 * no promise about a later version (review 2-3 finding 11): plain, short
 * sentences that say what is true now and what to do.
 */
describe('PASSKEY_ONLY_NOTICE_COPY', () => {
  it('says the step cannot be used in the app yet, and where to go', () => {
    expect(PASSKEY_ONLY_NOTICE_COPY).toEqual({
      title: "This sign-in step isn't in the app yet",
      body: "This account's second sign-in step can't be used in this app yet. To use the app now, add an authenticator app on the website, in Settings, Security. Recovery codes are used on the website.",
      openWebsite: 'Open Settings on the website',
      checkAgain: 'Check again',
      differentAccount: 'Use a different account',
    });
  });

  it('makes no promise about a version or a date', () => {
    for (const words of Object.values(PASSKEY_ONLY_NOTICE_COPY)) {
      expect(words).not.toMatch(/version|update|soon|will|comes with/i);
    }
  });

  it('claims nothing about a passkey', () => {
    for (const words of Object.values(PASSKEY_ONLY_NOTICE_COPY)) {
      expect(words.toLowerCase()).not.toContain('passkey');
    }
  });

  it("opens the website's security page", () => {
    expect(AUTHENTICATOR_SET_UP_PAGE).toBe('/dashboard/settings/security');
  });
});
