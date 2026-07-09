-- recurring_po_templates: align write RLS with the 0208 configurable-permission
-- posture. The 0206 policies were role-only (has_org_role 'manager'), which
--   (a) blocked a lower-role user GRANTED purchase_orders:manage from writing —
--       the web service passes assertPermission but runs on the USER-authed
--       client, so the role-only RLS rejected the row write; and
--   (b) diverged from every other PO-surface table (purchase_orders,
--       purchase_order_items, po_imports, po_import_lines — all additive since
--       0208).
-- Same additive shape: manager+ always passes (a wrong override row can never
-- lock a manager out); a member granted purchase_orders:manage now passes too.
-- App-level revocations keep taking effect at the assertPermission gate on the
-- service paths, exactly like the rest of the PO surface.

alter policy recurring_po_templates_insert on public.recurring_po_templates
  with check (
    ( select public.has_org_role(recurring_po_templates.organization_id, 'manager') )
    or ( select public.has_permission(recurring_po_templates.organization_id, 'purchase_orders:manage') )
  );

alter policy recurring_po_templates_update on public.recurring_po_templates
  using (
    ( select public.has_org_role(recurring_po_templates.organization_id, 'manager') )
    or ( select public.has_permission(recurring_po_templates.organization_id, 'purchase_orders:manage') )
  )
  with check (
    ( select public.has_org_role(recurring_po_templates.organization_id, 'manager') )
    or ( select public.has_permission(recurring_po_templates.organization_id, 'purchase_orders:manage') )
  );

alter policy recurring_po_templates_delete on public.recurring_po_templates
  using (
    ( select public.has_org_role(recurring_po_templates.organization_id, 'manager') )
    or ( select public.has_permission(recurring_po_templates.organization_id, 'purchase_orders:manage') )
  );
