import {
  APPEARANCE_AXES,
  recoveryAppearance,
  shownStyle,
  type AppearanceStyle,
  type DeviceAppearanceRecord,
  type GlassRollout,
} from '@stockpilot/core';

import type { AppearanceController } from './controller';
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

/** What "Use classic design" needs of the live controller, when one still answers. */
export type LiveAppearance = Pick<AppearanceController, 'chooseStyle' | 'settled'>;

/**
 * How long "Use classic design" waits for the account save before the reload.
 * A save usually answers in well under a second; past this (a captive portal,
 * a dead network) the reload goes ahead, and the phone still opens classic
 * from its own record.
 */
export const RECOVERY_SAVE_WAIT_MS = 3000;

/**
 * The error screen's "Use classic design", up to the reload (plan 5.6, R13).
 * Storage first, which works when the appearance layer is what threw. Then
 * the live controller, if it still answers, makes Classic an explicit choice
 * in this session: shown at once, saved to the account. The reload waits for
 * that save to answer (at most RECOVERY_SAVE_WAIT_MS), because the reload cuts
 * it, and after a reload the stored unsaved Design is checked against the row
 * first (SR1, round 2 finding 13): a Design saved on another device since
 * this phone last synced would win, and put the person back into the glass
 * that crashed. Offline the save cannot land: the phone still opens classic
 * from its record, and the Design stays unsaved, handled after the reload as
 * any choice whose save failed is (pushed when this phone has confirmed a
 * sync with the account, otherwise checked against the row once it can be
 * read). `wait` is the cap's timer (injectable for tests). Never throws.
 */
export async function recoverToClassic(
  storage: AppearanceStorage,
  now: number,
  live: LiveAppearance | null,
  wait?: (ms: number) => Promise<void>,
): Promise<void> {
  try {
    await recoverToClassicInStorage(storage, now);
  } catch {
    // Storage refused: the live controller below still has the choice.
  }
  if (live === null) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    live.chooseStyle('classic');
    const cap =
      wait?.(RECOVERY_SAVE_WAIT_MS) ??
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, RECOVERY_SAVE_WAIT_MS);
      });
    await Promise.race([live.settled(), cap]);
  } catch {
    // The stored choice is classic already; the reload reads it.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
