-- ============================================================================
-- 0047_bucket_size_limits.sql
-- ============================================================================
-- Pin the file_size_limit on the public-CDN-backed image buckets so
-- a renamed huge binary can't be POSTed directly to the Supabase
-- Storage API and bypass the client-side 5 MB UI cap.
-- 0046 already pinned allowed_mime_types; this closes the size leg.
-- ============================================================================

update storage.buckets
  set file_size_limit = 5 * 1024 * 1024  -- 5 MB
  where id in ('org-logos', 'user-avatars');

-- item-images stays generous (10 MB) since legitimate book covers /
-- product photos can run larger. Web uploader caps at 10 MB
-- client-side already; this matches it server-side.
update storage.buckets
  set file_size_limit = 10 * 1024 * 1024  -- 10 MB
  where id = 'item-images';

-- po-imports bucket holds scanned receipts/invoices — multi-page
-- PDFs can run a few MB each. 25 MB cap is well above realistic
-- documents and below DoS-via-upload territory.
update storage.buckets
  set file_size_limit = 25 * 1024 * 1024  -- 25 MB
  where id = 'po-imports';
