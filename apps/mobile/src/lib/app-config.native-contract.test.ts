import { describe, expect, it } from 'vitest';

import config from '../../app.config';

/**
 * THE PIN THAT DID NOT EXIST.
 *
 * A verifier deleted `LSApplicationQueriesSchemes: ['ms-outlook']`, the
 * Android plugin registration AND the plugin file itself, then ran the whole
 * mobile suite: 64 files / 1332 tests, all green, and `tsc --noEmit` exit 0.
 * Nothing failed — because vitest.config.ts scopes `include` to
 * ['src/**\/*.test.ts'], so app.config.ts and plugins/ are unreachable by any
 * test in the repo.
 *
 * That deletion IS the original bug. Without the scheme declaration
 * `Linking.canOpenURL('ms-outlook://...')` returns false even when Outlook is
 * installed, so the app decides Outlook is absent and falls back to the
 * browser — exactly the behaviour this feature exists to fix, reintroduced
 * silently and shipping green.
 *
 * app.config.ts is a plain TS module whose only expo import is type-only, so
 * it can be imported and asserted as DATA. These are value assertions, never
 * source-string containment: a grep over the config's text would pass against
 * a config that exports something else entirely.
 *
 * This is native config, so it lands at BUILD time. A regression here cannot
 * be repaired by an OTA — it needs a new binary. That asymmetry is why it is
 * worth pinning even though it is "just config".
 */
describe('app.config.ts — the native contract that no OTA can repair', () => {
  const ios = config.ios ?? {};
  const infoPlist = (ios.infoPlist ?? {}) as Record<string, unknown>;

  it('declares ms-outlook so canOpenURL can answer truthfully', () => {
    expect(infoPlist.LSApplicationQueriesSchemes).toEqual(
      expect.arrayContaining(['ms-outlook']),
    );
  });

  it('registers the Android queries plugin, the twin of the iOS declaration', () => {
    const plugins = (config.plugins ?? []) as unknown[];
    const names = plugins.map((p) => (Array.isArray(p) ? p[0] : p));
    expect(names).toContain('./plugins/with-android-outlook-queries.js');
  });

  /**
   * The infoPlist object is edited by hand and holds several unrelated,
   * load-bearing keys. Adding one by overwriting the object rather than
   * extending it would silently drop the others — and each loss is its own
   * outage: no camera prompt, no photo picker, no Face ID, a rejected App
   * Store submission. Pin them together so an overwrite fails here instead of
   * on a device.
   */
  it('keeps every pre-existing infoPlist key that a rewrite would silently drop', () => {
    expect(infoPlist.NSCameraUsageDescription).toEqual(expect.any(String));
    expect(infoPlist.NSPhotoLibraryUsageDescription).toEqual(expect.any(String));
    expect(infoPlist.NSFaceIDUsageDescription).toEqual(expect.any(String));
    expect(infoPlist.ITSAppUsesNonExemptEncryption).toBe(false);
  });

  it('keeps runtimeVersion on the appVersion policy, so an OTA cannot cross a native boundary', () => {
    expect(config.runtimeVersion).toEqual({ policy: 'appVersion' });
  });
});
