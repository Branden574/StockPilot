/**
 * The phone's screen for an account whose only second sign-in step is one the
 * app cannot take yet (a passkey: plan section 5). The phone knows that step
 * only by the reserved name of its factor (apps/mobile src/lib/mfa-level.ts),
 * which anyone could also give a factor at Supabase Auth directly, so these
 * words claim nothing about a passkey: they say the step cannot be used in the
 * app yet, and where to go, and they promise nothing about a later version.
 * The security page is AUTHENTICATOR_SET_UP_PAGE (./set-up-copy.ts); Check
 * again's result line is AUTHENTICATOR_CHECK_RESULT_COPY (same file).
 *
 * PURE: strings only, no platform imports.
 */
export const PASSKEY_ONLY_NOTICE_COPY = {
  title: "This sign-in step isn't in the app yet",
  body: "This account's second sign-in step can't be used in this app yet. To use the app now, add an authenticator app on the website, in Settings, Security. Recovery codes are used on the website.",
  openWebsite: 'Open Settings on the website',
  checkAgain: 'Check again',
  differentAccount: 'Use a different account',
} as const;
