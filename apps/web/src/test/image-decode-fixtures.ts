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

/** The zlib data of eight rows of an 8 x 8 image of colour type 4 or 6
 *  (8 bits), each row starting with `filterByte`. */
function alphaRows(colourType: 4 | 6, filterByte: number): Buffer {
  const row = Buffer.alloc(1 + 8 * (colourType === 4 ? 2 : 4));
  row[0] = filterByte;
  return deflateSync(Buffer.concat(Array<Buffer>(8).fill(row)));
}

/**
 * An 8 x 8 PNG of colour type 4 (grey and alpha) or 6 (RGBA) with a tRNS
 * chunk, which the PNG specification does not allow for a colour type that
 * has an alpha channel: libpng (sharp) skips it by its length, while png-js
 * (react-pdf and pdfkit) reads none of its data for these two colour types
 * and goes on to read the chunks inside it. Inside it are four bytes, an
 * IDAT whose rows start with `hiddenFilter` and IEND; after it come the
 * file's own IDAT, with rows of filter 0, and IEND. sharp reads the file's
 * own rows; png-js reads the hidden ones, and on a filter type over 4 throws
 * inside zlib's callback. 125 bytes for colour type 6.
 */
export function pngWithIdatInsideTrns(colourType: 4 | 6, hiddenFilter: number): Buffer {
  const hidden = Buffer.concat([
    Buffer.alloc(4),
    pngChunk('IDAT', alphaRows(colourType, hiddenFilter)),
    PNG_IEND,
  ]);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngIhdr(8, 8, { colourType }),
    pngChunk('tRNS', hidden),
    pngChunk('IDAT', alphaRows(colourType, 0)),
    PNG_IEND,
  ]);
}

/** An 8 x 8 RGBA PNG with one tEXt chunk of `textBytes` bytes: a keyword, a
 *  zero byte and the rest the letter A. png-js reads a tEXt chunk's text with
 *  one function call per byte as its arguments, which past about 110,000
 *  bytes throws a RangeError, and react-pdf then draws nothing. */
export function pngWithText(textBytes: number): Buffer {
  const keyword = Buffer.from('Comment\0', 'latin1');
  return Buffer.concat([
    PNG_SIGNATURE,
    pngIhdr(8, 8),
    pngChunk('tEXt', Buffer.concat([keyword, Buffer.alloc(textBytes - keyword.length, 'A')])),
    pngChunk('IDAT', rgbaRows(8, 8)),
    PNG_IEND,
  ]);
}

/**
 * PNGs that sharp reads cleanly but react-pdf's PNG reader (png-js) reads
 * differently, or cannot read, as stored. None may reach react-pdf unchanged;
 * each is re-made by sharp, which drops the chunk png-js misreads.
 */
export const PNGS_PNG_JS_MISREADS: Readonly<Record<string, Buffer>> = {
  'an IDAT and IEND inside the tRNS chunk of an RGBA PNG': pngWithIdatInsideTrns(6, 5),
  'an IDAT and IEND inside the tRNS chunk of a grey and alpha PNG': pngWithIdatInsideTrns(4, 7),
  'a tEXt chunk of 200,000 bytes': pngWithText(200_000),
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

export interface DerivedAvifOptions {
  /** A grid of `rows` x `columns` tiles, or an overlay (iovl) of one tile at
   *  the canvas's top left corner. */
  type: 'grid' | 'iovl';
  rows?: number;
  columns?: number;
  /** Every tile's coded size (its ispe). */
  tile: [number, number];
  /** The size the derived item's own data states: a grid's output size, an
   *  overlay's canvas. libheif makes an image of this size. */
  output: [number, number];
  /** The derived item's own ispe, or null for none. */
  ispe: [number, number] | null;
  /** Where the derived item's data is: the idat box inside meta
   *  (construction method 1, as libavif writes it) or mdat (method 0, a
   *  file offset). Default idat. */
  dataIn?: 'idat' | 'mdat';
  /** The sizes in 32 bits (flags bit 0) rather than 16. Default false. */
  wide?: boolean;
  /** Item ids in 32 bits: pitm, iref and ipma version 1, iinf version 1,
   *  infe version 3, iloc version 2. Default false (16 bits). */
  ids32?: boolean;
  /** ipma's property indexes in 15 bits (flags bit 0) rather than 7. */
  ipmaWide?: boolean;
  /** Each extent's offset in iloc's base offset, the extent's own 0. */
  ilocBase?: boolean;
  /** Zero bytes in idat before the derived item's data, so its offset (or
   *  base offset, with `ilocBase`) is not 0. Default 0. */
  idatPad?: number;
  /** An overlay's fill colour: red, green, blue and alpha, 16 bits each.
   *  Default all 0xffff. */
  fill?: [number, number, number, number];
  /** One tile's AV1 configuration (av1C contents) and coded data, each tile
   *  pointing at the same data. Default a 16-byte stand-in that is not AV1,
   *  so the file can never be decoded. */
  tileData?: { av1C: Buffer; data: Buffer };
}

/** A u16 or u32 per `wide`. */
function sized(n: number, wide: boolean): Buffer {
  return wide ? u32(n) : u16(n);
}

/**
 * An AVIF whose primary item is a derived image (ISO/IEC 23008-12): a grid
 * of AV1 tiles, or an overlay of one, laid out as libavif writes one (ftyp,
 * then meta with hdlr, pitm, iloc version 1, iinf, iref dimg, iprp and
 * idat, then mdat). libheif makes the derived image at the size its data
 * states, not at its ispe. With `tileData` from a real AV1 image the file
 * decodes; with the default stand-in it never can.
 */
export function avifDerivedBoxes(opts: DerivedAvifOptions): Buffer {
  const { type, tile, output, ispe, dataIn = 'idat', wide = false } = opts;
  const { ids32 = false, ipmaWide = false, ilocBase = false, idatPad = 0 } = opts;
  const fill = opts.fill ?? [0xffff, 0xffff, 0xffff, 0xffff];
  const id = (n: number) => sized(n, ids32);
  const version = (v: number) => Buffer.from([v, 0, 0, 0]);
  const rows = type === 'grid' ? (opts.rows ?? 1) : 1;
  const columns = type === 'grid' ? (opts.columns ?? 1) : 1;
  const tiles = rows * columns;
  const derivedId = tiles + 1;
  const tileData = opts.tileData ?? {
    av1C: Buffer.from([0x81, 0x3f, 0x02, 0x00]),
    data: Buffer.alloc(16),
  };
  const flags = wide ? 1 : 0;
  const payload =
    type === 'grid'
      ? Buffer.concat([
          Buffer.from([0, flags, rows - 1, columns - 1]),
          sized(output[0], wide),
          sized(output[1], wide),
        ])
      : Buffer.concat([
          Buffer.from([0, flags]),
          ...fill.map(u16),
          sized(output[0], wide),
          sized(output[1], wide),
          sized(0, wide),
          sized(0, wide),
        ]);
  const tileIds = Array.from({ length: tiles }, (_, i) => i + 1);
  // ipco: 1 av1C, 2 the tiles' ispe, 3 pixi, 4 the derived item's ispe.
  const properties = [
    box('av1C', tileData.av1C),
    fullBox('ispe', u32(tile[0]), u32(tile[1])),
    fullBox('pixi', Buffer.from([3, 8, 8, 8])),
    ...(ispe ? [fullBox('ispe', u32(ispe[0]), u32(ispe[1]))] : []),
  ];
  /** An item's property associations: [essential, index] each. */
  const associations = (list: Array<[boolean, number]>) =>
    Buffer.concat([
      Buffer.from([list.length]),
      ...list.map(([essential, index]) =>
        ipmaWide
          ? u16((essential ? 0x8000 : 0) | index)
          : Buffer.from([(essential ? 0x80 : 0) | index]),
      ),
    ]);
  const ipmaEntries = [
    ...tileIds.map((n) =>
      Buffer.concat([
        id(n),
        associations([
          [true, 1],
          [false, 2],
          [false, 3],
        ]),
      ]),
    ),
    Buffer.concat([
      id(derivedId),
      associations(
        ispe
          ? [
              [false, 4],
              [false, 3],
            ]
          : [[false, 3]],
      ),
    ]),
  ];
  const ilocEntry = (n: number, method: number, offset: number, length: number) =>
    Buffer.concat([
      id(n),
      u16(method),
      u16(0),
      ...(ilocBase ? [u32(offset), u16(1), u32(0)] : [u16(1), u32(offset)]),
      u32(length),
    ]);
  const meta = (mdatAt: number) => {
    const payloadAt = dataIn === 'idat' ? idatPad : mdatAt + 8 + tileData.data.length;
    return fullBox(
      'meta',
      fullBox('hdlr', u32(0), Buffer.from('pict', 'latin1'), Buffer.alloc(13)),
      box('pitm', version(ids32 ? 1 : 0), id(derivedId)),
      box(
        'iloc',
        version(ids32 ? 2 : 1),
        Buffer.from([0x44, ilocBase ? 0x40 : 0x00]),
        id(tiles + 1),
        ...tileIds.map((n) => ilocEntry(n, 0, mdatAt + 8, tileData.data.length)),
        ilocEntry(derivedId, dataIn === 'idat' ? 1 : 0, payloadAt, payload.length),
      ),
      box(
        'iinf',
        version(ids32 ? 1 : 0),
        id(tiles + 1),
        ...[...tileIds, derivedId].map((n) =>
          box(
            'infe',
            version(ids32 ? 3 : 2),
            id(n),
            u16(0),
            Buffer.from(n === derivedId ? type : 'av01', 'latin1'),
            Buffer.from([0]),
          ),
        ),
      ),
      box(
        'iref',
        version(ids32 ? 1 : 0),
        box('dimg', id(derivedId), u16(tiles), ...tileIds.map((n) => id(n))),
      ),
      box(
        'iprp',
        box('ipco', ...properties),
        box(
          'ipma',
          Buffer.from([ids32 ? 1 : 0, 0, 0, ipmaWide ? 1 : 0]),
          u32(ipmaEntries.length),
          ...ipmaEntries,
        ),
      ),
      ...(dataIn === 'idat' ? [box('idat', Buffer.alloc(idatPad), payload)] : []),
    );
  };
  const ftyp = box(
    'ftyp',
    Buffer.from('avif', 'latin1'),
    u32(0),
    Buffer.from('mif1avifmiaf', 'latin1'),
  );
  const mdatAt = ftyp.length + meta(0).length;
  const mdat = box('mdat', tileData.data, ...(dataIn === 'mdat' ? [payload] : []));
  return Buffer.concat([ftyp, meta(mdatAt), mdat]);
}

/**
 * AVIFs whose primary item is a grid or an overlay whose own data states a
 * far larger image than any ispe in the file. libheif 1.23 (sharp 0.35)
 * makes the image at the size the data states before it reads a tile, so
 * the file's largest ispe does not bound the decode: with real AV1 tiles the
 * first took 1.06 GB of memory and the overlay 0.87 GB (the reviewer's
 * measurement), with the decode failing only afterwards.
 */
export const OVERSIZED_DERIVED_AVIFS: Readonly<Record<string, Buffer>> = {
  'a grid of 64 tiles of 2048 x 2048 making 16384 x 16384, its ispe 4096 x 4096': avifDerivedBoxes({
    type: 'grid',
    rows: 8,
    columns: 8,
    tile: [2048, 2048],
    output: [16384, 16384],
    ispe: [4096, 4096],
  }),
  'a grid of 64 tiles of 1024 x 1024 making 8192 x 8192, its ispe 64 x 64': avifDerivedBoxes({
    type: 'grid',
    rows: 8,
    columns: 8,
    tile: [1024, 1024],
    output: [8192, 8192],
    ispe: [64, 64],
  }),
  'an overlay of one 512 x 512 tile on a 16000 x 16000 canvas, its ispe 512 x 512':
    avifDerivedBoxes({ type: 'iovl', tile: [512, 512], output: [16000, 16000], ispe: [512, 512] }),
  // Its fill colour's green and blue are where a grid states its output
  // size, so read as a grid it is a 64 x 64 one: only the overlay rule
  // refuses it.
  'an overlay on a 16000 x 16000 canvas whose fill colour reads as a 64 x 64 grid, its ispe 64 x 64':
    avifDerivedBoxes({
      type: 'iovl',
      tile: [64, 64],
      output: [16000, 16000],
      ispe: [64, 64],
      fill: [0, 64, 64, 0xffff],
    }),
};

/**
 * `avif` with the meta box of `first` (default a plain 64 x 64 AVIF) put
 * before its own, both right after ftyp. libheif 1.23 (sharp 0.35) reads the
 * LAST top-level meta, so a decoder reading the first one would see 64 x 64
 * and pass a file libheif decodes at `avif`'s size. `avif`'s offsets into
 * mdat are not moved, so the file is never decoded here.
 */
export function avifWithAFirstMeta(avif: Buffer, first: Buffer = avifBoxes([64, 64])): Buffer {
  const metaAt = (b: Buffer) => b.readUInt32BE(0);
  const firstAt = metaAt(first);
  if (first.toString('latin1', firstAt + 4, firstAt + 8) !== 'meta') throw new Error('no meta');
  const firstMeta = first.subarray(firstAt, firstAt + first.readUInt32BE(firstAt));
  return Buffer.concat([avif.subarray(0, metaAt(avif)), firstMeta, avif.subarray(metaAt(avif))]);
}

/** Each AVIF the decoder refuses on its own, behind a first meta box that
 *  reads as a plain 64 x 64 image. */
export const AVIFS_BEHIND_A_FIRST_META: Readonly<Record<string, Buffer>> = Object.fromEntries(
  Object.entries({
    'an AVIF coded at 8192 x 8192 and cropped to 64 x 64': AVIF_8192_CROPPED_TO_64,
    ...OVERSIZED_DERIVED_AVIFS,
  }).map(([label, avif]) => [label, avifWithAFirstMeta(avif)]),
);

/**
 * An AVIF of `grids` grid items, each with a 1 x 1 ispe and the same 1 x 1
 * grid data in idat, and each with `associations` property associations in
 * ipma, its ispe last. Every size in it is 1 x 1. A decoder that walks iloc
 * and ipma again for each grid reads about grids x grids x associations
 * fields: 1024 grids of 255 associations is a 302 KB file.
 */
export function avifOfManyGrids(grids: number, associations: number): Buffer {
  const ids = Array.from({ length: grids }, (_, i) => i + 1);
  const gridData = Buffer.from([0, 0, 0, 0, 0, 1, 0, 1]);
  const meta = fullBox(
    'meta',
    fullBox('hdlr', u32(0), Buffer.from('pict', 'latin1'), Buffer.alloc(13)),
    fullBox('pitm', u16(1)),
    box(
      'iloc',
      Buffer.from([1, 0, 0, 0, 0x44, 0x00]),
      u16(grids),
      ...ids.map((n) => Buffer.concat([u16(n), u16(1), u16(0), u16(1), u32(0), u32(8)])),
    ),
    fullBox(
      'iinf',
      u16(grids),
      ...ids.map((n) =>
        box('infe', Buffer.from([2, 0, 0, 0]), u16(n), u16(0), Buffer.from('grid\0', 'latin1')),
      ),
    ),
    box(
      'iprp',
      box('ipco', fullBox('ispe', u32(1), u32(1))),
      fullBox(
        'ipma',
        u32(grids),
        ...ids.map((n) =>
          Buffer.concat([
            u16(n),
            Buffer.from([associations]),
            Buffer.alloc(associations - 1),
            Buffer.from([1]),
          ]),
        ),
      ),
    ),
    box('idat', gridData),
  );
  const ftyp = box(
    'ftyp',
    Buffer.from('avif', 'latin1'),
    u32(0),
    Buffer.from('mif1avifmiaf', 'latin1'),
  );
  return Buffer.concat([ftyp, meta]);
}

/** The av1C contents and the coded data of a single-item AVIF made by
 *  sharp, for avifDerivedBoxes' tiles. */
export function av1TileOf(avif: Buffer): { av1C: Buffer; data: Buffer } {
  const boxAt = (type: string) => avif.indexOf(Buffer.from(type, 'latin1')) - 4;
  const contents = (at: number) => avif.subarray(at + 8, at + avif.readUInt32BE(at));
  return { av1C: contents(boxAt('av1C')), data: contents(boxAt('mdat')) };
}

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
  ...Object.values(OVERSIZED_DERIVED_AVIFS),
  ...Object.values(AVIFS_BEHIND_A_FIRST_META),
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
