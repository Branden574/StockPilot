-- Tighten organizations_insert: drop the open client-side INSERT policy.
--
-- Original policy (from 0003_rls.sql) granted INSERT to any authenticated
-- user via `with check (auth.uid() is not null)` — meaning anyone with a
-- valid Supabase JWT could call
-- `supabase.from('organizations').insert(...)` directly from the
-- browser SDK and create unlimited orgs, bypassing
-- `createOrganizationAction` (which already routes through the
-- service-role admin client).
--
-- For the invite-only internal-tool model, org creation must stay on
-- the server (createOrganizationAction in apps/web/src/server/actions/
-- organization.ts) where it can be gated by future invite-allowlist
-- checks. Dropping the client policy enforces that: legitimate calls
-- via the admin client continue to work (admin bypasses RLS); any
-- direct client INSERT now fails with RLS denial.

drop policy if exists organizations_insert on public.organizations;

-- No replacement policy is needed. service_role bypasses RLS, and that
-- is the only path that should create orgs going forward.
