-- 0104_mfa_recovery_grants.sql
-- ============================================================================
-- Bring `public.mfa_recovery_codes` (originally created in 0027) in line
-- with the explicit-GRANTs rule that took effect 2026-10-30 — every new
-- table since then must explicitly grant CRUD privileges to the
-- `authenticated` role so RLS policies are the only gate. We grandfather
-- old tables but `mfa_recovery_codes` is high-stakes enough to retrofit.
--
-- We also add explicit deny-by-default INSERT/UPDATE/DELETE policies so
-- that the SECURITY DEFINER functions (`generate_mfa_recovery_codes`,
-- `consume_mfa_recovery_code`) remain the SOLE path that writes to this
-- table. The existing SELECT policy on `0027` (`user_id = auth.uid()`)
-- stays in place — users still need to read their own row counts for
-- the "you've used N of 10" status pill.
-- ============================================================================

grant select, insert, update, delete on public.mfa_recovery_codes to authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- Deny-by-default policies for direct INSERT/UPDATE/DELETE. The
-- SECURITY DEFINER functions own the write path; nothing else should
-- be able to mint, burn, or wipe recovery codes from the client.
-- ─────────────────────────────────────────────────────────────────────

drop policy if exists mfa_recovery_codes_no_insert on public.mfa_recovery_codes;
create policy mfa_recovery_codes_no_insert on public.mfa_recovery_codes
  for insert
  with check (false);

drop policy if exists mfa_recovery_codes_no_update on public.mfa_recovery_codes;
create policy mfa_recovery_codes_no_update on public.mfa_recovery_codes
  for update
  using (false)
  with check (false);

drop policy if exists mfa_recovery_codes_no_delete on public.mfa_recovery_codes;
create policy mfa_recovery_codes_no_delete on public.mfa_recovery_codes
  for delete
  using (false);

-- The existing `mfa_recovery_codes_own` SELECT policy from 0027 stays
-- as-is so users can still see their own remaining-code count.
-- SECURITY DEFINER functions bypass RLS entirely (they run as the
-- function owner), so deny-by-default doesn't break the generate /
-- consume flows.

comment on table public.mfa_recovery_codes is
  'MFA recovery codes (hashed). Writes are SOLELY through '
  'generate_mfa_recovery_codes() and consume_mfa_recovery_code() '
  'SECURITY DEFINER functions; deny-by-default RLS policies block all '
  'other INSERT/UPDATE/DELETE paths. SELECT is per-user.';
