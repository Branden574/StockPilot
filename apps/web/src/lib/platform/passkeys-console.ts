/**
 * The platform console's passkey switches (part 2, plan 2.6 H): the words
 * the console and its actions share. No server import here, so the client
 * dialog and the server actions read the same typed word and sentences.
 *
 * Three switches, every one OFF until a platform admin turns it on:
 *   - passkeys_on (platform_settings): the kill switch, "Passkeys for everyone".
 *   - passkey_adds_on (platform_settings): "New passkeys" (review U6).
 *   - a row in organization_passkey_switches: one organization's switch.
 */

/** The word the operator types to confirm any passkey switch. Compared exactly. */
export const PASSKEYS_CONFIRM_WORD = 'PASSKEYS';

/** Which platform-wide setting a switch writes (the column, and the audit row's `setting`). */
export type PlatformPasskeySetting = 'passkeys_on' | 'passkey_adds_on';

export const PASSKEYS_COPY = {
  notAuthorized: 'Not authorized.',
  stepUp: 'Re-authenticate with MFA to change passkeys.',
  invalid: 'Invalid input.',
  wrongWord: `Type ${PASSKEYS_CONFIRM_WORD} to confirm.`,
  readFailed: 'Could not read the passkey switches, so nothing was changed. Try again.',
  writeFailed: 'Could not change the passkey switch, so nothing was changed. Try again.',
  orgNotFound: 'Organization not found.',
  orgReadFailed: 'Could not read the organization, so nothing was changed. Try again.',
  /** An ON whose audit row did not land, switched back off. */
  notRecordedLeftOff: {
    passkeys_on:
      'The change could not be recorded in the platform audit, so passkeys were left off. Try again.',
    passkey_adds_on:
      'The change could not be recorded in the platform audit, so new passkeys were left off. Try again.',
    organization:
      'The change could not be recorded in the platform audit, so passkeys were left off for this organization. Try again.',
  },
  /** An ON whose audit row did not land and whose switch-back failed too. */
  notRecordedMayBeOn:
    'The change could not be recorded in the platform audit, and the switch may still be on. Reload this page and turn it off if it is.',
  /** An OFF stands even when its audit row did not land; the operator is told. */
  offNotRecorded: 'It is off. The change could not be recorded in the platform audit.',
} as const;

/** What the console says after an organization's passkeys are turned off. */
export function membersStillHoldingWords(count: number | null): string {
  if (count === null) return 'Could not count the members who still hold passkeys.';
  if (count === 0) return 'No member of this organization holds a passkey.';
  if (count === 1) return '1 member still holds a passkey. It keeps working until it is removed.';
  return `${count} members still hold passkeys. They keep working until they are removed.`;
}

const ON_OFF = (v: boolean) => (v ? 'On' : 'Off');

/** The console's name for each platform-wide setting. */
export const PASSKEY_SETTING_LABEL: Record<PlatformPasskeySetting, string> = {
  passkeys_on: 'Passkeys for everyone',
  passkey_adds_on: 'New passkeys',
};

/**
 * The Platform audit's line under a passkey switch row: "Passkeys for
 * everyone: Off → On", "New passkeys: On → Off", or "Off → On" for an
 * organization's switch. Null for any other row, or a detail this build
 * cannot read, so nothing is guessed.
 */
export function passkeySwitchChangeOf(
  action: string,
  detail: Record<string, unknown>,
): string | null {
  const { from, to, setting } = detail;
  if (typeof from !== 'boolean' || typeof to !== 'boolean') return null;
  const change = `${ON_OFF(from)} → ${ON_OFF(to)}`;
  if (action === 'org_passkeys_switched') return change;
  if (action !== 'passkeys_switched') return null;
  if (setting !== 'passkeys_on' && setting !== 'passkey_adds_on') return null;
  return `${PASSKEY_SETTING_LABEL[setting]}: ${change}`;
}
