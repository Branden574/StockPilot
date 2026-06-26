-- 0203_fk_org_consistency.sql
-- Close the broad "FK-not-org-verified" class surfaced by the Phase 2b Place
-- adversarial sweep. Many tables' write RLS policies validate only the ROW's
-- organization_id (has_org_role / is_org_member) but never check that a
-- caller-supplied warehouse_id / location_id FK actually belongs to that org.
-- Because `authenticated` holds table DML (RLS is the only gate), a member could
-- POST/PATCH directly (or via a security-invoker RPC) with a FOREIGN-org FK,
-- writing a row in their own org that references another tenant's
-- warehouse/location (a cross-tenant integrity write; some FKs cascade-delete).
-- This is contained (no read-leak, no privilege escalation — user_can_access_warehouse
-- re-derives org from the warehouse), but we close it as defense-in-depth.
--
-- Approach: two SECURITY DEFINER, NULL-safe boolean guards + ALTER POLICY to
-- AND the guard onto each write policy's WITH CHECK. Using ALTER (not drop+create)
-- preserves each policy's USING / roles / cmd exactly; the existing WITH CHECK
-- expression is reproduced VERBATIM and only augmented, so no existing rule can
-- be weakened. A NULL FK passes (the column may legitimately be null = "no FK").
-- item_stock_levels (0202) + transfer_stock/adjust_stock (0201) are already done.
-- Already-guarded tables (rentals, schedule_events, inventory_items.warehouse_id
-- via user_can_access_warehouse) are not touched here; stock_reservations writes
-- are denied (WITH CHECK false) so it needs no guard.

-- ---------------------------------------------------------------------------
-- Guards (NULL-safe). location_in_org is re-created from 0202 to add the NULL
-- short-circuit (item_stock_levels.location_id is NOT NULL, so its behavior there
-- is unchanged; the new callers below have nullable FK columns that must pass).
-- ---------------------------------------------------------------------------
create or replace function public.location_in_org(p_location_id uuid, p_org_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select p_location_id is null or exists (
    select 1 from public.locations
    where id = p_location_id and organization_id = p_org_id
  );
$$;
grant execute on function public.location_in_org(uuid, uuid) to authenticated;

create or replace function public.warehouse_in_org(p_warehouse_id uuid, p_org_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select p_warehouse_id is null or exists (
    select 1 from public.warehouses
    where id = p_warehouse_id and organization_id = p_org_id
  );
$$;
grant execute on function public.warehouse_in_org(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Warehouse-FK tables, org via the row's own organization_id column.
-- (existing WITH CHECK reproduced verbatim AND warehouse_in_org(warehouse_id, organization_id))
-- ---------------------------------------------------------------------------
alter policy bins_write on public.bins
  with check (
    ( SELECT has_org_role(bins.organization_id, 'manager'::text) AS has_org_role)
    and ( SELECT public.warehouse_in_org(bins.warehouse_id, bins.organization_id))
  );

alter policy bundle_distributions_insert on public.bundle_distributions
  with check (
    ( SELECT has_org_role(bundle_distributions.organization_id, 'staff'::text) AS has_org_role)
    and ( SELECT public.warehouse_in_org(bundle_distributions.warehouse_id, bundle_distributions.organization_id))
  );

alter policy cycle_counts_insert on public.cycle_counts
  with check (
    ( SELECT has_org_role(cycle_counts.organization_id, 'manager'::text) AS has_org_role)
    and ( SELECT public.warehouse_in_org(cycle_counts.warehouse_id, cycle_counts.organization_id))
  );
alter policy cycle_counts_update on public.cycle_counts
  with check (
    ( SELECT has_org_role(cycle_counts.organization_id, 'manager'::text) AS has_org_role)
    and ( SELECT public.warehouse_in_org(cycle_counts.warehouse_id, cycle_counts.organization_id))
  );

alter policy inventory_stock_write on public.inventory_stock
  with check (
    ( SELECT has_org_role(inventory_stock.organization_id, 'staff'::text) AS has_org_role)
    and ( SELECT public.warehouse_in_org(inventory_stock.warehouse_id, inventory_stock.organization_id))
  );

alter policy locations_insert on public.locations
  with check (
    ( SELECT has_org_role(locations.organization_id, 'manager'::text) AS has_org_role)
    and ( SELECT public.warehouse_in_org(locations.warehouse_id, locations.organization_id))
  );
alter policy locations_update on public.locations
  with check (
    ( SELECT has_org_role(locations.organization_id, 'manager'::text) AS has_org_role)
    and ( SELECT public.warehouse_in_org(locations.warehouse_id, locations.organization_id))
  );

alter policy order_requests_insert on public.order_requests
  with check (
    (( SELECT is_org_member(order_requests.organization_id) AS is_org_member) AND (source = 'internal'::text) AND ((requester_user_id = auth.uid()) OR ((requester_user_id IS NULL) AND (requester_email IS NOT NULL) AND ( SELECT has_org_role(order_requests.organization_id, 'manager'::text) AS has_org_role))))
    and ( SELECT public.warehouse_in_org(order_requests.warehouse_id, order_requests.organization_id))
  );
alter policy order_requests_update on public.order_requests
  with check (
    ( SELECT has_org_role(order_requests.organization_id, 'manager'::text) AS has_org_role)
    and ( SELECT public.warehouse_in_org(order_requests.warehouse_id, order_requests.organization_id))
  );

alter policy organization_invites_insert on public.organization_invites
  with check (
    ( SELECT has_org_role(organization_invites.organization_id, 'admin'::text) AS has_org_role)
    and ( SELECT public.warehouse_in_org(organization_invites.warehouse_id, organization_invites.organization_id))
  );

alter policy po_imports_insert on public.po_imports
  with check (
    ( SELECT has_org_role(po_imports.organization_id, 'manager'::text) AS has_org_role)
    and ( SELECT public.warehouse_in_org(po_imports.warehouse_id, po_imports.organization_id))
  );
alter policy po_imports_update on public.po_imports
  with check (
    ( SELECT has_org_role(po_imports.organization_id, 'manager'::text) AS has_org_role)
    and ( SELECT public.warehouse_in_org(po_imports.warehouse_id, po_imports.organization_id))
  );

alter policy putaway_moves_write on public.putaway_moves
  with check (
    ( SELECT has_org_role(putaway_moves.organization_id, 'staff'::text) AS has_org_role)
    and ( SELECT public.warehouse_in_org(putaway_moves.warehouse_id, putaway_moves.organization_id))
  );

alter policy receipts_write on public.receipts
  with check (
    ( SELECT has_org_role(receipts.organization_id, 'staff'::text) AS has_org_role)
    and ( SELECT public.warehouse_in_org(receipts.warehouse_id, receipts.organization_id))
  );

alter policy serial_registry_write on public.serial_registry
  with check (
    ( SELECT has_org_role(serial_registry.organization_id, 'staff'::text) AS has_org_role)
    and ( SELECT public.warehouse_in_org(serial_registry.warehouse_id, serial_registry.organization_id))
  );

alter policy uwa_admin_write on public.user_warehouse_assignments
  with check (
    ( SELECT has_org_role(user_warehouse_assignments.organization_id, 'admin'::text) AS has_org_role)
    and ( SELECT public.warehouse_in_org(user_warehouse_assignments.warehouse_id, user_warehouse_assignments.organization_id))
  );

-- ---------------------------------------------------------------------------
-- Location-FK tables, org via the row's own organization_id column.
-- ---------------------------------------------------------------------------
alter policy purchase_orders_write on public.purchase_orders
  with check (
    ( SELECT has_org_role(purchase_orders.organization_id, 'manager'::text) AS has_org_role)
    and ( SELECT public.location_in_org(purchase_orders.destination_location_id, purchase_orders.organization_id))
  );

alter policy stock_movements_insert on public.stock_movements
  with check (
    ( SELECT has_org_role(stock_movements.organization_id, 'staff'::text) AS has_org_role)
    and ( SELECT public.location_in_org(stock_movements.from_location_id, stock_movements.organization_id))
    and ( SELECT public.location_in_org(stock_movements.to_location_id, stock_movements.organization_id))
  );

-- inventory_items: warehouse_id is already guarded (user_can_access_warehouse);
-- add the missing primary_location_id org check. Existing WITH CHECK verbatim.
alter policy inventory_items_insert on public.inventory_items
  with check (
    (( SELECT has_org_role(inventory_items.organization_id, 'staff'::text) AS has_org_role) AND (( SELECT has_org_role(inventory_items.organization_id, 'manager'::text) AS has_org_role) OR (warehouse_id IS NULL) OR user_can_access_warehouse(auth.uid(), warehouse_id, 'write'::text)))
    and ( SELECT public.location_in_org(inventory_items.primary_location_id, inventory_items.organization_id))
  );
alter policy inventory_items_update on public.inventory_items
  with check (
    (( SELECT has_org_role(inventory_items.organization_id, 'staff'::text) AS has_org_role) AND (( SELECT has_org_role(inventory_items.organization_id, 'manager'::text) AS has_org_role) OR (warehouse_id IS NULL) OR user_can_access_warehouse(auth.uid(), warehouse_id, 'write'::text)))
    and ( SELECT public.location_in_org(inventory_items.primary_location_id, inventory_items.organization_id))
  );

-- ---------------------------------------------------------------------------
-- Complex-org tables: organization_id is NOT on the row; derive it from the
-- parent (cycle_counts / charters). Existing WITH CHECK reproduced verbatim.
-- ---------------------------------------------------------------------------
alter policy cycle_count_lines_insert on public.cycle_count_lines
  with check (
    (EXISTS ( SELECT 1 FROM cycle_counts cc WHERE ((cc.id = cycle_count_lines.cycle_count_id) AND ( SELECT has_org_role(cc.organization_id, 'manager'::text) AS has_org_role))))
    and ( SELECT public.warehouse_in_org(cycle_count_lines.warehouse_id, (SELECT cc.organization_id FROM public.cycle_counts cc WHERE cc.id = cycle_count_lines.cycle_count_id)))
  );
alter policy cycle_count_lines_update on public.cycle_count_lines
  with check (
    ((EXISTS ( SELECT 1 FROM cycle_counts cc WHERE ((cc.id = cycle_count_lines.cycle_count_id) AND ( SELECT has_org_role(cc.organization_id, 'staff'::text) AS has_org_role) AND (cc.status = 'in_progress'::text)))) AND ((counted_by IS NULL) OR (counted_by = ( SELECT auth.uid() AS uid))))
    and ( SELECT public.warehouse_in_org(cycle_count_lines.warehouse_id, (SELECT cc.organization_id FROM public.cycle_counts cc WHERE cc.id = cycle_count_lines.cycle_count_id)))
  );

alter policy wc_admin_write on public.warehouse_charters
  with check (
    (EXISTS ( SELECT 1 FROM charters c WHERE ((c.id = warehouse_charters.charter_id) AND ( SELECT has_org_role(c.organization_id, 'admin'::text) AS has_org_role))))
    and ( SELECT public.warehouse_in_org(warehouse_charters.warehouse_id, (SELECT c.organization_id FROM public.charters c WHERE c.id = warehouse_charters.charter_id)))
  );

-- ---------------------------------------------------------------------------
-- Additional warehouse-FK columns the pattern sweep surfaced (direct org):
--   * shipments.source_warehouse_id (write policy had no FK guard)
--   * procedures.authoring_warehouse_id
--   * schedule_events: TWO warehouse FKs (warehouse_id, bundle_warehouse_id).
--     The INSERT policy already org-checks warehouse_id via user_can_access_warehouse
--     but NOT bundle_warehouse_id; the UPDATE policy checks neither. Add the gaps.
-- (existing WITH CHECK reproduced verbatim AND warehouse_in_org(<fk>, organization_id))
-- ---------------------------------------------------------------------------
alter policy shipments_write on public.shipments
  with check (
    ( SELECT has_org_role(shipments.organization_id, 'manager'::text) AS has_org_role)
    and ( SELECT public.warehouse_in_org(shipments.source_warehouse_id, shipments.organization_id))
  );

alter policy procedures_write on public.procedures
  with check (
    ( SELECT has_org_role(procedures.organization_id, 'manager'::text) AS has_org_role)
    and ( SELECT public.warehouse_in_org(procedures.authoring_warehouse_id, procedures.organization_id))
  );

alter policy schedule_events_insert on public.schedule_events
  with check (
    (( SELECT is_org_member(schedule_events.organization_id) AS is_org_member) AND (created_by = auth.uid()) AND ((warehouse_id IS NULL) OR user_can_access_warehouse(auth.uid(), warehouse_id, 'write'::text)))
    and ( SELECT public.warehouse_in_org(schedule_events.bundle_warehouse_id, schedule_events.organization_id))
  );
alter policy schedule_events_update on public.schedule_events
  with check (
    (( SELECT is_org_member(schedule_events.organization_id) AS is_org_member) AND ((created_by = auth.uid()) OR ( SELECT has_org_role(schedule_events.organization_id, 'manager'::text) AS has_org_role)))
    and ( SELECT public.warehouse_in_org(schedule_events.warehouse_id, schedule_events.organization_id))
    and ( SELECT public.warehouse_in_org(schedule_events.bundle_warehouse_id, schedule_events.organization_id))
  );
