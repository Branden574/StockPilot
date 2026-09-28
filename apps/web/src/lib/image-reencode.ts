import 'server-only';

/**
 * Re-encode an uploaded photo WITHOUT its metadata, and derive its thumbnail
 * from the same pixels (F1-4 photo evidence).
 *
 * ═══ WHY THE SERVER DOES THIS, NOT THE CLIENT ═══
 *
 * A phone photo's EXIF can carry where it was taken (GPS), the device and its
 * serial, and the owner's name. Checked 2026-09-27 against the maintenance
 * photo pipeline, which evidence photos reuse on both platforms:
 *   - the server never rewrites the bytes it is given (maintenance finalize
 *     reads a 4 KB prefix to sniff, then records the object as uploaded);
 *   - the web client re-encodes through a canvas (which drops EXIF), but falls
 *     back to uploading the ORIGINAL file whenever the re-encode is not
 *     smaller, the browser cannot decode it, or the canvas APIs are missing
 *     (lib/image-variants.ts and its worker);
 *   - the iOS app uploads the picker's file untouched when it is at most
 *     1600 px and already JPEG/PNG/WEBP (lib/image-resize.ts); with the
 *     screens' quality 0.7 the picker itself re-encodes JPEG and PNG, but a
 *     WEBP comes back byte for byte;
 *   - Android's picker copies the EXIF, GPS tags included, into the file it
 *     returns (CompressionImageExporter.copyExifData), and a small JPEG is
 *     then uploaded untouched.
 * So location data reaches storage on every platform in some case. Doing the
 * strip here covers all of them, and a direct PUT that skipped the app too.
 * Maintenance finalize (server/services/maintenance-attachments.ts) now runs
 * this step as well (2026-09-27), so the first point above describes it
 * before that change.
 *
 * ═══ WHAT COMES OUT ═══
 *
 *   - `master`: the same format as the input (JPEG stays JPEG, so the path's
 *     extension stays true), full size, EXIF orientation applied to the pixels
 *     first (`rotate()` with no angle) because dropping the tag would
 *     otherwise turn a portrait photo on its side. sharp writes NO metadata
 *     unless asked (no withMetadata/keepExif here): no EXIF, no GPS, no XMP,
 *     no IPTC, no maker notes.
 *   - `thumb`: a 400 px WEBP made from the cleaned master, so the thumbnail is
 *     always the same picture as the photo it stands for (a client-supplied
 *     thumbnail could show anything).
 *
 * `sharp` is already a dependency of apps/web and is loaded lazily, as in
 * lib/exports/webp-to-png.ts. Any failure resolves to null; the caller
 * rejects the upload and deletes the object.
 */

export type ReencodeKind = 'jpeg' | 'png' | 'webp';

export interface ReencodedPhoto {
  master: Uint8Array;
  thumb: Uint8Array;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  width: number | null;
  height: number | null;
}

/** Longest edge of the thumbnail, in pixels. */
export const EVIDENCE_THUMB_MAX_EDGE = 400;

/** A decode past this many pixels is refused (a decompression bomb, not a
 *  photo: a 48 MP phone sensor is 48e6). The default; a caller may ask for
 *  less (`maxInputPixels`). */
const MAX_INPUT_PIXELS = 100_000_000;

/** JPEG and WEBP quality of the master. The default; a caller may ask for
 *  another (`quality`). */
const DEFAULT_QUALITY = 90;

export interface ReencodeOptions {
  /** Refuse (resolve to null) an image of more pixels than this. sharp checks
   *  it from the header, before any pixel is decoded, so it bounds the
   *  memory the decode takes: measured on sharp 0.35.4, a 178 KB
   *  10000x10000 WEBP with EXIF orientation 6 peaked at 1.78 GB, a 50 MP one
   *  at 0.94 GB (2026-09-27). Default MAX_INPUT_PIXELS. */
  maxInputPixels?: number;
  /** JPEG/WEBP quality of the master, 1-100. PNG is lossless and ignores
   *  it. Default DEFAULT_QUALITY. */
  quality?: number;
}

const CONTENT_TYPE: Record<ReencodeKind, ReencodedPhoto['contentType']> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export async function reencodeWithoutMetadata(
  bytes: Uint8Array,
  kind: ReencodeKind,
  options: ReencodeOptions = {},
): Promise<ReencodedPhoto | null> {
  try {
    const { default: sharp } = await import('sharp');
    const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const quality = options.quality ?? DEFAULT_QUALITY;
    // rotate() with no angle applies the EXIF orientation to the pixels.
    const oriented = sharp(input, {
      limitInputPixels: options.maxInputPixels ?? MAX_INPUT_PIXELS,
    }).rotate();
    const encoded =
      kind === 'jpeg'
        ? oriented.jpeg({ quality, mozjpeg: true })
        : kind === 'png'
          ? oriented.png({ compressionLevel: 9 })
          : oriented.webp({ quality });
    const { data: master, info } = await encoded.toBuffer({ resolveWithObject: true });
    const thumb = await sharp(master)
      .resize({
        width: EVIDENCE_THUMB_MAX_EDGE,
        height: EVIDENCE_THUMB_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 80 })
      .toBuffer();
    return {
      master: new Uint8Array(master.buffer, master.byteOffset, master.byteLength),
      thumb: new Uint8Array(thumb.buffer, thumb.byteOffset, thumb.byteLength),
      contentType: CONTENT_TYPE[kind],
      width: info.width ?? null,
      height: info.height ?? null,
    };
  } catch {
    return null;
  }
}
