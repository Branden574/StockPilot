-- 0187_procedure_videos_1gb.sql
-- ─────────────────────────────────────────────────────────────────────
-- Raise the `procedure-videos` bucket per-file cap from 500 MB to 1 GB.
--
-- 500 MB turned out to be too small for desktop screen recordings (a real
-- 168 MB recording was rejected — see note below). Bump to 1 GB to cover
-- longer / higher-bitrate captures.
--
-- IMPORTANT — this per-bucket limit is only HALF the cap. Supabase also
-- enforces a PROJECT-WIDE global upload size limit, and storage rejects an
-- upload at min(global_limit, bucket_limit). The hosted default global
-- limit is 50 MB, which is why the 168 MB upload returned HTTP 400
-- ("Payload too large") even though this bucket already allowed 500 MB.
-- A migration cannot change the global limit — it is a storage-service
-- config value. The project owner must raise it to >= 1 GB in:
--   Supabase Dashboard → Storage → Settings → "Upload file size limit"
-- (or via the Management API: PATCH /v1/projects/{ref}/config/storage
--  { "fileSizeLimit": 1073741824 }). Without that, this bump has no effect.
--
-- allowed_mime_types is re-pinned to the video-only set so this migration
-- can't silently undo the 0172 MIME lockdown.
-- ─────────────────────────────────────────────────────────────────────

update storage.buckets
set file_size_limit    = 1073741824,  -- 1 GB (1024^3 bytes)
    allowed_mime_types = array['video/mp4', 'video/quicktime', 'video/webm']
where id = 'procedure-videos';
