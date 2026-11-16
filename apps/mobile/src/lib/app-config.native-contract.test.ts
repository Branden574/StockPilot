import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import config from '../../app.config';
import { palette } from './theme';

const MOBILE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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

/**
 * The launch screen shows from the tap until the app's first frame. The first
 * frames are the loading animation's ground, palette('dark').paper, so the
 * launch screen must be that same colour with nothing visible on it: any other
 * colour is a visible step, and any visible image is a logo frame before the
 * animation. Its one image is a fully transparent pixel, there only so the
 * plugin writes the colour into the iOS storyboard. It is part of the binary,
 * so a mistake here waits for the next store build to be undone.
 */
describe('app.config.ts — the launch screen is the loading animation’s ground', () => {
  const entries = ((config.plugins ?? []) as unknown[]).filter(
    (p) => (Array.isArray(p) ? p[0] : p) === 'expo-splash-screen',
  );
  const props = (Array.isArray(entries[0]) ? entries[0][1] : undefined) as
    | Record<string, unknown>
    | undefined;

  /** The launch image's exact bytes: a 1x1 RGBA PNG, its one pixel (0, 0, 0, 0). */
  const CLEAR_PIXEL_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=';

  /** Every key in the plugin's props, nested ones (ios, android, dark) included. */
  function keysDeep(value: unknown, prefix = ''): string[] {
    if (value === null || typeof value !== 'object') return [];
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
      prefix + k,
      ...keysDeep(v, `${prefix}${k}.`),
    ]);
  }

  /** A PNG's size, colour type and unfiltered pixel bytes (8-bit RGBA only). */
  function decodeRgba8(png: Buffer): { width: number; height: number; rgba: number[] } {
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    let at = 8;
    let width = 0;
    let height = 0;
    const idat: Buffer[] = [];
    while (at < png.length) {
      const length = png.readUInt32BE(at);
      const type = png.toString('ascii', at + 4, at + 8);
      const data = png.subarray(at + 8, at + 8 + length);
      if (type === 'IHDR') {
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        expect([data[8], data[9], data[12]]).toEqual([8, 6, 0]); // 8-bit, RGBA, not interlaced
      }
      if (type === 'IDAT') idat.push(data);
      at += 12 + length;
    }
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * 4;
    const rgba: number[] = [];
    for (let y = 0; y < height; y++) {
      expect(raw[y * (stride + 1)]).toBe(0); // filter: none
      rgba.push(...raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    }
    return { width, height, rgba };
  }

  it('is configured once', () => {
    expect(entries).toHaveLength(1);
    expect(props).toBeDefined();
  });

  it('has the same colour as the loading animation’s ground', () => {
    expect(props?.backgroundColor).toBe(palette('dark').paper);
  });

  it('draws one fully transparent pixel, 1 point wide', () => {
    expect(props?.image).toBe('./assets/launch-clear.png');
    expect(props?.imageWidth).toBe(1);
    const png = readFileSync(path.join(MOBILE_ROOT, 'assets/launch-clear.png'));
    expect(png.toString('base64')).toBe(CLEAR_PIXEL_PNG_BASE64);
    const { width, height, rgba } = decodeRgba8(png);
    expect([width, height]).toEqual([1, 1]);
    expect(rgba).toEqual([0, 0, 0, 0]);
  });

  it('has no other image setting, in any mode or on any platform', () => {
    const imageKeys = keysDeep(props).filter((k) =>
      /image|drawable|icon|dpi|resize|fullscreen/i.test(k.split('.').pop() ?? ''),
    );
    expect(imageKeys).toEqual(['image', 'imageWidth']);
  });

  it('sets nothing else, so no dark, iOS or Android entry can bring a second colour or image', () => {
    expect(props).toEqual({
      image: './assets/launch-clear.png',
      imageWidth: 1,
      backgroundColor: palette('dark').paper,
    });
  });
});
