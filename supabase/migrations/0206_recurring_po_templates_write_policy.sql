-- 0206_recurring_po_templates_write_policy.sql
-- Fix a functionality gap: mig 0180 created recurring_po_templates with RLS
-- ENABLED but only a SELECT policy + only `grant select` — the INSERT/UPDATE/DELETE
-- policies and grants were never added. RecurringPoTemplatesService does direct
-- .insert()/.update()/.delete() via the USER-authenticated client (ctx.supabase),
-- so every user-initiated create/update/toggle/delete was RLS-DENIED — the write
-- path has been dead since launch (0 rows in prod). The runDueTemplates cron uses
-- createAdminClient (service-role, bypasses RLS) so scheduled runs were unaffected.
--
-- Add the missing write policies + grants, manager-scoped to match the service's
-- `purchase_orders:manage` gate and the existing purchase_orders_write policy. The
-- WITH CHECK also carries the FK-org-consistency guards (migs 0203/0205) for this
-- table's FK columns (destination_location_id, supplier_id) so it joins the closed
-- class — a caller cannot reference another tenant's location/supplier on a template.
-- (The SELECT policy from 0180 is left untouched: any org member may read.)

grant insert, update, delete on public.recurring_po_templates to authenticated;

create policy recurring_po_templates_insert on public.recurring_po_templates
  for insert to authenticated
  with check (
    ( SELECT public.has_org_role(recurring_po_templates.organization_id, 'manager') )
    and ( SELECT public.location_in_org(recurring_po_templates.destination_location_id, recurring_po_templates.organization_id) )
    and ( SELECT public.supplier_in_org(recurring_po_templates.supplier_id, recurring_po_templates.organization_id) )
  );

create policy recurring_po_templates_update on public.recurring_po_templates
  for update to authenticated
  using ( ( SELECT public.has_org_role(recurring_po_templates.organization_id, 'manager') ) )
  with check (
    ( SELECT public.has_org_role(recurring_po_templates.organization_id, 'manager') )
    and ( SELECT public.location_in_org(recurring_po_templates.destination_location_id, recurring_po_templates.organization_id) )
    and ( SELECT public.supplier_in_org(recurring_po_templates.supplier_id, recurring_po_templates.organization_id) )
  );

create policy recurring_po_templates_delete on public.recurring_po_templates
  for delete to authenticated
  using ( ( SELECT public.has_org_role(recurring_po_templates.organization_id, 'manager') ) );
