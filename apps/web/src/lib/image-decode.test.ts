import { deflateSync } from 'node:zlib';

import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

/** Every sharp(...) call's arguments, the real sharp doing the work. */
const sharpCalls = vi.hoisted(() => [] as unknown[][]);
vi.mock('sharp', async (importOriginal) => {
  const { recordingSharp } = await import('@/test/image-decode-fixtures');
  const real = (await importOriginal<{ default: (...a: never[]) => unknown }>()).default;
  return { default: recordingSharp(real, sharpCalls) };
});

import {
  EXIF_JPEGS,
  gifHeader,
  IMAGE_LOOKALIKE_SVGS,
  MALFORMED_PNGS,
  PNG_8X8,
  PNG_IEND,
  PNG_SIGNATURE,
  pngChunk,
  pngIhdr,
  pngWithOversizedData,
  SVG_16000,
  SVG_UNDER_A_WEBP_HEADER,
  WEBP_16383,
  WEBP_7072,
} from '@/test/image-decode-fixtures';

import {
  DECODE_MAX_INPUT_PIXELS,
  DECODE_TIMEOUT_SECONDS,
  DecodeRefused,
  jpegPassesUnchanged,
  pngFitInside,
  pngPassesUnchanged,
  readImageHeader,
  withCappedImage,
  type ImageKind,
} from './image-decode';
import { sniffImage } from './image-signature';

/**
 * The one capped image decoder for PDFs, exports, logos and the thumbnail
 * backfill: what it reads from a header, which bytes it hands to sharp and
 * with what limits, and which PNG and JPEG files it lets through unchanged.
 */

const ALL_KINDS: readonly ImageKind[] = ['png', 'jpeg', 'webp', 'gif', 'avif'];

function rgb(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } });
}

function rgba(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 0.5 } },
  });
}

/** sharp calls made with `input` as the image (the test's own calls make
 *  fixtures from `create` or raw pixels, or read results back). */
function callsWith(input: Uint8Array): unknown[][] {
  const bytes = Buffer.from(input);
  return sharpCalls.filter(
    ([first]) => first instanceof Uint8Array && Buffer.from(first).equals(bytes),
  );
}

async function headerAndMetadata(bytes: Buffer) {
  const header = readImageHeader(bytes);
  const meta = await sharp(bytes).metadata();
  return { header, meta: { format: meta.format, width: meta.width, height: meta.height } };
}

describe('readImageHeader', () => {
  it.each([
    ['WebP, lossy (VP8)', () => rgb(30, 20).webp({ quality: 80 }), 'VP8 '],
    ['WebP, lossless (VP8L)', () => rgb(31, 21).webp({ lossless: true }), 'VP8L'],
    ['WebP with alpha (VP8X)', () => rgba(33, 17).webp(), 'VP8X'],
    [
      'WebP with EXIF (VP8X)',
      () =>
        rgb(29, 23)
          .webp()
          .withExif({ IFD0: { Make: 'Test' } }),
      'VP8X',
    ],
  ] as const)('%s: kind and size agree with sharp', async (_label, make, fourcc) => {
    const bytes = await make().toBuffer();
    expect(bytes.toString('latin1', 12, 16)).toBe(fourcc);
    const { header, meta } = await headerAndMetadata(bytes);
    expect(header).toEqual({ kind: 'webp', width: meta.width, height: meta.height, heavy: false });
  });

  it('an animated WebP: the canvas size sharp reports for its first frame', async () => {
    const frame = (r: number) =>
      sharp({
        create: { width: 16, height: 12, channels: 4, background: { r, g: 0, b: 0, alpha: 1 } },
      })
        .png()
        .toBuffer();
    const bytes = await sharp([await frame(10), await frame(200)], { join: { animated: true } })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();
    expect(bytes.includes(Buffer.from('ANIM'))).toBe(true);
    const { header, meta } = await headerAndMetadata(bytes);
    expect(header).toEqual({ kind: 'webp', width: meta.width, height: meta.height, heavy: false });
  });

  it.each([
    ['PNG, RGBA', () => rgba(40, 30).png(), false],
    ['PNG, interlaced', () => rgba(40, 30).png({ progressive: true }), true],
    ['PNG, 16-bit', () => rgb(40, 30).toColourspace('rgb16').png(), false],
    ['PNG, palette', () => rgba(40, 30).png({ palette: true, colours: 16 }), false],
    ['PNG, grey', () => rgb(40, 30).toColourspace('b-w').png(), false],
  ] as const)('%s: kind and size agree with sharp', async (_label, make, heavy) => {
    const { header, meta } = await headerAndMetadata(await make().toBuffer());
    expect(meta.format).toBe('png');
    expect(header).toEqual({ kind: 'png', width: meta.width, height: meta.height, heavy });
  });

  it.each([
    ['JPEG, baseline', () => rgb(45, 35).jpeg(), false],
    ['JPEG, progressive', () => rgb(45, 35).jpeg({ progressive: true }), true],
    ['JPEG, mozjpeg (progressive)', () => rgb(45, 35).jpeg({ mozjpeg: true }), true],
  ] as const)(
    '%s: kind and size agree with sharp; only baseline is light',
    async (_label, make, heavy) => {
      const { header, meta } = await headerAndMetadata(await make().toBuffer());
      expect(header).toEqual({ kind: 'jpeg', width: meta.width, height: meta.height, heavy });
    },
  );

  it('GIF: kind and size agree with sharp, and it is heavy', async () => {
    const { header, meta } = await headerAndMetadata(await rgba(26, 14).gif().toBuffer());
    expect(header).toEqual({ kind: 'gif', width: meta.width, height: meta.height, heavy: true });
  });

  it('AVIF: the kind only (its size sits in a box tree sharp reads), and it is heavy', async () => {
    const bytes = await rgb(20, 10).avif({ effort: 0 }).toBuffer();
    expect(readImageHeader(bytes)).toEqual({
      kind: 'avif',
      width: null,
      height: null,
      heavy: true,
    });
  });

  it('reads the size of the 38-byte WebP headers without sharp', () => {
    sharpCalls.length = 0;
    expect(readImageHeader(WEBP_7072)).toEqual({
      kind: 'webp',
      width: 7072,
      height: 7072,
      heavy: false,
    });
    expect(readImageHeader(WEBP_16383)).toEqual({
      kind: 'webp',
      width: 16383,
      height: 16383,
      heavy: false,
    });
    expect(readImageHeader(gifHeader(4097, 4096))).toMatchObject({ width: 4097, height: 4096 });
    expect(sharpCalls).toEqual([]);
  });

  it('the AVIF-looking SVG strings are AVIF to the upload sniffer, and nothing to the decoder', () => {
    for (const [label, bytes] of Object.entries(IMAGE_LOOKALIKE_SVGS)) {
      expect(sniffImage(bytes)?.kind, label).toBe('avif');
      expect(readImageHeader(bytes), label).toBeNull();
    }
  });

  it('is null for SVG, TIFF, HEIC, BMP, text and truncated files', async () => {
    const tiff = await rgb(8, 8).tiff().toBuffer();
    const heic = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftypheic\0\0\0\0mif1heic', 'latin1'),
      Buffer.alloc(16),
    ]);
    const bmp = Buffer.concat([Buffer.from('BM', 'latin1'), Buffer.alloc(60)]);
    const jpeg = await rgb(8, 8).jpeg().toBuffer();
    const webp = await rgb(8, 8).webp().toBuffer();
    for (const [label, bytes] of Object.entries({
      svg: SVG_16000,
      tiff,
      heic,
      bmp,
      text: Buffer.from('not an image at all, just some words'),
      empty: Buffer.alloc(0),
      'png cut inside its IHDR': PNG_8X8.subarray(0, 20),
      'jpeg cut before its frame': jpeg.subarray(0, 12),
      'webp cut inside its first chunk': webp.subarray(0, 22),
      'gif cut inside its screen size': gifHeader(8, 8).subarray(0, 8),
    })) {
      expect(readImageHeader(bytes), label).toBeNull();
    }
  });

  it('is null for a PNG whose first chunk is not IHDR, or whose IHDR is not 13 bytes', () => {
    const notFirst = Buffer.concat([
      PNG_SIGNATURE,
      pngChunk('tEXt', Buffer.from('a\0b')),
      pngIhdr(8, 8),
      PNG_IEND,
    ]);
    const longIhdr = Buffer.concat([
      PNG_SIGNATURE,
      pngChunk('IHDR', Buffer.concat([PNG_8X8.subarray(16, 29), Buffer.from([0])])),
      PNG_IEND,
    ]);
    expect(readImageHeader(notFirst)).toBeNull();
    expect(readImageHeader(longIhdr)).toBeNull();
    expect(readImageHeader(PNG_8X8)).toEqual({ kind: 'png', width: 8, height: 8, heavy: false });
  });
});

describe('DECODE_MAX_INPUT_PIXELS', () => {
  it('50 million for PNG, JPEG and WebP; 4096 x 4096 for GIF and AVIF', () => {
    expect(DECODE_MAX_INPUT_PIXELS).toEqual({
      png: 50_000_000,
      jpeg: 50_000_000,
      webp: 50_000_000,
      gif: 16_777_216,
      avif: 16_777_216,
    });
    expect(DECODE_TIMEOUT_SECONDS).toBe(20);
  });
});

describe('withCappedImage', () => {
  const noop = async () => 'decoded';

  it('never calls sharp for bytes it refuses', async () => {
    const refused: Array<[string, Buffer, readonly ImageKind[], RegExp]> = [
      ['an SVG', SVG_16000, ALL_KINDS, /not a PNG, JPEG, WebP, GIF or AVIF image/],
      ['WebP over its cap', WEBP_7072, ALL_KINDS, /^webp 7072x7072 is over 50000000 pixels$/],
      [
        'WebP far over its cap',
        WEBP_16383,
        ALL_KINDS,
        /^webp 16383x16383 is over 50000000 pixels$/,
      ],
      ['GIF over its cap', gifHeader(4097, 4096), ALL_KINDS, /^gif 4097x4096 is over 16777216/],
      [
        'PNG over its cap',
        MALFORMED_PNGS['an IHDR of 16000 x 16000 over 16 bytes of data']!,
        ALL_KINDS,
        /^png 16000x16000 is over 50000000 pixels$/,
      ],
      ['a kind the caller does not read', PNG_8X8, ['webp', 'jpeg'], /^png is not read here$/],
      ...Object.entries(IMAGE_LOOKALIKE_SVGS).map(
        ([label, bytes]) =>
          [label, bytes, ALL_KINDS, /not a PNG/] as [string, Buffer, ImageKind[], RegExp],
      ),
    ];
    for (const [label, bytes, kinds, message] of refused) {
      sharpCalls.length = 0;
      const run = withCappedImage(bytes, kinds, noop);
      await expect(run, label).rejects.toBeInstanceOf(DecodeRefused);
      await expect(run, label).rejects.toThrow(message);
      expect(sharpCalls, label).toEqual([]);
    }
  });

  it('a RIFF/WEBP header over SVG text is never read as SVG', async () => {
    const run = withCappedImage(SVG_UNDER_A_WEBP_HEADER, ALL_KINDS, (img) => img.png().toBuffer());
    await expect(run).rejects.toThrow();
    await expect(run).rejects.not.toThrow(/svg|xml/i);
  });

  it('opens sharp with exactly the cap of the kind and the EXIF orientation applied', async () => {
    const inputs: Array<[ImageKind, Buffer]> = [
      ['png', await rgba(12, 10).png().toBuffer()],
      ['jpeg', await rgb(12, 10).jpeg().toBuffer()],
      ['webp', await rgb(12, 10).webp().toBuffer()],
      ['gif', await rgba(12, 10).gif().toBuffer()],
      ['avif', await rgb(12, 10).avif({ effort: 0 }).toBuffer()],
    ];
    for (const [kind, bytes] of inputs) {
      sharpCalls.length = 0;
      let timeoutSeconds: unknown;
      const out = await withCappedImage(bytes, ALL_KINDS, (img) => {
        timeoutSeconds = (img as unknown as { options: { timeoutSeconds: number } }).options
          .timeoutSeconds;
        return img.png().toBuffer();
      });
      const calls = callsWith(bytes);
      expect((await sharp(out).metadata()).format, kind).toBe('png');
      expect(calls, kind).toEqual([
        [expect.anything(), { limitInputPixels: DECODE_MAX_INPUT_PIXELS[kind], autoOrient: true }],
      ]);
      expect(timeoutSeconds, kind).toBe(20);
    }
  });

  it('AVIF: sharp refuses 4096 x 4097 from its header and converts 4096 x 4096', async () => {
    const over = await rgb(4096, 4097).avif({ effort: 0 }).toBuffer();
    await expect(withCappedImage(over, ['avif'], (img) => img.png().toBuffer())).rejects.toThrow(
      /Input image exceeds pixel limit/,
    );
    const at = await rgb(4096, 4096).avif({ effort: 0 }).toBuffer();
    const small = await withCappedImage(at, ['avif'], (img) =>
      img.resize({ width: 64, height: 64, fit: 'inside' }).png().toBuffer(),
    );
    const meta = await sharp(small).metadata();
    expect([meta.width, meta.height]).toEqual([64, 64]);
  }, 30_000);

  /** Starts one decode per input, each holding its slot until released, and
   *  reports how many ran at once. */
  async function concurrency(inputs: Buffer[], failFirst = false) {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    let done = 0;
    const runs = inputs.map((bytes, i) =>
      withCappedImage(bytes, ALL_KINDS, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        if (failFirst && i === 0) throw new Error('the first decode failed');
        return i;
      }).finally(() => {
        done += 1;
      }),
    );
    const settled = Promise.allSettled(runs);
    // Give every decode that may start the time to start.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const startedTogether = active;
    while (done < inputs.length) {
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return { peak, startedTogether, settled: (await settled).map((s) => s.status) };
  }

  it('runs heavy decodes (AVIF, GIF, interlaced PNG, progressive JPEG) one at a time', async () => {
    const heavy = [
      await rgb(8, 8).avif({ effort: 0 }).toBuffer(),
      await rgba(8, 8).gif().toBuffer(),
      await rgba(8, 8).png({ progressive: true }).toBuffer(),
      await rgb(8, 8).jpeg({ progressive: true }).toBuffer(),
    ];
    for (const bytes of heavy) expect(readImageHeader(bytes)?.heavy).toBe(true);
    const { peak, startedTogether } = await concurrency(heavy);
    expect(startedTogether).toBe(1);
    expect(peak).toBe(1);
  });

  it('runs light decodes (WebP, PNG, baseline JPEG) together', async () => {
    const light = [
      await rgb(8, 8).webp().toBuffer(),
      await rgba(8, 8).png().toBuffer(),
      await rgb(8, 8).jpeg().toBuffer(),
    ];
    const { peak } = await concurrency(light);
    expect(peak).toBe(3);
  });

  it('frees the slot after a failed heavy decode', async () => {
    const heavy = [
      await rgb(8, 8).avif({ effort: 0 }).toBuffer(),
      await rgba(8, 8).gif().toBuffer(),
    ];
    const { peak, settled } = await concurrency(heavy, true);
    expect(peak).toBe(1);
    expect(settled).toEqual(['rejected', 'fulfilled']);
  });
});

describe('pngFitInside', () => {
  it('fits inside the box, never enlarges, and keeps transparency', async () => {
    const wide = await sharp({
      create: { width: 1000, height: 250, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const out = await pngFitInside(wide, ['png'], 400);
    const meta = await sharp(out).metadata();
    expect([meta.format, meta.width, meta.height, meta.hasAlpha]).toEqual(['png', 400, 100, true]);
    const small = await sharp(await pngFitInside(PNG_8X8, ['png'], 400)).metadata();
    expect([small.width, small.height]).toEqual([8, 8]);
  });

  it('applies a JPEG’s EXIF orientation: a 600 x 400 photo stored with orientation 6 stands upright', async () => {
    const sideways = await rgb(600, 400).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    expect((await sharp(sideways).metadata()).orientation).toBe(6);
    const meta = await sharp(await pngFitInside(sideways, ['jpeg'], 400)).metadata();
    expect([meta.width, meta.height, meta.orientation]).toEqual([267, 400, undefined]);
  });
});

describe('pngPassesUnchanged', () => {
  const LIMITS = { maxEdgePx: 400, maxBytes: 1024 * 1024 };

  it.each([
    ['RGBA', () => rgba(40, 30).png()],
    ['palette, 1 bit with tRNS', () => rgba(40, 30).png({ palette: true, colours: 2 })],
    ['palette, 2 bits with tRNS', () => rgba(40, 30).png({ palette: true, colours: 4 })],
    ['palette, 4 bits with tRNS', () => rgba(40, 30).png({ palette: true, colours: 16 })],
    ['palette, 8 bits with tRNS', () => rgba(40, 30).png({ palette: true, colours: 256 })],
    ['16-bit', () => rgb(40, 30).toColourspace('rgb16').png()],
    ['grey', () => rgb(40, 30).toColourspace('b-w').png()],
    ['at the edge', () => rgba(400, 10).png()],
  ] as const)('a PNG made by sharp passes: %s', async (label, make) => {
    const bytes = await make().toBuffer();
    if (label.startsWith('palette')) expect(bytes.includes(Buffer.from('tRNS'))).toBe(true);
    expect(await pngPassesUnchanged(bytes, LIMITS)).toBe(true);
  });

  it('the PNG built from its chunks passes (the control for the cases below)', async () => {
    expect(await pngPassesUnchanged(PNG_8X8, LIMITS)).toBe(true);
  });

  it.each(Object.entries(MALFORMED_PNGS))('refused: %s', async (_label, bytes) => {
    expect(await pngPassesUnchanged(bytes, LIMITS)).toBe(false);
  });

  it('refused: data that inflates past the rows the header states', async () => {
    const bytes = pngWithOversizedData();
    expect(bytes.length).toBeLessThan(20_000);
    expect(await pngPassesUnchanged(bytes, LIMITS)).toBe(false);
  });

  it('refused: data that inflates to fewer bytes than the rows', async () => {
    const short = Buffer.concat([
      PNG_SIGNATURE,
      pngIhdr(8, 8),
      pngChunk('IDAT', deflateSync(Buffer.alloc(8 * 33 - 1))),
      PNG_IEND,
    ]);
    expect(await pngPassesUnchanged(short, LIMITS)).toBe(false);
  });

  it('refused: interlaced, over the edge, over the byte limit, no IEND', async () => {
    expect(
      await pngPassesUnchanged(await rgba(40, 30).png({ progressive: true }).toBuffer(), LIMITS),
    ).toBe(false);
    expect(await pngPassesUnchanged(await rgba(401, 10).png().toBuffer(), LIMITS)).toBe(false);
    expect(await pngPassesUnchanged(await rgba(10, 401).png().toBuffer(), LIMITS)).toBe(false);
    expect(
      await pngPassesUnchanged(PNG_8X8, { maxEdgePx: 400, maxBytes: PNG_8X8.length - 1 }),
    ).toBe(false);
    expect(await pngPassesUnchanged(PNG_8X8.subarray(0, PNG_8X8.length - 12), LIMITS)).toBe(false);
  });

  it('refused: anything that is not a PNG', async () => {
    expect(await pngPassesUnchanged(await rgb(8, 8).jpeg().toBuffer(), LIMITS)).toBe(false);
    expect(await pngPassesUnchanged(SVG_16000, LIMITS)).toBe(false);
  });
});

describe('jpegPassesUnchanged', () => {
  const LIMITS = { maxEdgePx: 400, maxBytes: 1024 * 1024 };

  it('a baseline JPEG and a mozjpeg (progressive) one made by sharp pass', async () => {
    const baseline = await rgb(400, 300).jpeg().toBuffer();
    const progressive = await rgb(300, 400).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
    expect(progressive.includes(Buffer.from([0xff, 0xc2]))).toBe(true);
    expect(jpegPassesUnchanged(baseline, LIMITS)).toBe(true);
    expect(jpegPassesUnchanged(progressive, LIMITS)).toBe(true);
  });

  it.each(Object.entries(EXIF_JPEGS))('refused: %s', (_label, bytes) => {
    expect(jpegPassesUnchanged(bytes, LIMITS)).toBe(false);
  });

  it('refused: EXIF orientation, XMP, CMYK', async () => {
    const oriented = await rgb(40, 30).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const xmp = await rgb(40, 30)
      .jpeg()
      .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>')
      .toBuffer();
    const cmyk = await rgb(40, 30).toColourspace('cmyk').jpeg().toBuffer();
    expect((await sharp(cmyk).metadata()).channels).toBe(4);
    expect(jpegPassesUnchanged(oriented, LIMITS)).toBe(false);
    expect(jpegPassesUnchanged(xmp, LIMITS)).toBe(false);
    expect(jpegPassesUnchanged(cmyk, LIMITS)).toBe(false);
  });

  it('refused: a fill byte before a marker (sharp reads it; the walk must be strict)', async () => {
    const plain = await rgb(40, 30).jpeg().toBuffer();
    const filled = Buffer.concat([plain.subarray(0, 2), Buffer.from([0xff]), plain.subarray(2)]);
    expect((await sharp(filled).metadata()).width).toBe(40);
    expect(jpegPassesUnchanged(plain, LIMITS)).toBe(true);
    expect(jpegPassesUnchanged(filled, LIMITS)).toBe(false);
  });

  it('refused: over the edge, over the byte limit, not a JPEG', async () => {
    const wide = await rgb(401, 10).jpeg().toBuffer();
    const small = await rgb(40, 30).jpeg().toBuffer();
    expect(jpegPassesUnchanged(wide, LIMITS)).toBe(false);
    expect(jpegPassesUnchanged(small, { maxEdgePx: 400, maxBytes: small.length - 1 })).toBe(false);
    expect(jpegPassesUnchanged(PNG_8X8, LIMITS)).toBe(false);
    expect(jpegPassesUnchanged(Buffer.from([0xff, 0xd8, 0xff]), LIMITS)).toBe(false);
  });
});
