import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert } from 'react-native';

import { api } from '../api';
import { createOrderStorefrontApi } from './api';
import type { SessionStore } from './session';
import { createSignOutOrderSubmissions } from './sign-out-hold';
import { ORDER_DRAFT_PREFIX, unsettledSubmissions } from './store';

/**
 * The phone storefront's services, wired to the app (phone ordering PO-4): the
 * six calls through the real api() (each with orgId and asUserId) and
 * AsyncStorage. No React and no auth context here, so the auth context's
 * sign-out can use it without an import cycle; the hooks are in runtime.ts.
 */

export const orderStorefrontApi = createOrderStorefrontApi((path, opts) => api(path, opts));

/** AsyncStorage as the session's store. */
export const orderStore: SessionStore = {
  getItem: (k) => AsyncStorage.getItem(k),
  setItem: (k, v) => AsyncStorage.setItem(k, v),
  removeItem: (k) => AsyncStorage.removeItem(k),
  getAllKeys: async () => [...(await AsyncStorage.getAllKeys())],
  multiGet: async (keys) => [...(await AsyncStorage.multiGet([...keys]))],
};

/** This account's sends not settled in this organization, read from the
 *  device (the Orders list banner). */
export async function unsettledSendsOnDevice(userId: string, orgId: string): Promise<number> {
  try {
    const prefix = `${ORDER_DRAFT_PREFIX}${userId}.${orgId}.`;
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(prefix));
    if (keys.length === 0) return 0;
    return unsettledSubmissions(await AsyncStorage.multiGet(keys), userId, orgId).length;
  } catch {
    return 0;
  }
}

/** The sign-out flow's order-request steps (sign-out-flow.ts), for one
 *  account: status reads, "Don't send it", the hold marker, the report. */
export function signOutOrderSubmissions(userId: string) {
  return createSignOutOrderSubmissions({
    userId,
    store: orderStore,
    calls: orderStorefrontApi,
    say: (message) =>
      new Promise<void>((resolve) => {
        Alert.alert(message, undefined, [{ text: 'OK', onPress: () => resolve() }], {
          cancelable: true,
          onDismiss: () => resolve(),
        });
      }),
  });
}
