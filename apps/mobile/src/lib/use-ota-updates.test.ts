import { describe, expect, it, vi } from 'vitest';

import { runStartupUpdate, type StartupUpdateDeps } from './use-ota-updates';

// The hook's real wiring reaches for native modules; runStartupUpdate takes
// everything it calls as deps, so these only keep the imports loadable.
vi.mock('expo-updates', () => ({ isEnabled: true }));
vi.mock('./notification-intent', () => ({ notificationIntents: { seenThisLaunch: () => false } }));
vi.mock('./push-open-diagnostics', () => ({ pushOpenDiag: vi.fn() }));

/**
 * The launch OTA reload (use-ota-updates.ts) restarts JavaScript, and with it
 * the pending notification tap AND native's record of it (expo-notifications
 * recreates its module on Updates.reloadAsync()). So a launch that took a tap
 * keeps its bundle: the fetched update applies on the next cold launch, and
 * nothing is persisted (owner decision 1).
 */

function deps(over: Partial<StartupUpdateDeps> = {}) {
  const d: StartupUpdateDeps = {
    isDev: false,
    isEnabled: true,
    checkForUpdateAsync: vi.fn(async () => ({ isAvailable: true })),
    fetchUpdateAsync: vi.fn(async () => ({})),
    reloadAsync: vi.fn(async () => {}),
    seenNotificationThisLaunch: vi.fn(() => false),
    isCancelled: () => false,
    diag: vi.fn(),
    ...over,
  };
  return d;
}

describe('runStartupUpdate', () => {
  it('an update and no notification tap: fetched, then reloaded once', async () => {
    const d = deps();
    await expect(runStartupUpdate(d)).resolves.toBe('reloaded');
    expect(d.fetchUpdateAsync).toHaveBeenCalledTimes(1);
    expect(d.reloadAsync).toHaveBeenCalledTimes(1);
    expect(d.diag).not.toHaveBeenCalled();
  });

  it('an update on a launch from a notification: fetched, NOT reloaded, and said', async () => {
    const d = deps({ seenNotificationThisLaunch: vi.fn(() => true) });
    await expect(runStartupUpdate(d)).resolves.toBe('deferred');
    expect(d.fetchUpdateAsync).toHaveBeenCalledTimes(1);
    expect(d.reloadAsync).not.toHaveBeenCalled();
    expect(d.diag).toHaveBeenCalledWith({ stage: 'ota-reload-deferred' });
  });

  it('a tap that arrives while the update downloads defers it too (read after the fetch)', async () => {
    let tapped = false;
    const d = deps({
      fetchUpdateAsync: vi.fn(async () => {
        tapped = true;
        return {};
      }),
      seenNotificationThisLaunch: vi.fn(() => tapped),
    });
    await expect(runStartupUpdate(d)).resolves.toBe('deferred');
    expect(d.reloadAsync).not.toHaveBeenCalled();
  });

  it('in development, or with updates off: nothing is called', async () => {
    for (const d of [deps({ isDev: true }), deps({ isEnabled: false })]) {
      await expect(runStartupUpdate(d)).resolves.toBe('skipped');
      expect(d.checkForUpdateAsync).not.toHaveBeenCalled();
      expect(d.fetchUpdateAsync).not.toHaveBeenCalled();
      expect(d.reloadAsync).not.toHaveBeenCalled();
    }
  });

  it('no update: nothing is fetched', async () => {
    const d = deps({ checkForUpdateAsync: vi.fn(async () => ({ isAvailable: false })) });
    await expect(runStartupUpdate(d)).resolves.toBe('up-to-date');
    expect(d.fetchUpdateAsync).not.toHaveBeenCalled();
  });

  it('unmounted meanwhile: stops', async () => {
    let cancelled = false;
    const d = deps({
      fetchUpdateAsync: vi.fn(async () => {
        cancelled = true;
        return {};
      }),
      isCancelled: () => cancelled,
    });
    await expect(runStartupUpdate(d)).resolves.toBe('cancelled');
    expect(d.reloadAsync).not.toHaveBeenCalled();
  });

  it('a failure is quiet: the default path applies the update next launch', async () => {
    const d = deps({
      checkForUpdateAsync: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    await expect(runStartupUpdate(d)).resolves.toBe('failed');
    expect(d.reloadAsync).not.toHaveBeenCalled();
  });
});
