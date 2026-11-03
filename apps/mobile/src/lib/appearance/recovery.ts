import {
  APPEARANCE_AXES,
  recoveryAppearance,
  shownStyle,
  type AppearanceStyle,
  type DeviceAppearanceRecord,
  type GlassRollout,
} from '@stockpilot/core';

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
 * Always able to switch back (plan 5.6, revision R13, item 39). These run
 * from the error boundary, which must keep working when the appearance layer
 * is what threw, so they talk to storage directly and depend on nothing in
 * the provider.
 */

/**
 * Liquid Glass is shown, so the way back is offered. `drawnNow` is the live
 * controller's answer when it still has one (it knows about this launch's
 * crash fallback and a held adoption); otherwise the stored Design is read
 * through the rollout, exactly as the controller would draw it: under
 * 'default' a phone that never chose a Design is in Liquid Glass too.
 */
export async function isGlassShown(
  storage: AppearanceStorage,
  rollout: GlassRollout,
  now: number,
  drawnNow: AppearanceStyle | null = null,
): Promise<boolean> {
  if (drawnNow !== null) return drawnNow === 'liquid-glass';
  if (rollout === 'off') return false;
  const device = await readDeviceRecord(storage, now);
  return shownStyle(device?.style ?? null, rollout, false) === 'liquid-glass';
}

/**
 * A render crash was caught while Liquid Glass is shown: owe the next launch
 * one classic start (the controller reads and clears the flag before its
 * first paint and the notice says so). Nothing the person chose is changed,
 * so a passing fault never switches anyone's appearance for good. Returns
 * whether the flag was set.
 */
export async function markCrashFallback(
  storage: AppearanceStorage,
  rollout: GlassRollout,
  now: number,
  drawnNow: AppearanceStyle | null = null,
): Promise<boolean> {
  if (!(await isGlassShown(storage, rollout, now, drawnNow))) return false;
  await setFallbackFlag(storage);
  return true;
}

/**
 * "Use classic design": the Design becomes Classic and the Theme is left as
 * it is (core recoveryAppearance; there is no "previous classic look" any
 * more). The account sync record, if this phone has one for a signed-in
 * person, gets the Design marked unsaved so it is saved to the account after
 * the reload, and the crash-fallback flag is cleared (the person has answered
 * it). Only the three appearance keys involved are written.
 */
export async function recoverToClassicInStorage(
  storage: AppearanceStorage,
  now: number,
): Promise<void> {
  const device = await readDeviceRecord(storage, now);
  const record: DeviceAppearanceRecord = { v: 2, ...recoveryAppearance() };
  if (device?.theme !== undefined) record.theme = device.theme;
  await writeDeviceRecord(storage, record);
  const sync = await readSyncRecord(storage);
  if (sync) {
    const dirtyAxes = APPEARANCE_AXES.filter(
      (axis) => axis === 'style' || sync.dirtyAxes.includes(axis),
    );
    await writeSyncRecord(storage, { ...sync, dirtyAxes });
  }
  await clearFallbackFlag(storage);
}
