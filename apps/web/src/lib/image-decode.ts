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
 *     AVIF, nothing else: no SVG, TIFF, HEIC or BMP) and the size, at fixed
 *     offsets or by a bounded walk. For AVIF that is the largest size an item
 *     is coded at (its ispe) or a grid's data states, not the size after a
 *     crop: libheif decodes those sizes, while sharp's own pixel limit sees
 *     the cropped one (avifCodedSize).
 *   - withCappedImage refuses, before sharp is called, a format the caller
 *     does not read, any other bytes, and a size over the format's cap
 *     (DECODE_MAX_INPUT_PIXELS); then it opens sharp with that cap (which
 *     libvips checks from the header as well), the EXIF orientation applied,
 *     and a time limit, libvips' operation cache off (loadSharp). Decodes
 *     that hold the whole image in memory before any resize (AVIF, GIF,
 *     interlaced PNG, progressive and other non-baseline JPEG) run one at a
 *     time in each process.
 *   - pngPassesUnchanged and jpegPassesUnchanged are the only way PNG or JPEG
 *     bytes reach react-pdf as they are. react-pdf and pdfkit read a PNG's
 *     chunks and a JPEG's segments themselves and take the lengths and sizes
 *     in them as given, so these checks walk the same structure first, with
 *     size and byte limits: png-js walks a PNG's chunks as the check does,
 *     and every row starts with a filter type png-js knows (it throws on any
 *     other inside zlib's callback, where nothing can catch it), and a JPEG
 *     holds only segments jay-peg reads at their stated length, few enough to
 *     parse in well under a millisecond. Bytes that fail are re-made by sharp
 *     instead.
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

/**
 * The most boxes an AVIF may hold at its top level (ftyp included), and
 * inside each of meta, iprp and ipco. Files sharp and libavif write hold 3
 * at the top level and under 20 in each of the others. The header read runs
 * on the main thread before any decode, and without a limit 8 MiB of empty
 * boxes took it 0.24 s each time the photo was read.
 */
export const AVIF_MAX_TOP_LEVEL_BOXES = 64;
export const AVIF_MAX_BOXES_INSIDE = 256;
/** The most items an AVIF may describe (iinf, iloc and ipma entries): a
 *  4096 x 4096 grid of 256 x 256 tiles, with an alpha grid as well, is 514. */
export const AVIF_MAX_ITEMS = 1024;

/** A refusal by the decoder's own checks, before sharp is called. */
export class DecodeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeRefused';
  }
}

export interface ImageHeader {
  kind: ImageKind;
  /** The size the decoder holds: for AVIF, the largest coded size of any of
   *  its items, before a crop. */
  width: number;
  height: number;
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
/** A PNG row's first byte names its filter: None, Sub, Up, Average, Paeth. */
const PNG_LAST_FILTER_TYPE = 4;

const INT31_MAX = 0x7fffffff;

/** The longest tEXt chunk a PNG may hold to reach react-pdf as it is. png-js
 *  hands a tEXt chunk's bytes to String.fromCharCode as one argument each,
 *  which throws past about 110,000 (Node 22), and react-pdf then draws
 *  nothing; sharp re-makes the file without it. */
const PNG_MAX_TEXT_CHUNK_BYTES = 64 * 1024;

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

interface IsoBox {
  type: string;
  /** Where the box's contents start, after its size and type. */
  body: number;
  end: number;
}

/** The boxes that exactly fill `start` to `end`, or null when a box's size
 *  is under its header or runs past `end`, or there are more than
 *  `maxBoxes`. A size of 0 runs to `end`; a 64-bit size must fit in 32 bits. */
function isoBoxes(
  bytes: Uint8Array,
  start: number,
  end: number,
  maxBoxes: number,
): IsoBox[] | null {
  const view = viewOf(bytes);
  const boxes: IsoBox[] = [];
  for (let at = start; at < end;) {
    if (boxes.length === maxBoxes || at + 8 > end) return null;
    let size = view.getUint32(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end || view.getUint32(at + 8) !== 0) return null;
      size = view.getUint32(at + 12);
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) return null;
    boxes.push({ type: ascii(bytes, at + 4, 4), body: at + header, end: at + size });
    at += size;
  }
  return boxes;
}

type Size = { width: number; height: number };

function larger(a: Size | null, b: Size): Size {
  return a && a.width * a.height >= b.width * b.height ? a : b;
}

/** The ispe property's size (a full box: version and flags, width,
 *  height), or null when it is too short or a side is 0. */
function ispeSize(bytes: Uint8Array, ispe: IsoBox): Size | null {
  if (ispe.end - ispe.body < 12) return null;
  const view = viewOf(bytes);
  const width = view.getUint32(ispe.body + 4);
  const height = view.getUint32(ispe.body + 8);
  return width < 1 || height < 1 ? null : { width, height };
}

/** A reader of big-endian fields from `at` up to `end`; each read gives
 *  null past `end`. A field of 8 bytes must fit in 32 bits. */
function fieldReader(bytes: Uint8Array, at: number, end: number) {
  const view = viewOf(bytes);
  return {
    get at() {
      return at;
    },
    skip(size: number): boolean {
      at += size;
      return at <= end;
    },
    read(size: number): number | null {
      if (at + size > end) return null;
      const start = at;
      at += size;
      switch (size) {
        case 0:
          return 0;
        case 1:
          return bytes[start]!;
        case 2:
          return view.getUint16(start);
        case 4:
          return view.getUint32(start);
        case 8:
          return view.getUint32(start) === 0 ? view.getUint32(start + 4) : null;
        default:
          return null;
      }
    },
  };
}

/** The id and type of every item iinf describes as a grid or an overlay
 *  (iovl), or null when its entries do not read. Entries of version 0 and 1
 *  state no item type, so they are no image. */
function avifDerivedItems(
  bytes: Uint8Array,
  inMeta: IsoBox[],
): Array<{ id: number; type: string }> | null {
  const iinf = inMeta.find((b) => b.type === 'iinf');
  if (!iinf) return [];
  const header = fieldReader(bytes, iinf.body, iinf.end);
  const version = header.read(1);
  if (version === null || !header.skip(3) || header.read(version === 0 ? 2 : 4) === null) {
    return null;
  }
  const entries = isoBoxes(bytes, header.at, iinf.end, AVIF_MAX_ITEMS);
  if (!entries) return null;
  const derived: Array<{ id: number; type: string }> = [];
  for (const infe of entries.filter((b) => b.type === 'infe')) {
    const entry = fieldReader(bytes, infe.body, infe.end);
    const infeVersion = entry.read(1);
    if (infeVersion === null) return null;
    if (infeVersion < 2) continue;
    entry.skip(3);
    const id = entry.read(infeVersion === 2 ? 2 : 4);
    if (id === null || !entry.skip(2) || entry.at + 4 > infe.end) return null;
    const type = ascii(bytes, entry.at, 4);
    if (type === 'grid' || type === 'iovl') derived.push({ id, type });
  }
  return derived;
}

/** Where each item's data is, by its iloc entry: one extent of a stated
 *  length, in the file (construction method 0) or in idat (1), in this file
 *  (data reference 0), or null for an entry of any other kind. null for the
 *  whole map when iloc does not read or holds two entries for one item (the
 *  size counted must come from the data libheif reads). One pass, so a file
 *  of many grids costs no more than its size. */
function avifItemData(
  bytes: Uint8Array,
  inMeta: IsoBox[],
): Map<number, { start: number; end: number } | null> | null {
  const iloc = inMeta.find((b) => b.type === 'iloc');
  if (!iloc) return null;
  const r = fieldReader(bytes, iloc.body, iloc.end);
  const version = r.read(1);
  if (version === null || version > 2 || !r.skip(3)) return null;
  const sizes = r.read(2);
  if (sizes === null) return null;
  const offsetSize = sizes >> 12;
  const lengthSize = (sizes >> 8) & 0xf;
  const baseSize = (sizes >> 4) & 0xf;
  const indexSize = version > 0 ? sizes & 0xf : 0;
  if (![offsetSize, lengthSize, baseSize, indexSize].every((n) => n === 0 || n === 4 || n === 8)) {
    return null;
  }
  const idSize = version < 2 ? 2 : 4;
  const count = r.read(idSize);
  if (count === null || count > AVIF_MAX_ITEMS) return null;
  const idat = inMeta.find((b) => b.type === 'idat');
  const located = new Map<number, { start: number; end: number } | null>();
  for (let i = 0; i < count; i += 1) {
    const id = r.read(idSize);
    // 12 reserved bits, then the construction method.
    const method = version > 0 ? r.read(2) : 0;
    const dataReference = r.read(2);
    const base = r.read(baseSize);
    const extents = r.read(2);
    if (id === null || method === null || dataReference === null || base === null) return null;
    if (extents === null || located.has(id)) return null;
    if (dataReference !== 0 || extents !== 1) {
      located.set(id, null);
      if (!r.skip(extents * (indexSize + offsetSize + lengthSize))) return null;
      continue;
    }
    if (!r.skip(indexSize)) return null;
    const offset = r.read(offsetSize);
    const length = r.read(lengthSize);
    if (offset === null || length === null) return null;
    let start: number | null = null;
    let end = bytes.length;
    if (method === 0) {
      start = base + offset;
    } else if (method === 1 && idat) {
      start = idat.body + base + offset;
      end = idat.end;
    }
    located.set(
      id,
      start !== null && start + length <= end ? { start, end: start + length } : null,
    );
  }
  return located;
}

/** The size each item's first associated ispe states (ipma, its property
 *  indexes counted from 1 into ipco), by item id. null when ipma does not
 *  read, or its boxes hold more than AVIF_MAX_ITEMS entries between them.
 *  One pass over every ipma box (libheif merges them). */
function avifItemIspes(
  bytes: Uint8Array,
  inIprp: IsoBox[],
  properties: IsoBox[],
): Map<number, Size> | null {
  const ispes = new Map<number, Size>();
  let entries = 0;
  for (const ipma of inIprp.filter((b) => b.type === 'ipma')) {
    const r = fieldReader(bytes, ipma.body, ipma.end);
    const version = r.read(1);
    // The low byte of the 24 flag bits.
    const flags = r.skip(2) ? r.read(1) : null;
    const count = r.read(4);
    if (version === null || flags === null || count === null) return null;
    entries += count;
    if (entries > AVIF_MAX_ITEMS) return null;
    const wideIndex = (flags & 1) === 1;
    for (let i = 0; i < count; i += 1) {
      const id = r.read(version < 1 ? 2 : 4);
      const associations = r.read(1);
      if (id === null || associations === null) return null;
      for (let j = 0; j < associations; j += 1) {
        const association = r.read(wideIndex ? 2 : 1);
        if (association === null) return null;
        if (ispes.has(id)) continue;
        const property = properties[(association & (wideIndex ? 0x7fff : 0x7f)) - 1];
        const size = property?.type === 'ispe' ? ispeSize(bytes, property) : null;
        if (size) ispes.set(id, size);
      }
    }
  }
  return ispes;
}

/** The one box of `type` among `boxes`, or null when there is none or more
 *  than one. */
function onlyBox(boxes: IsoBox[], type: string): IsoBox | null {
  const found = boxes.filter((b) => b.type === type);
  return found.length === 1 ? found[0]! : null;
}

/** Whether `boxes` hold at most one box of each of `types`. */
function atMostOneOf(boxes: IsoBox[], types: readonly string[]): boolean {
  return types.every((type) => boxes.filter((b) => b.type === type).length <= 1);
}

/**
 * The size a grid item's data states (ImageGrid: version 0, flags, rows and
 * columns less one, then the output width and height in 16 bits, or 32 when
 * flags bit 0 is set), or null when it cannot be read.
 */
function avifGridOutput(bytes: Uint8Array, data: { start: number; end: number }): Size | null {
  const r = fieldReader(bytes, data.start, data.end);
  const version = r.read(1);
  const flags = r.read(1);
  if (version !== 0 || flags === null || !r.skip(2)) return null;
  const size = (flags & 1) === 1 ? 4 : 2;
  const width = r.read(size);
  const height = r.read(size);
  if (!width || !height) return null;
  return { width, height };
}

/**
 * The largest size libheif may decode any item of an AVIF at. That is
 * every ispe property in meta > iprp > ipco (meta and ispe are full boxes,
 * so their contents start after 4 bytes of version and flags): libheif
 * decodes a coded item at its ispe and refuses data of any other size, then
 * applies a crop (clap), while sharp's pixel limit compares against the size
 * after the crop, so a 64 x 64 crop of an 8192 x 8192 image would pass it.
 *
 * A derived item is made at the size its own data states, not at its ispe:
 * libheif 1.23 allocates a grid's output size, or an overlay's canvas,
 * before it reads a tile. So each grid's output size counts as well, and a
 * file is refused (null) when a grid's data cannot be read or states a
 * larger width or height than the grid's own ispe, and when it holds an
 * overlay (iovl) at all: overlays are rare, and refusing them keeps their
 * canvas and offsets out of reach.
 *
 * The boxes read must be the ones libheif decodes. It reads the LAST meta
 * box at the top level, and the first iinf, iloc, iprp, idat and ipco, so a
 * file with a harmless meta before a second one would read here as the
 * harmless one and decode as the other. A file is refused when it holds
 * more than one meta, or a meta more than one of those boxes (files sharp
 * and libavif write hold one of each).
 *
 * null as well when the boxes do not fill their parents, are more than
 * AVIF_MAX_TOP_LEVEL_BOXES or AVIF_MAX_BOXES_INSIDE, or there is no ispe.
 */
function avifCodedSize(bytes: Uint8Array): Size | null {
  const top = isoBoxes(bytes, 0, bytes.length, AVIF_MAX_TOP_LEVEL_BOXES);
  const meta = top && onlyBox(top, 'meta');
  if (!meta) return null;
  const inMeta = isoBoxes(bytes, meta.body + 4, meta.end, AVIF_MAX_BOXES_INSIDE);
  if (!inMeta || !atMostOneOf(inMeta, ['iinf', 'iloc', 'iprp', 'idat'])) return null;
  const iprp = onlyBox(inMeta, 'iprp');
  const inIprp = iprp && isoBoxes(bytes, iprp.body, iprp.end, AVIF_MAX_BOXES_INSIDE);
  const ipco = inIprp && onlyBox(inIprp, 'ipco');
  const properties = ipco && isoBoxes(bytes, ipco.body, ipco.end, AVIF_MAX_BOXES_INSIDE);
  if (!inIprp || !properties) return null;
  let largest: Size | null = null;
  for (const ispe of properties.filter((b) => b.type === 'ispe')) {
    const size = ispeSize(bytes, ispe);
    if (!size) return null;
    largest = larger(largest, size);
  }
  const derived = avifDerivedItems(bytes, inMeta);
  if (!derived) return null;
  if (derived.length === 0) return largest;
  if (derived.some((item) => item.type === 'iovl')) return null;
  const located = avifItemData(bytes, inMeta);
  const ispes = avifItemIspes(bytes, inIprp, properties);
  if (!located || !ispes) return null;
  for (const item of derived) {
    const data = located.get(item.id);
    const output = data && avifGridOutput(bytes, data);
    const ispe = ispes.get(item.id);
    if (!output || !ispe || output.width > ispe.width || output.height > ispe.height) return null;
    largest = larger(largest, output);
  }
  return largest;
}

/** An ftyp box the upload sniffer calls AVIF, of 16 to AVIF_FTYP_MAX_BYTES
 *  bytes, a multiple of 4, inside the buffer, and the largest coded size of
 *  its items (avifCodedSize). */
function avifHeader(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 16) return null;
  const box = viewOf(bytes).getUint32(0);
  if (box < 16 || box > AVIF_FTYP_MAX_BYTES || box % 4 !== 0 || box > bytes.length) return null;
  if (sniffImage(bytes)?.kind !== 'avif') return null;
  const coded = avifCodedSize(bytes);
  if (!coded) return null;
  return { kind: 'avif', width: coded.width, height: coded.height, heavy: true };
}

/** Whether the bytes start with the PNG signature: readImageHeader reads
 *  them as a PNG or not at all. */
export function hasPngSignature(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

/**
 * The format, the size when the header states it, and whether the decode is
 * heavy, from the leading bytes. null for anything but PNG, JPEG, WebP, GIF
 * and AVIF, and for a header that does not read cleanly.
 */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  if (hasPngSignature(bytes)) return pngHeader(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpegHeader(bytes);
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return webpHeader(bytes);
  const gif = ascii(bytes, 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') return gifHeader(bytes);
  if (ascii(bytes, 4, 4) === 'ftyp') return avifHeader(bytes);
  return null;
}

/**
 * sharp, with libvips' operation cache turned off. By default libvips keeps
 * the last 100 operations, and with them buffers it does not count against
 * the cache's 50 MB: libjpeg's whole-image buffers for a progressive JPEG
 * (about 290 MB at the 50 million cap) and the decoded AVIF and GIF frames.
 * On Linux one PDF's prefetch of 24 progressive JPEGs at the cap held over
 * 2.6 GB that way, and at most 764 MB with the cache off. No request here
 * decodes the same bytes twice, so the cache saves nothing. The setting is
 * the process's; it is set again before every decode, so nothing that turned
 * it back on in between keeps it on.
 */
async function loadSharp() {
  const { default: sharp } = await import('sharp');
  sharp.cache(false);
  return sharp;
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
 * for bytes readImageHeader does not read, a kind not in `kinds`, or a size
 * over the kind's cap; sharp's own errors (a damaged file) reject as they are.
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
  if (header.width * header.height > cap) {
    throw new DecodeRefused(
      `${header.kind} ${header.width}x${header.height} is over ${cap} pixels`,
    );
  }
  const decode = async () => {
    const sharp = await loadSharp();
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
 * rows the IHDR states, each starting with a filter type from 0 to 4. The
 * inflate stops at that many bytes. png-js, which pdfkit runs over every
 * pixel of a PNG with transparency, throws on any other filter type inside
 * zlib's callback, which ends the process. png-js must also walk the chunks
 * as this does, so no tRNS chunk for a colour type with alpha (png-js does
 * not move past its data), and no tEXt chunk over PNG_MAX_TEXT_CHUNK_BYTES.
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
    // The PNG specification allows tRNS only for colour types without an
    // alpha channel. For 4 and 6 png-js reads none of its data and goes on
    // to read the chunks inside it, which may hold an IDAT and IEND of their
    // own: png-js would decode rows this walk never checked.
    if (type === 'tRNS' && (ihdr.colourType === 4 || ihdr.colourType === 6)) return false;
    if (type === 'tEXt' && length > PNG_MAX_TEXT_CHUNK_BYTES) return false;
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
  let rows: Buffer;
  try {
    rows = await inflateAsync(Buffer.concat(idat), { maxOutputLength: expected });
  } catch {
    return false;
  }
  if (rows.length !== expected) return false;
  for (let row = 0; row < expected; row += 1 + rowBytes) {
    if (rows[row]! > PNG_LAST_FILTER_TYPE) return false;
  }
  return true;
}

/**
 * The most parts of one JPEG that passes unchanged: its marker segments, and
 * the frame and scan components and Huffman and quantization tables inside
 * them. react-pdf reads a JPEG with jay-peg, which turns every one of these
 * into an object, synchronously, at about a microsecond each, with nothing
 * else on the server running meanwhile. JPEGs sharp makes have 22 (baseline)
 * to 54 (progressive); a 1 MiB file of nothing but empty comment segments has
 * over 262,000, which took jay-peg 0.3 to 0.5 s each time it was drawn.
 */
export const JPEG_MAX_PARSED_PARTS = 256;

/** Where a scan's entropy-coded data, from `start`, ends: at the first FF
 *  followed by anything but 00 or a restart marker (RST0-7), as jay-peg
 *  looks for it. -1 when there is no such FF. */
function scanDataEnd(bytes: Uint8Array, start: number): number {
  const whole = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = whole.indexOf(0xff, start); at !== -1; at = whole.indexOf(0xff, at + 1)) {
    const next = whole[at + 1];
    if (next === undefined || (next !== 0x00 && (next < 0xd0 || next > 0xd7))) return at;
  }
  return -1;
}

/**
 * A JPEG's frame when the whole file, SOI to EOI, reads exactly as jay-peg
 * reads it (react-pdf's JPEG reader, which parses every segment and skips
 * whatever follows EOI), and cheaply:
 *   - each marker exactly where the segment before it ends or, after a scan
 *     (SOS) header, where its entropy-coded data ends (scanDataEnd);
 *   - only markers encoders write: one frame (SOF0, SOF1 or SOF2) before
 *     any scan, DHT, DQT, DRI, SOS, APP0, APP2 to APP15 and COM, nothing else
 *     (no APP1, whose EXIF jay-peg parses entry by entry, no DAC, no second
 *     SOI, no restart marker outside a scan);
 *   - each segment jay-peg reads field by field exactly as long as that
 *     reading (a frame 8 + 3 per component, a scan header 6 + 2 per
 *     component, DRI 4, APP0 16 for its JFIF fields, DQT 2 + 65 per table),
 *     so it never reads a segment's contents as markers;
 *   - at least one scan, and at most JPEG_MAX_PARSED_PARTS parts.
 * null when any of these fails.
 */
function jpegFrameAsJayPegReadsIt(bytes: Uint8Array): JpegFrame | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let frame: JpegFrame | null = null;
  let scans = 0;
  let parts = 1;
  let at = 2;
  for (;;) {
    if (at + 2 > bytes.length || bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    parts += 1;
    if (marker === 0xd9) return frame && scans > 0 && parts <= JPEG_MAX_PARSED_PARTS ? frame : null;
    if (at + 4 > bytes.length) return null;
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    const end = at + 2 + length;
    if (length < 2 || end > bytes.length) return null;
    let next = end;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      const components = bytes[at + 9] ?? 0;
      if (frame || scans > 0 || length !== 8 + 3 * components) return null;
      parts += components;
      frame = {
        marker,
        height: (bytes[at + 5]! << 8) | bytes[at + 6]!,
        width: (bytes[at + 7]! << 8) | bytes[at + 8]!,
        components,
      };
    } else if (marker === 0xc4) {
      // jay-peg's DHT reader: tables of an id, 16 code counts and the codes,
      // one after another until the segment ends.
      for (let table = at + 4; table < end && parts <= JPEG_MAX_PARSED_PARTS; parts += 1) {
        let codes = 0;
        for (let i = table + 1; i < Math.min(table + 17, end); i += 1) codes += bytes[i]!;
        table += 17 + codes;
      }
    } else if (marker === 0xdb) {
      if ((length - 2) % 65 !== 0) return null;
      parts += (length - 2) / 65;
    } else if (marker === 0xda) {
      const components = bytes[at + 4] ?? 0;
      if (!frame || length !== 6 + 2 * components) return null;
      parts += components;
      scans += 1;
      next = scanDataEnd(bytes, end);
      if (next === -1) return null;
    } else if (marker === 0xdd || marker === 0xe0) {
      if (length !== (marker === 0xdd ? 4 : 16)) return null;
    } else if (!(marker >= 0xe2 && marker <= 0xef) && marker !== 0xfe) {
      return null;
    }
    if (parts > JPEG_MAX_PARSED_PARTS) return null;
    at = next;
  }
}

/**
 * Whether JPEG bytes may reach react-pdf unchanged: at most maxBytes, the
 * whole file reading as jay-peg reads it within JPEG_MAX_PARSED_PARTS
 * (jpegFrameAsJayPegReadsIt: so no APP1 segment, EXIF or XMP, and no
 * orientation to apply), and a baseline, extended or progressive Huffman
 * frame (SOF0, SOF1, SOF2) of 1 or 3 components with both sides within
 * maxEdgePx. Anything else is re-made, its orientation applied.
 */
export function jpegPassesUnchanged(bytes: Uint8Array, limits: PassThroughLimits): boolean {
  if (bytes.length > limits.maxBytes) return false;
  const frame = jpegFrameAsJayPegReadsIt(bytes);
  if (!frame) return false;
  if (frame.components !== 1 && frame.components !== 3) return false;
  return (
    frame.width >= 1 &&
    frame.height >= 1 &&
    frame.width <= limits.maxEdgePx &&
    frame.height <= limits.maxEdgePx
  );
}
