import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/** Every sharp(...) call's arguments, the real sharp doing the work. */
const sharpCalls = vi.hoisted(() => [] as unknown[][]);
vi.mock('sharp', async (importOriginal) => {
  const real = (await importOriginal<{ default: (...a: unknown[]) => unknown }>()).default;
  const wrapped = Object.assign((...args: unknown[]) => {
    sharpCalls.push(args);
    return real(...args);
  }, real);
  return { default: wrapped };
});

import { sniffImage } from './image-signature';
import { EVIDENCE_THUMB_MAX_EDGE, reencodeWithoutMetadata } from './image-reencode';

/**
 * Security invariant (listed in scripts/security-test.sh).
 *
 * PRIVACY PIN (F1-4): a photo's EXIF, GPS location included, never survives
 * into what evidence stores. Real sharp, real bytes: each fixture carries a
 * GPS IFD and a camera make, and the assertion reads the OUTPUT's metadata
 * and bytes. An implementation that kept metadata (withMetadata / keepExif)
 * fails here, and so does one that dropped the orientation tag without
 * applying it (the portrait photo comes out on its side).
 */

const GPS = {
  IFD0: { Make: 'PinCam', Model: 'Privacy 1' },
  IFD3: {
    GPSLatitudeRef: 'N',
    GPSLatitude: '37/1 46/1 30/1',
    GPSLongitudeRef: 'W',
    GPSLongitude: '122/1 25/1 10/1',
  },
};

/** The GPS IFD pointer tag (0x8825) in either byte order. */
function hasGpsIfd(exif: Buffer | undefined): boolean {
  return (
    !!exif && (exif.includes(Buffer.from([0x25, 0x88])) || exif.includes(Buffer.from([0x88, 0x25])))
  );
}

async function fixture(
  format: 'jpeg' | 'png' | 'webp',
  opts: { orientation?: number } = {},
): Promise<Buffer> {
  let img = sharp({
    create: { width: 60, height: 30, channels: 3, background: { r: 10, g: 200, b: 60 } },
  });
  img = format === 'jpeg' ? img.jpeg() : format === 'png' ? img.png() : img.webp();
  img = img.withExif(GPS);
  if (opts.orientation) img = img.withMetadata({ orientation: opts.orientation });
  return img.toBuffer();
}

describe('reencodeWithoutMetadata', () => {
  it('the fixtures really carry GPS and a camera make (a vacuous test proves nothing)', async () => {
    for (const f of ['jpeg', 'png', 'webp'] as const) {
      const input = await fixture(f);
      const meta = await sharp(input).metadata();
      expect(hasGpsIfd(meta.exif), f).toBe(true);
      expect(input.includes(Buffer.from('PinCam')), f).toBe(true);
    }
  });

  it.each(['jpeg', 'png', 'webp'] as const)(
    '%s: the stored master has no EXIF, no GPS, no camera details',
    async (f) => {
      const out = await reencodeWithoutMetadata(new Uint8Array(await fixture(f)), f);
      expect(out).not.toBeNull();
      const master = Buffer.from(out!.master);
      const meta = await sharp(master).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(meta.iptc).toBeUndefined();
      expect(master.includes(Buffer.from('PinCam'))).toBe(false);
      expect(master.includes(Buffer.from('Exif\0\0'))).toBe(false);
    },
  );

  it.each(['jpeg', 'png', 'webp'] as const)(
    '%s: the master keeps its format, so the path extension stays true',
    async (f) => {
      const out = await reencodeWithoutMetadata(new Uint8Array(await fixture(f)), f);
      expect(sniffImage(out!.master)?.kind).toBe(f);
      expect(out!.contentType).toBe(`image/${f}`);
    },
  );

  it('applies the orientation to the pixels before dropping the tag (portrait stays portrait)', async () => {
    const input = await fixture('jpeg', { orientation: 6 });
    expect((await sharp(input).metadata()).orientation).toBe(6);
    const out = await reencodeWithoutMetadata(new Uint8Array(input), 'jpeg');
    const meta = await sharp(Buffer.from(out!.master)).metadata();
    expect(meta.orientation).toBeUndefined();
    expect([meta.width, meta.height]).toEqual([30, 60]);
    expect([out!.width, out!.height]).toEqual([30, 60]);
  });

  it('makes a WEBP thumbnail of the same picture, at most 400 px, with no EXIF either', async () => {
    const big = await sharp({
      create: { width: 1200, height: 900, channels: 3, background: '#123456' },
    })
      .jpeg()
      .withExif(GPS)
      .toBuffer();
    const out = await reencodeWithoutMetadata(new Uint8Array(big), 'jpeg');
    const meta = await sharp(Buffer.from(out!.thumb)).metadata();
    expect(meta.format).toBe('webp');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(EVIDENCE_THUMB_MAX_EDGE);
    expect(meta.exif).toBeUndefined();
    // A small photo is not blown up for its thumbnail.
    const small = await reencodeWithoutMetadata(new Uint8Array(await fixture('png')), 'png');
    const smallMeta = await sharp(Buffer.from(small!.thumb)).metadata();
    expect([smallMeta.width, smallMeta.height]).toEqual([60, 30]);
  });

  it('answers null for bytes that are not the image they claim to be', async () => {
    expect(
      await reencodeWithoutMetadata(new TextEncoder().encode('<html>not a photo</html>'), 'jpeg'),
    ).toBeNull();
    // A JPEG signature with nothing decodable after it.
    expect(
      await reencodeWithoutMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), 'jpeg'),
    ).toBeNull();
  });

  // ─── Options (maintenance, review 2026-09-27). Exception evidence passes
  // none, so its behaviour is pinned here too: the defaults did not move.

  it('maxInputPixels: refuses (null) an image of more pixels than asked, and takes one of exactly that many', async () => {
    const input = new Uint8Array(await fixture('webp')); // 60 x 30 = 1800 pixels
    expect(await reencodeWithoutMetadata(input, 'webp', { maxInputPixels: 1799 })).toBeNull();
    const at = await reencodeWithoutMetadata(input, 'webp', { maxInputPixels: 1800 });
    expect([at?.width, at?.height]).toEqual([60, 30]);
  });

  it('the pixel limit handed to sharp: 50e6 with no options (exception evidence too), else the one asked for', async () => {
    // 100e6 let a crafted 178 KB WEBP drive the decode to 1.78 GB.
    const input = new Uint8Array(await fixture('jpeg'));
    sharpCalls.length = 0;
    await reencodeWithoutMetadata(input, 'jpeg');
    expect(sharpCalls[0]![1]).toEqual({ limitInputPixels: 50_000_000 });
    sharpCalls.length = 0;
    await reencodeWithoutMetadata(input, 'jpeg', { maxInputPixels: 20_000_000 });
    expect(sharpCalls[0]![1]).toEqual({ limitInputPixels: 20_000_000 });
  });

  it.each(['jpeg', 'webp'] as const)(
    '%s: `quality` sets the master quality; the default is 90, byte for byte',
    async (f) => {
      // Photo-like (noise) so the quality shows in the size.
      const raw = Buffer.alloc(160 * 120 * 3);
      for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 7919) % 251;
      const src = await sharp(raw, { raw: { width: 160, height: 120, channels: 3 } })
        [f]({ quality: 95 })
        .toBuffer();
      const input = new Uint8Array(src);
      const byDefault = await reencodeWithoutMetadata(input, f);
      const at90 = await reencodeWithoutMetadata(input, f, { quality: 90 });
      const at75 = await reencodeWithoutMetadata(input, f, { quality: 75 });
      expect(Buffer.from(byDefault!.master).equals(Buffer.from(at90!.master))).toBe(true);
      expect(at75!.master.byteLength).toBeLessThan(at90!.master.byteLength);
      const meta = await sharp(Buffer.from(at75!.master)).metadata();
      expect(meta.format).toBe(f);
      expect(meta.exif).toBeUndefined();
    },
  );

  it('png ignores `quality` (lossless)', async () => {
    const input = new Uint8Array(await fixture('png'));
    const byDefault = await reencodeWithoutMetadata(input, 'png');
    const at10 = await reencodeWithoutMetadata(input, 'png', { quality: 10 });
    expect(Buffer.from(byDefault!.master).equals(Buffer.from(at10!.master))).toBe(true);
  });
});
