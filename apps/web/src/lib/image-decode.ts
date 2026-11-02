import 'server-only';

import { promisify } from 'node:util';
import { inflate } from 'node:zlib';

import type { Sharp } from 'sharp';

import { sniffImage } from '@/lib/image-signature';

/**
 * The one capped image decoder for stored photos and logos (S45): the PDF
 * image prefetch (photos, covers and logos), the Items and Books export, and
 * the thumbnail backfill. With lib/image-reencode.ts it is the only code that
 * loads sharp (lib/sharp-input-limits.guard.test.ts).
 *
 * The bytes come from members: an item's photo, its cover URL, an
 * organization's logo. So nothing reaches sharp, and nothing reaches react-pdf
 * unchanged, on the strength of a few leading bytes:
 *
 *   - readImageHeader reads the format from the bytes (PNG, JPEG, WebP, GIF or
 *     AVIF, nothing else: no SVG, TIFF, HEIC or BMP) and, where the header
 *     states it, the size, at fixed offsets or by a bounded walk.
 *   - withCappedImage refuses, before sharp is called, a format the caller
 *     does not read, any other bytes, and a stated size over the format's cap
 *     (DECODE_MAX_INPUT_PIXELS); then it opens sharp with that cap (which
 *     libvips checks from the header as well), the EXIF orientation applied,
 *     and a time limit. Decodes that hold the whole image in memory before any
 *     resize (AVIF, GIF, interlaced PNG, progressive and other non-baseline
 *     JPEG) run one at a time in each process.
 *   - pngPassesUnchanged and jpegPassesUnchanged are the only way PNG or JPEG
 *     bytes reach react-pdf as they are. react-pdf and pdfkit read a PNG's
 *     chunks and a JPEG's segments themselves and take the lengths and sizes
 *     in them as given, so these checks walk the same structure first, with
 *     size and byte limits. Bytes that fail are re-made by sharp instead.
 */

export type ImageKind = 'png' | 'jpeg' | 'webp' | 'gif' | 'avif';

/**
 * The most pixels one decode may hold, by format. JPEG and WebP shrink while
 * loading when a resize follows; AVIF and GIF are decoded at full size first
 * (about 0.6 GB at 4096 x 4096 for AVIF), so they get less. 50 million is the
 * limit lib/image-reencode.ts measured for uploads (a 48 MP phone photo fits).
 */
export const DECODE_MAX_INPUT_PIXELS: Readonly<Record<ImageKind, number>> = Object.freeze({
  png: 50_000_000,
  jpeg: 50_000_000,
  webp: 50_000_000,
  gif: 4096 * 4096,
  avif: 4096 * 4096,
});

/** sharp's own time limit for one decode. A decode at the caps takes under a
 *  second, so only a file that cannot be read in time meets it, and it cannot
 *  hold the one-at-a-time slot for longer. */
export const DECODE_TIMEOUT_SECONDS = 20;

/** libvips' HEIF loader reads an ftyp box of at most this many bytes. A box
 *  that small starts with 00 00, which no other loader claims. */
const AVIF_FTYP_MAX_BYTES = 2048;

/** A refusal by the decoder's own checks, before sharp is called. */
export class DecodeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeRefused';
  }
}

export interface ImageHeader {
  kind: ImageKind;
  /** null when the header does not state the size (AVIF). */
  width: number | null;
  height: number | null;
  /** Decoded at full size before any resize: runs one at a time. */
  heavy: boolean;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Valid bit depths, and channels, by PNG colour type. */
const PNG_BIT_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};
const PNG_CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const INT31_MAX = 0x7fffffff;

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The `length` bytes at `start` as Latin-1, or '' past the end. */
function ascii(bytes: Uint8Array, start: number, length: number): string {
  if (start + length > bytes.length) return '';
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

interface PngIhdr {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
  interlaced: boolean;
}

/** The PNG signature, then a first chunk that is IHDR of 13 bytes with valid
 *  fields: width and height 1 to 2^31-1, a bit depth valid for the colour
 *  type, compression and filter 0, interlace 0 or 1. */
function readPngIhdr(bytes: Uint8Array): PngIhdr | null {
  if (bytes.length < 33 || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return null;
  const view = viewOf(bytes);
  if (view.getUint32(8) !== 13 || ascii(bytes, 12, 4) !== 'IHDR') return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const bitDepth = bytes[24]!;
  const colourType = bytes[25]!;
  const interlace = bytes[28]!;
  if (width < 1 || height < 1 || width > INT31_MAX || height > INT31_MAX) return null;
  if (!PNG_BIT_DEPTHS[colourType]?.includes(bitDepth)) return null;
  if (bytes[26] !== 0 || bytes[27] !== 0 || interlace > 1) return null;
  return { width, height, bitDepth, colourType, interlaced: interlace === 1 };
}

function isFrameMarker(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

interface JpegFrame {
  marker: number;
  width: number;
  height: number;
  components: number;
}

/**
 * A JPEG's frame header by a strict walk from SOI: every marker exactly where
 * the previous segment ends (no fill bytes), every length at least 2 and
 * inside the file, and a frame (SOF) before any scan, restart or end marker.
 * null when the walk does not get there.
 */
function strictJpegFrame(bytes: Uint8Array): JpegFrame | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  for (;;) {
    if (at + 4 > bytes.length || bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    if (marker === 0xff || marker === 0x00 || marker === 0x01) return null;
    // RST0-7, SOI, EOI and SOS before a frame.
    if (marker >= 0xd0 && marker <= 0xda) return null;
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    if (length < 2 || at + 2 + length > bytes.length) return null;
    if (isFrameMarker(marker)) {
      if (length < 8) return null;
      return {
        marker,
        height: (bytes[at + 5]! << 8) | bytes[at + 6]!,
        width: (bytes[at + 7]! << 8) | bytes[at + 8]!,
        components: bytes[at + 9]!,
      };
    }
    at += 2 + length;
  }
}

function pngHeader(bytes: Uint8Array): ImageHeader | null {
  const ihdr = readPngIhdr(bytes);
  if (!ihdr) return null;
  return { kind: 'png', width: ihdr.width, height: ihdr.height, heavy: ihdr.interlaced };
}

/** The size from the upload sniffer's frame walk; light only for a baseline
 *  or extended sequential frame (SOF0, SOF1) found by the strict walk. */
function jpegHeader(bytes: Uint8Array): ImageHeader | null {
  const sniffed = sniffImage(bytes);
  if (sniffed?.kind !== 'jpeg' || sniffed.width === null || sniffed.height === null) return null;
  const frame = strictJpegFrame(bytes);
  const light = frame !== null && (frame.marker === 0xc0 || frame.marker === 0xc1);
  return { kind: 'jpeg', width: sniffed.width, height: sniffed.height, heavy: !light };
}

/** The canvas of the first chunk: VP8X (24-29), VP8L (14-bit sizes after the
 *  0x2F signature at 20) or VP8 (14-bit sizes after the start code at 23). */
function webpHeader(bytes: Uint8Array): ImageHeader | null {
  const view = viewOf(bytes);
  const chunk = ascii(bytes, 12, 4);
  let width: number;
  let height: number;
  if (chunk === 'VP8X') {
    if (bytes.length < 30) return null;
    width = 1 + (view.getUint16(24, true) | (bytes[26]! << 16));
    height = 1 + (view.getUint16(27, true) | (bytes[29]! << 16));
  } else if (chunk === 'VP8L') {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
    const bits = view.getUint32(21, true);
    width = 1 + (bits & 0x3fff);
    height = 1 + ((bits >>> 14) & 0x3fff);
  } else if (chunk === 'VP8 ') {
    if (bytes.length < 30 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      return null;
    }
    width = view.getUint16(26, true) & 0x3fff;
    height = view.getUint16(28, true) & 0x3fff;
    if (width < 1 || height < 1) return null;
  } else {
    return null;
  }
  return { kind: 'webp', width, height, heavy: false };
}

/** The logical screen size (6-9, little-endian). */
function gifHeader(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 13) return null;
  const view = viewOf(bytes);
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  if (width < 1 || height < 1) return null;
  return { kind: 'gif', width, height, heavy: true };
}

/** An ftyp box the upload sniffer calls AVIF, of 16 to AVIF_FTYP_MAX_BYTES
 *  bytes, a multiple of 4, inside the buffer. Its size sits in a box tree
 *  this does not walk: sharp checks it against the cap from the header. */
function avifHeader(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 16) return null;
  const box = viewOf(bytes).getUint32(0);
  if (box < 16 || box > AVIF_FTYP_MAX_BYTES || box % 4 !== 0 || box > bytes.length) return null;
  if (sniffImage(bytes)?.kind !== 'avif') return null;
  return { kind: 'avif', width: null, height: null, heavy: true };
}

/**
 * The format, the size when the header states it, and whether the decode is
 * heavy, from the leading bytes. null for anything but PNG, JPEG, WebP, GIF
 * and AVIF, and for a header that does not read cleanly.
 */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  if (PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return pngHeader(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpegHeader(bytes);
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return webpHeader(bytes);
  const gif = ascii(bytes, 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') return gifHeader(bytes);
  if (ascii(bytes, 4, 4) === 'ftyp') return avifHeader(bytes);
  return null;
}

/** The end of the queue of heavy decodes; it never rejects. */
let heavyQueue: Promise<void> = Promise.resolve();

/** Runs `decode` after every heavy decode queued before it has settled. */
function inHeavySlot<T>(decode: () => Promise<T>): Promise<T> {
  const result = heavyQueue.then(decode);
  heavyQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Hands `work` a sharp instance of `bytes`, opened with exactly
 * `{ limitInputPixels: cap, autoOrient: true }` and DECODE_TIMEOUT_SECONDS,
 * and returns what `work` returns. Throws DecodeRefused, without calling sharp,
 * for bytes readImageHeader does not read, a kind not in `kinds`, or a stated
 * size over the kind's cap; sharp's own errors (an AVIF over its cap, a
 * damaged file) reject as they are.
 */
export async function withCappedImage<T>(
  bytes: Uint8Array,
  kinds: readonly ImageKind[],
  work: (image: Sharp) => Promise<T>,
): Promise<T> {
  const header = readImageHeader(bytes);
  if (!header) throw new DecodeRefused('not a PNG, JPEG, WebP, GIF or AVIF image');
  if (!kinds.includes(header.kind)) throw new DecodeRefused(`${header.kind} is not read here`);
  const cap = DECODE_MAX_INPUT_PIXELS[header.kind];
  if (header.width !== null && header.height !== null && header.width * header.height > cap) {
    throw new DecodeRefused(
      `${header.kind} ${header.width}x${header.height} is over ${cap} pixels`,
    );
  }
  const decode = async () => {
    const { default: sharp } = await import('sharp');
    const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const image = sharp(input, { limitInputPixels: cap, autoOrient: true });
    return work(image.timeout({ seconds: DECODE_TIMEOUT_SECONDS }));
  };
  return header.heavy ? inHeavySlot(decode) : decode();
}

/** A PNG of `bytes` fit inside `maxEdgePx` (aspect kept, never enlarged),
 *  its transparency kept. Throws as withCappedImage does. */
export async function pngFitInside(
  bytes: Uint8Array,
  kinds: readonly ImageKind[],
  maxEdgePx: number,
): Promise<Buffer> {
  return withCappedImage(bytes, kinds, (image) =>
    image
      .resize({ width: maxEdgePx, height: maxEdgePx, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer(),
  );
}

export interface PassThroughLimits {
  /** The longest edge, in pixels, a file may have to pass as it is. */
  maxEdgePx: number;
  /** The most bytes a file may have to pass as it is. */
  maxBytes: number;
}

const inflateAsync = promisify(inflate);

/**
 * Whether PNG bytes may reach react-pdf unchanged: the IHDR as
 * readPngIhdr reads it (not interlaced, both sides within maxEdgePx), at most
 * maxBytes, every chunk inside the file, no IHDR but the first, IEND reached,
 * and the IDAT data (every IDAT before IEND, joined) inflating to exactly the
 * rows the IHDR states. The inflate stops at that many bytes.
 */
export async function pngPassesUnchanged(
  bytes: Uint8Array,
  limits: PassThroughLimits,
): Promise<boolean> {
  if (bytes.length > limits.maxBytes) return false;
  const ihdr = readPngIhdr(bytes);
  if (!ihdr || ihdr.interlaced) return false;
  if (ihdr.width > limits.maxEdgePx || ihdr.height > limits.maxEdgePx) return false;
  const view = viewOf(bytes);
  const idat: Uint8Array[] = [];
  let at = 8;
  let ended = false;
  while (at + 12 <= bytes.length) {
    const length = view.getUint32(at);
    if (length > INT31_MAX || at + 12 + length > bytes.length) return false;
    const type = ascii(bytes, at + 4, 4);
    if (type === 'IHDR' && at !== 8) return false;
    if (type === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  if (!ended || idat.length === 0) return false;
  const rowBytes = Math.ceil((ihdr.width * ihdr.bitDepth * PNG_CHANNELS[ihdr.colourType]!) / 8);
  const expected = ihdr.height * (1 + rowBytes);
  try {
    const rows = await inflateAsync(Buffer.concat(idat), { maxOutputLength: expected });
    return rows.length === expected;
  } catch {
    return false;
  }
}

/**
 * Whether JPEG bytes may reach react-pdf unchanged: at most maxBytes, no byte
 * pair FF E1 anywhere (so no APP1 segment, EXIF or XMP; inside the
 * entropy-coded data FF is only ever followed by 00 or a restart marker), and
 * a strict marker walk (strictJpegFrame) to a baseline, extended or
 * progressive Huffman frame (SOF0, SOF1, SOF2) of 1 or 3 components with both
 * sides within maxEdgePx. Anything else is re-made, its orientation applied.
 */
export function jpegPassesUnchanged(bytes: Uint8Array, limits: PassThroughLimits): boolean {
  if (bytes.length > limits.maxBytes) return false;
  const whole = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (whole.indexOf(Buffer.from([0xff, 0xe1])) !== -1) return false;
  const frame = strictJpegFrame(bytes);
  if (!frame || frame.marker > 0xc2) return false;
  if (frame.components !== 1 && frame.components !== 3) return false;
  return (
    frame.width >= 1 &&
    frame.height >= 1 &&
    frame.width <= limits.maxEdgePx &&
    frame.height <= limits.maxEdgePx
  );
}
