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

import { IMAGE_VARIANTS } from './image-variants.config';
import { makeItemPhotoThumbnail } from './item-photo-thumbnail';

/**
 * The server-made thumbnail the backfill stores for a photo that has none
 * (B31). It must be the file the web uploader makes in the browser, the
 * longest edge 200 px with the aspect kept (the backfill used to crop every
 * photo to a 200 x 200 square), never enlarged, standing the way the photo is
 * shown, as WEBP with no metadata.
 */

async function photo(
  width: number,
  height: number,
  format: 'jpeg' | 'png' | 'webp' = 'jpeg',
  opts: { orientation?: number } = {},
): Promise<Uint8Array> {
  let img = sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } },
  });
  img = format === 'jpeg' ? img.jpeg() : format === 'png' ? img.png() : img.webp();
  img = img.withExif({ IFD0: { Make: 'TestCam' } });
  if (opts.orientation) img = img.withMetadata({ orientation: opts.orientation });
  return new Uint8Array(await img.toBuffer());
}

async function described(bytes: Uint8Array | null) {
  expect(bytes).not.toBeNull();
  const meta = await sharp(Buffer.from(bytes!)).metadata();
  return {
    format: meta.format,
    width: meta.width,
    height: meta.height,
    exif: meta.exif,
    orientation: meta.orientation,
  };
}

describe('makeItemPhotoThumbnail', () => {
  it('a landscape photo: 200 px wide, aspect kept (not a 200 x 200 crop), as WEBP', async () => {
    expect(await described(await makeItemPhotoThumbnail(await photo(1600, 1200)))).toMatchObject({
      format: 'webp',
      width: 200,
      height: 150,
    });
  });

  it('a portrait photo: 200 px tall', async () => {
    expect(await described(await makeItemPhotoThumbnail(await photo(1200, 1600)))).toMatchObject({
      width: 150,
      height: 200,
    });
  });

  it('a photo smaller than the thumbnail is never enlarged', async () => {
    expect(
      await described(await makeItemPhotoThumbnail(await photo(120, 80, 'png'))),
    ).toMatchObject({
      format: 'webp',
      width: 120,
      height: 80,
    });
  });

  it('applies the EXIF orientation, so a photo stored on its side stands upright, and keeps no metadata', async () => {
    // Stored 1600 x 1200 with orientation 6: a browser shows it 1200 x 1600.
    const input = await photo(1600, 1200, 'jpeg', { orientation: 6 });
    expect((await sharp(Buffer.from(input)).metadata()).orientation).toBe(6);
    const out = await described(await makeItemPhotoThumbnail(input));
    expect(out).toMatchObject({ width: 150, height: 200 });
    expect(out.exif).toBeUndefined();
    expect(out.orientation).toBeUndefined();
  });

  it('takes the size and quality from the shared config the web uploader uses', async () => {
    expect(IMAGE_VARIANTS.thumb).toEqual({ maxDimension: 200, quality: 0.8 });
    const input = await photo(800, 600, 'webp');
    const ours = await makeItemPhotoThumbnail(input);
    const atConfig = await sharp(Buffer.from(input))
      .rotate()
      .resize({ width: 200, height: 200, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    expect(Buffer.from(ours!).equals(atConfig)).toBe(true);
  });

  it('refuses a decode past 50 million pixels, from the header', async () => {
    sharpCalls.length = 0;
    await makeItemPhotoThumbnail(await photo(40, 30));
    const call = sharpCalls.find((args) => args[1] !== undefined);
    expect(call?.[1]).toEqual({ limitInputPixels: 50_000_000 });
  });

  it('answers null for bytes that are not an image', async () => {
    expect(
      await makeItemPhotoThumbnail(new TextEncoder().encode('<html>not a photo</html>')),
    ).toBeNull();
    expect(await makeItemPhotoThumbnail(new Uint8Array())).toBeNull();
  });
});
