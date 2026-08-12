-- 0332_po_imports_bucket_allow_heif.sql
-- ============================================================================
-- Widen the po-imports bucket pin by ONE entry: 'image/heif'.
--
-- 0325 pinned this bucket's allowed_mime_types from the code that writes to
-- it, and derived the image leg from PO_IMPORT_SCAN_MIME_TYPES
-- (apps/web/src/lib/po-imports/mime.ts). That set carried 'image/heic' but
-- not 'image/heif' — and those two labels are the SAME picture. Both name an
-- ISO-BMFF HEIF container; which of the two a browser reports for one iPhone
-- photo is an OS/browser choice, not a property of the bytes. (The repo
-- already knows this everywhere else it matters:
-- apps/web/src/lib/image-variants.ts:194 transcodes on either label, and
-- apps/web/src/server/services/order-attachments.ts:94 tests /heic|heif/i as
-- one class.)
--
-- CONSEQUENCE THIS CLOSES: the web scan form's drag-drop hands the file's own
-- Content-Type to /api/po-imports/scan, and the service then writes the first
-- frame into this bucket with `contentType = the frame's own MIME`
-- (apps/web/src/server/services/po-imports.ts:896-899, service-role — an
-- allowed_mime_types pin is bucket validation and applies to service-role
-- PUTs too). A photo labelled image/heif was therefore refusable at the
-- bucket door even after the request itself was accepted. Mobile never hit
-- this: resizeForUpload transcodes HEIC/HEIF to JPEG before upload.
--
-- WIDENED TOGETHER, IN THE SAME CHANGE (all four must agree or the widening
-- is a lie at whichever layer lags):
--   * apps/web/src/lib/po-imports/mime.ts        PO_IMPORT_SCAN_MIME_TYPES
--   * apps/web/src/app/api/po-imports/scan/route.ts   ACCEPT_TYPES
--   * apps/web/src/components/po-imports/po-scan-form.tsx   ACCEPT
--   * this migration                              storage.buckets pin
--
-- The rest of the array is REWRITTEN VERBATIM from 0325 on purpose: the
-- column is a whole-array replace, so a partial list here would silently drop
-- the entries it omits. See 0325's header for why each surviving entry is
-- there.
--
-- Safety: a single-row catalog UPDATE on storage.buckets, no storage.objects
-- DDL and no policy touched, so 0315's lock_timeout rationale does not apply.
-- INV-24 (supabase/tests/security_invariants.test.sql) only asserts the pin is
-- non-null; it stays green — this file makes the pin wider, never null.
-- ============================================================================

update storage.buckets
  set allowed_mime_types = array[
        'application/pdf',
        'text/*',
        'application/vnd.ms-excel',
        'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'
      ]
  where id = 'po-imports';
