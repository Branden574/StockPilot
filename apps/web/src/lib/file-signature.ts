/**
 * Byte-signature sniffing for DOCUMENT buckets — the superset of
 * `image-signature.ts` that also recognises PDF.
 *
 * ═══ WHY A SIBLING RATHER THAN A WIDER `SniffedImage` ═══
 *
 * `sniffImage` guards four flows in production today and its own header warns
 * what a half-finished widening costs: add a member to `SniffedImage['kind']`
 * without a detection branch and every legitimate upload of that format sniffs
 * as `null`, at which point the verify-or-delete guard DELETES it. Widening a
 * type called `SniffedImage` to carry `pdf` would also make its name a lie.
 *
 * So this module composes rather than mutates: it delegates to `sniffImage`
 * for every image format and adds exactly one branch of its own. The image
 * path keeps its existing behaviour, byte fixtures and callers untouched.
 *
 * ═══ WHAT THIS EXISTS TO STOP ═══
 *
 * A bucket's `allowed_mime_types` is checked against the Content-Type the
 * CLIENT sent with its PUT, and every attachment surface passes
 * `contentType: file.type` — the browser's word for it. A renamed binary, an
 * HTML document or an SVG carrying script all reach `po-attachments`,
 * `order-attachments` and `support-attachments` today by declaring
 * `application/pdf`. Those objects are later signed and opened from our own
 * storage origin, which makes an unverified object a payload host.
 *
 * Like `sniffImage` this is byte-pure: it takes ONLY bytes. No filename, no
 * declared MIME, no extension. There is nothing here for a lie to reach.
 */
import {
  MIME_FOR_KIND,
  sniffImage,
  sniffNeedsMoreBytes,
  type SniffedImage,
} from './image-signature';

export type SniffedFile =
  | { kind: SniffedImage['kind']; mime: string }
  | { kind: 'pdf'; mime: 'application/pdf' };

/**
 * `%PDF-` — ISO 32000-1 §7.5.2, required at the START of the file.
 *
 * MATCHED AT OFFSET 0 ONLY, deliberately. The spec permits a reader to scan
 * the first 1024 bytes for the header, and being that lenient is what lets a
 * polyglot — a file that is simultaneously valid HTML and valid PDF — satisfy
 * this guard while a browser renders the HTML half. Every real producer emits
 * the header at 0, so strictness costs legitimate uploads nothing and removes
 * the polyglot entirely.
 */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const; // %PDF-

function isPdf(data: Uint8Array): boolean {
  if (data.length < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i += 1) if (data[i] !== PDF_MAGIC[i]) return false;
  return true;
}

/**
 * Sniff any format the document buckets accept. `null` means "these bytes are
 * not a format we recognise" — which the callers treat as reject-and-delete.
 */
export function sniffFile(data: Uint8Array): SniffedFile | null {
  if (isPdf(data)) return { kind: 'pdf', mime: 'application/pdf' };
  const img = sniffImage(data);
  if (img) return { kind: img.kind, mime: MIME_FOR_KIND[img.kind] };
  return null;
}

/**
 * Re-exported so document callers use ONE prefix-widening rule with the image
 * ones. A PDF is decidable from its first five bytes, so it never widens —
 * only the image formats that need more can ask for a full read.
 */
export function fileSniffNeedsMoreBytes(data: Uint8Array): boolean {
  if (isPdf(data)) return false;
  return sniffNeedsMoreBytes(data);
}

/**
 * Bucket allowlists for the document surfaces, transcribed from the migrations
 * that pin them — same invariant as the image table: a bucket must never
 * appear here accepting a format `sniffFile` cannot detect, or the guard
 * deletes every legitimate upload of it. The unit suite asserts both
 * directions against real byte fixtures.
 *
 * `image/heif` is NOT listed for order-attachments even though the bucket
 * accepts it: the sniffer classifies HEIF-family bytes as `heic`, and the two
 * are the same container. Listing the mime the sniffer actually reports is
 * what keeps this table checkable.
 */
export const DOCUMENT_BUCKET_MIME_ALLOWLISTS = {
  'po-attachments': ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic'],
  'order-attachments': ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic'],
  // 5 MB screenshots only — no PDF, and deliberately no HEIC: the form
  // transcodes before upload and a raw HEIC screenshot renders nowhere.
  'support-attachments': ['image/png', 'image/jpeg', 'image/webp'],
} as const;

export type DocumentBucket = keyof typeof DOCUMENT_BUCKET_MIME_ALLOWLISTS;

/**
 * Whether sniffed bytes are a format this bucket actually holds.
 *
 * Gate on THIS, never on `sniffFile(...) !== null`: "these bytes are some
 * known format" is weaker than "these bytes are a format this bucket is
 * pinned to", and the two differ for support-attachments, which takes no PDF.
 */
export function isSniffedFileAllowedInBucket(
  sniffed: SniffedFile,
  bucket: DocumentBucket,
): boolean {
  const allowed: readonly string[] = DOCUMENT_BUCKET_MIME_ALLOWLISTS[bucket];
  return allowed.includes(sniffed.mime);
}
