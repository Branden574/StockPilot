-- 0219_org_module_minplan_rls.sql
-- #2 MODULE SELF-ENABLE (crown-jewel review): organization_modules had a single
-- `for all ... has_org_role(admin)` write policy, so an org admin could directly
-- INSERT/UPDATE rows to enable premium (minPlan) modules — e.g. the
-- enterprise-only api_access — bypassing the app-layer minPlan check
-- (setModuleEnabledAction). RLS is the authoritative boundary, so encode the
-- entitlement there: enabling a module whose minPlan exceeds the org's EFFECTIVE
-- plan is denied. Disabling (enabled=false) stays unrestricted.

-- Effective plan tier, mirroring resolveEffectivePlan (override > live Stripe >
-- active trial > base plan > free). SECURITY DEFINER so it reads organizations
-- regardless of the caller's RLS.
create or replace function public.org_effective_tier(org_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  o record;
begin
  select access_tier, plan, stripe_subscription_id, trial_ends_at, trial_tier
    into o from public.organizations where id = org_id;
  if not found then return 'free'; end if;
  if o.access_tier is not null then return o.access_tier; end if;                         -- 1. admin override
  if o.stripe_subscription_id is not null then return coalesce(o.plan, 'free'); end if;    -- 2. live Stripe sub
  if o.trial_ends_at is not null and o.trial_ends_at > now()                              -- 3. active trial
    then return coalesce(o.trial_tier, 'enterprise'); end if;
  return coalesce(o.plan, 'free');                                                         -- 4. base plan
end;
$$;

-- True when the org's effective plan (or an all-modules comp) entitles it to
-- enable the given module. minPlan mirrors the TS MODULE_REGISTRY; modules not
-- listed have no minPlan and are always allowed.
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
        when 'api_access' then 3
        else 0
      end
    );
$$;

revoke all on function public.org_effective_tier(uuid) from public, anon;
revoke all on function public.org_can_enable_module(uuid, text) from public, anon;
grant execute on function public.org_effective_tier(uuid) to authenticated;
grant execute on function public.org_can_enable_module(uuid, text) to authenticated;

-- Replace the single `for all` admin write policy with per-command policies that
-- AND the minPlan gate into INSERT/UPDATE WITH CHECK (only when enabling).
drop policy if exists org_modules_admin on public.organization_modules;

create policy org_modules_admin_insert on public.organization_modules
  for insert to authenticated
  with check (
    ( SELECT public.has_org_role(organization_modules.organization_id, 'admin') )
    and (
      organization_modules.enabled = false
      or ( SELECT public.org_can_enable_module(organization_modules.organization_id, organization_modules.module_id) )
    )
  );

create policy org_modules_admin_update on public.organization_modules
  for update to authenticated
  using ( ( SELECT public.has_org_role(organization_modules.organization_id, 'admin') ) )
  with check (
    ( SELECT public.has_org_role(organization_modules.organization_id, 'admin') )
    and (
      organization_modules.enabled = false
      or ( SELECT public.org_can_enable_module(organization_modules.organization_id, organization_modules.module_id) )
    )
  );

create policy org_modules_admin_delete on public.organization_modules
  for delete to authenticated
  using ( ( SELECT public.has_org_role(organization_modules.organization_id, 'admin') ) );
