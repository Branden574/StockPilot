import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

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
});
