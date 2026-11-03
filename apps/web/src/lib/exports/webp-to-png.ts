import 'server-only';

import { pngFitInside } from '@/lib/image-decode';

import type { EmbeddedImage } from './export-images';

/**
 * Decode an image body into PNG bytes for the Excel / PDF embedders.
 *
 * Why this exists: every stored item thumbnail is WebP, and neither exceljs
 * nor @react-pdf/renderer can decode WebP. Until 2026-08-18 the exporters
 * worked around that by asking Supabase's on-demand image transformation
 * endpoint for a PNG/JPEG re-encode of every thumb. That endpoint is
 * rate-limited: one L4L Excel export issued 272 transform requests in 24
 * seconds and 30 of them came back HTTP 429, each one a blank picture cell.
 * Decoding here, on the export function, means the exporter can fetch the
 * stored WebP thumb through the plain (CDN-cached, un-throttled) object URL
 * and never touch the transform endpoint for a row that has a thumb.
 *
 * The decode is the capped decoder's (lib/image-decode.ts, S45): WebP, AVIF,
 * GIF, PNG or JPEG, read from the bytes and held to that format's pixel cap,
 * the EXIF orientation applied, fit inside `targetWidth` (never enlarged),
 * transparency kept. The export sends here every body it does not embed as
 * it is: WebP, and any PNG or JPEG that fails its pass-through checks.
 *
 * `sharp` is loaded lazily by the decoder, so the module graph of an export
 * that embeds no image never pays for the native binary. Any failure -- a
 * refusal, a corrupt body, an unsupported feature -- resolves to null; the
 * caller records the row as skipped ("unsupported"). Nothing here throws and
 * nothing here logs: the bytes came from a signed URL and the caller must
 * stay URL-free.
 */
export async function webpToPng(
  bytes: Uint8Array,
  targetWidth: number,
): Promise<EmbeddedImage | null> {
  try {
    const side = Math.max(1, Math.floor(targetWidth));
    const out = await pngFitInside(bytes, ['webp', 'avif', 'gif', 'png', 'jpeg'], side);
    return {
      data: new Uint8Array(out.buffer, out.byteOffset, out.byteLength),
      extension: 'png',
    };
  } catch {
    return null;
  }
}
