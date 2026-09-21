/**
 * Reduces an image URL to a CLASS that is safe to record.
 *
 * Item photos are private: the browser fetches them through signed URLs whose
 * `?token=` is a 30-day bearer credential and whose path names an organization
 * and an item. A performance record may say "a pre-generated thumbnail, served
 * straight from Storage" or "a master, resized by the optimizer at w=384"; it
 * may never contain the URL, the path or the token (owner rule: "Do not log
 * signed image URLs or bearer tokens").
 *
 * SELF-CONTAINED ON PURPOSE. The Playwright harness injects this function into
 * the page with `classifyImageUrl.toString()`, so the raw URL is classified
 * INSIDE the browser and never crosses into the Node process or onto disk. Keep
 * every constant and helper inside the function body, import nothing, and close
 * over nothing, or the injected copy breaks.
 */

export type ImageDelivery =
  /** `/_next/image?url=…`: fetched and resized on demand by the image optimizer. */
  | 'optimizer'
  /** Supabase Storage signed object URL, served as stored. */
  | 'storage-signed'
  /** Supabase on-demand transform (`/render/image/`): the pattern the repo reverted. */
  | 'storage-transform'
  /** Any other Supabase Storage URL (public or authenticated endpoint). */
  | 'storage-other'
  | 'same-origin'
  | 'external'
  | 'inline'
  | 'unknown';

export type ImageVariant = 'thumb' | 'master' | 'not-an-item-photo';

export interface ImageClass {
  delivery: ImageDelivery;
  /** For `optimizer`, what the optimizer itself has to fetch. */
  upstream: Exclude<ImageDelivery, 'optimizer'> | null;
  variant: ImageVariant;
  /** `w=` and `q=` on an optimizer URL; null elsewhere. */
  requestedWidth: number | null;
  requestedQuality: number | null;
  /** True when the URL carries a `token` parameter (a signed credential). */
  signed: boolean;
}

export function classifyImageUrl(rawUrl: string, pageOrigin: string): ImageClass {
  const unknown: ImageClass = {
    delivery: 'unknown',
    upstream: null,
    variant: 'not-an-item-photo',
    requestedWidth: null,
    requestedQuality: null,
    signed: false,
  };
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return unknown;
  if (rawUrl.startsWith('data:') || rawUrl.startsWith('blob:')) {
    // Written out, not spread: a transpiler may turn a spread into a helper
    // call, and a helper does not exist in the injected copy.
    return {
      delivery: 'inline',
      upstream: null,
      variant: 'not-an-item-photo',
      requestedWidth: null,
      requestedQuality: null,
      signed: false,
    };
  }

  const parse = (value: string): URL | null => {
    try {
      return new URL(value, pageOrigin);
    } catch {
      return null;
    }
  };
  const num = (value: string | null): number | null => {
    if (value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const variantOf = (pathname: string): ImageVariant => {
    // `<org>/items/<item>/<uuid>-thumb.webp` next to `<uuid>.<ext>`
    // (ItemImagesService.createUploadTarget). Only item photos have a variant.
    if (!pathname.includes('/item-images/')) return 'not-an-item-photo';
    return /-thumb\.[a-z0-9]+$/i.test(pathname) ? 'thumb' : 'master';
  };
  const direct = (url: URL): Exclude<ImageDelivery, 'optimizer'> => {
    if (url.pathname.includes('/storage/v1/')) {
      if (url.pathname.includes('/render/image/')) return 'storage-transform';
      if (url.pathname.includes('/object/sign/')) return 'storage-signed';
      return 'storage-other';
    }
    return url.origin === pageOrigin ? 'same-origin' : 'external';
  };

  const url = parse(rawUrl);
  if (!url) return unknown;

  if (url.pathname === '/_next/image') {
    const inner = parse(url.searchParams.get('url') ?? '');
    return {
      delivery: 'optimizer',
      upstream: inner ? direct(inner) : 'unknown',
      variant: inner ? variantOf(inner.pathname) : 'not-an-item-photo',
      requestedWidth: num(url.searchParams.get('w')),
      requestedQuality: num(url.searchParams.get('q')),
      signed: inner ? inner.searchParams.has('token') : false,
    };
  }

  return {
    delivery: direct(url),
    upstream: null,
    variant: variantOf(url.pathname),
    requestedWidth: null,
    requestedQuality: null,
    signed: url.searchParams.has('token'),
  };
}
