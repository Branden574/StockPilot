-- 0022_receipt_search_path.sql
-- ============================================================================
-- Adds `extensions` to the search_path of post_receipt_v2 and reverse_receipt
-- so they can find pgcrypto's digest() function.
--
-- Receiving stock against an imported PO failed with:
--   ERROR: function digest(text, unknown) does not exist
-- Cause: Supabase installs pgcrypto into the `extensions` schema by default,
-- but both functions were created with `set search_path = public` — so the
-- unqualified digest() call inside them couldn't resolve.
--
-- Fix: ALTER FUNCTION ... SET search_path = public, extensions for both.
-- The function bodies don't change.
-- ============================================================================

alter function public.post_receipt_v2(uuid, uuid, jsonb, text, text, text)
  set search_path = public, extensions;

alter function public.reverse_receipt(uuid, text)
  set search_path = public, extensions;
