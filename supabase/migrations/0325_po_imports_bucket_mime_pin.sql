-- 0325_po_imports_bucket_mime_pin.sql
-- ============================================================================
-- Pin `allowed_mime_types` on the po-imports storage bucket — the LAST bucket
-- in this schema without one. 0021 created it with no pin at all and 0047 only
-- closed the size leg (25 MB), so until now the bucket accepted a PUT of ANY
-- declared content type. That is reachable, not theoretical: presignUpload
-- (apps/web/src/server/services/po-imports.ts:522-523) mints a signed upload
-- URL and the CLIENT performs the PUT itself, so the bucket-level pin is the
-- only check that runs against the request Storage actually receives. The
-- service refuses a bad declared MIME before minting (MED-22), but a caller
-- holding a legitimately-minted URL still chooses the Content-Type header of
-- its own PUT — this pin is what refuses that header.
--
-- THE ACCEPTED SET, DERIVED FROM CODE (every entry has a live writer):
--
--   'application/pdf'
--       upload allowlist  apps/web/src/lib/po-imports/mime.ts:42
--       scan allowlist    apps/web/src/lib/po-imports/mime.ts:75
--       scan upload       apps/web/src/server/services/po-imports.ts:898
--                         (contentType = the frame's own MIME, service-role —
--                         allowed_mime_types applies to service-role PUTs too,
--                         it is bucket validation, not RLS)
--   'text/*'
--       upload allowlist  apps/web/src/lib/po-imports/mime.ts:43 ('text/csv')
--       client PUT        apps/web/src/components/po-imports/po-upload-form.tsx:54
--                         sends `Content-Type: file.type` verbatim. A wildcard
--                         rather than a bare 'text/csv' because CSV tooling is
--                         charset-noisy: browsers and exporters legitimately
--                         send 'text/csv;charset=utf-8' (and friends), and an
--                         exact pin would refuse those uploads at the storage
--                         door AFTER the service already accepted the mint.
--                         The bucket is PRIVATE and every read is a signed URL
--                         minted server-side, so the wider text/* surface does
--                         not create a public text/html host.
--   'application/vnd.ms-excel'
--       upload allowlist  apps/web/src/lib/po-imports/mime.ts:44 — Windows
--                         reports THIS for a plain .csv; it maps to the same
--                         CSV parse path. Real XLSX
--                         (...openxmlformats...sheet) is deliberately ABSENT:
--                         no upload mints it (mime.ts:30-34 — the parser has
--                         no xlsx branch), so the bucket refuses it too.
--   'image/jpeg', 'image/png', 'image/webp', 'image/heic'
--       scan allowlist    apps/web/src/lib/po-imports/mime.ts:70-76
--       service twin gate apps/web/src/server/services/po-imports.ts:849
--       scan upload       apps/web/src/server/services/po-imports.ts:896-899
--                         (first frame stored as the canonical scan record)
--
-- Style/precedent: 0046:196-205 (image buckets), 0143:79-85
-- (order-attachments), 0211:30-38 (po-attachments), 0315:29-34
-- (maintenance-photos) — all pin with a literal array on storage.buckets.
-- No storage.objects DDL here (no policy is touched), so 0315's lock_timeout
-- rationale does not apply: this is a single-row catalog UPDATE.
-- ============================================================================

update storage.buckets
  set allowed_mime_types = array[
        'application/pdf',
        'text/*',
        'application/vnd.ms-excel',
        'image/jpeg', 'image/png', 'image/webp', 'image/heic'
      ]
  where id = 'po-imports';
