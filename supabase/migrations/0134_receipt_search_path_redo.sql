-- 0134_receipt_search_path_redo.sql
--
-- Re-applies the search_path fix from migration 0022. Receiving a PO
-- failed with:
--
--   ERROR: function digest(text, unknown) does not exist
--
-- Root cause: migration 0069 recreated public.post_receipt_v2 with
-- `set search_path = public` (no `extensions`), overwriting the
-- 0022 fix. pgcrypto lives in the `extensions` schema on Supabase,
-- so unqualified `digest(...)` calls inside the function body don't
-- resolve. Migration 0015 had the same omission for reverse_receipt
-- (which is also called from receiving flows), so we patch both
-- defensively even though only post_receipt_v2 is in the current
-- failure path.
--
-- This is an ALTER FUNCTION ... SET — it does NOT change function
-- bodies, signatures, or grants. Safe to re-run.

alter function public.post_receipt_v2(uuid, uuid, jsonb, text, text, text)
  set search_path = public, extensions;

alter function public.reverse_receipt(uuid, text)
  set search_path = public, extensions;
