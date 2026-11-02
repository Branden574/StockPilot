// SSRF: the PDF image prefetch. Storage URLs are fetched as before; any other
// URL goes through safeFetch with the book-cover host allowlist (pinned IP,
// every redirect hop re-validated), so a staff-editable legacy
// custom_fields.thumbnail_url can no longer make the server fetch an internal
// host. A body over the byte cap is refused (advertised or streamed). The
// optional downscale fits inside the box and has its own cache key. A photo
// with a see-through background prints on white, never on black (B62).
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const { cacheKeys, cachedFns, safeFetch } = vi.hoisted(() => ({
  cacheKeys: [] as string[][],
  // The function each cache key wraps, so a test can see what it would store.
  cachedFns: new Map<string, (...args: unknown[]) => unknown>(),
  safeFetch: vi.fn(),
}));
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
  // calls revalidateTag on these entries). The sized path always flattened and
  // makes the same bytes, so its v6 entries stay.
  it('the unsized key is v7, so no black square stored under v5 is served; the sized key stays v6', () => {
    expect(cacheKeys).toEqual(
      expect.arrayContaining([['pdf-image-data-uri-v7'], ['pdf-image-data-uri-v6']]),
    );
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
 * SSRF: an organization's logo for a branded PDF header. logo_url is set by an
 * org owner or admin and the database does not hold it to the logo bucket the
 * settings action checks, so it is fetched like an item image (a Storage read
 * on the project origin by plain fetch that never follows a redirect, any
 * other URL only through safeFetch with the cover allowlist, anything else
 * refused before a request) and react-pdf is handed the bytes. Only PNG and
 * JPEG are returned, unchanged, so a PNG or JPEG logo prints as it did. An SVG
 * logo, which react-pdf also drew from a URL, is refused like any other
 * format (the uploader has refused SVG since 2026-05-09).
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
    await expect(cachedFns.get('pdf-logo-data-uri-v1')!(LOGO)).rejects.toThrow();
  });

  it('draws no logo for bytes react-pdf could not draw from a URL before (WebP)', async () => {
    const webp = await sharp({
      create: { width: 4, height: 4, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0 } },
    })
      .webp()
      .toBuffer();
    fetchSpy.mockResolvedValue(response(webp, { 'content-type': 'image/webp' }));
    expect(await prefetchPdfLogo(LOGO)).toBeNull();
  });

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
    const cached = cachedFns.get('pdf-logo-data-uri-v1');
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
      const stored = expect(cachedFns.get('pdf-logo-data-uri-v1')!(LOGO)).rejects.toMatchObject({
        name: 'AbortError',
      });
      await vi.advanceTimersByTimeAsync(PDF_IMAGE_TIMEOUT_MS);
      await stored;
    } finally {
      vi.useRealTimers();
    }
  });
});
