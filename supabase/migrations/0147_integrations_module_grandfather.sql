-- ============================================================================
-- 0147_integrations_module_grandfather.sql
-- Net-new optional module 'integrations' (connector framework, 0146) defaults
-- OFF for every existing org.
--
-- Unlike the 0145 grandfather (which enabled the full charter set so behaviour
-- was byte-for-byte identical to the pre-entitlement world), 'integrations' is
-- brand-new functionality that NO org has ever exercised. It must be explicit
-- opt-in (admin connects QuickBooks from /dashboard/settings/integrations), so
-- we seed the row with enabled=false. The off row makes module_enabled(org,
-- 'integrations') return false and lets the settings UI show a "not connected"
-- state without a missing-row special case.
--
-- Column set is the source-of-truth from 0144_org_modules_entitlements.sql:
--   organization_modules(organization_id, module_id, enabled, tier,
--                        settings default '{}', enabled_at default now(),
--                        enabled_by); tier check allows 'optional'.
-- The 0145 seed_org_modules() new-org trigger intentionally does NOT seed
-- 'integrations', so brand-new orgs also start without it (explicit opt-in).
-- ============================================================================

insert into public.organization_modules (organization_id, module_id, enabled, tier, enabled_at)
select o.id, 'integrations', false, 'optional', now()
from public.organizations o
on conflict (organization_id, module_id) do nothing;
