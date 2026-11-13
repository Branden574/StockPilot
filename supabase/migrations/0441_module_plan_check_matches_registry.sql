-- The module plan check names every module the module registry gives a
-- minimum plan, at that plan, and answers only for the caller's own
-- organization; the effective-plan helper is called only by the database's
-- own rules.
--
-- public.org_can_enable_module(org_id, p_module) is the plan check behind the
-- organization_modules write policies (org_modules_admin_insert and
-- org_modules_admin_update, 0219): an admin's row may turn a module on only
-- while it is true. It is true when the organization holds the
-- all_modules_comp flag, or when the rank of its effective plan
-- (org_effective_tier: free 0, pro 1, business 2, enterprise 3) reaches the
-- module's rank in a CASE on the module key; a module the CASE does not name
-- ranks 0.
--
-- 1. The CASE is a copy of the minPlan values in packages/core/src/modules/
--    registry.ts, which the app's own switch (setModuleEnabledAction) reads.
--    The registry gives instant_size_count the business plan; the CASE now
--    names it at 2, beside lot_serial, reports_advanced, ai_shelf_scan and
--    sports (2) and api_access (3). The guard test
--    apps/web/src/test/module-min-plan.guard.test.ts reads this function's
--    last definition and fails whenever the CASE and the registry differ in
--    either direction, so the next module with a minimum plan carries its
--    arm here.
--
-- 2. The whole predicate is now guarded by
--      (select auth.uid()) is null or public.is_org_member(org_id)
--    in exactly the form module_enabled has carried since 0354: a signed-in
--    caller gets an answer only for an organization they are a member of,
--    and false for any other. A context with no end user (the service role,
--    migrations: auth.uid() is null) is answered as before. The two policies
--    ask it about the row's own organization, for a caller who is already an
--    admin of it (has_org_role, ANDed before it), so they decide exactly as
--    before.
--
-- 3. org_effective_tier(uuid) is called only by org_can_enable_module, which
--    runs as its owner (SECURITY DEFINER), so authenticated no longer holds
--    EXECUTE on it; anon and PUBLIC hold none, and service_role keeps it.
--    Nothing in the app or the phone calls either function directly; the
--    database's own rules are their only callers.
--
-- Otherwise the body is the last definition's (0297_sports_module.sql) as it
-- was, plus the one arm, inside the guard (md5(prosrc)
-- 2f83822e46286c67f0f58a3079d1d49c -> 4d6ad56b2749cd71a1aa440a82159ecf).
-- Signature, result, language, volatility (STABLE), SECURITY
-- DEFINER, search_path (public; the body schema-qualifies everything it
-- names) and owner are unchanged for both functions, and org_effective_tier's
-- body is not restated. The EXECUTE grants are restated below in full:
--   org_can_enable_module: authenticated and service_role (unchanged);
--   org_effective_tier:    service_role only.
-- No table, policy or stored row is changed: a row that is already enabled
-- stays as it is, since the policies ask the check only on an insert or
-- update that turns a module on, and disabling stays open to an admin on any
-- plan.
--
-- Tier A: the code and the privileges of two functions. lock_timeout 900ms,
-- as in 0416 to 0419, ends any wait for a lock with an error instead of a
-- queue. Nothing here names this file's number, so the number it takes in
-- ship order is a rename only.

set lock_timeout = '900ms';

create or replace function public.org_can_enable_module(org_id uuid, p_module text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    ((select auth.uid()) is null or public.is_org_member(org_id))
    and (
      coalesce((select all_modules_comp from public.organizations where id = org_id), false)
      or (
        case public.org_effective_tier(org_id)
          when 'pro' then 1 when 'business' then 2 when 'enterprise' then 3 else 0
        end
      ) >= (
        case p_module
          when 'lot_serial' then 2
          when 'reports_advanced' then 2
          when 'ai_shelf_scan' then 2
          when 'instant_size_count' then 2
          when 'sports' then 2
          when 'api_access' then 3
          else 0
        end
      )
    );
$$;

revoke execute on function public.org_can_enable_module(uuid, text) from public, anon;
grant execute on function public.org_can_enable_module(uuid, text) to authenticated, service_role;

revoke execute on function public.org_effective_tier(uuid) from public, anon, authenticated;
grant execute on function public.org_effective_tier(uuid) to service_role;

reset lock_timeout;
