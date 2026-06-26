-- 0205_supplier_fk_org_consistency.sql
-- Final FK-org-consistency class (after 0201/0202/0203 warehouse+location, 0204
-- charter): the supplier FK. Several write policies validate only the row's
-- organization_id but never that a caller-supplied supplier_id / vendor_id points
-- at a supplier in that org — so a member could reference another tenant's
-- supplier on their own row (cross-tenant integrity write). All such columns
-- (supplier_id AND vendor_id) FK to public.suppliers(id). Same pattern as 0203/0204:
-- a NULL-safe SECURITY DEFINER `supplier_in_org` guard AND-ed onto each write
-- policy's WITH CHECK via ALTER POLICY (existing WITH CHECK — already carrying the
-- 0203/0204 warehouse/location/charter guards — reproduced VERBATIM; USING untouched).
-- recurring_po_templates.supplier_id has no direct-write RLS policy (RLS denies
-- direct writes; the service writes it) so it is guarded in the service layer, not here.

create or replace function public.supplier_in_org(p_supplier_id uuid, p_org_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select p_supplier_id is null or exists (
    select 1 from public.suppliers
    where id = p_supplier_id and organization_id = p_org_id
  );
$$;
grant execute on function public.supplier_in_org(uuid, uuid) to authenticated;

-- inventory_items.supplier_id
alter policy inventory_items_insert on public.inventory_items
  with check (
    (( SELECT has_org_role(inventory_items.organization_id, 'staff'::text) AS has_org_role) AND (( SELECT has_org_role(inventory_items.organization_id, 'manager'::text) AS has_org_role) OR (warehouse_id IS NULL) OR user_can_access_warehouse(auth.uid(), warehouse_id, 'write'::text)) AND ( SELECT location_in_org(inventory_items.primary_location_id, inventory_items.organization_id) AS location_in_org) AND ( SELECT charter_in_org(inventory_items.charter_id, inventory_items.organization_id) AS charter_in_org))
    and ( SELECT public.supplier_in_org(inventory_items.supplier_id, inventory_items.organization_id))
  );
alter policy inventory_items_update on public.inventory_items
  with check (
    (( SELECT has_org_role(inventory_items.organization_id, 'staff'::text) AS has_org_role) AND (( SELECT has_org_role(inventory_items.organization_id, 'manager'::text) AS has_org_role) OR (warehouse_id IS NULL) OR user_can_access_warehouse(auth.uid(), warehouse_id, 'write'::text)) AND ( SELECT location_in_org(inventory_items.primary_location_id, inventory_items.organization_id) AS location_in_org) AND ( SELECT charter_in_org(inventory_items.charter_id, inventory_items.organization_id) AS charter_in_org))
    and ( SELECT public.supplier_in_org(inventory_items.supplier_id, inventory_items.organization_id))
  );

-- purchase_orders.supplier_id
alter policy purchase_orders_write on public.purchase_orders
  with check (
    (( SELECT has_org_role(purchase_orders.organization_id, 'manager'::text) AS has_org_role) AND ( SELECT location_in_org(purchase_orders.destination_location_id, purchase_orders.organization_id) AS location_in_org) AND ( SELECT charter_in_org(purchase_orders.charter_id, purchase_orders.organization_id) AS charter_in_org))
    and ( SELECT public.supplier_in_org(purchase_orders.supplier_id, purchase_orders.organization_id))
  );

-- po_imports.vendor_id (FK to suppliers)
alter policy po_imports_insert on public.po_imports
  with check (
    (( SELECT has_org_role(po_imports.organization_id, 'manager'::text) AS has_org_role) AND ( SELECT warehouse_in_org(po_imports.warehouse_id, po_imports.organization_id) AS warehouse_in_org))
    and ( SELECT public.supplier_in_org(po_imports.vendor_id, po_imports.organization_id))
  );
alter policy po_imports_update on public.po_imports
  with check (
    (( SELECT has_org_role(po_imports.organization_id, 'manager'::text) AS has_org_role) AND ( SELECT warehouse_in_org(po_imports.warehouse_id, po_imports.organization_id) AS warehouse_in_org))
    and ( SELECT public.supplier_in_org(po_imports.vendor_id, po_imports.organization_id))
  );

-- vendor_item_mappings.vendor_id (FK to suppliers, NOT NULL)
alter policy vim_admin_write on public.vendor_item_mappings
  with check (
    ( SELECT has_org_role(vendor_item_mappings.organization_id, 'manager'::text) AS has_org_role)
    and ( SELECT public.supplier_in_org(vendor_item_mappings.vendor_id, vendor_item_mappings.organization_id))
  );
