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
  before:
    "Before you add one: use a passkey only on a device that only you unlock. Adding your first passkey signs you out on your other devices. The StockPilot phone app can't use passkeys yet: to keep using the app, keep or add an authenticator app too. Save your recovery codes: if you lose your passkey, a recovery code gets you back in, and it removes all your sign-in methods.",
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
  /** Decision A: the panel with only the list and Remove (the kill switch off). */
  turnedOff: 'Passkeys are turned off right now.',
  /** The same panel when the passkeys cannot work here now (no key, or the switch unreadable). */
  unavailable: 'Passkeys are not available right now.',
} as const;

