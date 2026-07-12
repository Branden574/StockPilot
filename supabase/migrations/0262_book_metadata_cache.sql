-- 0262_book_metadata_cache.sql
-- Persistent ISBN → metadata cache (books "database").
--
-- Problem: every mobile scan / bulk import / AI tool call re-ran the full
-- lib/books/lookup.ts pipeline live, re-hitting Google Books each time. With
-- no caching, the Google Books free quota (1,000 queries/day/project) is
-- exhausted mid-day (the price-pull cron alone took up to 500), so ~3/4 of
-- lookups fell back to Open Library and lost Google Books' richer metadata.
--
-- Fix: cache each successful lookup here, keyed by the CANONICAL ISBN-13 (so
-- a book scanned as ISBN-10 or ISBN-13 shares one row). lookupIsbn() reads
-- this first and only touches the external APIs on a miss — turning a fixed
-- catalog's repeat scans into zero-quota reads. Global reference data (not
-- org-scoped): the same ISBN resolves to the same book for everyone.
--
-- Only real-bibliographic-source results are cached (google-books /
-- open-library / library-of-congress). AI-fallback-only ('gemini') results
-- are deliberately NOT persisted — the hallucination guard (lookup-gemini.ts)
-- verifies them per-request, and we never want a possibly-wrong AI answer
-- served from cache forever; a later scan can still resolve it from a real
-- source. Negative results (nothing found) are not stored either, so a book
-- added to Open Library later is still discoverable.
--
-- RLS: enabled with NO policies — read and written exclusively via the
-- service-role lookup pipeline (server-side). No client ever touches this
-- table directly. Same posture as api_keys (0170) / support_tickets (0173).

create table if not exists public.book_metadata_cache (
  isbn           text primary key,          -- canonical ISBN-13 when derivable, else the normalized input
  title          text,
  authors        jsonb       not null default '[]'::jsonb,
  publisher      text,
  published_date text,
  description    text,
  page_count     integer,
  thumbnail_url  text,
  grade          text,
  source         text,                       -- primary (first) source of the merged result
  sources        jsonb       not null default '[]'::jsonb,
  fetched_at     timestamptz not null default now()
);

comment on table public.book_metadata_cache is
  'Global ISBN->metadata cache. Populated on lookup miss to stop re-hitting the Google Books daily quota; read first on every scan/import. Service-role only (RLS enabled, no policies).';

alter table public.book_metadata_cache enable row level security;
