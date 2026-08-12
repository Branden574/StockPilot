/**
 * MED-22 — the file types the PO-import surfaces accept, in ONE place.
 *
 * WHY THIS IS ITS OWN MODULE
 * Both the web action's boundary check and the service's gate need this list,
 * and two copies of an allowlist is how an allowlist rots: the boundary gets
 * widened for a new format, the service does not, and the surface that is
 * actually load-bearing quietly disagrees with the one that gets reviewed. A
 * shared module makes drift impossible. It lives in `lib/` rather than in the
 * service because `server/services/po-imports.ts` is `server-only` and is
 * mocked wholesale by the action tests — importing a constant from it would
 * resolve to `undefined` under those mocks, which is exactly the kind of
 * silently-empty allowlist that reads as "allow everything".
 *
 * WHY BOTH LAYERS KEEP A CHECK
 * The service's is the load-bearing one (it is the only path to the presign,
 * and it is what any future Bearer surface will reach). The action keeps its
 * own so a bad request is refused at the edge with a clean `validation_error`
 * before any service instantiation, which is the posture every other action in
 * this repo takes. Neither is a substitute for the other.
 */

/**
 * Upload path — a DOCUMENT to be parsed. Maps each accepted MIME to the
 * extension the SERVER stamps on the storage path.
 *
 * Read off the parser rather than guessed: `lib/po-parser/index.ts` dispatches
 * on exactly two source types, `pdf` and `csv`. `application/vnd.ms-excel` is
 * present because Windows reports THAT for a plain `.csv`, which is why it maps
 * to the `csv` extension and not to an Excel one — it is the same CSV code
 * path. `xlsx` appears in the `po_imports.source_type` column and in the record
 * action's enum, but no upload mints it: there is no xlsx branch in the parser,
 * so accepting an xlsx MIME would presign an upload that could only fail to
 * parse.
 *
 * The extension being chosen HERE, from the MIME, is itself the fix for a path
 * injection: the old presign built it from `fileName.split('.').pop()`, so a
 * `fileName` of `po.csv/../../item-images/x` produced a minted path containing
 * a traversal.
 */
export const PO_IMPORT_UPLOAD_MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'application/vnd.ms-excel': 'csv',
};

/** The user-facing copy for a refusal, shared so both layers say the same thing. */
export const PO_IMPORT_UPLOAD_MIME_ERROR = 'Only PDF or CSV files are allowed';

export function isAllowedPoImportUploadMime(mime: string): boolean {
  return Object.prototype.hasOwnProperty.call(PO_IMPORT_UPLOAD_MIME_EXTENSIONS, mime);
}

/** The extension the server stamps for an allowlisted MIME, or null if the MIME
 *  is not allowed. Returns null rather than a fallback like 'bin' on purpose —
 *  a fallback would let an unknown type through with a plausible-looking path. */
export function poImportUploadExtensionFor(mime: string): string | null {
  return isAllowedPoImportUploadMime(mime)
    ? (PO_IMPORT_UPLOAD_MIME_EXTENSIONS[mime] as string)
    : null;
}

/**
 * Scan path — a PHOTOGRAPH or page image run through vision extraction. A
 * deliberately different, wider set than the document allowlist above: these
 * never reach the text parser. Mirrors the `/api/po-imports/scan` route's own
 * boundary check so the service twin refuses the same set the route does
 * instead of trusting its caller.
 *
 * `image/heif` sits beside `image/heic` because they are the SAME picture:
 * both label an ISO-BMFF HEIF container, and which of the two a browser
 * reports for one iPhone photo depends on the OS/browser, not on the bytes.
 * Allowing only `heic` therefore refused a coin-flip half of the drag-drops
 * on the web scan form. Everything downstream already treats them alike —
 * `lib/image-variants.ts:194` transcodes both, and `lib/ai/claude.ts:56-62`
 * relabels any non-jpeg/png/gif/webp subtype to jpeg for vision. The bucket
 * pin (migration 0325, widened by 0332) and the route's own ACCEPT_TYPES
 * carry the identical pair; all three must move together.
 */
export const PO_IMPORT_SCAN_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
]);
