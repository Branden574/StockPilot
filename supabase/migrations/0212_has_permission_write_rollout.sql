-- 0212_has_permission_write_rollout.sql
-- Configurable permissions P3: roll the has_permission() resolver (mig 0207)
-- onto the remaining write RLS, so granting a permission to a role/user is fully
-- effective end-to-end (not just at the app gate). Same ADDITIVE pattern as 0208
-- (PO write): each policy's role-gate `has_org_role(org, 'X')` becomes
-- `( has_org_role(org,'X') OR has_permission(org, '<perm>') )`.
--   • Existing roles unaffected (the has_org_role term is kept).
--   • A member granted the permission (role/user override) now passes the
--     row-level write too.
-- ALL FK-org-consistency guards (warehouse/location/charter/supplier) + the
-- warehouse-access sub-checks are reproduced VERBATIM (copied from the live
-- policy definitions). Tables: inventory_items, stock_movements, locations,
-- categories, suppliers, order_requests(+lines).

-- ── categories → categories:manage ─────────────────────────────────────────
alter policy categories_insert on public.categories
  with check (
    ( SELECT public.has_org_role(categories.organization_id, 'manager') )
    or ( SELECT public.has_permission(categories.organization_id, 'categories:manage') )
  );
alter policy categories_update on public.categories
  using (
    ( SELECT public.has_org_role(categories.organization_id, 'manager') )
    or ( SELECT public.has_permission(categories.organization_id, 'categories:manage') )
  )
  with check (
    ( SELECT public.has_org_role(categories.organization_id, 'manager') )
    or ( SELECT public.has_permission(categories.organization_id, 'categories:manage') )
  );
alter policy categories_delete on public.categories
  using (
    ( SELECT public.has_org_role(categories.organization_id, 'manager') )
    or ( SELECT public.has_permission(categories.organization_id, 'categories:manage') )
  );

-- ── suppliers → suppliers:manage (FOR ALL) ─────────────────────────────────
alter policy suppliers_write on public.suppliers
  using (
    ( SELECT public.has_org_role(suppliers.organization_id, 'manager') )
    or ( SELECT public.has_permission(suppliers.organization_id, 'suppliers:manage') )
  )
  with check (
    ( SELECT public.has_org_role(suppliers.organization_id, 'manager') )
    or ( SELECT public.has_permission(suppliers.organization_id, 'suppliers:manage') )
  );

-- ── locations → locations:manage (delete is admin-gated; manage covers it) ──
alter policy locations_insert on public.locations
  with check (
    (
      ( SELECT public.has_org_role(locations.organization_id, 'manager') )
      or ( SELECT public.has_permission(locations.organization_id, 'locations:manage') )
    )
    and ( SELECT public.warehouse_in_org(locations.warehouse_id, locations.organization_id) )
  );
alter policy locations_update on public.locations
  using (
    ( SELECT public.has_org_role(locations.organization_id, 'manager') )
    or ( SELECT public.has_permission(locations.organization_id, 'locations:manage') )
  )
  with check (
    (
      ( SELECT public.has_org_role(locations.organization_id, 'manager') )
      or ( SELECT public.has_permission(locations.organization_id, 'locations:manage') )
    )
    and ( SELECT public.warehouse_in_org(locations.warehouse_id, locations.organization_id) )
  );
alter policy locations_delete on public.locations
  using (
    ( SELECT public.has_org_role(locations.organization_id, 'admin') )
    or ( SELECT public.has_permission(locations.organization_id, 'locations:manage') )
  );

-- ── stock_movements → stock:adjust ─────────────────────────────────────────
alter policy stock_movements_insert on public.stock_movements
  with check (
    (
      ( SELECT public.has_org_role(stock_movements.organization_id, 'staff') )
      or ( SELECT public.has_permission(stock_movements.organization_id, 'stock:adjust') )
    )
    and ( SELECT public.location_in_org(stock_movements.from_location_id, stock_movements.organization_id) )
    and ( SELECT public.location_in_org(stock_movements.to_location_id, stock_movements.organization_id) )
  );

-- ── inventory_items → items:create / items:update / items:delete ───────────
-- Base role-gate is 'staff'; the warehouse-access sub-check + FK-org guards are
-- kept verbatim. (Delete is admin-gated by default → items:delete grants it.)
alter policy inventory_items_insert on public.inventory_items
  with check (
    (
      ( ( SELECT public.has_org_role(inventory_items.organization_id, 'staff') )
        or ( SELECT public.has_permission(inventory_items.organization_id, 'items:create') ) )
      and ( ( SELECT public.has_org_role(inventory_items.organization_id, 'manager') ) OR (warehouse_id IS NULL) OR public.user_can_access_warehouse(auth.uid(), warehouse_id, 'write') )
      and ( SELECT public.location_in_org(inventory_items.primary_location_id, inventory_items.organization_id) )
      and ( SELECT public.charter_in_org(inventory_items.charter_id, inventory_items.organization_id) )
      and ( SELECT public.supplier_in_org(inventory_items.supplier_id, inventory_items.organization_id) )
    )
  );
alter policy inventory_items_update on public.inventory_items
  using (
    (
      ( ( SELECT public.has_org_role(inventory_items.organization_id, 'staff') )
        or ( SELECT public.has_permission(inventory_items.organization_id, 'items:update') ) )
      and ( ( SELECT public.has_org_role(inventory_items.organization_id, 'manager') ) OR (warehouse_id IS NULL) OR public.user_can_access_warehouse(auth.uid(), warehouse_id, 'write') )
    )
  )
  with check (
    (
      ( ( SELECT public.has_org_role(inventory_items.organization_id, 'staff') )
        or ( SELECT public.has_permission(inventory_items.organization_id, 'items:update') ) )
      and ( ( SELECT public.has_org_role(inventory_items.organization_id, 'manager') ) OR (warehouse_id IS NULL) OR public.user_can_access_warehouse(auth.uid(), warehouse_id, 'write') )
      and ( SELECT public.location_in_org(inventory_items.primary_location_id, inventory_items.organization_id) )
      and ( SELECT public.charter_in_org(inventory_items.charter_id, inventory_items.organization_id) )
      and ( SELECT public.supplier_in_org(inventory_items.supplier_id, inventory_items.organization_id) )
    )
  );
alter policy inventory_items_delete on public.inventory_items
  using (
    ( SELECT public.has_org_role(inventory_items.organization_id, 'admin') )
    or ( SELECT public.has_permission(inventory_items.organization_id, 'items:delete') )
  );

-- ── order_requests → orders:approve (manage side: approve/fulfill/status) ───
-- The INSERT "on behalf" manager clause + the line-insert manager clause also
-- honor orders:approve. (Self-submit via orders:request is already universal —
-- any org member can submit their own request — so no change there.)
alter policy order_requests_insert on public.order_requests
  with check (
    ( SELECT public.is_org_member(order_requests.organization_id) )
    and (source = 'internal')
    and (
      (requester_user_id = ( SELECT auth.uid() ))
      or (
        (requester_user_id IS NULL) and (requester_email IS NOT NULL)
        and (
          ( SELECT public.has_org_role(order_requests.organization_id, 'manager') )
          or ( SELECT public.has_permission(order_requests.organization_id, 'orders:approve') )
        )
      )
    )
    and ( SELECT public.warehouse_in_org(order_requests.warehouse_id, order_requests.organization_id) )
    and ( SELECT public.charter_in_org(order_requests.delivery_charter_id, order_requests.organization_id) )
  );
alter policy order_requests_update on public.order_requests
  using (
    ( SELECT public.has_org_role(order_requests.organization_id, 'manager') )
    or ( SELECT public.has_permission(order_requests.organization_id, 'orders:approve') )
  )
  with check (
    (
      ( SELECT public.has_org_role(order_requests.organization_id, 'manager') )
      or ( SELECT public.has_permission(order_requests.organization_id, 'orders:approve') )
    )
    and ( SELECT public.warehouse_in_org(order_requests.warehouse_id, order_requests.organization_id) )
    and ( SELECT public.charter_in_org(order_requests.delivery_charter_id, order_requests.organization_id) )
  );
alter policy order_request_lines_insert on public.order_request_lines
  with check (
    exists (
      select 1
      from public.order_requests r
        join public.inventory_items ii on ((ii.id = order_request_lines.item_id) and (ii.organization_id = r.organization_id))
      where (r.id = order_request_lines.order_request_id)
        and (
          (r.requester_user_id = ( SELECT auth.uid() ))
          or ( SELECT public.has_org_role(r.organization_id, 'manager') )
          or ( SELECT public.has_permission(r.organization_id, 'orders:approve') )
        )
        and (ii.warehouse_id = r.warehouse_id)
    )
  );
