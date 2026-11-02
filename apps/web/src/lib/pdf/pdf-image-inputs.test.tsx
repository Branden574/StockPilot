/* eslint-disable jsx-a11y/alt-text -- react-pdf's Image has no alt */
import { Document, Image, Page, renderToBuffer, View } from '@react-pdf/renderer';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

import { fetchExportImageBytes } from '@/lib/exports/export-images';
import {
  EXIF_JPEGS,
  MALFORMED_PNGS,
  PNGS_PNG_JS_MISREADS,
  SLOW_TO_PARSE_JPEGS,
} from '@/test/image-decode-fixtures';
import { countInPdf, STORAGE_PHOTO_URL, withStoragePhoto } from '@/test/see-through-images';

import { BrandedHeader } from './branding';
import { prefetchImagesAsDataUris, prefetchPdfLogo } from './image-prefetch';
import { toPdfImageSrc } from './inventory-export-pdf';

/**
 * Images in PDFs (S45): what each PDF path hands react-pdf for a stored file,
 * and that the document then renders. The three paths are an item photo on
 * a slip or report (prefetchImagesAsDataUris), the organization's logo in a
 * branded header (prefetchPdfLogo, BrandedHeader) and a photo in the Items
 * and Books PDF export (fetchExportImageBytes, toPdfImageSrc).
 *
 * For PNG and JPEG files whose chunks or segments do not hold what their
 * header states, or that react-pdf's readers (png-js, jay-peg) would throw
 * on out of reach of any catch or take far longer over than a photo, each
 * path first gives no image (that is asserted before any
 * render, so a run against code that passes such bytes on stops there); the
 * document then renders with the placeholder or no logo. A PNG that sharp
 * reads cleanly but png-js would read otherwise (chunks inside a tRNS chunk
 * of a colour type with alpha; a tEXt chunk too long for png-js) is re-made
 * first: each path gives an image that is not the stored file (asserted
 * before any render), and the document renders it. Ordinary PNG and JPEG
 * files still render one image.
 */

// The prefetch's data-URI cache needs a Next request scope; here it calls
// straight through.
vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
}));

type Path = 'photo' | 'logo' | 'export';

/** What the path gives react-pdf for `bytes`, or null for no image. */
async function boundary(
  path: Path,
  bytes: Buffer,
  contentType: string,
): Promise<string | { data: Buffer; format: 'png' | 'jpg' } | null> {
  if (path === 'export') {
    const fetchImpl = vi.fn(
      async () =>
        new Response(new Uint8Array(bytes), {
          status: 200,
          headers: { 'content-type': contentType },
        }),
    );
    const { images } = await fetchExportImageBytes(
      new Map([['a', 'https://signed.example/a.img']]),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    return toPdfImageSrc(images.get('a'));
  }
  return withStoragePhoto({ label: 'stored', bytes, contentType }, async () =>
    path === 'logo'
      ? prefetchPdfLogo(STORAGE_PHOTO_URL)
      : ((await prefetchImagesAsDataUris([['a', STORAGE_PHOTO_URL] as const])).get('a') ?? null),
  );
}

/** A one-image document for the path: the header for the logo, else a
 *  slip-like cell holding the photo or its placeholder square. */
async function render(path: Path, src: Awaited<ReturnType<typeof boundary>>): Promise<Buffer> {
  const cell = { width: 38, height: 38 };
  return renderToBuffer(
    <Document>
      <Page size="A6">
        {path === 'logo' ? (
          <BrandedHeader
            orgName="Example Org"
            orgLogoUrl={typeof src === 'string' ? src : null}
            title="Images"
          />
        ) : src ? (
          <Image src={src} style={cell} />
        ) : (
          <View style={{ ...cell, backgroundColor: '#eeeeee' }} />
        )}
      </Page>
    </Document>,
  );
}

const PATHS: readonly Path[] = ['photo', 'logo', 'export'];

const CHECKED = [
  ...Object.entries(MALFORMED_PNGS).map(([label, bytes]) => [label, bytes, 'image/png'] as const),
  ...Object.entries(EXIF_JPEGS).map(([label, bytes]) => [label, bytes, 'image/jpeg'] as const),
  ...Object.entries(SLOW_TO_PARSE_JPEGS).map(
    ([label, bytes]) => [label, bytes, 'image/jpeg'] as const,
  ),
];

describe('images in PDFs (S45)', () => {
  for (const path of PATHS) {
    it.each(CHECKED)(
      `${path}: %s gives no image, and the document renders without one`,
      async (_label, bytes, contentType) => {
        const src = await boundary(path, bytes, contentType);
        expect(src).toBeNull();
        const pdf = await render(path, src);
        expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
        expect(countInPdf(pdf, '/Subtype /Image')).toBe(0);
      },
      10_000,
    );
  }

  /** Whether `src` hands react-pdf `bytes` exactly as stored. */
  function isStored(src: Awaited<ReturnType<typeof boundary>>, bytes: Buffer): boolean {
    if (typeof src === 'string')
      return Buffer.from(src.split(',')[1] ?? '', 'base64').equals(bytes);
    return src !== null && Buffer.from(src.data).equals(bytes);
  }

  for (const path of PATHS) {
    it.each(Object.entries(PNGS_PNG_JS_MISREADS))(
      `${path}: %s is re-made, and the document renders it`,
      async (_label, bytes) => {
        const src = await boundary(path, bytes, 'image/png');
        expect(src).not.toBeNull();
        expect(isStored(src, bytes)).toBe(false);
        const pdf = await render(path, src);
        expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
        // The image, and its soft mask: these files are see-through.
        expect(countInPdf(pdf, '/Subtype /Image')).toBeGreaterThan(0);
      },
      10_000,
    );
  }

  it.each(PATHS)(
    '%s: an 8 x 8 PNG, an 8 x 8 JPEG and a 400 px PNG each render one image',
    async (path) => {
      // Opaque, so each is one image object (a see-through PNG adds its soft
      // mask as a second).
      const controls = [
        [
          await sharp({ create: { width: 8, height: 8, channels: 3, background: '#c81e1e' } })
            .png()
            .toBuffer(),
          'image/png',
        ],
        [
          await sharp({ create: { width: 8, height: 8, channels: 3, background: '#c81e1e' } })
            .jpeg()
            .toBuffer(),
          'image/jpeg',
        ],
        [
          await sharp({ create: { width: 400, height: 300, channels: 3, background: '#c81e1e' } })
            .png()
            .toBuffer(),
          'image/png',
        ],
      ] as const;
      for (const [bytes, contentType] of controls) {
        const src = await boundary(path, bytes, contentType);
        expect(src, contentType).not.toBeNull();
        expect(countInPdf(await render(path, src), '/Subtype /Image'), contentType).toBe(1);
      }
    },
    30_000,
  );
});
