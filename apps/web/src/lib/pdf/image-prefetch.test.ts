// SSRF: the PDF image prefetch. Storage URLs are fetched as before; any other
// URL goes through safeFetch with the book-cover host allowlist (pinned IP,
// every redirect hop re-validated), so a staff-editable legacy
// custom_fields.thumbnail_url can no longer make the server fetch an internal
// host. A body over the byte cap is refused (advertised or streamed). The
// optional downscale fits inside the box and has its own cache key.
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cacheKeys, safeFetch } = vi.hoisted(() => ({
  cacheKeys: [] as string[][],
  safeFetch: vi.fn(),
}));
vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown, keyParts: string[]) => {
    cacheKeys.push(keyParts);
    return fn;
  },
}));
vi.mock('@/lib/ssrf-guard', () => ({ safeFetch: (...args: unknown[]) => safeFetch(...args) }));

import { COVER_HOST_ALLOWLIST } from '@/lib/books/cover-hosts';

import {
  pdfImageFetchRoute,
  pdfImageLogLabel,
  prefetchImagesAsDataUris,
  PDF_IMAGE_MAX_BYTES,
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
  it('the sized path has its own cache key; the unsized one keeps v5', () => {
    expect(cacheKeys).toEqual(
      expect.arrayContaining([['pdf-image-data-uri-v5'], ['pdf-image-data-uri-v6']]),
    );
  });
});
