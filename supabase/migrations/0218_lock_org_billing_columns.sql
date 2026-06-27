-- 0218_lock_org_billing_columns.sql
-- #4 BILLING SELF-UPGRADE (crown-jewel review): the entitlement-driving columns
-- on `organizations` are set ONLY by the platform billing panel + the Stripe
-- webhook, both via the SERVICE-ROLE client. But `authenticated` has TABLE-level
-- UPDATE and the organizations_update RLS only gates the ROW (not columns) — so
-- a tenant admin could `update organizations set access_tier='enterprise'` for a
-- free upgrade. RLS can't express column rules, and a column-level REVOKE is
-- ineffective against a table-level grant, so guard with a BEFORE UPDATE trigger:
-- block a CLIENT role (authenticated/anon) from changing any billing column.
-- The service-role path (current_user='service_role') and migrations (postgres)
-- are unaffected, so the platform panel + Stripe webhook keep working.
--
-- The trigger is SECURITY INVOKER (default) ON PURPOSE: it must run as the
-- caller's role so current_user reflects authenticated/anon vs service_role.

create or replace function public._guard_org_billing_columns()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('authenticated', 'anon') and (
       new.access_tier            is distinct from old.access_tier
    or new.plan                   is distinct from old.plan
    or new.billing_arrangement    is distinct from old.billing_arrangement
    or new.all_modules_comp       is distinct from old.all_modules_comp
    or new.custom_price_cents     is distinct from old.custom_price_cents
    or new.custom_price_interval  is distinct from old.custom_price_interval
    or new.billing_notes          is distinct from old.billing_notes
    or new.trial_started_at       is distinct from old.trial_started_at
    or new.trial_ends_at          is distinct from old.trial_ends_at
    or new.trial_tier             is distinct from old.trial_tier
    or new.stripe_subscription_id is distinct from old.stripe_subscription_id
    or new.stripe_customer_id     is distinct from old.stripe_customer_id
  ) then
    raise exception 'billing/entitlement columns are not user-writable'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists organizations_billing_guard on public.organizations;
create trigger organizations_billing_guard
  before update on public.organizations
  for each row execute function public._guard_org_billing_columns();

revoke all on function public._guard_org_billing_columns() from public, anon, authenticated;
