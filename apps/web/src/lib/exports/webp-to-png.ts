import 'server-only';

import type { EmbeddedImage } from './export-images';

/**
 * Decode a WebP body into PNG bytes for the Excel / PDF embedders.
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
 * `sharp` is already a dependency of apps/web (Next's image optimizer) and is
 * loaded lazily so the module graph of an export that embeds no WebP never
 * pays for the native binary. Any failure -- the import itself, a corrupt
 * body, an unsupported feature -- resolves to null; the caller records the
 * row as skipped ("unsupported"). Nothing here throws and nothing here logs:
 * the bytes came from a signed URL and the caller must stay URL-free.
 */
export async function webpToPng(
  bytes: Uint8Array,
  targetWidth: number,
): Promise<EmbeddedImage | null> {
  try {
    const mod = await import('sharp');
    const sharp = mod.default;
    const side = Math.max(1, Math.floor(targetWidth));
    const out = await sharp(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
      .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    return {
      data: new Uint8Array(out.buffer, out.byteOffset, out.byteLength),
      extension: 'png',
    };
  } catch {
    return null;
  }
}
