/**
 * Strict, positive-shape validation for caller-supplied Supabase Storage
 * object paths (security wave D, HI-8).
 *
 * WHY THIS EXISTS — the prefix-check failure mode, spelled out
 * ----------------------------------------------------------------------
 * Four services used to gate a client-supplied `storage_path` with
 * `path.startsWith(`${orgId}/`)` and then hand it to the SERVICE-ROLE
 * client to download or sign. A prefix check is a NEGATIVE guard: it
 * asserts what the front of the string looks like and says nothing about
 * the rest. `@supabase/storage-js` interpolates `path` straight into a
 * `fetch()` URL, and the WHATWG URL parser resolves `..` / `%2e%2e`
 * segments BEFORE the request leaves Node — so
 *
 *     `${orgId}/../../item-images/<victim-org>/<victim-item>/cover.jpg`
 *
 * passes `startsWith`, escapes the org prefix, escapes the BUCKET, and
 * comes back as a service-role-signed URL that RLS never got a chance to
 * refuse. The traversal is invisible if you only reason about the string
 * you think you received, because the normalization happens downstream.
 *
 * The fix is a STRICT POSITIVE SHAPE: the path must be exactly the form
 * the mint produces, built from server-known ids. A denylist has to
 * enumerate every encoding of "go up a level"; a positive shape only has
 * to enumerate what a legitimate path looks like, and every encoding of
 * traversal falls outside it for free. `..`, `%2e%2e`, `%252e%252e`, a
 * leading `/`, a `\`, an embedded NUL and a different-bucket hop are all
 * rejected by the same `^...$` match, not by six separate rules.
 *
 * Two deliberately-redundant layers, ported from the reference
 * implementation this generalizes (`maintenance-attachments.ts`'s
 * `validateFinalizePath`, security wave for Task 9 CRITICAL 1):
 *
 *   (b) `hasUnsafeStorageSegment` — a belt-and-braces character/segment
 *       denylist, so a subtle bug in a shape regex (a missing anchor, a
 *       forgotten escape) is not the ONLY thing standing between a
 *       hostile path and a service-role storage call;
 *   (a) the shape match itself.
 *
 * `isValidStoragePath` runs (b) then (a). Callers should never call (a)
 * alone — go through `isValidStoragePath`.
 *
 * PREDICATE, NOT THROWER: this module returns booleans and never throws a
 * domain error. `ServiceError` lives in the `server-only` service context,
 * and every one of the four call sites wants its own error code + copy
 * (`forbidden` vs `validation_error`, different messages). Keeping the
 * validator pure means it is unit-testable with no server harness and no
 * caller has to change its error contract to adopt it.
 */

/** Lowercase-canonical UUID, the shape Postgres renders a `uuid` column as
 *  and the shape `crypto.randomUUID()` produces. Deliberately NOT
 *  case-insensitive: every id these paths are built from comes out of
 *  Postgres or `randomUUID()`, both lowercase. */
export const UUID_SEGMENT = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * The final (filename) segment of an object path.
 *
 * Widened past a bare UUID on purpose — the real conventions in this repo
 * disagree with each other and all four are legitimate, in-production
 * shapes (verified against the actual writers, not assumed):
 *
 *   `{uuid}.webp`            web item-image / order-attachment / video mint
 *   `{uuid}-thumb.webp`      web item-image thumb + backfill-item-thumbs
 *   `{base36x12}.jpg`        mobile (`Math.random().toString(36).slice(2,14)`)
 *   `cover.jpg`              books-import cover rehost
 *   `{uuid}.poster.jpg`      procedure-video poster frame
 *
 * The security property does NOT come from pinning the id format — it
 * comes from the character class. `.` may only appear as an extension
 * separator followed by at least one alphanumeric, so `.`, `..` and
 * `...` are all unrepresentable; `/`, `\`, `%` and control characters
 * (including NUL and newline) are outside every class here, so no
 * encoding of a traversal or a segment break can be expressed.
 */
export const OBJECT_FILENAME_SEGMENT = '[A-Za-z0-9_-]{1,120}(?:\\.[A-Za-z0-9]{1,10}){1,3}';

/** Longest path any of these buckets legitimately produces is ~120 chars
 *  (36 + 6 + 36 + filename); 400 is a generous boundary cap that still
 *  refuses a megabyte of garbage before the regex engine sees it. */
export const MAX_STORAGE_PATH_LENGTH = 400;

/** Escapes a string for literal interpolation into a `RegExp` source. */
export function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Layer (b) — the character/segment denylist, byte-for-byte the set the
 * reference implementation used, plus control characters.
 *
 * `%` is rejected outright rather than only `%2e`: percent-decoding
 * happens somewhere downstream in every storage client, and there is no
 * legitimate path in this product that contains one, so refusing the
 * character removes the entire encoded-traversal family (`%2e%2e`,
 * `%252e%252e`, `%2f`, over-long UTF-8 forms) in one rule instead of
 * chasing encodings. The control-character class (U+0000-U+001F plus
 * U+007F) covers the embedded-NUL payload and the trailing-newline
 * smuggle.
 */
export function hasUnsafeStorageSegment(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return true;
  if (path.length > MAX_STORAGE_PATH_LENGTH) return true;
  if (
    path.includes('%') ||
    path.includes('\\') ||
    path.startsWith('/') ||
    path.includes('//') ||
    // Deliberate control-character class: NUL/newline smuggling IS the
    // payload, so matching those bytes is the whole point. No
    // eslint-disable is needed (`no-control-regex` is not enabled in this
    // config) and a dead directive is itself a lint warning.
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    return true;
  }
  return path.split('/').some((seg) => seg === '.' || seg === '..' || seg === '');
}

/**
 * Both layers, in order. THE entry point — a caller that reaches for
 * `shape.test(path)` directly loses layer (b).
 */
export function isValidStoragePath(path: string, shape: RegExp): boolean {
  if (hasUnsafeStorageSegment(path)) return false;
  return shape.test(path);
}

/** Anchors a fragment into a whole-string shape. */
function anchored(fragment: string): RegExp {
  return new RegExp(`^${fragment}$`);
}

/**
 * `{org}/items/{item}/{file}` — the shape `ItemImagesService.createUploadUrl`
 * mints and the shape mobile's three direct uploaders build. Both ids are
 * pinned as regex-escaped LITERALS from the server's own context, so the
 * path cannot point at another org OR another item.
 *
 * Note the `items/` middle segment is required here, unlike
 * `itemImageAnyPathShape` below: `record()` is only ever reached from the
 * presigned-upload flow, which always mints that segment. The books-import
 * cover rehost writes the shorter `{org}/{item}/cover.{ext}` form but
 * inserts its row directly and never calls `record()`.
 */
export function itemImagePathShape(organizationId: string, itemId: string): RegExp {
  return anchored(
    `${escapeRegExpLiteral(organizationId)}/items/${escapeRegExpLiteral(itemId)}/${OBJECT_FILENAME_SEGMENT}`,
  );
}

/**
 * READ-side shape for an `item_images.storage_path` value that came out of
 * the DB rather than from a caller, where the owning org id is not in hand
 * (`public-items.ts` reads by item id with the service-role client, on an
 * unauthenticated public page).
 *
 * Structural only — two UUID segments with an OPTIONAL `items/` between
 * them, covering BOTH real conventions:
 *   `{org}/items/{item}/{file}`  presigned uploads (web) + mobile
 *   `{org}/{item}/{file}`        books-import cover rehost
 *
 * It cannot pin the ids (they are exactly what is unknown at that call
 * site) but it fully blocks traversal, bucket escape and absolute paths,
 * which is the HI-8 property. Item-level pinning is enforced on the WRITE
 * side by `itemImagePathShape`.
 */
export function itemImageAnyPathShape(): RegExp {
  return anchored(`${UUID_SEGMENT}/(?:items/)?${UUID_SEGMENT}/${OBJECT_FILENAME_SEGMENT}`);
}

/** `{org}/{orderRequestId}/{file}` — web `order-attachments-panel.tsx` and
 *  mobile `order/[id].tsx` both mint exactly this. Pinning the order id is
 *  new: `add()` previously checked only the org prefix, so a manager could
 *  file order A's attachment row against order B's uploaded proof photo. */
export function orderAttachmentPathShape(organizationId: string, orderRequestId: string): RegExp {
  return anchored(
    `${escapeRegExpLiteral(organizationId)}/${escapeRegExpLiteral(orderRequestId)}/${OBJECT_FILENAME_SEGMENT}`,
  );
}

/** `{org}/{procedureId}/{file}` — covers both the video (`{uuid}.mp4`) and
 *  its poster (`{uuid}.poster.jpg`), which is why
 *  `OBJECT_FILENAME_SEGMENT` allows more than one dotted extension group. */
export function procedureVideoPathShape(organizationId: string, procedureId: string): RegExp {
  return anchored(
    `${escapeRegExpLiteral(organizationId)}/${escapeRegExpLiteral(procedureId)}/${OBJECT_FILENAME_SEGMENT}`,
  );
}

/** `{org}/{maintenanceRequestId}/{uuid}.{ext}` — the reference
 *  implementation's shape, kept STRICTER than the others (the filename
 *  must be a real UUID plus one of four image extensions) because that
 *  surface mints every path server-side and has no legacy variants to
 *  accommodate. Behavior is byte-identical to the inline regex it
 *  replaces. */
export function maintenanceAttachmentPathShape(organizationId: string, requestId: string): RegExp {
  return anchored(
    `${escapeRegExpLiteral(organizationId)}/${escapeRegExpLiteral(requestId)}/${UUID_SEGMENT}\\.(?:jpg|jpeg|png|webp)`,
  );
}

/**
 * `{org}/{purchaseOrderId}/{file}` — the po-attachments convention, which is
 * built CLIENT-SIDE on both platforms (web `po-attachments-panel.tsx`:
 * `${organizationId}/${purchaseOrderId}/${crypto.randomUUID()}.${ext}`;
 * mobile `po-attachments.tsx`: the same with a base36 random instead of a
 * uuid — which is why the filename segment is not pinned to a uuid here).
 * Pinning the PO id is new: `add()` checked only the org prefix, so a
 * manager could file PO A's attachment row against PO B's uploaded invoice.
 *
 * NOTE the mobile uploader inserts into `po_attachments` DIRECTLY via
 * PostgREST rather than through `PoAttachmentsService.add()`, so this shape
 * does not gate that write — the storage RLS org-prefix policy and the
 * `storage_path` CHECK constraint are what cover it.
 */
export function poAttachmentPathShape(organizationId: string, purchaseOrderId: string): RegExp {
  return anchored(
    `${escapeRegExpLiteral(organizationId)}/${escapeRegExpLiteral(purchaseOrderId)}/${OBJECT_FILENAME_SEGMENT}`,
  );
}

/**
 * `{org}/po-imports/{file}` — ONE shape for both real po-imports mints, which
 * differ only in the filename:
 *
 *   `{uuid}.{ext}`      presignUpload           (po-imports.ts, randomUUID)
 *   `{sha256}.{ext}`    createFromScan          (po-imports.ts, 64 hex chars)
 *
 * A second shape would be redundant: `OBJECT_FILENAME_SEGMENT`'s
 * `[A-Za-z0-9_-]{1,120}` already admits both (a uuid's hyphens are in the
 * class, and 64 hex chars are a strict subset of it), so the two conventions
 * are the SAME shape as far as the security property is concerned — the
 * property comes from the character class, not from pinning the id format.
 * The literal `po-imports/` middle segment is what stops a caller from
 * pointing a po_imports row at some other folder inside the bucket.
 *
 * The org id is the only pinnable id here (a PO import has no parent entity
 * at upload time — the import row IS the parent, created after the upload).
 */
export function poImportPathShape(organizationId: string): RegExp {
  return anchored(`${escapeRegExpLiteral(organizationId)}/po-imports/${OBJECT_FILENAME_SEGMENT}`);
}

/**
 * `{org}/{file}` — the org-logos convention (`org-logo-uploader.tsx` mints
 * `${organizationId}/logo-${Date.now()}.${ext}`). Only TWO segments, unlike
 * every other shape here, because a logo has no parent entity below the org.
 *
 * Needed on the READ side: `setOrgLogoUrlAction` derives this path back out
 * of the public URL the client submits and hands it to the SERVICE-ROLE
 * client to download-and-sniff (MED-23). The org-prefix check on the URL is
 * a prefix check, so on its own it carries the exact HI-8 weakness this
 * module exists to close — `.../org-logos/{org}/../../item-images/x/y.jpg`
 * starts with the expected prefix and still escapes the bucket.
 */
export function orgLogoPathShape(organizationId: string): RegExp {
  return anchored(`${escapeRegExpLiteral(organizationId)}/${OBJECT_FILENAME_SEGMENT}`);
}

/**
 * BOUNDARY schema guard for zod `.refine()` on an action/route input.
 *
 * Deliberately weaker than the shape checks above — a schema does not
 * know the caller's org or the target entity, so it cannot pin ids. Its
 * job is to reject the obviously-malformed at the edge (defence in depth
 * + a clean `validation_error` instead of a service-layer `forbidden`)
 * and to bound the length before any of this reaches a service. The
 * service-layer shape check remains the load-bearing gate; this is NOT a
 * substitute for it.
 */
const BOUNDARY_SHAPE = anchored(
  `[A-Za-z0-9_-]{1,64}(?:/[A-Za-z0-9_-]{1,64}){1,4}/${OBJECT_FILENAME_SEGMENT}`,
);

export function isBoundarySafeStoragePath(path: string): boolean {
  return isValidStoragePath(path, BOUNDARY_SHAPE);
}
