/**
 * The Passkeys panel's words (plan section 4), in a plain module so the
 * Security page (a server component) can read them too.
 */
export const PASSKEYS_PANEL_WORDS = {
  description:
    "Confirm it's you with your face, fingerprint or device PIN instead of a 6-digit code. You still sign in with your password first.",
  atLimit: 'You can add up to 10 passkeys.',
  add: 'Add a passkey',
  phoneTitle: 'You use the StockPilot phone app',
  phoneBody:
    "The phone app can't use passkeys yet. After you add one, the phone app will stop working for you until its next version, unless you add an authenticator app first. Work saved on the phone waits until you can sign in there again.",
  phoneAppFirst: 'Add an authenticator app first',
  phoneTypeLabel: 'Type I understand to add a passkey anyway',
  /** The Add dialog's warnings before the proof (addPasskeyBeforeWords puts them together). */
  beforeDevice: 'Before you add one: use a passkey only on a device that only you unlock.',
  beforePhoneAndCodes:
    "The StockPilot phone app can't use passkeys yet: to keep using the app, keep or add an authenticator app too. Save your recovery codes: if you lose your passkey, a recovery code gets you back in, and it removes all your sign-in methods.",
  /**
   * Said only to a member with no other method (no verified factor: the Add's
   * proof is the password). Their first passkey raises this session, and Auth
   * then ends the account's other sessions, all of them aal1. A member with
   * an authenticator app is at aal2 to add one, and their other signed-in
   * sessions stay: nothing is said to them about other devices (the lab walk
   * of stage 4, finding 1).
   */
  beforeFirstSignsOut: 'Adding your first passkey signs you out on your other devices.',
  password: 'Enter your password',
  code: 'Enter the 6-digit code from your authenticator app',
  usePasskey: 'Use one of your passkeys',
  name: 'Name this passkey, for example Work laptop',
  done: 'Passkey added. Next time, use it after your password.',
  saveCodes: 'Save your recovery codes now.',
  savedCodes: 'I saved my recovery codes',
  deviceKept:
    "Your device may have kept the passkey it just made. You can remove it in your device's settings.",
  removeConfirm: 'Remove this passkey? You will be signed out on your other devices.',
  unfinished: 'Setup not finished',
  synced: 'Synced to your other devices',
  oneDevice: 'Only on the device that made it',
  notUsed: 'Not used yet',
  cancelled: 'No passkey was used. Try again when you are ready.',
  noSupport: "This browser can't use passkeys. Use another browser.",
  noAnswer: 'Could not reach StockPilot. Check your connection and try again.',
  stepUp: "Confirm it's you first. Sign out and sign in again with your second step.",
  /** Review 4 finding 4: the same words as the server's (passkeys.test.ts pins them equal). */
  onlyMethodUnfinished:
    "This passkey's setup isn't finished and it is your only second step, so it can't be removed yet. Add an authenticator app first, then remove it. Or use a recovery code, if you saved one: it removes every second step, passkeys included.",
  useRecoveryCode: 'Use a recovery code',
  recoveryTitle: 'Use a recovery code',
  recoveryBody:
    'Enter one of the recovery codes you saved and your password. The code is used up, and every second step of your account is removed, passkeys included. Then set up a new one.',
  recoveryMissing: 'Enter a recovery code and your password.',
  /** Decision A: the panel with only the list and Remove (the kill switch off). */
  turnedOff: 'Passkeys are turned off right now.',
  /** The same panel when the passkeys cannot work here now (no key, or the switch unreadable). */
  unavailable: 'Passkeys are not available right now.',
} as const;

/**
 * The Add dialog's warnings before the proof: the first-passkey sign-out only
 * for a member with no other method (PASSKEYS_PANEL_WORDS.beforeFirstSignsOut).
 */
export function addPasskeyBeforeWords(noOtherMethod: boolean): string {
  return [
    PASSKEYS_PANEL_WORDS.beforeDevice,
    ...(noOtherMethod ? [PASSKEYS_PANEL_WORDS.beforeFirstSignsOut] : []),
    PASSKEYS_PANEL_WORDS.beforePhoneAndCodes,
  ].join(' ');
}
