/**
 * The phone's screen for an account whose only second sign-in step is one the
 * app cannot take yet (a passkey: plan section 5). The phone knows that step
 * only by the reserved name of its factor (apps/mobile src/lib/mfa-level.ts),
 * which anyone could also give a factor at Supabase Auth directly, so these
 * words claim nothing about a passkey: they say the step cannot be used in the
 * app yet, and where to go. The security page is AUTHENTICATOR_SET_UP_PAGE
 * (./set-up-copy.ts).
 *
 * PURE: strings only, no platform imports.
 */
export const PASSKEY_ONLY_NOTICE_COPY = {
  title: "This sign-in step isn't in the app yet",
  body: "Your account's second sign-in step can't be used in the StockPilot app yet. It comes with the app's next version. To use the app now, add an authenticator app on the website, in Settings, Security. Recovery codes are used on the website.",
  openWebsite: 'Open Settings on the website',
  differentAccount: 'Use a different account',
} as const;
