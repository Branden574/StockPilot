-- 0086_uom_conversions_trim_check.sql
-- ─────────────────────────────────────────────────────────────────────
-- U6 (DB half): add a CHECK constraint so from_uom / to_uom can never
-- carry leading or trailing whitespace. The service-side fix .trim()s
-- input before upsert, but historical rows or any non-service write
-- path (RLS-allowed direct REST calls, future bulk imports) would
-- still let through ` PK` or `EA ` and silently break the
-- case-insensitive convert() lookup downstream.
--
-- We backfill-trim existing rows first so the constraint can be added
-- VALID instead of NOT VALID (avoids a follow-up VALIDATE step).
-- ─────────────────────────────────────────────────────────────────────

set check_function_bodies = off;

-- Normalize any historical rows that snuck in with whitespace.
update public.uom_conversions
   set from_uom = btrim(from_uom),
       to_uom   = btrim(to_uom),
       updated_at = now()
 where from_uom <> btrim(from_uom)
    or to_uom   <> btrim(to_uom);

alter table public.uom_conversions
  drop constraint if exists uom_conversions_uom_trimmed_check;

alter table public.uom_conversions
  add constraint uom_conversions_uom_trimmed_check
  check (from_uom = btrim(from_uom) and to_uom = btrim(to_uom));
