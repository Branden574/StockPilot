// SSRF: the PDF image prefetch. Storage URLs are fetched as before; any other
// URL goes through safeFetch with the book-cover host allowlist (pinned IP,
// every redirect hop re-validated), so a staff-editable legacy
// custom_fields.thumbnail_url can no longer make the server fetch an internal
// host. A body over the byte cap is refused (advertised or streamed). The
// optional downscale fits inside the box and has its own cache key. A photo
// with a see-through background prints on white, never on black (B62). Every
// decode goes through the capped decoder, and PNG and JPEG bytes reach
// react-pdf unchanged only when its structure checks pass (S45).
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AVIF_8192_CROPPED_TO_64,
  EXIF_JPEGS,
  gifHeader,
  IMAGE_LOOKALIKE_SVGS,
  MALFORMED_PNGS,
  pngWithOversizedData,
  SLOW_TO_PARSE_JPEGS,
  SVG_16000,
  SVG_UNDER_A_WEBP_HEADER,
  WEBP_100_BY_1000000,
  WEBP_7072,
} from '@/test/image-decode-fixtures';
import {
  CONVERTED_FORMATS,
  HIDDEN_COLOURS,
  isRed,
  isWhite,
  rgbAt,
  SEE_THROUGH_SIZE,
  seeThroughImage,
  type SeeThroughImage,
} from '@/test/see-through-images';

const { cacheKeys, cachedFns, safeFetch, sharpCalls } = vi.hoisted(() => ({
  cacheKeys: [] as string[][],
  // The function each cache key wraps, so a test can see what it would store.
  cachedFns: new Map<string, (...args: unknown[]) => unknown>(),
  safeFetch: vi.fn(),
  /** Every sharp(...) call's arguments, the real sharp doing the work. */
  sharpCalls: [] as unknown[][],
}));
vi.mock('sharp', async (importOriginal) => {
  const { recordingSharp } = await import('@/test/image-decode-fixtures');
  const real = (await importOriginal<{ default: (...a: never[]) => unknown }>()).default;
  return { default: recordingSharp(real, sharpCalls) };
});
vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown, keyParts: string[]) => {
    cacheKeys.push(keyParts);
    cachedFns.set(keyParts.join('|'), fn);
    return fn;
  },
}));
vi.mock('@/lib/ssrf-guard', () => ({ safeFetch: (...args: unknown[]) => safeFetch(...args) }));

import { COVER_HOST_ALLOWLIST } from '@/lib/books/cover-hosts';

import {
  pdfImageFetchRoute,
  pdfImageLogLabel,
  prefetchImagesAsDataUris,
  prefetchPdfLogo,
  PDF_IMAGE_MAX_BYTES,
  PDF_IMAGE_TIMEOUT_MS,
} from './image-prefetch';

const STORAGE = 'https://proj.supabase.co';
const SIGNED = `${STORAGE}/storage/v1/object/sign/item-images/org/item/cover.jpg?token=secret-token`;

async function png(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0.5 } },
  })
    .png()
    .toBuffer();
}

function response(bytes: Buffer | Uint8Array, headers: Record<string, string> = {}) {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': 'image/png', ...headers },
  });
}

/** sharp calls made with `input` as the image (the tests' own calls make
 *  fixtures from `create` or raw pixels, or read results back). */
function callsWith(input: Uint8Array): unknown[][] {
  const bytes = Buffer.from(input);
  return sharpCalls.filter(
    ([first]) => first instanceof Uint8Array && Buffer.from(first).equals(bytes),
  );
}

/** A `side` square PNG, see-through but for an opaque red middle half. */
async function seeThroughPng(side: number): Promise<Buffer> {
  const half = side / 2;
  return sharp({
    create: { width: side, height: side, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      {
        input: {
          create: {
            width: half,
            height: half,
            channels: 4,
            background: { r: 200, g: 30, b: 30, alpha: 1 },
          },
        },
        top: side / 4,
        left: side / 4,
      },
    ])
    .png()
    .toBuffer();
}

function bytesOf(uri: string | null | undefined): Buffer {
  expect(uri).toMatch(/^data:image\/(png|jpeg);base64,/);
  return Buffer.from(uri!.split(',')[1]!, 'base64');
}

/** Format, size, orientation tag and the alpha of the top-left pixel. */
async function described(bytes: Buffer) {
  const meta = await sharp(bytes).metadata();
  const { data } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    format: meta.format,
    width: meta.width,
    height: meta.height,
    orientation: meta.orientation,
    cornerAlpha: data[3],
  };
}

const fetchSpy = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_SUPABASE_URL = STORAGE;
  vi.stubGlobal('fetch', fetchSpy);
});

describe('which fetch a URL gets', () => {
  it('routes the storage origin to fetch and everything else through the guard', () => {
    expect(pdfImageFetchRoute(SIGNED)).toBe('storage');
    expect(pdfImageFetchRoute('https://covers.openlibrary.org/b/id/1-L.jpg')).toBe('external');
    expect(pdfImageFetchRoute('http://169.254.169.254/latest')).toBe('external');
    expect(pdfImageFetchRoute('file:///etc/passwd')).toBeNull();
    expect(pdfImageFetchRoute('not a url')).toBeNull();
  });
  it('never logs a signed token or an external path', () => {
    expect(pdfImageLogLabel(SIGNED)).not.toContain('token');
    expect(pdfImageLogLabel('https://evil.example/a/b?c=d')).toBe('host evil.example');
  });
});

describe('prefetchImagesAsDataUris', () => {
  it('fetches a storage URL with plain fetch (existing callers unchanged)', async () => {
    fetchSpy.mockResolvedValue(response(await png(4, 4)));
    const out = await prefetchImagesAsDataUris([['a', SIGNED] as const]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(safeFetch).not.toHaveBeenCalled();
    expect(out.get('a')).toMatch(/^data:image\/png;base64,/);
  });
  it('sends any other origin through safeFetch with the cover allowlist, never plain fetch', async () => {
    safeFetch.mockResolvedValue(response(await png(4, 4)));
    const url = 'https://ia800000.us.archive.org/view/cover.jpg';
    const out = await prefetchImagesAsDataUris([['b', url] as const]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(safeFetch).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ hostAllowlist: COVER_HOST_ALLOWLIST }),
    );
    expect(out.get('b')).toMatch(/^data:image\/png;base64,/);
  });
  it('a host the guard refuses is a placeholder (null), not an error', async () => {
    safeFetch.mockRejectedValue(new Error('host not on allowlist: 169.254.169.254'));
    const out = await prefetchImagesAsDataUris([
      ['c', 'http://169.254.169.254/latest/meta-data'] as const,
    ]);
    expect(out.get('c')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('refuses a body over the byte cap, advertised or streamed', async () => {
    fetchSpy.mockResolvedValueOnce(
      response(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0]), {
        'content-length': String(PDF_IMAGE_MAX_BYTES + 1),
      }),
    );
    const big = new Uint8Array(PDF_IMAGE_MAX_BYTES + 10);
    big.set([0x89, 0x50, 0x4e, 0x47]);
    fetchSpy.mockResolvedValueOnce(new Response(new Blob([big]).stream(), { status: 200 }));
    const out = await prefetchImagesAsDataUris([
      ['advertised', SIGNED] as const,
      ['streamed', `${SIGNED}&2`] as const,
    ]);
    expect(out.get('advertised')).toBeNull();
    expect(out.get('streamed')).toBeNull();
  });
  it('maxEdgePx fits the image inside the box (aspect kept, never enlarged) as a JPEG', async () => {
    fetchSpy.mockResolvedValueOnce(response(await png(1000, 1500)));
    fetchSpy.mockResolvedValueOnce(response(await png(60, 90)));
    const out = await prefetchImagesAsDataUris(
      [['big', SIGNED] as const, ['small', `${SIGNED}&small`] as const],
      { maxEdgePx: 240 },
    );
    const meta = async (uri: string | null | undefined) => {
      expect(uri).toMatch(/^data:image\/jpeg;base64,/);
      return sharp(Buffer.from(uri!.split(',')[1]!, 'base64')).metadata();
    };
    const big = await meta(out.get('big'));
    expect([big.width, big.height]).toEqual([160, 240]);
    const small = await meta(out.get('small'));
    expect([small.width, small.height]).toEqual([60, 90]);
  });
  // B62: the unsized entries stored before the flatten hold see-through photos
  // on a black square for up to 25 days, so that key moved to v7 (nothing
  // calls revalidateTag on these entries). S45: v7 entries hold PNG and JPEG
  // bytes exactly as they were fetched, before the structure checks, so the
  // key moved to v8. The sized path's output was always sharp's own JPEG, so
  // its v6 entries stay.
  it('the unsized key is v8, so nothing stored under v7 or v5 is served; the sized key stays v6', () => {
    expect(cacheKeys).toEqual(
      expect.arrayContaining([['pdf-image-data-uri-v8'], ['pdf-image-data-uri-v6']]),
    );
    expect(cacheKeys).not.toContainEqual(['pdf-image-data-uri-v7']);
    expect(cacheKeys).not.toContainEqual(['pdf-image-data-uri-v5']);
  });
});

/**
 * B62: a photo with a see-through background printed on a black square in
 * the pick slip, both packing slips and the report PDFs. JPEG has no
 * transparency, and libvips paints a transparent pixel black on a JPEG save
 * (even one that hides white), so every JPEG this helper makes flattens onto
 * white first, as the sized path always did. PNG and JPEG still pass through
 * unchanged: react-pdf keeps a PNG's transparency, so the page shows through.
 */
describe('photos with a see-through background (B62)', () => {
  async function convertedSet(): Promise<SeeThroughImage[]> {
    const out: SeeThroughImage[] = [];
    for (const format of CONVERTED_FORMATS) {
      for (const hidden of HIDDEN_COLOURS) out.push(await seeThroughImage(format, hidden));
    }
    return out;
  }

  /** Each image at its own URL, answered by URL (the worker pool fetches them
   *  in any order), all in one batch. */
  async function prefetchAll(images: SeeThroughImage[], opts?: { maxEdgePx?: number }) {
    const urlOf = (i: number) => `${SIGNED}&photo=${i}`;
    fetchSpy.mockImplementation(async (url: string) => {
      const image = images.find((_, i) => urlOf(i) === url);
      if (!image) throw new Error(`unexpected request: ${url}`);
      return response(image.bytes, { 'content-type': image.contentType });
    });
    const out = await prefetchImagesAsDataUris(
      images.map((image, i) => [image.label, urlOf(i)] as const),
      opts,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(images.length);
    return out;
  }

  /** What went wrong for each image that did not print as a JPEG on white
   *  with its red photo kept; empty when every one did. */
  async function notOnWhite(images: SeeThroughImage[], out: Map<string, string | null>) {
    const wrong: string[] = [];
    const middle = SEE_THROUGH_SIZE / 2;
    for (const { label } of images) {
      const uri = out.get(label);
      if (!uri?.startsWith('data:image/jpeg;base64,')) {
        wrong.push(`${label}: ${uri === null ? 'no image' : uri?.slice(0, 24)}`);
        continue;
      }
      const jpeg = Buffer.from(uri.split(',')[1]!, 'base64');
      const corner = await rgbAt(jpeg, 0, 0);
      const centre = await rgbAt(jpeg, middle, middle);
      if (!isWhite(corner)) wrong.push(`${label}: corner ${corner.join(',')}`);
      if (!isRed(centre)) wrong.push(`${label}: centre ${centre.join(',')}`);
    }
    return wrong;
  }

  it('WebP (lossy and lossless), AVIF and GIF print on white with the photo kept', async () => {
    const images = await convertedSet();
    expect(images).toHaveLength(8);
    expect(await notOnWhite(images, await prefetchAll(images))).toEqual([]);
  });

  // The same images through the sized path (Book Order Totals covers), which
  // has always flattened: one fixture set for both paths.
  it('the sized path prints the same images on white too', async () => {
    const images = await convertedSet();
    expect(await notOnWhite(images, await prefetchAll(images, { maxEdgePx: 240 }))).toEqual([]);
  });

  it('a see-through PNG comes back unchanged, its transparency kept', async () => {
    const png = await seeThroughImage('png');
    const out = await prefetchAll([png]);
    expect(out.get(png.label)).toBe(`data:image/png;base64,${png.bytes.toString('base64')}`);
  });

  // Ordinary photos do not change: a photo with nothing see-through makes the
  // same JPEG as before the flatten, and the sized path the same bytes as
  // before (so its v6 cache entries stay valid).
  it('an opaque photo gives the bytes it gave before', async () => {
    const opaque = await sharp({
      create: { width: 48, height: 32, channels: 3, background: { r: 30, g: 90, b: 160 } },
    })
      .webp({ quality: 80 })
      .toBuffer();
    const image = { label: 'opaque webp', bytes: opaque, contentType: 'image/webp' };
    const before = await sharp(opaque).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
    const out = await prefetchAll([image]);
    expect(out.get(image.label)).toBe(`data:image/jpeg;base64,${before.toString('base64')}`);
  });

  it('the sized path makes the bytes it made before for a see-through photo', async () => {
    const webp = await seeThroughImage('webp-lossy');
    const before = await sharp(webp.bytes)
      .resize({ width: 40, height: 40, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 75, mozjpeg: true })
      .toBuffer();
    const out = await prefetchAll([webp], { maxEdgePx: 40 });
    expect(out.get(webp.label)).toBe(`data:image/jpeg;base64,${before.toString('base64')}`);
  });
});

/**
 * S45: every photo the PDF prefetch decodes goes through the capped decoder
 * (lib/image-decode.ts), at most 400 px on its longest edge. PNG and JPEG
 * reach react-pdf unchanged only when their structure checks pass and they
 * are within 400 px and 1 MiB; any other PNG is re-made as a PNG and
 * anything else as a JPEG on white. Bytes that are not a PNG, JPEG, WebP,
 * GIF or AVIF, and sizes over the decoder's caps, print the placeholder.
 */
describe('photos through the capped decoder (S45)', () => {
  const CHECKED = { ...MALFORMED_PNGS, ...EXIF_JPEGS, ...SLOW_TO_PARSE_JPEGS };

  async function prefetchOne(bytes: Buffer, contentType = 'image/png', url = SIGNED) {
    // A fresh answer for each request: the cached function is called again below.
    const answer = async () => response(bytes, { 'content-type': contentType });
    if (pdfImageFetchRoute(url) === 'storage') fetchSpy.mockImplementation(answer);
    else safeFetch.mockImplementation(answer);
    return (await prefetchImagesAsDataUris([['a', url] as const])).get('a');
  }

  it.each(Object.entries(CHECKED))(
    'from storage, %s: no image, and the cached function stores nothing',
    async (_label, bytes) => {
      const uri = await prefetchOne(bytes);
      expect(uri).toBeNull();
      const cached = cachedFns.get('pdf-image-data-uri-v8');
      expect(cached).toBeDefined();
      await expect(cached!(SIGNED)).rejects.toThrow();
    },
  );

  it.each(Object.entries(CHECKED))('from a cover host, %s: no image', async (_label, bytes) => {
    const uri = await prefetchOne(
      bytes,
      'image/jpeg',
      'https://covers.openlibrary.org/b/id/1-L.jpg',
    );
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(uri).toBeNull();
  });

  it('a WebP, GIF or AVIF whose header states more pixels than the cap: no image, and sharp is not called', async () => {
    for (const bytes of [
      WEBP_7072,
      WEBP_100_BY_1000000,
      gifHeader(4097, 4096),
      AVIF_8192_CROPPED_TO_64,
    ]) {
      sharpCalls.length = 0;
      expect(await prefetchOne(bytes, 'image/webp')).toBeNull();
      expect(callsWith(bytes)).toEqual([]);
    }
  });

  it('SVG, SVG that the upload sniffer calls AVIF, and TIFF: no image, and sharp is not called', async () => {
    const tiff = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 30, b: 30 } },
    })
      .tiff()
      .toBuffer();
    for (const bytes of [
      SVG_16000,
      IMAGE_LOOKALIKE_SVGS['SVG after a comment holding ftypavif']!,
      tiff,
    ]) {
      sharpCalls.length = 0;
      expect(await prefetchOne(bytes, 'image/webp')).toBeNull();
      expect(callsWith(bytes)).toEqual([]);
    }
  });

  it('photos over 400 px are printed from a copy at most 400 px on its longest edge', async () => {
    const webp = await sharp({
      create: { width: 1000, height: 1500, channels: 3, background: { r: 30, g: 90, b: 160 } },
    })
      .webp()
      .toBuffer();
    expect(await described(bytesOf(await prefetchOne(webp, 'image/webp')))).toMatchObject({
      format: 'jpeg',
      width: 267,
      height: 400,
    });
    const jpeg = await sharp({
      create: { width: 2000, height: 1000, channels: 3, background: { r: 30, g: 90, b: 160 } },
    })
      .jpeg()
      .toBuffer();
    expect(await described(bytesOf(await prefetchOne(jpeg, 'image/jpeg')))).toMatchObject({
      format: 'jpeg',
      width: 400,
      height: 200,
    });
  });

  it('a see-through PNG over 400 px stays a PNG at 400 px, its transparency kept', async () => {
    const out = await described(bytesOf(await prefetchOne(await seeThroughPng(4096))));
    expect(out).toMatchObject({ format: 'png', width: 400, height: 400, cornerAlpha: 0 });
  }, 30_000);

  it('a PNG whose data inflates past its rows is re-made: a fresh 64 x 64 PNG', async () => {
    const bytes = pngWithOversizedData();
    const printed = bytesOf(await prefetchOne(bytes));
    expect(printed.equals(bytes)).toBe(false);
    expect(await described(printed)).toMatchObject({ format: 'png', width: 64, height: 64 });
  });

  it('applies the EXIF orientation: photos stored on their side print upright', async () => {
    const make = () =>
      sharp({
        create: { width: 600, height: 400, channels: 3, background: { r: 30, g: 90, b: 160 } },
      });
    const webp = await make().webp().withMetadata({ orientation: 6 }).toBuffer();
    const jpeg = await make().jpeg().withMetadata({ orientation: 6 }).toBuffer();
    for (const [bytes, type] of [
      [webp, 'image/webp'],
      [jpeg, 'image/jpeg'],
    ] as const) {
      expect((await sharp(bytes).metadata()).orientation, type).toBe(6);
      expect(await described(bytesOf(await prefetchOne(bytes, type))), type).toMatchObject({
        format: 'jpeg',
        width: 267,
        height: 400,
        orientation: undefined,
      });
    }
  });

  it('every decode opens sharp with the cap of its format and the orientation applied', async () => {
    const inputs: Array<[Buffer, number]> = [
      [
        await sharp({ create: { width: 900, height: 600, channels: 3, background: '#123456' } })
          .webp()
          .toBuffer(),
        50_000_000,
      ],
      [
        await sharp({ create: { width: 900, height: 600, channels: 3, background: '#123456' } })
          .jpeg()
          .toBuffer(),
        50_000_000,
      ],
      [await seeThroughPng(512), 50_000_000],
      [
        await sharp({ create: { width: 64, height: 64, channels: 3, background: '#123456' } })
          .avif({ effort: 0 })
          .toBuffer(),
        16_777_216,
      ],
      [
        await sharp({ create: { width: 64, height: 64, channels: 4, background: '#12345680' } })
          .gif()
          .toBuffer(),
        16_777_216,
      ],
    ];
    for (const [bytes, cap] of inputs) {
      sharpCalls.length = 0;
      expect(await prefetchOne(bytes, 'image/webp')).toMatch(/^data:image\/(png|jpeg);base64,/);
      const calls = callsWith(bytes);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls)
        expect(call[1]).toEqual({ limitInputPixels: cap, autoOrient: true });
    }
  });

  it('the sized path (Book Order Totals covers) refuses an AVIF over 4096 x 4096 before sharp', async () => {
    const avif = await sharp({
      create: { width: 4096, height: 4097, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .avif({ effort: 0 })
      .toBuffer();
    fetchSpy.mockResolvedValue(response(avif, { 'content-type': 'image/avif' }));
    sharpCalls.length = 0;
    const out = await prefetchImagesAsDataUris([['cover', SIGNED] as const], { maxEdgePx: 40 });
    expect(out.get('cover')).toBeNull();
    expect(callsWith(avif)).toEqual([]);
    // Nor one coded over the cap and cropped under it.
    fetchSpy.mockResolvedValue(response(AVIF_8192_CROPPED_TO_64, { 'content-type': 'image/avif' }));
    const cropped = await prefetchImagesAsDataUris([['cover', SIGNED] as const], { maxEdgePx: 40 });
    expect(cropped.get('cover')).toBeNull();
    expect(callsWith(AVIF_8192_CROPPED_TO_64)).toEqual([]);
  }, 30_000);
});

/**
 * SSRF: an organization's logo for a branded PDF header. logo_url is set by an
 * org owner or admin and the database does not hold it to the logo bucket the
 * settings action checks, so it is fetched like an item image (a Storage read
 * on the project origin by plain fetch that never follows a redirect, any
 * other URL only through safeFetch with the cover allowlist, anything else
 * refused before a request) and react-pdf is handed the bytes. A PNG or JPEG
 * logo within 1024 px and 1 MiB whose structure checks pass is returned
 * unchanged, so it prints as it did; any other PNG, JPEG, WebP or AVIF logo is
 * re-made by the capped decoder as a PNG at most 512 px, its transparency
 * kept (S45). An SVG logo, which react-pdf also drew from a URL, is refused
 * like any other format (the uploader has refused SVG since 2026-05-09).
 */
describe('prefetchPdfLogo', () => {
  const LOGO = `${STORAGE}/storage/v1/object/public/org-logos/org-1/logo-1.png`;

  it('fetches a logo in the project storage with plain fetch and returns its PNG bytes unchanged', async () => {
    const bytes = await png(4, 4);
    fetchSpy.mockResolvedValue(response(bytes));
    const uri = await prefetchPdfLogo(LOGO);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![0]).toBe(LOGO);
    expect(safeFetch).not.toHaveBeenCalled();
    expect(uri).toBe(`data:image/png;base64,${bytes.toString('base64')}`);
  });

  it('returns JPEG bytes unchanged', async () => {
    const bytes = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toBuffer();
    fetchSpy.mockResolvedValue(response(bytes, { 'content-type': 'image/jpeg' }));
    expect(await prefetchPdfLogo(LOGO)).toBe(`data:image/jpeg;base64,${bytes.toString('base64')}`);
  });

  it('draws no logo, and makes no request, for no value or a value that is not an http(s) URL', async () => {
    for (const value of [null, undefined, '', '   ']) {
      expect(await prefetchPdfLogo(value)).toBeNull();
    }
    for (const value of ['/var/task/logo.png', 'logo.png', 'file:///etc/hosts']) {
      expect(await prefetchPdfLogo(value)).toBeNull();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('sends any other host through safeFetch with the cover allowlist; a refusal is no logo', async () => {
    safeFetch.mockRejectedValue(new Error('host not on allowlist: 169.254.169.254'));
    const url = 'http://169.254.169.254/latest/meta-data/';
    expect(await prefetchPdfLogo(url)).toBeNull();
    expect(safeFetch).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        hostAllowlist: COVER_HOST_ALLOWLIST,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Plain fetch is for a Storage read on the exact project origin. Another
  // project's host, or a path on ours that is not a Storage read (GoTrue's
  // /auth/v1/verify answers a bogus token with a 303 to an allow-listed
  // redirect_to), is a host like any other: the guard and the cover allowlist.
  it('decides storage for a logo by the exact project origin and a Storage read path', async () => {
    safeFetch.mockRejectedValue(new Error('host not on allowlist'));
    for (const url of [
      'https://other-ref.supabase.co/storage/v1/object/public/org-logos/org-1/logo-1.png',
      `${STORAGE}/auth/v1/verify?type=signup&token=bogus&redirect_to=https%3A%2F%2Fpreview.example.test%2Fauth%2Fcallback`,
    ]) {
      expect(await prefetchPdfLogo(url), url).toBeNull();
      expect(safeFetch).toHaveBeenLastCalledWith(
        url,
        expect.objectContaining({ hostAllowlist: COVER_HOST_ALLOWLIST }),
      );
    }
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a logo whose Storage answer is a redirect is no logo: one request that does not follow it, never stored', async () => {
    fetchSpy.mockResolvedValue(
      new Response(null, {
        status: 303,
        headers: { location: 'http://169.254.169.254/latest/meta-data/logo.png' },
      }),
    );
    expect(await prefetchPdfLogo(LOGO)).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(LOGO, expect.objectContaining({ redirect: 'manual' }));
    expect(safeFetch).not.toHaveBeenCalled();
    await expect(cachedFns.get('pdf-logo-data-uri-v2')!(LOGO)).rejects.toThrow();
  });

  // S45 (it carries B48's logo conversion): react-pdf cannot read WebP or
  // AVIF, so those logos never printed. The capped decoder makes a PNG of
  // them, at most 512 px, the see-through background kept (never painted
  // black or white).
  it.each(['webp-lossy', 'webp-lossless', 'avif'] as const)(
    'a %s logo prints as a PNG with its transparency kept',
    async (format) => {
      for (const hidden of HIDDEN_COLOURS) {
        const image = await seeThroughImage(format, hidden);
        fetchSpy.mockImplementation(async () =>
          response(image.bytes, { 'content-type': image.contentType }),
        );
        const uri = await prefetchPdfLogo(LOGO);
        expect(uri, image.label).toMatch(/^data:image\/png;base64,/);
        const png = bytesOf(uri);
        const meta = await sharp(png).metadata();
        expect([meta.width, meta.height, meta.channels], image.label).toEqual([
          SEE_THROUGH_SIZE,
          SEE_THROUGH_SIZE,
          4,
        ]);
        expect((await described(png)).cornerAlpha, image.label).toBe(0);
        const middle = SEE_THROUGH_SIZE / 2;
        expect(isRed(await rgbAt(png, middle, middle)), image.label).toBe(true);
      }
    },
  );

  // react-pdf drew an SVG from a URL, so this is a change, kept on purpose:
  // SVG logos were refused at upload on 2026-05-09 (they can carry script),
  // and the bucket refuses them since migration 0046. Rasterizing one with
  // sharp is the way to print it, if one is ever found.
  it('draws no logo for SVG bytes', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>';
    fetchSpy.mockResolvedValue(
      new Response(svg, { status: 200, headers: { 'content-type': 'image/svg+xml' } }),
    );
    expect(
      await prefetchPdfLogo(`${STORAGE}/storage/v1/object/public/org-logos/org-1/logo.svg`),
    ).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a failed fetch is no logo, and the cached function throws so the failure is never stored', async () => {
    fetchSpy.mockResolvedValue(new Response('unavailable', { status: 503 }));
    expect(await prefetchPdfLogo(LOGO)).toBeNull();
    const cached = cachedFns.get('pdf-logo-data-uri-v2');
    expect(cached).toBeDefined();
    await expect(cached!(LOGO)).rejects.toThrow();
  });

  // On main react-pdf fetched the logo itself with no time limit, so a slow
  // host held the PDF route until its maxDuration. The fetch is now aborted at
  // PDF_IMAGE_TIMEOUT_MS: the document prints with no logo, and nothing is
  // stored, so the next document tries again.
  it('a logo that does not answer within PDF_IMAGE_TIMEOUT_MS is aborted: no logo, never stored', async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      fetchSpy.mockImplementation(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signals.push(init.signal);
            init.signal.addEventListener('abort', () => reject(init.signal.reason), {
              once: true,
            });
          }),
      );
      let settled = false;
      const pending = prefetchPdfLogo(LOGO).then((uri) => {
        settled = true;
        return uri;
      });
      await vi.advanceTimersByTimeAsync(PDF_IMAGE_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(await pending).toBeNull();
      expect(signals[0]!.aborted).toBe(true);

      // The cached function rejects on the timeout as well, so it stores nothing.
      const stored = expect(cachedFns.get('pdf-logo-data-uri-v2')!(LOGO)).rejects.toMatchObject({
        name: 'AbortError',
      });
      await vi.advanceTimersByTimeAsync(PDF_IMAGE_TIMEOUT_MS);
      await stored;
    } finally {
      vi.useRealTimers();
    }
  });

  function serveLogo(bytes: Buffer, contentType = 'image/png') {
    fetchSpy.mockImplementation(async () => response(bytes, { 'content-type': contentType }));
  }

  it('the logo key is v2: entries stored before the structure checks are never served', () => {
    expect(cacheKeys).toContainEqual(['pdf-logo-data-uri-v2']);
    expect(cacheKeys).not.toContainEqual(['pdf-logo-data-uri-v1']);
  });

  it.each(Object.entries({ ...MALFORMED_PNGS, ...EXIF_JPEGS, ...SLOW_TO_PARSE_JPEGS }))(
    '%s: no logo, and the cached function stores nothing',
    async (_label, bytes) => {
      serveLogo(bytes);
      expect(await prefetchPdfLogo(LOGO)).toBeNull();
      await expect(cachedFns.get('pdf-logo-data-uri-v2')!(LOGO)).rejects.toThrow();
    },
  );

  it('a PNG logo of 1024 px passes unchanged; a larger one prints from a 512 px copy', async () => {
    const at = await seeThroughPng(1024);
    serveLogo(at);
    expect(await prefetchPdfLogo(LOGO)).toBe(`data:image/png;base64,${at.toString('base64')}`);

    serveLogo(await seeThroughPng(4096));
    expect(await described(bytesOf(await prefetchPdfLogo(LOGO)))).toMatchObject({
      format: 'png',
      width: 512,
      height: 512,
      cornerAlpha: 0,
    });

    const wide = await sharp({
      create: { width: 1025, height: 10, channels: 4, background: { r: 9, g: 9, b: 9, alpha: 1 } },
    })
      .png()
      .toBuffer();
    serveLogo(wide);
    expect(await described(bytesOf(await prefetchPdfLogo(LOGO)))).toMatchObject({
      format: 'png',
      width: 512,
    });
  }, 30_000);

  it('a JPEG logo stored on its side prints upright, as a PNG', async () => {
    const jpeg = await sharp({
      create: { width: 600, height: 400, channels: 3, background: { r: 30, g: 90, b: 160 } },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    serveLogo(jpeg, 'image/jpeg');
    expect(await described(bytesOf(await prefetchPdfLogo(LOGO)))).toMatchObject({
      format: 'png',
      width: 341,
      height: 512,
      orientation: undefined,
    });
  });

  it('a WebP logo fits inside 512 px, aspect kept, never enlarged', async () => {
    const webp = (width: number, height: number) =>
      sharp({
        create: { width, height, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 0.5 } },
      })
        .webp({ effort: 0 })
        .toBuffer();
    serveLogo(await webp(1024, 512), 'image/webp');
    expect(await described(bytesOf(await prefetchPdfLogo(LOGO)))).toMatchObject({
      format: 'png',
      width: 512,
      height: 256,
    });
    serveLogo(await webp(64, 64), 'image/webp');
    expect(await described(bytesOf(await prefetchPdfLogo(LOGO)))).toMatchObject({
      width: 64,
      height: 64,
    });
    // WebP is held to 50 million pixels, not to AVIF's 4096 x 4096.
    serveLogo(await webp(8000, 4000), 'image/webp');
    expect(await described(bytesOf(await prefetchPdfLogo(LOGO)))).toMatchObject({
      width: 512,
      height: 256,
    });
  }, 30_000);

  it('an AVIF logo up to 4096 x 4096 prints; over it, no logo and nothing stored', async () => {
    const avif = (height: number) =>
      sharp({ create: { width: 4096, height, channels: 3, background: { r: 1, g: 2, b: 3 } } })
        .avif({ effort: 0 })
        .toBuffer();
    serveLogo(await avif(4096), 'image/avif');
    expect(await described(bytesOf(await prefetchPdfLogo(LOGO)))).toMatchObject({
      format: 'png',
      width: 512,
      height: 512,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    serveLogo(await avif(4097), 'image/avif');
    expect(await prefetchPdfLogo(LOGO)).toBeNull();
    expect(warn.mock.calls.flat().join(' ')).toContain('avif 4096x4097 is over 16777216 pixels');
    await expect(cachedFns.get('pdf-logo-data-uri-v2')!(LOGO)).rejects.toThrow(
      /^avif 4096x4097 is over 16777216 pixels$/,
    );
    // Coded over the cap and cropped under it: refused before sharp.
    sharpCalls.length = 0;
    serveLogo(AVIF_8192_CROPPED_TO_64, 'image/avif');
    expect(await prefetchPdfLogo(LOGO)).toBeNull();
    await expect(cachedFns.get('pdf-logo-data-uri-v2')!(LOGO)).rejects.toThrow(
      /^avif 8192x8192 is over 16777216 pixels$/,
    );
    expect(callsWith(AVIF_8192_CROPPED_TO_64)).toEqual([]);
  }, 30_000);

  it('the cached function stores the PNG made from a WebP logo', async () => {
    const image = await seeThroughImage('webp-lossy');
    serveLogo(image.bytes, image.contentType);
    await expect(cachedFns.get('pdf-logo-data-uri-v2')!(LOGO)).resolves.toMatch(
      /^data:image\/png;base64,/,
    );
  });

  it('SVG text the upload sniffer calls AVIF is refused before sharp; under a WebP header it is never read as SVG', async () => {
    for (const [label, bytes] of Object.entries(IMAGE_LOOKALIKE_SVGS)) {
      fetchSpy.mockClear();
      sharpCalls.length = 0;
      serveLogo(bytes, 'image/avif');
      expect(await prefetchPdfLogo(LOGO), label).toBeNull();
      expect(fetchSpy, label).toHaveBeenCalledTimes(1);
      expect(callsWith(bytes), label).toEqual([]);
      await expect(cachedFns.get('pdf-logo-data-uri-v2')!(LOGO), label).rejects.toThrow(
        /not a PNG, JPEG, WebP, GIF or AVIF image/,
      );
    }
    serveLogo(SVG_UNDER_A_WEBP_HEADER, 'image/webp');
    expect(await prefetchPdfLogo(LOGO)).toBeNull();
    const stored = cachedFns.get('pdf-logo-data-uri-v2')!(LOGO);
    await expect(stored).rejects.toThrow();
    await expect(stored).rejects.not.toThrow(/svg|xml/i);
  });

  it('GIF, HEIC and text logos: no logo, one request each, nothing stored', async () => {
    const gif = await seeThroughImage('gif');
    const heic = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftypheic\0\0\0\0mif1heic', 'latin1'),
      Buffer.alloc(16),
    ]);
    for (const [label, bytes] of [
      ['gif', gif.bytes],
      ['heic', heic],
      ['text', Buffer.from('not an image')],
    ] as const) {
      fetchSpy.mockClear();
      serveLogo(bytes);
      expect(await prefetchPdfLogo(LOGO), label).toBeNull();
      expect(fetchSpy, label).toHaveBeenCalledTimes(1);
      await expect(cachedFns.get('pdf-logo-data-uri-v2')!(LOGO), label).rejects.toThrow();
    }
  });
});
