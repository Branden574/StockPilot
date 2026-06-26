-- 0204_charter_fk_org_consistency.sql
-- Extend the FK-org-consistency hardening (0201/0202/0203) to the *charter_id FK
-- class. Several write policies validate only the row's organization_id but never
-- that a caller-supplied charter_id / *_charter_id points at a charter in that org
-- — so a member could reference another tenant's charter on their own row
-- (cross-tenant integrity write; charters are app-verified today, but a direct
-- service-role/PostgREST write bypasses that). Same pattern as 0203: a NULL-safe
-- SECURITY DEFINER `charter_in_org` guard AND-ed onto each write policy's WITH
-- CHECK via ALTER POLICY (existing WITH CHECK — already carrying the 0203
-- warehouse/location guards — reproduced VERBATIM; USING untouched).
-- warehouse_charters is excluded: its policy already requires has_org_role on the
-- charter's own org (the charter_id IS the org source there).

create or replace function public.charter_in_org(p_charter_id uuid, p_org_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select p_charter_id is null or exists (
    select 1 from public.charters
    where id = p_charter_id and organization_id = p_org_id
  );
$$;
grant execute on function public.charter_in_org(uuid, uuid) to authenticated;

-- inventory_items.charter_id (item-ownership charter)
alter policy inventory_items_insert on public.inventory_items
  with check (
    (( SELECT has_org_role(inventory_items.organization_id, 'staff'::text) AS has_org_role) AND (( SELECT has_org_role(inventory_items.organization_id, 'manager'::text) AS has_org_role) OR (warehouse_id IS NULL) OR user_can_access_warehouse(auth.uid(), warehouse_id, 'write'::text)) AND ( SELECT location_in_org(inventory_items.primary_location_id, inventory_items.organization_id) AS location_in_org))
    and ( SELECT public.charter_in_org(inventory_items.charter_id, inventory_items.organization_id))
  );
alter policy inventory_items_update on public.inventory_items
  with check (
    (( SELECT has_org_role(inventory_items.organization_id, 'staff'::text) AS has_org_role) AND (( SELECT has_org_role(inventory_items.organization_id, 'manager'::text) AS has_org_role) OR (warehouse_id IS NULL) OR user_can_access_warehouse(auth.uid(), warehouse_id, 'write'::text)) AND ( SELECT location_in_org(inventory_items.primary_location_id, inventory_items.organization_id) AS location_in_org))
    and ( SELECT public.charter_in_org(inventory_items.charter_id, inventory_items.organization_id))
  );

-- order_requests.delivery_charter_id
alter policy order_requests_insert on public.order_requests
  with check (
    (( SELECT is_org_member(order_requests.organization_id) AS is_org_member) AND (source = 'internal'::text) AND ((requester_user_id = auth.uid()) OR ((requester_user_id IS NULL) AND (requester_email IS NOT NULL) AND ( SELECT has_org_role(order_requests.organization_id, 'manager'::text) AS has_org_role))) AND ( SELECT warehouse_in_org(order_requests.warehouse_id, order_requests.organization_id) AS warehouse_in_org))
    and ( SELECT public.charter_in_org(order_requests.delivery_charter_id, order_requests.organization_id))
  );
alter policy order_requests_update on public.order_requests
  with check (
    (( SELECT has_org_role(order_requests.organization_id, 'manager'::text) AS has_org_role) AND ( SELECT warehouse_in_org(order_requests.warehouse_id, order_requests.organization_id) AS warehouse_in_org))
    and ( SELECT public.charter_in_org(order_requests.delivery_charter_id, order_requests.organization_id))
  );

-- organization_invites.charter_id
alter policy organization_invites_insert on public.organization_invites
  with check (
    (( SELECT has_org_role(organization_invites.organization_id, 'admin'::text) AS has_org_role) AND ( SELECT warehouse_in_org(organization_invites.warehouse_id, organization_invites.organization_id) AS warehouse_in_org))
    and ( SELECT public.charter_in_org(organization_invites.charter_id, organization_invites.organization_id))
  );

-- purchase_orders.charter_id (bill-to charter)
alter policy purchase_orders_write on public.purchase_orders
  with check (
    (( SELECT has_org_role(purchase_orders.organization_id, 'manager'::text) AS has_org_role) AND ( SELECT location_in_org(purchase_orders.destination_location_id, purchase_orders.organization_id) AS location_in_org))
    and ( SELECT public.charter_in_org(purchase_orders.charter_id, purchase_orders.organization_id))
  );

-- shipments.destination_charter_id (NOT NULL)
alter policy shipments_write on public.shipments
  with check (
    (( SELECT has_org_role(shipments.organization_id, 'manager'::text) AS has_org_role) AND ( SELECT warehouse_in_org(shipments.source_warehouse_id, shipments.organization_id) AS warehouse_in_org))
    and ( SELECT public.charter_in_org(shipments.destination_charter_id, shipments.organization_id))
  );

-- user_warehouse_assignments.charter_id
alter policy uwa_admin_write on public.user_warehouse_assignments
  with check (
    (( SELECT has_org_role(user_warehouse_assignments.organization_id, 'admin'::text) AS has_org_role) AND ( SELECT warehouse_in_org(user_warehouse_assignments.warehouse_id, user_warehouse_assignments.organization_id) AS warehouse_in_org))
    and ( SELECT public.charter_in_org(user_warehouse_assignments.charter_id, user_warehouse_assignments.organization_id))
  );
