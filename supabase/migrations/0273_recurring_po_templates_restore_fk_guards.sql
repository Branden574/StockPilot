-- 0273_recurring_po_templates_restore_fk_guards.sql
-- ============================================================================
-- SECURITY FIX (found 2026-07-16 by the 0206 pgTAP suite once fixture drift
-- was repaired): mig 0249 aligned recurring_po_templates' write RLS with the
-- 0208 configurable-permission posture using `alter policy … with check (…)`
-- — which REPLACES the whole expression, silently dropping the
-- location_in_org()/supplier_in_org() FK-org-consistency guards that 0206
-- added (the closed 0201-0206 class). Live effect: any manager — or any
-- member granted purchase_orders:manage — could attach ANOTHER TENANT's
-- supplier/destination location to a recurring PO template.
--
-- Restore the guards while keeping 0249's permission shape verbatim:
--   (manager+ OR has_permission) AND location_in_org AND supplier_in_org
-- Both helpers are NULL-safe (`p_x is null or exists …`), so templates
-- without a supplier/location keep working.
--
-- LESSON (goes with recurring-bug patterns): `alter policy … with check`
-- replaces, never extends — when touching a policy that carries guards,
-- re-state EVERY conjunct.
-- ============================================================================

alter policy recurring_po_templates_insert on public.recurring_po_templates
  with check (
    (
      ( select public.has_org_role(recurring_po_templates.organization_id, 'manager') )
      or ( select public.has_permission(recurring_po_templates.organization_id, 'purchase_orders:manage') )
    )
    and ( select public.location_in_org(recurring_po_templates.destination_location_id, recurring_po_templates.organization_id) )
    and ( select public.supplier_in_org(recurring_po_templates.supplier_id, recurring_po_templates.organization_id) )
  );

alter policy recurring_po_templates_update on public.recurring_po_templates
  with check (
    (
      ( select public.has_org_role(recurring_po_templates.organization_id, 'manager') )
      or ( select public.has_permission(recurring_po_templates.organization_id, 'purchase_orders:manage') )
    )
    and ( select public.location_in_org(recurring_po_templates.destination_location_id, recurring_po_templates.organization_id) )
    and ( select public.supplier_in_org(recurring_po_templates.supplier_id, recurring_po_templates.organization_id) )
  );
