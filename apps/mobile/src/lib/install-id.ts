import * as SecureStore from 'expo-secure-store';

import { randomRequestUuid } from '@stockpilot/core';

/**
 * This install's id: what tells one of a person's phones from another for the
 * new-device email (S5, plans/S5.md 3.3 step 5).
 *
 * The server keyed a device on its user agent with the version numbers taken
 * out (apps/web/src/lib/auth/login-device.ts), and every iPhone's app agent
 * then reads 'StockPilot/# CFNetwork/# Darwin/#': all of a person's phones were
 * one device, and a new phone never sent the email the web sends. The sign-in
 * note (auth-notes.ts) now sends this id, and the server hashes it with the
 * account.
 *
 * One random id per install, in the Keychain (readable after the first unlock,
 * so a note sent with the phone locked still has it). The app never clears it:
 * not at a sign-out, not at an account eviction (the Keychain is not
 * AsyncStorage's `workspace.` keys). When the Keychain refuses, there is no id:
 * no copy anywhere else (an id kept only in memory would differ at the next
 * launch, a new device each time), and the server falls back to the agent. A
 * refusal is not remembered: the next call tries again.
 */
export const INSTALL_ID_STORAGE_KEY = 'sp_install_id_v1';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let pending: Promise<string | null> | null = null;

/** This install's id, made on first use. Null when the Keychain refuses. */
export function getInstallId(): Promise<string | null> {
  if (!pending) {
    const read = readOrMake();
    pending = read;
    void read.then((id) => {
      if (id === null && pending === read) pending = null;
    });
  }
  return pending;
}

async function readOrMake(): Promise<string | null> {
  let stored: string | null;
  try {
    stored = await SecureStore.getItemAsync(INSTALL_ID_STORAGE_KEY);
  } catch (e) {
    console.warn('[install-id] the Keychain could not be read', e);
    return null;
  }
  if (stored && UUID.test(stored)) return stored;
  const id = randomRequestUuid();
  try {
    await SecureStore.setItemAsync(INSTALL_ID_STORAGE_KEY, id, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
  } catch (e) {
    console.warn('[install-id] the Keychain did not keep the id', e);
    return null;
  }
  return id;
}
