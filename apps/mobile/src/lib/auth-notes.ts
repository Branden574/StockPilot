import Constants from 'expo-constants';
import * as Device from 'expo-device';

import { api } from './api';
import { getInstallId } from './install-id';

/**
 * The phone's sign-in and sign-out notes to the server (S5, plans/S5.md 3.3
 * step 6).
 *
 * The phone signs in and out against the Auth server directly, so no phone
 * sign-in or sign-out reached the Audit log, a new phone never sent the
 * new-device email the web sends, and a phone's Sign out did not tell the
 * account's other devices. Each note is one request through api(), bounded by
 * its timeout; a failure is only warned, and never holds a sign-in or a
 * sign-out.
 *
 * The device is named by its model (expo-device modelName), never by the name
 * a person gave the phone, which often carries their own name. The server
 * checks every field against an allowlist (POST /api/v1/auth/signed-in).
 */

export const SIGNED_IN_NOTE_TIMEOUT_MS = 8_000;
export const SIGNED_OUT_NOTE_TIMEOUT_MS = 6_000;

/** Right after a password sign-in: the Audit log row and the device note. */
export async function sendSignedInNote(): Promise<void> {
  try {
    const installId = await getInstallId();
    await api('/api/v1/auth/signed-in', {
      method: 'POST',
      body: {
        installId,
        device: {
          model: Device.modelName ?? null,
          osName: Device.osName ?? null,
          osVersion: Device.osVersion ?? null,
          appVersion: Constants.expoConfig?.version ?? null,
        },
      },
      timeoutMs: SIGNED_IN_NOTE_TIMEOUT_MS,
    });
  } catch (e) {
    console.warn('[auth] could not record this sign-in', e);
  }
}

/** Just before the session ends: the Audit log row, and the account's other
 *  devices signed out at once. */
export async function sendSignedOutNote(): Promise<void> {
  try {
    await api('/api/v1/auth/signed-out', {
      method: 'POST',
      body: {},
      timeoutMs: SIGNED_OUT_NOTE_TIMEOUT_MS,
    });
  } catch (e) {
    console.warn('[auth] could not record this sign-out', e);
  }
}
