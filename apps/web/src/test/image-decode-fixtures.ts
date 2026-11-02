import { crc32, deflateSync, gzipSync } from 'node:zlib';

/**
 * Image bytes for the capped decoder's tests (lib/image-decode.ts): files
 * whose structure does not match what their header says, headers that state
 * more pixels than the decoder takes, and files that look like an image
 * format at a glance but are not one. All are built here from their bytes,
 * so no sample file is kept in the repository.
 *
 * recordingSharp wraps the real sharp for vi.mock('sharp'): it records every
 * call's arguments and refuses, without decoding, any input registered with
 * holdBackFromSharp (every fixture here that states a large size). A test
 * run against code that would hand such a file to sharp therefore fails
 * fast at its own assertion instead of decoding the full size.
 */

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** One PNG chunk with a correct CRC. `declaredLength` states a length other
 *  than the data's own. */
export function pngChunk(type: string, data: Buffer, declaredLength = data.length): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  return Buffer.concat([u32(declaredLength), typeAndData, u32(crc32(typeAndData))]);
}

export function pngIhdr(
  width: number,
  height: number,
  opts: { bitDepth?: number; colourType?: number; interlace?: number } = {},
): Buffer {
  const { bitDepth = 8, colourType = 6, interlace = 0 } = opts;
  return pngChunk(
    'IHDR',
    Buffer.concat([u32(width), u32(height), Buffer.from([bitDepth, colourType, 0, 0, interlace])]),
  );
}

export const PNG_IEND = pngChunk('IEND', Buffer.alloc(0));

/** The zlib data of `height` all-zero RGBA rows `width` pixels wide. */
function rgbaRows(width: number, height: number): Buffer {
  return deflateSync(Buffer.alloc(height * (1 + width * 4)));
}

/** An 8 x 8 RGBA PNG made from its chunks: the control the others differ from. */
export const PNG_8X8 = Buffer.concat([
  PNG_SIGNATURE,
  pngIhdr(8, 8),
  pngChunk('IDAT', rgbaRows(8, 8)),
  PNG_IEND,
]);

/**
 * An 8 x 8 PNG of colour type `colourType` (8 bits) whose rows each start
 * with `filterByte`. A row's first byte names its filter, 0 to 4; png-js
 * (which pdfkit uses to split out a PNG's transparency) throws on any other
 * value inside zlib's callback, where nothing can catch it. A palette PNG
 * gets a PLTE and a tRNS chunk, so pdfkit decodes it too.
 */
export function pngWithRowFilter(colourType: 3 | 4 | 6, filterByte: number): Buffer {
  const channels = { 3: 1, 4: 2, 6: 4 }[colourType];
  const row = Buffer.alloc(1 + 8 * channels);
  row[0] = filterByte;
  const palette =
    colourType === 3
      ? [pngChunk('PLTE', Buffer.alloc(3, 0x80)), pngChunk('tRNS', Buffer.from([0x40]))]
      : [];
  return Buffer.concat([
    PNG_SIGNATURE,
    pngIhdr(8, 8, { colourType }),
    ...palette,
    pngChunk('IDAT', deflateSync(Buffer.concat(Array<Buffer>(8).fill(row)))),
    PNG_IEND,
  ]);
}

/**
 * PNGs with the PNG signature and a well-formed first IHDR whose chunks do
 * not hold what the header states. None may reach react-pdf unchanged.
 */
export const MALFORMED_PNGS: Readonly<Record<string, Buffer>> = {
  'a chunk whose length runs past the end of the file': Buffer.concat([
    PNG_SIGNATURE,
    pngIhdr(8, 8),
    pngChunk('zzzz', Buffer.alloc(0), 0xfffffff4),
  ]),
  'an IDAT whose length runs past the end of the file': Buffer.concat([
    PNG_SIGNATURE,
    pngIhdr(8, 8),
    pngChunk('IDAT', Buffer.alloc(0), 0x7ffffff0),
  ]),
  'an IDAT that is not zlib data': Buffer.concat([
    PNG_SIGNATURE,
    pngIhdr(8, 8),
    pngChunk('IDAT', Buffer.from('these bytes are not zlib data')),
    PNG_IEND,
  ]),
  'an IHDR of 16000 x 16000 over 16 bytes of data': Buffer.concat([
    PNG_SIGNATURE,
    pngIhdr(16000, 16000),
    pngChunk('IDAT', deflateSync(Buffer.alloc(16))),
    PNG_IEND,
  ]),
  'an IHDR of 100000 x 100000 over 16 bytes of data': Buffer.concat([
    PNG_SIGNATURE,
    pngIhdr(100_000, 100_000),
    pngChunk('IDAT', deflateSync(Buffer.alloc(16))),
    PNG_IEND,
  ]),
  'a second IHDR after the first': Buffer.concat([
    PNG_SIGNATURE,
    pngIhdr(8, 8),
    pngIhdr(100_000, 100_000),
    pngChunk('IDAT', rgbaRows(8, 8)),
    PNG_IEND,
  ]),
  'RGBA rows whose filter byte is not a PNG filter': pngWithRowFilter(6, 5),
  'grey and alpha rows whose filter byte is not a PNG filter': pngWithRowFilter(4, 5),
  'palette rows with tRNS whose filter byte is not a PNG filter': pngWithRowFilter(3, 5),
};

/** A 64 x 64 RGBA PNG whose IDAT inflates to 16 MiB instead of its 16,448
 *  bytes of rows (about 16 KB). sharp reads only the rows the header states. */
export function pngWithOversizedData(): Buffer {
  return Buffer.concat([
    PNG_SIGNATURE,
    pngIhdr(64, 64),
    pngChunk('IDAT', deflateSync(Buffer.alloc(16 * 1024 * 1024), { level: 9 })),
    PNG_IEND,
  ]);
}

/** A three-component 8 x 8 baseline frame header (SOF0). */
const JPEG_SOF0_8X8 = Buffer.from([
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x08, 0x00, 0x08, 0x03, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0,
]);

/** A JPEG of SOI, one APP1 EXIF segment holding a single IFD entry
 *  (orientation, SHORT) that states `count` values, the 8 x 8 frame and EOI. */
export function jpegWithExifEntryCount(count: number): Buffer {
  const tiff = Buffer.concat([
    Buffer.from('MM'),
    Buffer.from([0, 0x2a]),
    u32(8),
    Buffer.from([0, 1]),
    Buffer.from([0x01, 0x12, 0x00, 0x03]),
    u32(count),
    u32(0x00010000),
    u32(0),
  ]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff]),
    body,
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, JPEG_SOF0_8X8, Buffer.from([0xff, 0xd9])]);
}

/** JPEGs with an EXIF segment. None may reach react-pdf unchanged. */
export const EXIF_JPEGS: Readonly<Record<string, Buffer>> = {
  'an EXIF entry that states 0xFFFFFFFF values': jpegWithExifEntryCount(0xffffffff),
  'an EXIF entry that states one value': jpegWithExifEntryCount(1),
};

/** One JPEG marker segment: FF, the marker, the length (2 + the data's). */
export function jpegSegment(marker: number, data: Buffer): Buffer {
  const length = data.length + 2;
  return Buffer.concat([Buffer.from([0xff, marker, length >> 8, length & 0xff]), data]);
}

/** A scan header (SOS) for the three components of JPEG_SOF0_8X8. */
const JPEG_SOS_3 = jpegSegment(0xda, Buffer.from([3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 0x3f, 0]));

/**
 * SOI, the 8 x 8 baseline frame, `segments`, a scan with two bytes of data,
 * and EOI: a file whose markers all read in order, with no tables, so sharp
 * cannot decode it. It has 10 parts in jpegPassesUnchanged's count (SOI, the
 * frame and its 3 components, the scan and its 3, EOI) plus `segments`'.
 */
export function jpegFrameThen(...segments: Buffer[]): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    JPEG_SOF0_8X8,
    ...segments,
    JPEG_SOS_3,
    Buffer.from([0x12, 0x34, 0xff, 0xd9]),
  ]);
}

/** An empty comment segment (COM), four bytes. */
export const JPEG_EMPTY_COMMENT = jpegSegment(0xfe, Buffer.alloc(0));

/** `count` copies of `segment`. */
export function repeated(segment: Buffer, count: number): Buffer {
  return Buffer.concat(Array<Buffer>(count).fill(segment));
}

/**
 * JPEGs whose frame and markers read cleanly up to the frame, but whose
 * segments after it take react-pdf's JPEG reader (jay-peg) far longer than
 * any photo's, or that it reads differently from their stated lengths. A
 * file of 100,000 empty comments holds jay-peg for about 0.1 s each time it
 * is drawn; the 1 MiB one in the tests for about 0.3 to 0.5 s. None may
 * reach react-pdf unchanged.
 */
export const SLOW_TO_PARSE_JPEGS: Readonly<Record<string, Buffer>> = {
  '100,000 empty comment segments after the frame': jpegFrameThen(
    repeated(JPEG_EMPTY_COMMENT, 100_000),
  ),
  'a Huffman table segment of 3,000 empty tables': jpegFrameThen(
    jpegSegment(0xc4, Buffer.alloc(17 * 3000)),
  ),
  'a frame header longer than its components, holding 1,000 comments': Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(
      0xc0,
      Buffer.concat([JPEG_SOF0_8X8.subarray(4), repeated(JPEG_EMPTY_COMMENT, 1000)]),
    ),
    JPEG_SOS_3,
    Buffer.from([0x12, 0x34, 0xff, 0xd9]),
  ]),
  '1,000 restart markers outside a scan': jpegFrameThen(
    repeated(jpegSegment(0xd0, Buffer.alloc(0)), 1000),
  ),
  'an arithmetic coding conditioning segment (DAC)': jpegFrameThen(
    jpegSegment(0xcc, Buffer.from([0x00, 0x10])),
  ),
};

function box(type: string, ...contents: Buffer[]): Buffer {
  const body = Buffer.concat(contents);
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]);
}

/** A full box: version 0 and no flags before the contents. */
function fullBox(type: string, ...contents: Buffer[]): Buffer {
  return box(type, u32(0), ...contents);
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

/**
 * An AVIF's boxes, as sharp's encoder lays them out, for one item coded at
 * `coded` (its ispe) and, given `crop`, a clean aperture (clap) of that size
 * at its centre. The item's data in mdat is 16 bytes, not AV1, so sharp can
 * read the header but never decode it.
 */
export function avifBoxes(coded: [number, number], crop?: [number, number]): Buffer {
  const properties = [
    box('av1C', Buffer.from([0x81, 0x3f, 0x02, 0x00])),
    fullBox('ispe', u32(coded[0]), u32(coded[1])),
    fullBox('pixi', Buffer.from([3, 8, 8, 8])),
    ...(crop
      ? [box('clap', u32(crop[0]), u32(1), u32(crop[1]), u32(1), u32(0), u32(1), u32(0), u32(1))]
      : []),
  ];
  // av1C and clap are essential (0x80) to the item; ispe and pixi are not.
  const associations = properties.map((_, i) => (i === 0 || i === 3 ? 0x80 : 0) | (i + 1));
  const data = Buffer.alloc(16);
  const meta = (dataAt: number) =>
    fullBox(
      'meta',
      fullBox('hdlr', u32(0), Buffer.from('pict', 'latin1'), Buffer.alloc(13)),
      fullBox('pitm', u16(1)),
      fullBox(
        'iloc',
        Buffer.from([0x44, 0x40]),
        u16(1),
        u16(1),
        u16(0),
        u32(dataAt),
        u16(1),
        u32(0),
        u32(data.length),
      ),
      fullBox(
        'iinf',
        u16(1),
        box('infe', Buffer.from([2, 0, 0, 0]), u16(1), u16(0), Buffer.from('av01\0', 'latin1')),
      ),
      box(
        'iprp',
        box('ipco', ...properties),
        fullBox('ipma', u32(1), u16(1), Buffer.from([associations.length, ...associations])),
      ),
    );
  const ftyp = box(
    'ftyp',
    Buffer.from('avif', 'latin1'),
    u32(0),
    Buffer.from('mif1avifmiaf', 'latin1'),
  );
  const dataAt = ftyp.length + meta(0).length + 8;
  return Buffer.concat([ftyp, meta(dataAt), box('mdat', data)]);
}

/** An AVIF coded at 8192 x 8192 (four times the decoder's AVIF cap) with a
 *  64 x 64 crop: sharp sees 64 x 64, and libheif would decode 8192 x 8192 (a
 *  file like it with real AV1 data took 1.1 GB of memory). */
export const AVIF_8192_CROPPED_TO_64 = avifBoxes([8192, 8192], [64, 64]);

/** A 30-byte WebP header (RIFF, WEBP, VP8X) stating a `width` x `height`
 *  canvas, each up to 2^24. */
export function webpVp8xHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(22, 4);
  b.write('WEBPVP8X', 8, 'latin1');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

/** A VP8X header of 100 x 1,000,000: 100 million pixels, twice the cap. Its
 *  height needs the third byte (bytes[29]); without it the header reads as
 *  100 x 16,960. */
export const WEBP_100_BY_1000000 = webpVp8xHeader(100, 1_000_000);

/** 38-byte lossless WebP headers (VP8L) that state 7072 x 7072 and 16383 x
 *  16383 pixels: over the decoder's 50 million. */
export const WEBP_7072 = Buffer.from(
  'UklGRh4AAABXRUJQVlA4TBEAAAAvn9vnBgdQrXoUtP+BiOh/AAA=',
  'base64',
);
export const WEBP_16383 = Buffer.from(
  'UklGRh4AAABXRUJQVlA4TBEAAAAv/r//DwdQrXoUtP+BiOh/AAA=',
  'base64',
);

/** A GIF of a header and logical screen of `width` x `height`, no frame. */
export function gifHeader(width: number, height: number): Buffer {
  const b = Buffer.from('GIF89a\0\0\0\0\0\0\0;', 'latin1');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

export function svg(width: number, height: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="red"/></svg>`
  );
}

export const SVG_16000 = Buffer.from(svg(16000, 16000));

/** gzip (SVGZ) of `text` whose header carries an extra field, so bytes 4-11
 *  can be chosen: `ftypavif`. */
function svgzWithFtypAt4(text: string): Buffer {
  const gz = gzipSync(Buffer.from(text));
  const xlen = 0x6669; // 'if', read little-endian, as the extra field's length
  return Buffer.concat([
    Buffer.from([0x1f, 0x8b, 0x08, 0x04]),
    Buffer.from('ftypav', 'latin1'),
    Buffer.from('if', 'latin1'),
    Buffer.alloc(xlen),
    gz.subarray(10),
  ]);
}

/**
 * SVG text, and gzip of it, whose bytes 4-11 read `ftypavif`, which the
 * upload sniffer (lib/image-signature.ts) calls AVIF, and one under a
 * RIFF/WEBP header. The decoder must refuse each before sharp is called.
 */
export const IMAGE_LOOKALIKE_SVGS: Readonly<Record<string, Buffer>> = {
  'SVG after a comment holding ftypavif': Buffer.from(`<!--ftypavif-->${svg(8, 8)}`),
  'SVG after a processing instruction holding ftypavif': Buffer.from(`<?abftypavif?>${svg(8, 8)}`),
  'SVGZ whose gzip header holds ftypavif': svgzWithFtypAt4(svg(8, 8)),
  'SVG after whitespace and ftypavif': Buffer.from(`\n\n\n ftypavif ${svg(8, 8)}`),
};

export const SVG_UNDER_A_WEBP_HEADER = Buffer.from(`RIFF    WEBPVP8L    /   ${svg(8, 8)}`);

const heldBack: Buffer[] = [];

/** Registers inputs recordingSharp refuses without decoding. */
export function holdBackFromSharp(...inputs: Uint8Array[]): void {
  for (const input of inputs) heldBack.push(Buffer.from(input));
}

holdBackFromSharp(
  WEBP_7072,
  WEBP_16383,
  WEBP_100_BY_1000000,
  AVIF_8192_CROPPED_TO_64,
  SVG_16000,
  MALFORMED_PNGS['an IHDR of 16000 x 16000 over 16 bytes of data']!,
  MALFORMED_PNGS['an IHDR of 100000 x 100000 over 16 bytes of data']!,
);

function isHeldBack(input: unknown): boolean {
  if (!(input instanceof Uint8Array)) return false;
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return heldBack.some((b) => b.length === bytes.length && b.equals(bytes));
}

/**
 * The real sharp, with every call's arguments pushed to `calls`. An input
 * registered with holdBackFromSharp throws instead of being decoded (the
 * call is still recorded).
 */
export function recordingSharp<S extends (...args: never[]) => unknown>(
  real: S,
  calls: unknown[][],
): S {
  const wrapped = (...args: Parameters<S>) => {
    calls.push(args);
    if (isHeldBack(args[0])) throw new Error('test input held back from a full-size decode');
    return real(...args);
  };
  return Object.assign(wrapped, real) as unknown as S;
}
