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
