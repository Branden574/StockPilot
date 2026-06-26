-- 0208_po_write_has_permission.sql
-- Configurable permissions P2: make the purchase-order write surface honor the
-- has_permission('purchase_orders:manage') resolver (migration 0207) so an org
-- can grant a lower role (e.g. a viewer / "read-only auditor") the ability to
-- create + import POs. The concrete driver: "read-only auditors should be able
-- to import POs."
--
-- Strategy = ADDITIVE. Each policy's manager role-gate
--   has_org_role(org, 'manager')
-- becomes
--   ( has_org_role(org, 'manager') OR has_permission(org, 'purchase_orders:manage') )
-- so:
--   • managers+ still pass exactly as before (zero regression — they also have
--     the permission by default, but the has_org_role term is kept so a wrong
--     override row can never lock a manager out);
--   • a member granted purchase_orders:manage (role- or user-level override)
--     now passes the row-level write too, not just the app gate.
-- All existing FK-org-consistency guards (location/charter/supplier/warehouse,
-- migs 0203/0204/0205) are reproduced VERBATIM and AND-ed exactly as before.
--
-- Tables covered = the full PO management + import write surface:
--   purchase_orders, purchase_order_items, po_imports, po_import_lines.
-- (Revokes already take effect at the app gate, which runs before any write.)

-- ── purchase_orders (FOR ALL) ──────────────────────────────────────────────
alter policy purchase_orders_write on public.purchase_orders
  using (
    ( SELECT public.has_org_role(purchase_orders.organization_id, 'manager') )
    or ( SELECT public.has_permission(purchase_orders.organization_id, 'purchase_orders:manage') )
  )
  with check (
    (
      ( ( SELECT public.has_org_role(purchase_orders.organization_id, 'manager') )
        or ( SELECT public.has_permission(purchase_orders.organization_id, 'purchase_orders:manage') ) )
      and ( SELECT public.location_in_org(purchase_orders.destination_location_id, purchase_orders.organization_id) )
      and ( SELECT public.charter_in_org(purchase_orders.charter_id, purchase_orders.organization_id) )
    )
    and ( SELECT public.supplier_in_org(purchase_orders.supplier_id, purchase_orders.organization_id) )
  );

-- ── purchase_order_items (FOR ALL) — no FK-org guards ──────────────────────
alter policy purchase_order_items_write on public.purchase_order_items
  using (
    ( SELECT public.has_org_role(purchase_order_items.organization_id, 'manager') )
    or ( SELECT public.has_permission(purchase_order_items.organization_id, 'purchase_orders:manage') )
  )
  with check (
    ( SELECT public.has_org_role(purchase_order_items.organization_id, 'manager') )
    or ( SELECT public.has_permission(purchase_order_items.organization_id, 'purchase_orders:manage') )
  );

-- ── po_imports (INSERT) ────────────────────────────────────────────────────
alter policy po_imports_insert on public.po_imports
  with check (
    (
      ( ( SELECT public.has_org_role(po_imports.organization_id, 'manager') )
        or ( SELECT public.has_permission(po_imports.organization_id, 'purchase_orders:manage') ) )
      and ( SELECT public.warehouse_in_org(po_imports.warehouse_id, po_imports.organization_id) )
    )
    and ( SELECT public.supplier_in_org(po_imports.vendor_id, po_imports.organization_id) )
  );

-- ── po_imports (UPDATE) ────────────────────────────────────────────────────
alter policy po_imports_update on public.po_imports
  using (
    ( SELECT public.has_org_role(po_imports.organization_id, 'manager') )
    or ( SELECT public.has_permission(po_imports.organization_id, 'purchase_orders:manage') )
  )
  with check (
    (
      ( ( SELECT public.has_org_role(po_imports.organization_id, 'manager') )
        or ( SELECT public.has_permission(po_imports.organization_id, 'purchase_orders:manage') ) )
      and ( SELECT public.warehouse_in_org(po_imports.warehouse_id, po_imports.organization_id) )
    )
    and ( SELECT public.supplier_in_org(po_imports.vendor_id, po_imports.organization_id) )
  );

-- ── po_import_lines (FOR ALL, scoped via parent po_imports) ────────────────
alter policy po_import_lines_write on public.po_import_lines
  using (
    exists (
      select 1 from public.po_imports pi
      where pi.id = po_import_lines.po_import_id
        and ( ( SELECT public.has_org_role(pi.organization_id, 'manager') )
              or ( SELECT public.has_permission(pi.organization_id, 'purchase_orders:manage') ) )
    )
  )
  with check (
    exists (
      select 1 from public.po_imports pi
      where pi.id = po_import_lines.po_import_id
        and ( ( SELECT public.has_org_role(pi.organization_id, 'manager') )
              or ( SELECT public.has_permission(pi.organization_id, 'purchase_orders:manage') ) )
    )
  );
