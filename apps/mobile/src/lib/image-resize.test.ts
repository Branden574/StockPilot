/**
 * Pins the ONE property every mobile upload path depends on: whatever
 * `resizeForUpload` returns is web-decodable, and the extension it reports
 * describes the bytes it actually produced.
 *
 * Why this file exists: expo-image-picker 17 (SDK 56) flipped
 * `preferredAssetRepresentationMode`, so an iOS library pick now hands back
 * HEIC where it used to hand back JPEG. Every caller derives the stored
 * object's content-type from the returned `ext`, so an `ext` that disagreed
 * with the bytes would silently store a HEIC labelled `image/jpeg` — an
 * attachment no browser can render. That defect shipped on the support
 * screenshot path (which bypassed this helper entirely) and was found in
 * production on 2026-08-11.
 *
 * The assertions are deliberately about the CONTRACT (`ext` is always
 * web-safe; non-web-safe input is always transcoded), not about how many
 * times the manipulator happens to be called.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// expo-image-manipulator and react-native both reach for native modules at
// import time, so both are mocked — same reasoning storage-upload.test.ts
// documents for its own mocks.
const manipMock = vi.hoisted(() => ({
  manipulateAsync: vi.fn(),
  SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
}));
vi.mock('expo-image-manipulator', () => manipMock);

const rnMock = vi.hoisted(() => ({
  getSize: vi.fn(),
}));
vi.mock('react-native', () => ({ Image: rnMock }));

import { resizeForUpload } from './image-resize';

/** Drive Image.getSize's callback API with a fixed result. */
function stubDims(dims: { width: number; height: number } | null) {
  rnMock.getSize.mockImplementation(
    (_uri: string, ok: (w: number, h: number) => void, fail: () => void) => {
      if (dims) ok(dims.width, dims.height);
      else fail();
    },
  );
}

const WEB_SAFE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif'];

beforeEach(() => {
  vi.clearAllMocks();
  manipMock.manipulateAsync.mockResolvedValue({ uri: 'file:///cache/out.jpg' });
});

describe('resizeForUpload — the ext always describes the bytes', () => {
  it('a SMALL HEIC is transcoded to JPEG and reports ext jpg (the shipped defect)', async () => {
    // Small enough to hit the skip-the-resize fast path — the exact path the
    // support screenshot bug went through. "Small" must NOT mean "untouched"
    // for a format the web cannot decode.
    stubDims({ width: 800, height: 600 });
    const out = await resizeForUpload('file:///photos/IMG_0001.heic');
    expect(out.ext).toBe('jpg');
    expect(out.uri).toBe('file:///cache/out.jpg');
    expect(manipMock.manipulateAsync).toHaveBeenCalledTimes(1);
    // Transcode only — no resize op on the already-small image.
    expect(manipMock.manipulateAsync.mock.calls[0]?.[1]).toEqual([]);
    expect(manipMock.manipulateAsync.mock.calls[0]?.[2]).toMatchObject({ format: 'jpeg' });
  });

  it('a small HEIF (the other iOS variant) is transcoded too', async () => {
    stubDims({ width: 640, height: 480 });
    const out = await resizeForUpload('file:///photos/IMG_0002.heif');
    expect(out.ext).toBe('jpg');
    expect(manipMock.manipulateAsync).toHaveBeenCalledTimes(1);
  });

  it('a small JPEG is returned untouched — no needless re-encode', async () => {
    stubDims({ width: 800, height: 600 });
    const out = await resizeForUpload('file:///photos/IMG_0003.jpg');
    expect(out).toEqual({ uri: 'file:///photos/IMG_0003.jpg', ext: 'jpg' });
    expect(manipMock.manipulateAsync).not.toHaveBeenCalled();
  });

  it('normalises a small .jpeg to ext jpg so the stored key is consistent', async () => {
    stubDims({ width: 100, height: 100 });
    expect((await resizeForUpload('file:///photos/a.jpeg')).ext).toBe('jpg');
  });

  it('a small PNG keeps ext png (it is web-decodable; do not re-encode to jpg)', async () => {
    stubDims({ width: 300, height: 300 });
    const out = await resizeForUpload('file:///photos/shot.png');
    expect(out).toEqual({ uri: 'file:///photos/shot.png', ext: 'png' });
    expect(manipMock.manipulateAsync).not.toHaveBeenCalled();
  });

  it('an OVERSIZE HEIC is resized AND transcoded, reporting ext jpg', async () => {
    stubDims({ width: 4032, height: 3024 });
    const out = await resizeForUpload('file:///photos/IMG_0004.heic');
    expect(out.ext).toBe('jpg');
    const [, ops, opts] = manipMock.manipulateAsync.mock.calls[0] ?? [];
    // Longest edge clamped to the 1600 default, aspect preserved.
    expect(ops).toEqual([{ resize: { width: 1600, height: 1200 } }]);
    expect(opts).toMatchObject({ format: 'jpeg' });
  });

  it('when the dimension probe FAILS it still returns a web-safe jpg', async () => {
    // getSize failing is the documented HEIC-the-OS-will-not-decode case; the
    // fallback must not leak the undecodable original through.
    stubDims(null);
    const out = await resizeForUpload('file:///photos/IMG_0005.heic');
    expect(out.ext).toBe('jpg');
    expect(manipMock.manipulateAsync).toHaveBeenCalledTimes(1);
  });

  it('NEVER returns a non-web-safe ext, across every input shape', async () => {
    // The contract, swept: whatever goes in, what comes out is renderable.
    for (const [uri, dims] of [
      ['file:///a.heic', { width: 10, height: 10 }],
      ['file:///a.heif', { width: 9000, height: 100 }],
      ['file:///a.HEIC', null],
      ['file:///a.tiff', { width: 50, height: 50 }],
      ['file:///a.avif', { width: 5000, height: 5000 }],
      ['file:///noextension', { width: 20, height: 20 }],
    ] as const) {
      vi.clearAllMocks();
      manipMock.manipulateAsync.mockResolvedValue({ uri: 'file:///cache/out.jpg' });
      stubDims(dims);
      const out = await resizeForUpload(uri);
      expect(WEB_SAFE_EXTS, `${uri} produced a non-web-safe ext`).toContain(out.ext);
    }
  });
});
