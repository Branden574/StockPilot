-- org_can_enable_module names every module the module registry gives a
-- minimum plan, at that plan.
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
-- The CASE is a copy of the minPlan values in packages/core/src/modules/
-- registry.ts, which the app's own switch (setModuleEnabledAction) reads.
-- The registry gives instant_size_count the business plan; the CASE now
-- names it at 2, beside lot_serial, reports_advanced, ai_shelf_scan and
-- sports (2) and api_access (3). The guard test
-- apps/web/src/test/module-min-plan.guard.test.ts reads this function's last
-- definition and fails whenever the CASE and the registry differ in either
-- direction, so the next module with a minimum plan carries its arm here.
--
-- The body is the last definition's (0297_sports_module.sql) byte for byte
-- plus that one arm: md5(prosrc) 2f83822e46286c67f0f58a3079d1d49c ->
-- b2212c120cef0fcea6eb37cbdc9fdd01. Signature, result, language, volatility (STABLE),
-- SECURITY DEFINER, search_path (public), owner and EXECUTE grants
-- (authenticated and service_role; none for anon or PUBLIC) are unchanged:
-- CREATE OR REPLACE keeps the owner and the grants. No policy is touched and
-- no stored row is changed: a row that is already enabled stays as it is,
-- since the policies ask the check only on an insert or update that turns a
-- module on, and disabling stays open to an admin on any plan.
--
-- Tier A: one CREATE OR REPLACE FUNCTION. lock_timeout 900ms, as in 0416 to
-- 0419, ends any wait for a lock with an error instead of a queue. Nothing
-- here names this file's number, so the number it takes in ship order is a
-- rename only.

set lock_timeout = '900ms';

create or replace function public.org_can_enable_module(org_id uuid, p_module text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
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
    );
$$;

reset lock_timeout;
