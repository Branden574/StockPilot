import type { ClassicAppearanceMode } from '@stockpilot/core';

import {
  clearFallbackFlag,
  readDeviceRecord,
  readSyncRecord,
  setFallbackFlag,
  writeDeviceRecord,
  writeSyncRecord,
  type AppearanceStorage,
} from './store';

/**
 * Always able to switch back (plan 5.6). These run from the error boundary,
 * which must keep working when the appearance layer is what threw, so they
 * talk to storage directly and depend on nothing in the provider.
 */

/** Liquid Glass is the stored choice (and this build can show it). */
export async function isGlassStored(
  storage: AppearanceStorage,
  glassEnabled: boolean,
): Promise<boolean> {
  if (!glassEnabled) return false;
  const device = await readDeviceRecord(storage);
  return device?.mode === 'liquid-glass';
}

/**
 * A render crash was caught while Liquid Glass is the stored choice: owe the
 * next launch one classic start (the provider reads and clears the flag before
 * its first paint and shows the notice). The stored choice is NOT changed, so a
 * passing fault never switches anyone's appearance for good. Returns whether
 * the flag was set.
 */
export async function markCrashFallback(
  storage: AppearanceStorage,
  glassEnabled: boolean,
): Promise<boolean> {
  if (!(await isGlassStored(storage, glassEnabled))) return false;
  await setFallbackFlag(storage);
  return true;
}

/**
 * "Use classic appearance": the device goes back to the person's previous
 * classic choice (the record's lastClassic; System when there is none), the
 * account sync record (if this device has one for the signed-in person) is
 * marked dirty so the choice is saved to the account after the reload, and the
 * crash-fallback flag is cleared (the person has answered it). Only the three
 * appearance keys are written. Returns the classic mode now stored.
 */
export async function recoverToClassicInStorage(
  storage: AppearanceStorage,
): Promise<ClassicAppearanceMode> {
  const device = await readDeviceRecord(storage);
  const target: ClassicAppearanceMode = device?.lastClassic ?? 'system';
  await writeDeviceRecord(storage, { v: 1, mode: target, lastClassic: target });
  const sync = await readSyncRecord(storage);
  if (sync) await writeSyncRecord(storage, { ...sync, dirty: true });
  await clearFallbackFlag(storage);
  return target;
}
