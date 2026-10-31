import { inflateSync } from 'node:zlib';

import sharp from 'sharp';
import { vi } from 'vitest';

/**
 * Photos with a see-through background, and readers for what a rendered PDF
 * embedded (B62). Shared by the PDF image prefetch tests and the slip render
 * tests, so every path is fed the same images.
 *
 * Each image is SEE_THROUGH_SIZE square, fully transparent except an opaque
 * red square in its middle half, built from raw RGBA so the colour hidden
 * under the transparency is chosen. libvips paints a transparent pixel black
 * on a JPEG save whatever colour it hides, so both black and white are used.
 */
export const SEE_THROUGH_SIZE = 64;

const RED = [200, 30, 30] as const;

export type SeeThroughFormat = 'webp-lossy' | 'webp-lossless' | 'avif' | 'gif' | 'png';

export type HiddenColour = 'black' | 'white';

/** Every format the PDF prefetch converts to JPEG (PNG and JPEG pass through). */
export const CONVERTED_FORMATS: readonly SeeThroughFormat[] = [
  'webp-lossy',
  'webp-lossless',
  'avif',
  'gif',
];

export const HIDDEN_COLOURS: readonly HiddenColour[] = ['black', 'white'];

function seeThroughRgba(hidden: HiddenColour): Buffer {
  const size = SEE_THROUGH_SIZE;
  const under = hidden === 'black' ? 0 : 255;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inPhoto = x >= size / 4 && x < (size * 3) / 4 && y >= size / 4 && y < (size * 3) / 4;
      px.set(inPhoto ? [...RED, 255] : [under, under, under, 0], i);
    }
  }
  return px;
}

export interface SeeThroughImage {
  label: string;
  bytes: Buffer;
  contentType: string;
}

export async function seeThroughImage(
  format: SeeThroughFormat,
  hidden: HiddenColour = 'black',
): Promise<SeeThroughImage> {
  const size = SEE_THROUGH_SIZE;
  const img = sharp(seeThroughRgba(hidden), { raw: { width: size, height: size, channels: 4 } });
  const encoded = {
    'webp-lossy': () => img.webp({ quality: 80 }),
    'webp-lossless': () => img.webp({ lossless: true }),
    avif: () => img.avif(),
    gif: () => img.gif(),
    png: () => img.png(),
  }[format]();
  const contentType = {
    'webp-lossy': 'image/webp',
    'webp-lossless': 'image/webp',
    avif: 'image/avif',
    gif: 'image/gif',
    png: 'image/png',
  }[format];
  return { label: `${format} over ${hidden}`, bytes: await encoded.toBuffer(), contentType };
}

/** The red, green and blue of one pixel of an encoded image. */
export async function rgbAt(bytes: Buffer, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i]!, data[i + 1]!, data[i + 2]!];
}

/** Where a printed photo was see-through, it must be white (never black). */
export const isWhite = (rgb: number[]) => rgb.every((v) => v >= 250);

/** The photo itself must still be red. */
export const isRed = ([r, g, b]: number[]) => r! >= 180 && g! <= 60 && b! <= 60;

/** How many times a PDF's bytes contain `token` (for example /DCTDecode). */
export function countInPdf(pdf: Buffer, token: string): number {
  return pdf.toString('latin1').split(token).length - 1;
}

/** The JPEG a PDF embeds as it is (/DCTDecode): from the FF D8 FF marker
 *  that starts its stream to the next endstream. The search starts at the
 *  image's dictionary, so those bytes inside an earlier compressed stream
 *  cannot be taken for it. */
export function embeddedJpeg(pdf: Buffer): Buffer {
  const dictionary = pdf.indexOf('/DCTDecode');
  if (dictionary === -1) throw new Error('the PDF embeds no JPEG');
  const start = pdf.indexOf(Buffer.from([0xff, 0xd8, 0xff]), dictionary);
  return pdf.subarray(start, pdf.indexOf('endstream', start));
}

/**
 * The soft mask of the image a PDF draws with one (/SMask N 0 R): object N's
 * stream inflated, one alpha byte per pixel, row by row. 0 is see-through
 * (the page shows), 255 is opaque.
 */
export function softMask(pdf: Buffer): Buffer {
  const text = pdf.toString('latin1');
  const ref = /\/SMask (\d+) 0 R/.exec(text);
  if (!ref) throw new Error('the PDF draws no image with a soft mask');
  const obj = new RegExp(`(?:^|\\n)${ref[1]} 0 obj\\b`).exec(text);
  if (!obj) throw new Error(`soft mask object ${ref[1]} not found`);
  let data = text.indexOf('stream', obj.index) + 'stream'.length;
  if (text[data] === '\r') data += 1;
  if (text[data] === '\n') data += 1;
  return inflateSync(pdf.subarray(data, text.indexOf('endstream', data)));
}

export const STORAGE_ORIGIN = 'https://proj.supabase.test';
export const STORAGE_PHOTO_URL = `${STORAGE_ORIGIN}/storage/v1/object/sign/item-images/org-1/item-1/thumb.webp?token=t`;

/**
 * Runs `run` while STORAGE_PHOTO_URL answers with `image`, as the project's
 * storage would. Any other request but a data: URL (react-pdf loads its layout
 * engine from one) fails the test.
 */
export async function withStoragePhoto<T>(
  image: SeeThroughImage,
  run: () => Promise<T>,
): Promise<T> {
  const realFetch = globalThis.fetch;
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', STORAGE_ORIGIN);
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('data:')) return realFetch(input, init);
    if (url === STORAGE_PHOTO_URL) {
      return new Response(new Uint8Array(image.bytes), {
        status: 200,
        headers: { 'content-type': image.contentType },
      });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  try {
    return await run();
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
}
