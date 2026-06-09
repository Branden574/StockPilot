-- 0172_procedure_videos_mime_lockdown.sql
-- ─────────────────────────────────────────────────────────────────────
-- Tighten the `procedure-videos` storage bucket to video MIME types only.
--
-- 0053 created the bucket with allowed_mime_types that ALSO included image/jpeg,
-- image/png, image/webp. The feature only uploads video (the client uploader
-- restricts to video/*), and there is no server-side magic-byte validation — so
-- the image/* allowance was an unused widening that let a privileged caller
-- store a non-video (e.g. an SVG renamed/typed as image/jpeg) in the bucket.
-- Removing image/* closes that vector with zero feature impact. Security audit
-- 2026-06-09.
-- ─────────────────────────────────────────────────────────────────────

update storage.buckets
set allowed_mime_types = array['video/mp4', 'video/quicktime', 'video/webm']
where id = 'procedure-videos';
