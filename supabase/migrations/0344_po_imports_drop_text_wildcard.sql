-- ═══════════════════════════════════════════════════════════════════════════
-- 0344 — `text/*` IS NOT A FILE-TYPE ALLOWLIST
--
-- The po-imports bucket accepted `text/*`, which matches text/html. A bucket's
-- allowed_mime_types is checked against the Content-Type the CLIENT sent with
-- its PUT, so declaring `text/html` was enough to land an HTML document in the
-- bucket — and objects there are served from the storage origin with their
-- stored mime, which means a browser renders it. An uploaded page executing on
-- our own storage domain is exactly what an upload allowlist exists to stop.
--
-- The wildcard was almost certainly meant to cover CSV. It does — and also
-- html, xml, javascript, and every other text/* subtype ever registered or
-- ever to be. That is what makes a wildcard the wrong shape for a security
-- allowlist: it is a denylist wearing an allowlist's clothes.
--
-- Replaced with the explicit types real producers emit. `text/plain` is
-- included DELIBERATELY: browsers and operating systems label a .csv as
-- text/plain often enough that dropping it would reject legitimate imports,
-- and plain text carries no active content. text/html is not reachable from
-- that set.
--
-- NOT a substitute for byte verification. This narrows what can be DECLARED;
-- it cannot detect a lie. The finalize-time sniff is the layer that reads the
-- actual bytes. Both, or neither is worth much.
-- ═══════════════════════════════════════════════════════════════════════════

update storage.buckets
   set allowed_mime_types = array[
     'application/pdf',
     'text/csv',
     'text/plain',
     'application/csv',
     'application/vnd.ms-excel',
     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
     'image/jpeg',
     'image/png',
     'image/webp',
     'image/heic',
     'image/heif'
   ]
 where id = 'po-imports';
