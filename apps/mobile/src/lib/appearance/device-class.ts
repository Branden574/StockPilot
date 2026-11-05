import * as Device from 'expo-device';

import { isLowEndDevice } from './material';

/**
 * This phone's class for the low-end fallback (revision R9), read once:
 * expo-device (~57.0.2) is already in every shipped binary, and its year
 * class and memory never change while the app runs.
 */
let lowEnd: boolean | null = null;

export function isThisDeviceLowEnd(): boolean {
  if (lowEnd === null) {
    try {
      lowEnd = isLowEndDevice({
        yearClass: Device.deviceYearClass ?? null,
        totalMemory: Device.totalMemory ?? null,
      });
    } catch {
      lowEnd = false;
    }
  }
  return lowEnd;
}
