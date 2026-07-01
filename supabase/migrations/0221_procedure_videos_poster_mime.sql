-- 0221_procedure_videos_poster_mime.sql
-- ─────────────────────────────────────────────────────────────────────
-- Re-allow POSTER image types on the `procedure-videos` bucket.
--
-- 0172 locked the bucket to video/* because the image allowance was unused
-- at the time. The media/perf audit (2026-07-01, owner-approved) adds a
-- poster pipeline: the uploader captures one JPEG frame per video client-side
-- and stores it as `{org}/{procedure}/{uuid}.poster.jpg`, so the Procedures
-- grid can render a ~30 KB <img> instead of range-fetching the FULL video
-- file (up to 1 GB) as a "thumbnail" on every list view.
--
-- Scope of the widening: image/jpeg + image/webp only (no SVG — it can carry
-- script; no PNG needed). procedure_videos.thumbnail_path rows are validated
-- server-side in ProcedureVideosService.record() to the same org/procedure
-- prefix as the video itself.

update storage.buckets
set allowed_mime_types = array[
  'video/mp4', 'video/quicktime', 'video/webm',
  'image/jpeg', 'image/webp'
]
where id = 'procedure-videos';
