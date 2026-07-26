-- 0293_b2b_portal_pricing_mode_backfill.sql
-- Backfill the B2B portal's pricing mode for orgs that ALREADY charge.
--
-- WHY: the new per-org setting lives in organization_modules.settings->>'pricingMode'
-- for module 'b2b_portal', and resolvePortalPricingMode (@stockpilot/core) resolves
-- an absent/malformed value to 'no_charge'. That default is the right one for a NEW
-- org — a misconfigured portal must never invent prices — but every org that
-- enabled the portal before this feature existed has settings = '{}', so shipping
-- the code alone would silently flip a real, price-list-driven portal to no-charge:
-- prices and order totals would vanish from the customer's shop and checkout would
-- start stamping unit_price_at_request = 0 on real order_request_lines.
--
-- The signal for "this org charges" is DATA, not a hardcoded org id: it already
-- built a price list. Orgs with no price list have nothing to charge from and
-- correctly keep the 'no_charge' default.
--
-- Idempotent and non-clobbering:
--   • `settings || jsonb` MERGES — every other key in that settings bucket
--     survives (several modules share this column for their own settings).
--   • the `not settings ? 'pricingMode'` guard means an explicit choice (made
--     later through the UI, or by re-running this file) is never overwritten,
--     in either direction.
--
-- Body lives in a locked-down function so the pgTAP test can re-invoke the REAL
-- statement against its own fixtures rather than a copy of it (same shape as
-- 0270's _dedup_rack_locations).
-- Proof: supabase/tests/0293_b2b_portal_pricing_mode_backfill.test.sql

create or replace function public._backfill_portal_pricing_mode()
returns void
language sql
security definer
set search_path = public
as $$
  update public.organization_modules m
  set settings = coalesce(m.settings, '{}'::jsonb) || '{"pricingMode":"priced"}'::jsonb
  where m.module_id = 'b2b_portal'
    and not (coalesce(m.settings, '{}'::jsonb) ? 'pricingMode')
    and exists (
      select 1 from public.price_lists pl
      where pl.organization_id = m.organization_id
    );
$$;

-- One-shot maintenance helper — no runtime caller, so no grants.
revoke all on function public._backfill_portal_pricing_mode() from public, anon, authenticated, service_role;

select public._backfill_portal_pricing_mode();
