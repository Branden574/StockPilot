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

/** The options of every zlib inflate call, the real inflate doing the work. */
const inflateOptions = vi.hoisted(() => [] as unknown[]);
vi.mock('node:zlib', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:zlib')>();
  return {
    ...real,
    inflate: (...args: Parameters<typeof real.inflate>) => {
      inflateOptions.push(args[1]);
      return real.inflate(...args);
    },
  };
});

import {
  av1TileOf,
  AVIF_8192_CROPPED_TO_64,
  avifBoxes,
  avifDerivedBoxes,
  avifOfManyGrids,
  AVIFS_BEHIND_A_FIRST_META,
  avifWithAFirstMeta,
  type DerivedAvifOptions,
  EXIF_JPEGS,
  gifHeader,
  IMAGE_LOOKALIKE_SVGS,
  JPEG_EMPTY_COMMENT,
  jpegFrameThen,
  jpegSegment,
  MALFORMED_PNGS,
  OVERSIZED_DERIVED_AVIFS,
  PNG_8X8,
  PNG_IEND,
  PNG_SIGNATURE,
  pngChunk,
  pngIhdr,
  pngWithIdatInsideTrns,
  pngWithOversizedData,
  pngWithRowFilter,
  pngWithText,
  PNGS_PNG_JS_MISREADS,
  repeated,
  SLOW_TO_PARSE_JPEGS,
  SVG_16000,
  SVG_UNDER_A_WEBP_HEADER,
  WEBP_100_BY_1000000,
  WEBP_16383,
  WEBP_7072,
  webpVp8xHeader,
} from '@/test/image-decode-fixtures';

import {
  AVIF_MAX_BOXES_INSIDE,
  AVIF_MAX_ITEMS,
  AVIF_MAX_TOP_LEVEL_BOXES,
  DECODE_MAX_INPUT_PIXELS,
  DECODE_TIMEOUT_SECONDS,
  DecodeRefused,
  JPEG_MAX_PARSED_PARTS,
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

function u32be(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

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

  it.each([
    ['AVIF', () => rgb(20, 10).avif({ effort: 0 })],
    ['AVIF with alpha (a second, auxiliary item)', () => rgba(33, 17).avif({ effort: 0 })],
  ] as const)('%s: kind and size agree with sharp, and it is heavy', async (_label, make) => {
    const { header, meta } = await headerAndMetadata(await make().toBuffer());
    expect(meta.format).toBe('heif');
    expect(header).toEqual({ kind: 'avif', width: meta.width, height: meta.height, heavy: true });
  });

  it('AVIF: the boxes built here read as sharp reads them (the control for the crop)', async () => {
    const { header, meta } = await headerAndMetadata(avifBoxes([40, 30]));
    expect(meta).toEqual({ format: 'heif', width: 40, height: 30 });
    expect(header).toEqual({ kind: 'avif', width: 40, height: 30, heavy: true });
  });

  it('AVIF with a crop (clap): the size it is coded at, not the cropped size sharp reports', async () => {
    // A crop of 64 x 48, so sharp may read it (AVIF_8192_CROPPED_TO_64 is held
    // back from sharp entirely); its data is not AV1, so nothing is decoded.
    const { header, meta } = await headerAndMetadata(avifBoxes([8192, 8192], [64, 48]));
    expect(meta).toEqual({ format: 'heif', width: 64, height: 48 });
    expect(header).toEqual({ kind: 'avif', width: 8192, height: 8192, heavy: true });
    expect(readImageHeader(AVIF_8192_CROPPED_TO_64)).toEqual(header);
  });

  it('AVIF: the largest coded size of any item', () => {
    const bytes = avifBoxes([64, 64]);
    const ispe = bytes.indexOf('ispe');
    const second = Buffer.concat([
      u32be(20),
      Buffer.from('ispe'),
      Buffer.alloc(4),
      u32be(5000),
      u32be(4000),
    ]);
    const withSecond = Buffer.concat([
      bytes.subarray(0, ispe + 16),
      second,
      bytes.subarray(ispe + 16),
    ]);
    for (const box of ['meta', 'iprp', 'ipco']) {
      const at = withSecond.indexOf(box) - 4;
      withSecond.writeUInt32BE(withSecond.readUInt32BE(at) + 20, at);
    }
    expect(readImageHeader(withSecond)).toMatchObject({ width: 5000, height: 4000 });
  });

  it('AVIF: a box with a 64-bit size and a last box of size 0 (to the end) read the same', () => {
    const plain = avifBoxes([300, 200]);
    const meta = plain.indexOf('meta') - 4;
    const metaSize = plain.readUInt32BE(meta);
    const largeMeta = (high: number) =>
      Buffer.concat([
        plain.subarray(0, meta),
        u32be(1),
        Buffer.from('meta'),
        u32be(high),
        u32be(metaSize + 8),
        plain.subarray(meta + 8),
      ]);
    expect(readImageHeader(largeMeta(0))).toMatchObject({ width: 300, height: 200 });
    // Over 4 GiB: no image here is that large.
    expect(readImageHeader(largeMeta(1))).toBeNull();
    const toEnd = Buffer.from(plain);
    toEnd.writeUInt32BE(0, plain.indexOf('mdat') - 4);
    expect(readImageHeader(toEnd)).toMatchObject({ width: 300, height: 200 });
  });

  it('AVIF: null when there is no meta, no ispe, an ispe of 0, or a box past its parent', () => {
    const plain = avifBoxes([64, 64]);
    const ftyp = plain.readUInt32BE(0);
    const meta = plain.indexOf('meta') - 4;
    const ispe = plain.indexOf('ispe') - 4;
    const renamed = (at: number, type: string) => {
      const b = Buffer.from(plain);
      b.write(type, at + 4, 'latin1');
      return b;
    };
    const zeroWidth = Buffer.from(plain);
    zeroWidth.writeUInt32BE(0, ispe + 12);
    const metaTooLong = Buffer.from(plain);
    metaTooLong.writeUInt32BE(plain.length, meta);
    const ispeTooShort = Buffer.from(plain);
    ispeTooShort.writeUInt32BE(8, ispe);
    for (const [label, bytes] of Object.entries({
      'only an ftyp box': plain.subarray(0, ftyp),
      'meta renamed': renamed(meta, 'mexa'),
      'ispe renamed': renamed(ispe, 'ispx'),
      'an ispe of width 0': zeroWidth,
      'meta running past the end': metaTooLong,
      'cut inside meta': plain.subarray(0, meta + 40),
      'an ispe box too short for a size': ispeTooShort,
    })) {
      expect(readImageHeader(bytes), label).toBeNull();
    }
    expect(readImageHeader(plain)).toEqual({ kind: 'avif', width: 64, height: 64, heavy: true });
  });

  it(`AVIF: at most ${AVIF_MAX_TOP_LEVEL_BOXES} boxes at the top level, ftyp included`, () => {
    // ftyp, meta and mdat, then empty free boxes.
    const free = Buffer.concat([u32be(8), Buffer.from('free')]);
    const withFree = (n: number) => Buffer.concat([avifBoxes([64, 64]), repeated(free, n)]);
    expect(AVIF_MAX_TOP_LEVEL_BOXES).toBe(64);
    expect(readImageHeader(withFree(61))).toMatchObject({ kind: 'avif', width: 64, height: 64 });
    expect(readImageHeader(withFree(62))).toBeNull();
    // 8 MiB of them: refused at the 65th box rather than walked to the end.
    expect(readImageHeader(withFree(1024 * 1024 - 64))).toBeNull();
  });

  it(`AVIF: at most ${AVIF_MAX_BOXES_INSIDE} boxes inside meta, iprp and ipco`, () => {
    const plain = avifBoxes([64, 64]);
    const free = Buffer.concat([u32be(8), Buffer.from('free')]);
    /** `n` free boxes at the end of `container`, its size and its parents' grown. */
    const withFree = (container: 'meta' | 'iprp' | 'ipco', n: number) => {
      const at = plain.indexOf(container) - 4;
      const end = at + plain.readUInt32BE(at);
      const bytes = Buffer.concat([plain.subarray(0, end), repeated(free, n), plain.subarray(end)]);
      const chain = { meta: ['meta'], iprp: ['meta', 'iprp'], ipco: ['meta', 'iprp', 'ipco'] };
      for (const box of chain[container]) {
        const boxAt = bytes.indexOf(box) - 4;
        bytes.writeUInt32BE(bytes.readUInt32BE(boxAt) + 8 * n, boxAt);
      }
      return bytes;
    };
    expect(AVIF_MAX_BOXES_INSIDE).toBe(256);
    // avifBoxes' meta holds 5 boxes, its iprp 2 and its ipco 3.
    for (const [container, own] of [
      ['meta', 5],
      ['iprp', 2],
      ['ipco', 3],
    ] as const) {
      expect(readImageHeader(withFree(container, 256 - own)), container).toMatchObject({
        width: 64,
        height: 64,
      });
      expect(readImageHeader(withFree(container, 257 - own)), container).toBeNull();
    }
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
    expect(readImageHeader(WEBP_100_BY_1000000)).toEqual({
      kind: 'webp',
      width: 100,
      height: 1_000_000,
      heavy: false,
    });
    expect(readImageHeader(webpVp8xHeader(1_000_000, 100))).toMatchObject({
      width: 1_000_000,
      height: 100,
    });
    expect(sharpCalls).toEqual([]);
  });

  it('is null for a PNG whose bit depth is not one its colour type allows', () => {
    for (const [colourType, bitDepth] of [
      [6, 4],
      [2, 1],
      [4, 2],
      [3, 16],
      [0, 3],
    ] as const) {
      const bytes = Buffer.concat([
        PNG_SIGNATURE,
        pngIhdr(8, 8, { colourType, bitDepth }),
        PNG_IEND,
      ]);
      expect(readImageHeader(bytes), `${colourType}/${bitDepth}`).toBeNull();
    }
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

/**
 * An AVIF whose primary item is derived from others: a grid of tiles, or an
 * overlay (iovl). libheif makes the image at the size the item's own data
 * states (a grid's output size, an overlay's canvas) before it reads a tile,
 * so that size, and not only the file's ispe properties, must be within the
 * cap.
 */
describe('readImageHeader: AVIF grids and overlays', () => {
  const GRID: DerivedAvifOptions = {
    type: 'grid',
    rows: 2,
    columns: 2,
    tile: [64, 64],
    output: [128, 128],
    ispe: [128, 128],
  };

  /** A sharp-made 64 x 64 AV1 image's data, for tiles libheif can decode. */
  async function realTile() {
    return av1TileOf(await rgb(64, 64).avif({ effort: 0 }).toBuffer());
  }

  it('a grid of real AV1 tiles: the boxes built here read and decode as sharp reads them', async () => {
    const tileData = await realTile();
    for (const opts of [
      { ...GRID, tileData },
      { ...GRID, tileData, dataIn: 'mdat', wide: true },
      { ...GRID, tileData, output: [120, 100], ispe: [120, 100] },
      { ...GRID, tileData, ids32: true },
      { ...GRID, tileData, ipmaWide: true },
      { ...GRID, tileData, ilocBase: true, dataIn: 'mdat' },
      // libheif adds iloc's base offset to an offset into idat as well.
      { ...GRID, tileData, idatPad: 16 },
      { ...GRID, tileData, ilocBase: true, idatPad: 16 },
    ] as DerivedAvifOptions[]) {
      const bytes = avifDerivedBoxes(opts);
      const label = JSON.stringify({ ...opts, tileData: undefined });
      const { header, meta } = await headerAndMetadata(bytes);
      expect(meta, label).toEqual({
        format: 'heif',
        width: opts.output[0],
        height: opts.output[1],
      });
      expect(header, label).toEqual({
        kind: 'avif',
        width: opts.output[0],
        height: opts.output[1],
        heavy: true,
      });
      const png = await withCappedImage(bytes, ['avif'], (img) => img.png().toBuffer());
      const decoded = await sharp(png).metadata();
      expect([decoded.width, decoded.height], label).toEqual(opts.output);
    }
  });

  it('a grid within its ispe: the larger of its ispe and its tiles', () => {
    expect(readImageHeader(avifDerivedBoxes(GRID))).toEqual({
      kind: 'avif',
      width: 128,
      height: 128,
      heavy: true,
    });
    // Data in mdat (construction method 0) and 32-bit sizes read the same.
    expect(readImageHeader(avifDerivedBoxes({ ...GRID, dataIn: 'mdat', wide: true }))).toEqual({
      kind: 'avif',
      width: 128,
      height: 128,
      heavy: true,
    });
    // A grid of 64 tiles of 512 making 4096 x 4096: at the cap.
    expect(
      readImageHeader(
        avifDerivedBoxes({
          ...GRID,
          rows: 8,
          columns: 8,
          tile: [512, 512],
          output: [4096, 4096],
          ispe: [4096, 4096],
        }),
      ),
    ).toMatchObject({ width: 4096, height: 4096 });
    // Its data 16 bytes into idat, by the extent's offset or by iloc's base
    // offset, reads the same.
    for (const ilocBase of [false, true]) {
      expect(readImageHeader(avifDerivedBoxes({ ...GRID, idatPad: 16, ilocBase }))).toEqual({
        kind: 'avif',
        width: 128,
        height: 128,
        heavy: true,
      });
    }
    // Its output under its ispe: the ispe still counts.
    expect(
      readImageHeader(avifDerivedBoxes({ ...GRID, output: [100, 100], ispe: [128, 128] })),
    ).toMatchObject({ width: 128, height: 128 });
  });

  it(`null for more than ${AVIF_MAX_ITEMS} items: iinf entries, or an iloc or ipma count`, () => {
    expect(AVIF_MAX_ITEMS).toBe(1024);
    // 31 x 33 tiles and the grid: 1024 items. 32 x 32 and the grid: 1025.
    const grid = (rows: number, columns: number) =>
      avifDerivedBoxes({
        ...GRID,
        rows,
        columns,
        tile: [128, 128],
        output: [columns * 128, rows * 128],
        ispe: [columns * 128, rows * 128],
      });
    expect(readImageHeader(grid(31, 33))).toMatchObject({ width: 4224, height: 3968 });
    expect(readImageHeader(grid(32, 32))).toBeNull();
    // The 5-item grid with more infe entries (for items nothing else names)
    // in its iinf: only iinf holds more than 1024.
    const withEntries = (extra: number) => {
      const plain = avifDerivedBoxes(GRID);
      const iinf = plain.indexOf('iinf') - 4;
      const end = iinf + plain.readUInt32BE(iinf);
      const entries = Array.from({ length: extra }, (_, i) =>
        Buffer.concat([
          u32be(21),
          Buffer.from('infe'),
          Buffer.from([2, 0, 0, 0]),
          Buffer.from([(100 + i) >> 8, (100 + i) & 0xff, 0, 0]),
          Buffer.from('av01\0', 'latin1'),
        ]),
      );
      const b = Buffer.concat([plain.subarray(0, end), ...entries, plain.subarray(end)]);
      for (const box of ['meta', 'iinf']) {
        const at = b.indexOf(box) - 4;
        b.writeUInt32BE(b.readUInt32BE(at) + 21 * extra, at);
      }
      return b;
    };
    expect(readImageHeader(withEntries(AVIF_MAX_ITEMS - 5))).toMatchObject({ width: 128 });
    expect(readImageHeader(withEntries(AVIF_MAX_ITEMS - 4))).toBeNull();
    // The 5-item grid, its iloc or ipma stating 1025 entries: the grid's
    // entry is read before the count runs past the entries there are, so
    // only the count refuses it.
    const counted = (box: 'iloc' | 'ipma') => {
      const b = Buffer.from(avifDerivedBoxes(GRID));
      const at = b.indexOf(box) + 4 + 4 + (box === 'iloc' ? 2 : 0);
      if (box === 'iloc') b.writeUInt16BE(AVIF_MAX_ITEMS + 1, at);
      else b.writeUInt32BE(AVIF_MAX_ITEMS + 1, at);
      return b;
    };
    expect(readImageHeader(counted('iloc'))).toBeNull();
    expect(readImageHeader(counted('ipma'))).toBeNull();
    // Two ipma boxes (libheif merges them): 1024 entries between them, not
    // in each.
    const ipmaTwice = (grids: number) => {
      const plain = avifOfManyGrids(grids, 1);
      const at = plain.indexOf('ipma') - 4;
      const end = at + plain.readUInt32BE(at);
      const copy = plain.subarray(at, end);
      const b = Buffer.concat([plain.subarray(0, end), copy, plain.subarray(end)]);
      for (const box of ['meta', 'iprp']) {
        const boxAt = b.indexOf(box) - 4;
        b.writeUInt32BE(b.readUInt32BE(boxAt) + copy.length, boxAt);
      }
      return b;
    };
    expect(readImageHeader(ipmaTwice(512))).toMatchObject({ width: 1, height: 1 });
    expect(readImageHeader(ipmaTwice(513))).toBeNull();
  });

  it.each(Object.entries(OVERSIZED_DERIVED_AVIFS))(
    'null, and refused before sharp: %s',
    async (_label, bytes) => {
      expect(readImageHeader(bytes)).toBeNull();
      sharpCalls.length = 0;
      await expect(withCappedImage(bytes, ALL_KINDS, async () => 'decoded')).rejects.toBeInstanceOf(
        DecodeRefused,
      );
      expect(sharpCalls).toEqual([]);
    },
  );

  it('null for a grid whose data states a larger width or height than its ispe', () => {
    for (const [output, ispe] of [
      [
        [129, 128],
        [128, 128],
      ],
      [
        [128, 129],
        [128, 128],
      ],
      [
        [60_000, 64],
        [128, 128],
      ],
    ] as Array<[[number, number], [number, number]]>) {
      expect(readImageHeader(avifDerivedBoxes({ ...GRID, output, ispe })), `${output}`).toBeNull();
      expect(
        readImageHeader(avifDerivedBoxes({ ...GRID, output, ispe, dataIn: 'mdat', wide: true })),
        `${output} in mdat, 32-bit`,
      ).toBeNull();
      expect(
        readImageHeader(avifDerivedBoxes({ ...GRID, output, ispe, ids32: true, ipmaWide: true })),
        `${output} with 32-bit item ids`,
      ).toBeNull();
    }
  });

  it('a grid’s 32-bit sizes are read as 32 bits', () => {
    // 65536 + 128: its 16-bit halves read 1 and 128, under the ispe.
    expect(
      readImageHeader(
        avifDerivedBoxes({ ...GRID, wide: true, output: [65_664, 128], ispe: [128, 128] }),
      ),
    ).toBeNull();
  });

  it('null for any overlay (iovl), whatever its sizes', async () => {
    const tileData = await realTile();
    const overlay = avifDerivedBoxes({
      type: 'iovl',
      tile: [64, 64],
      output: [64, 64],
      ispe: [64, 64],
      tileData,
    });
    // sharp reads it: the refusal is the decoder's.
    expect((await sharp(overlay).metadata()).width).toBe(64);
    expect(readImageHeader(overlay)).toBeNull();
    expect(
      readImageHeader(
        avifDerivedBoxes({ type: 'iovl', tile: [64, 64], output: [32, 32], ispe: [64, 64] }),
      ),
    ).toBeNull();
  });

  it('null when a grid’s data cannot be read', () => {
    const plain = avifDerivedBoxes(GRID);
    const inMdat = avifDerivedBoxes({ ...GRID, dataIn: 'mdat' });
    /** The grid's iloc entry: item 5, after iloc's 4 + 2 + 2 bytes and four
     *  tile entries of 16 bytes. Its fields: id, method, data reference,
     *  extent count, offset, length. */
    const gridEntry = (bytes: Buffer) => bytes.indexOf('iloc') + 4 + 8 + 4 * 16;
    const edited = (bytes: Buffer, edit: (b: Buffer, entry: number) => void) => {
      const b = Buffer.from(bytes);
      edit(b, gridEntry(b));
      return b;
    };
    const idat = plain.indexOf('idat') + 4;
    expect(plain.readUInt16BE(gridEntry(plain))).toBe(5);
    expect(readImageHeader(plain)).toMatchObject({ width: 128 });
    for (const [label, bytes] of Object.entries({
      'no iloc entry for the grid': edited(plain, (b, e) => b.writeUInt16BE(9, e)),
      'construction method 2 (another item)': edited(plain, (b, e) => b.writeUInt16BE(2, e + 2)),
      'reserved bits before the construction method': edited(plain, (b, e) =>
        b.writeUInt16BE(0x10 | 1, e + 2),
      ),
      // Laid out as version 2 (32-bit ids), stating version 3.
      'iloc version 3': (() => {
        const b = avifDerivedBoxes({ ...GRID, ids32: true });
        b[b.indexOf('iloc') + 4] = 3;
        return b;
      })(),
      // Every offset and length in 2 bytes, read that way they find the grid.
      'iloc offsets and lengths of 2 bytes': (() => {
        const entry = (id: number, method: number, length: number) =>
          [id, method, 0, 1, 0, length].map((n) => Buffer.from([n >> 8, n & 0xff]));
        const body = Buffer.concat([
          Buffer.from([1, 0, 0, 0, 0x22, 0x00, 0, 5]),
          ...[1, 2, 3, 4].flatMap((id) => entry(id, 0, 16)),
          ...entry(5, 1, 8),
        ]);
        const iloc = plain.indexOf('iloc') - 4;
        const old = plain.readUInt32BE(iloc);
        const b = Buffer.concat([
          plain.subarray(0, iloc),
          u32be(8 + body.length),
          Buffer.from('iloc'),
          body,
          plain.subarray(iloc + old),
        ]);
        const meta = b.indexOf('meta') - 4;
        b.writeUInt32BE(b.readUInt32BE(meta) + 8 + body.length - old, meta);
        return b;
      })(),
      'a data reference to another file': edited(plain, (b, e) => b.writeUInt16BE(1, e + 4)),
      // The grid's entry twice, both reading cleanly: which one libheif
      // reads is not the decoder's to guess.
      'two iloc entries for the grid': (() => {
        const e = gridEntry(plain);
        const b = Buffer.concat([
          plain.subarray(0, e + 16),
          plain.subarray(e, e + 16),
          plain.subarray(e + 16),
        ]);
        for (const box of ['meta', 'iloc']) {
          const at = b.indexOf(box) - 4;
          b.writeUInt32BE(b.readUInt32BE(at) + 16, at);
        }
        b.writeUInt16BE(6, b.indexOf('iloc') + 4 + 4 + 2);
        return b;
      })(),
      'two extents': edited(plain, (b, e) => b.writeUInt16BE(2, e + 6)),
      'an extent past the end of idat': edited(plain, (b, e) => b.writeUInt32BE(4, e + 8)),
      'an extent longer than idat': edited(plain, (b, e) => b.writeUInt32BE(12, e + 12)),
      'an extent shorter than the sizes': edited(plain, (b, e) => b.writeUInt32BE(7, e + 12)),
      'an extent past the end of the file': edited(inMdat, (b, e) =>
        b.writeUInt32BE(inMdat.length - 4, e + 8),
      ),
      'grid version 1': (() => {
        const b = Buffer.from(plain);
        b[idat] = 1;
        return b;
      })(),
      'a 32-bit grid in 8 bytes': (() => {
        const b = Buffer.from(plain);
        b[idat + 1] = 1;
        return b;
      })(),
      'an output width of 0': (() => {
        const b = Buffer.from(plain);
        b.writeUInt16BE(0, idat + 4);
        return b;
      })(),
      'no ispe for the grid': avifDerivedBoxes({ ...GRID, ispe: null }),
      'no idat box': (() => {
        const b = Buffer.from(plain);
        b.write('idax', plain.indexOf('idat'), 'latin1');
        return b;
      })(),
    })) {
      expect(readImageHeader(bytes), label).toBeNull();
    }
  });

  it('reads iloc and ipma once, not once for each grid: 1024 grids of 255 associations each', () => {
    const many = avifOfManyGrids(1024, 255);
    expect(many.length).toBeLessThan(310_000);
    // The control: a few grids read as the 1 x 1 image they state.
    expect(readImageHeader(avifOfManyGrids(4, 3))).toEqual({
      kind: 'avif',
      width: 1,
      height: 1,
      heavy: true,
    });
    const started = performance.now();
    const header = readImageHeader(many);
    const took = performance.now() - started;
    expect(header).toEqual({ kind: 'avif', width: 1, height: 1, heavy: true });
    // Walking them again for each grid took about 5 s; once, a few ms.
    expect(took).toBeLessThan(500);
  });
});

/**
 * libheif 1.23 (sharp 0.35) reads the LAST meta box at the top level of an
 * AVIF, and the first iinf, iloc, iprp and idat inside it. A file with more
 * than one of any of them is refused, so the box the decoder reads is the
 * one libheif decodes.
 */
describe('readImageHeader: AVIF boxes there should be one of', () => {
  it('libheif reads the last of two top-level meta boxes; the decoder refuses the file', async () => {
    const twoMetas = avifWithAFirstMeta(avifBoxes([40, 30]));
    expect((await sharp(twoMetas).metadata()).width).toBe(40);
    expect(readImageHeader(twoMetas)).toBeNull();
    // And the other way round.
    const other = avifWithAFirstMeta(avifBoxes([64, 64]), avifBoxes([40, 30]));
    expect((await sharp(other).metadata()).width).toBe(64);
    expect(readImageHeader(other)).toBeNull();
    expect(readImageHeader(avifBoxes([40, 30]))).toMatchObject({ width: 40, height: 30 });
  });

  it.each(Object.entries(AVIFS_BEHIND_A_FIRST_META))(
    'null, and refused before sharp, behind a first meta of 64 x 64: %s',
    async (_label, bytes) => {
      expect(readImageHeader(bytes)).toBeNull();
      sharpCalls.length = 0;
      await expect(withCappedImage(bytes, ALL_KINDS, async () => 'decoded')).rejects.toBeInstanceOf(
        DecodeRefused,
      );
      expect(sharpCalls).toEqual([]);
    },
  );

  it('null for a meta with two iinf, iloc, iprp or idat boxes, or an iprp with two ipco', () => {
    const plain = avifDerivedBoxes({
      type: 'grid',
      rows: 2,
      columns: 2,
      tile: [64, 64],
      output: [128, 128],
      ispe: [128, 128],
    });
    /** `plain` with a copy of its `type` box right after it, the boxes
     *  holding it grown to fit. */
    const twice = (type: string, parents: string[]) => {
      const at = plain.indexOf(type) - 4;
      const end = at + plain.readUInt32BE(at);
      const copy = plain.subarray(at, end);
      const b = Buffer.concat([plain.subarray(0, end), copy, plain.subarray(end)]);
      for (const parent of parents) {
        const parentAt = b.indexOf(parent) - 4;
        b.writeUInt32BE(b.readUInt32BE(parentAt) + copy.length, parentAt);
      }
      return b;
    };
    expect(readImageHeader(plain)).toMatchObject({ width: 128, height: 128 });
    for (const type of ['iinf', 'iloc', 'iprp', 'idat']) {
      expect(readImageHeader(twice(type, ['meta'])), type).toBeNull();
    }
    expect(readImageHeader(twice('ipco', ['meta', 'iprp'])), 'ipco').toBeNull();
    // Two ipma boxes are allowed (libheif merges them), as are two of a box
    // that states no size.
    expect(readImageHeader(twice('ipma', ['meta', 'iprp']))).toMatchObject({ width: 128 });
    expect(readImageHeader(twice('hdlr', ['meta']))).toMatchObject({ width: 128 });
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
      [
        'WebP over its cap by the third byte of its VP8X height',
        WEBP_100_BY_1000000,
        ALL_KINDS,
        /^webp 100x1000000 is over 50000000 pixels$/,
      ],
      ['GIF over its cap', gifHeader(4097, 4096), ALL_KINDS, /^gif 4097x4096 is over 16777216/],
      [
        'AVIF coded over its cap, cropped under it',
        AVIF_8192_CROPPED_TO_64,
        ALL_KINDS,
        /^avif 8192x8192 is over 16777216 pixels$/,
      ],
      ['AVIF coded at 4096 x 4097', avifBoxes([4096, 4097]), ['avif'], /^avif 4096x4097 is over/],
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

  it('turns sharp’s operation cache off, so no decoded image is kept after its request', async () => {
    // sharp's default: up to 50 MB, 20 files and 100 operations. libjpeg's
    // whole-image buffers of a progressive JPEG are not counted against the
    // 50 MB, so 24 at the cap held 2.6 GB (S45 Linux measurement).
    sharp.cache(true);
    expect(sharp.cache()).toMatchObject({ memory: { max: 50 }, items: { max: 100 } });
    const jpeg = await rgb(8, 8).jpeg({ progressive: true }).toBuffer();
    await withCappedImage(jpeg, ['jpeg'], (img) => img.png().toBuffer());
    expect(sharp.cache()).toMatchObject({
      memory: { current: 0, max: 0 },
      files: { max: 0 },
      items: { current: 0, max: 0 },
    });
  });

  it('AVIF: refuses 4096 x 4097 before sharp and converts 4096 x 4096', async () => {
    const over = await rgb(4096, 4097).avif({ effort: 0 }).toBuffer();
    sharpCalls.length = 0;
    await expect(withCappedImage(over, ['avif'], (img) => img.png().toBuffer())).rejects.toThrow(
      /^avif 4096x4097 is over 16777216 pixels$/,
    );
    expect(callsWith(over)).toEqual([]);
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

  it('a JPEG the strict walk cannot read to its frame is heavy, though sharp reads it', async () => {
    for (const make of [() => rgb(40, 30).jpeg(), () => rgb(40, 30).jpeg({ progressive: true })]) {
      const plain = await make().toBuffer();
      const filled = Buffer.concat([plain.subarray(0, 2), Buffer.from([0xff]), plain.subarray(2)]);
      expect(readImageHeader(plain)).toMatchObject({ width: 40, height: 30 });
      expect(readImageHeader(filled)).toEqual({ kind: 'jpeg', width: 40, height: 30, heavy: true });
      expect((await sharp(filled).metadata()).width).toBe(40);
    }
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

  it.each(Object.entries(PNGS_PNG_JS_MISREADS))(
    'refused: %s (sharp reads it; png-js reads it otherwise)',
    async (_label, bytes) => {
      expect((await sharp(bytes).metadata()).format).toBe('png');
      expect(await pngPassesUnchanged(bytes, LIMITS)).toBe(false);
    },
  );

  it('refused: a tRNS chunk on a colour type with alpha (4 or 6), even empty; allowed on 0, 2 and 3', async () => {
    const rows = (channels: number) => deflateSync(Buffer.alloc(8 * (1 + 8 * channels)));
    const withTrns = (colourType: number, trns: Buffer) =>
      Buffer.concat([
        PNG_SIGNATURE,
        pngIhdr(8, 8, { colourType }),
        ...(colourType === 3 ? [pngChunk('PLTE', Buffer.alloc(6, 0x80))] : []),
        pngChunk('tRNS', trns),
        pngChunk('IDAT', rows({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colourType]!)),
        PNG_IEND,
      ]);
    expect(await pngPassesUnchanged(withTrns(0, Buffer.from([0, 7])), LIMITS)).toBe(true);
    expect(await pngPassesUnchanged(withTrns(2, Buffer.from([0, 1, 0, 2, 0, 3])), LIMITS)).toBe(
      true,
    );
    expect(await pngPassesUnchanged(withTrns(3, Buffer.from([0, 0x80])), LIMITS)).toBe(true);
    for (const colourType of [4, 6]) {
      expect(await pngPassesUnchanged(withTrns(colourType, Buffer.alloc(0)), LIMITS)).toBe(false);
      expect(await pngPassesUnchanged(withTrns(colourType, Buffer.alloc(2)), LIMITS)).toBe(false);
      // The fixture's hidden rows are valid here: refused for the chunk alone.
      expect(await pngPassesUnchanged(pngWithIdatInsideTrns(colourType as 4 | 6, 0), LIMITS)).toBe(
        false,
      );
    }
  });

  it('a tEXt chunk of up to 64 KiB passes; a longer one is refused', async () => {
    expect(await pngPassesUnchanged(pngWithText(64 * 1024), LIMITS)).toBe(true);
    expect(await pngPassesUnchanged(pngWithText(64 * 1024 + 1), LIMITS)).toBe(false);
    // Other chunks are not held to it: a 200,000-byte zTXt or private chunk passes.
    const withChunk = (type: string) =>
      Buffer.concat([
        PNG_SIGNATURE,
        pngIhdr(8, 8),
        pngChunk(type, Buffer.alloc(200_000, 0x41)),
        pngChunk('IDAT', deflateSync(Buffer.alloc(8 * 33))),
        PNG_IEND,
      ]);
    expect(await pngPassesUnchanged(withChunk('zTXt'), LIMITS)).toBe(true);
    expect(await pngPassesUnchanged(withChunk('prVt'), LIMITS)).toBe(true);
  });

  it('refused: data that inflates past the rows the header states, inflating no more than the rows', async () => {
    const bytes = pngWithOversizedData();
    expect(bytes.length).toBeLessThan(20_000);
    inflateOptions.length = 0;
    expect(await pngPassesUnchanged(bytes, LIMITS)).toBe(false);
    // 64 rows of a filter byte and 64 RGBA pixels, not the 16 MiB the data holds.
    expect(inflateOptions).toEqual([{ maxOutputLength: 64 * (1 + 64 * 4) }]);
  });

  it('every row filter type png-js knows (0 to 4) passes; any other is refused', async () => {
    for (const colourType of [3, 4, 6] as const) {
      for (const filter of [0, 1, 2, 3, 4]) {
        expect(
          await pngPassesUnchanged(pngWithRowFilter(colourType, filter), LIMITS),
          `${colourType}/${filter}`,
        ).toBe(true);
      }
      for (const filter of [5, 6, 0x80, 0xff]) {
        expect(
          await pngPassesUnchanged(pngWithRowFilter(colourType, filter), LIMITS),
          `${colourType}/${filter}`,
        ).toBe(false);
      }
    }
  });

  it('refused: one row of eight with a filter type png-js does not know', async () => {
    const row = (filter: number) => Buffer.concat([Buffer.from([filter]), Buffer.alloc(32)]);
    const rows = [0, 1, 2, 3, 4, 0, 1, 2].map(row);
    const at = (i: number, filter: number) =>
      Buffer.concat([
        PNG_SIGNATURE,
        pngIhdr(8, 8),
        pngChunk(
          'IDAT',
          deflateSync(Buffer.concat(rows.map((r, j) => (j === i ? row(filter) : r)))),
        ),
        PNG_IEND,
      ]);
    expect(await pngPassesUnchanged(at(0, 0), LIMITS)).toBe(true);
    for (const i of [0, 3, 7])
      expect(await pngPassesUnchanged(at(i, 5), LIMITS), `row ${i}`).toBe(false);
  });

  it('refused: a bit depth its colour type does not allow, though the data fits it', async () => {
    // 4-bit RGBA: 8 pixels of 16 bits a row, so 16 bytes and the filter byte.
    const bytes = Buffer.concat([
      PNG_SIGNATURE,
      pngIhdr(8, 8, { colourType: 6, bitDepth: 4 }),
      pngChunk('IDAT', deflateSync(Buffer.alloc(8 * 17))),
      PNG_IEND,
    ]);
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

  it('refused: a frame other than baseline, extended or progressive Huffman (SOF0-2)', async () => {
    const plain = await rgb(40, 30).jpeg().toBuffer();
    const sof = plain.indexOf(Buffer.from([0xff, 0xc0]));
    const withFrame = (marker: number) => {
      const b = Buffer.from(plain);
      b[sof + 1] = marker;
      return b;
    };
    for (const marker of [0xc0, 0xc1, 0xc2]) {
      expect(jpegPassesUnchanged(withFrame(marker), LIMITS), marker.toString(16)).toBe(true);
    }
    // Lossless, hierarchical and arithmetic-coded frames.
    for (const marker of [0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]) {
      expect(jpegPassesUnchanged(withFrame(marker), LIMITS), marker.toString(16)).toBe(false);
    }
  });

  it.each(Object.entries(SLOW_TO_PARSE_JPEGS))('refused: %s', (_label, bytes) => {
    expect(readImageHeader(bytes)).toMatchObject({ kind: 'jpeg', width: 8, height: 8 });
    expect(jpegPassesUnchanged(bytes, LIMITS)).toBe(false);
  });

  it('refused: 1 MiB of empty comment segments after the frame (over 262,000 for jay-peg to parse)', () => {
    const count = Math.floor((1024 * 1024 - 64) / 4);
    const bytes = jpegFrameThen(repeated(JPEG_EMPTY_COMMENT, count));
    expect(count).toBe(262_128);
    expect(bytes.length).toBeLessThanOrEqual(LIMITS.maxBytes);
    expect(jpegPassesUnchanged(bytes, LIMITS)).toBe(false);
  });

  it(`at most ${JPEG_MAX_PARSED_PARTS} parts: segments, components and tables each count`, () => {
    // jpegFrameThen's own file has 10 parts.
    const comments = (n: number) => jpegFrameThen(repeated(JPEG_EMPTY_COMMENT, n));
    expect(jpegPassesUnchanged(jpegFrameThen(), LIMITS)).toBe(true);
    expect(jpegPassesUnchanged(comments(JPEG_MAX_PARSED_PARTS - 10), LIMITS)).toBe(true);
    expect(jpegPassesUnchanged(comments(JPEG_MAX_PARSED_PARTS - 9), LIMITS)).toBe(false);
    // One DHT segment of n empty tables (17 bytes each) is 1 + n parts.
    const huffman = (n: number) => jpegFrameThen(jpegSegment(0xc4, Buffer.alloc(17 * n)));
    expect(jpegPassesUnchanged(huffman(JPEG_MAX_PARSED_PARTS - 11), LIMITS)).toBe(true);
    expect(jpegPassesUnchanged(huffman(JPEG_MAX_PARSED_PARTS - 10), LIMITS)).toBe(false);
    // A table's codes follow its 16 counts: one table of 16 codes, then one empty.
    const counted = Buffer.concat([Buffer.from([0, 16]), Buffer.alloc(15 + 16), Buffer.alloc(17)]);
    const twoTables = (rest: number) =>
      jpegFrameThen(jpegSegment(0xc4, counted), repeated(JPEG_EMPTY_COMMENT, rest));
    expect(jpegPassesUnchanged(twoTables(JPEG_MAX_PARSED_PARTS - 13), LIMITS)).toBe(true);
    expect(jpegPassesUnchanged(twoTables(JPEG_MAX_PARSED_PARTS - 12), LIMITS)).toBe(false);
    // One DQT segment of n tables (65 bytes each) is 1 + n parts.
    const quant = (n: number) => jpegFrameThen(jpegSegment(0xdb, Buffer.alloc(65 * n)));
    expect(jpegPassesUnchanged(quant(JPEG_MAX_PARSED_PARTS - 11), LIMITS)).toBe(true);
    expect(jpegPassesUnchanged(quant(JPEG_MAX_PARSED_PARTS - 10), LIMITS)).toBe(false);
  });

  it('JPEGs from encoders are far under the part limit and pass', async () => {
    for (const make of [
      () => rgb(400, 300).jpeg({ quality: 95 }),
      () => rgb(400, 300).jpeg({ progressive: true }),
      () => rgb(400, 300).jpeg({ mozjpeg: true }),
      () => rgb(400, 300).jpeg({ mozjpeg: true, chromaSubsampling: '4:4:4', quality: 30 }),
      () => rgb(400, 300).toColourspace('b-w').jpeg({ progressive: true }),
    ]) {
      expect(jpegPassesUnchanged(await make().toBuffer(), LIMITS)).toBe(true);
    }
  });

  it('bytes after EOI, which jay-peg skips, do not count', async () => {
    const plain = await rgb(40, 30).jpeg().toBuffer();
    const trailed = Buffer.concat([plain, repeated(JPEG_EMPTY_COMMENT, 1000), Buffer.alloc(64)]);
    expect(jpegPassesUnchanged(trailed, LIMITS)).toBe(true);
  });

  it('refused: a segment jay-peg would read at another length than it states', () => {
    const app0 = (length: number) =>
      jpegSegment(0xe0, Buffer.concat([Buffer.from('JFIF\0', 'latin1'), Buffer.alloc(length - 7)]));
    expect(jpegPassesUnchanged(jpegFrameThen(app0(16)), LIMITS)).toBe(true);
    expect(jpegPassesUnchanged(jpegFrameThen(app0(18)), LIMITS)).toBe(false);
    expect(jpegPassesUnchanged(jpegFrameThen(jpegSegment(0xdd, Buffer.alloc(2))), LIMITS)).toBe(
      true,
    );
    expect(jpegPassesUnchanged(jpegFrameThen(jpegSegment(0xdd, Buffer.alloc(4))), LIMITS)).toBe(
      false,
    );
    // DQT: 2 + 65 bytes a table, so 66 bytes is a table and one byte over.
    expect(jpegPassesUnchanged(jpegFrameThen(jpegSegment(0xdb, Buffer.alloc(66))), LIMITS)).toBe(
      false,
    );
    // A scan header of one component stating three.
    const sos = jpegSegment(0xda, Buffer.from([3, 1, 0, 0, 0x3f, 0]));
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8]), jpegFrameThen().subarray(2, 21), sos]);
    expect(jpegPassesUnchanged(Buffer.concat([bytes, Buffer.from([0, 0xff, 0xd9])]), LIMITS)).toBe(
      false,
    );
  });

  it('refused: no scan, a scan before the frame, a second frame, a second SOI, no EOI', () => {
    const whole = jpegFrameThen();
    const frame = whole.subarray(2, 21);
    const scan = whole.subarray(21, whole.length - 2);
    const soi = Buffer.from([0xff, 0xd8]);
    const eoi = Buffer.from([0xff, 0xd9]);
    expect(jpegPassesUnchanged(Buffer.concat([soi, frame, scan, eoi]), LIMITS)).toBe(true);
    for (const [label, bytes] of Object.entries({
      'no scan': Buffer.concat([soi, frame, eoi]),
      'a scan before the frame': Buffer.concat([soi, scan, frame, scan, eoi]),
      'a second frame': Buffer.concat([soi, frame, frame, scan, eoi]),
      'a second SOI': Buffer.concat([soi, soi, frame, scan, eoi]),
      'no EOI': Buffer.concat([soi, frame, scan]),
      'scan data with no marker after it': Buffer.concat([
        soi,
        frame,
        scan,
        Buffer.from([0xff, 0, 1]),
      ]),
    })) {
      expect(jpegPassesUnchanged(bytes, LIMITS), label).toBe(false);
    }
  });

  it('a stuffed FF 00 and restart markers inside scan data are data', () => {
    const whole = jpegFrameThen();
    const head = whole.subarray(0, whole.length - 4);
    const data = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd7, 0x78]);
    const bytes = Buffer.concat([head, repeated(data, 500), Buffer.from([0xff, 0xd9])]);
    expect(jpegPassesUnchanged(bytes, LIMITS)).toBe(true);
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
