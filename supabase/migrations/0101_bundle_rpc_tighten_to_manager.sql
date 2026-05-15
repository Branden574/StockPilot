-- 0101_bundle_rpc_tighten_to_manager.sql
-- ============================================================================
-- Tighten assemble_bundle / distribute_bundle role check to manager+
-- ----------------------------------------------------------------------------
-- 0040_bundles.sql defined both functions to call
-- `public.has_org_role(v_org, 'staff')`. The service layer
-- (BundlesService.assemble + .distribute) gates on `bundles:manage` and
-- `bundles:distribute` respectively — both of which are manager+ in the
-- permission matrix.
--
-- A staff member who could find the right RPC payload (or any third
-- party with a staff-role JWT) could bypass the service layer entirely
-- and call the RPC directly. Tighten the role check so the RPC matches
-- the service-layer gate, and a stolen staff token can't pre-assemble
-- or run distributions.
--
-- Aside from the role-check argument, the function bodies are
-- preserved verbatim from 0040 — the diff is intentionally minimal so
-- a future audit of bundle math doesn't have to re-read this migration.
--
-- Note: bundle_distributions_insert RLS in 0040 still requires
-- `has_org_role(... 'staff')`, but the RPC now enforces manager+ before
-- the insert ever runs, so staff inserts via the RPC will fail with
-- 'forbidden'. Direct INSERTs into bundle_distributions are not part
-- of the supported API; the service always goes through distribute_bundle.
-- ============================================================================

create or replace function public.assemble_bundle(
  p_bundle_id    uuid,
  p_quantity     numeric,
  p_warehouse_id uuid,
  p_notes        text default null
)
returns table (phantom_item_id uuid, phantom_qty numeric)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_bundle    public.bundles%rowtype;
  v_org       uuid;
  v_phantom   public.inventory_items%rowtype;
  v_user      uuid := auth.uid();
  v_phantom_sku text;
  v_component record;
  v_needed    numeric(14,4);
  v_prev      numeric(14,4);
  v_new       numeric(14,4);
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity_must_be_positive' using errcode = '22023';
  end if;

  select * into v_bundle
  from public.bundles where id = p_bundle_id for update;
  if not found then raise exception 'bundle_not_found' using errcode = 'P0002'; end if;
  if not v_bundle.is_active or v_bundle.archived_at is not null then
    raise exception 'bundle_not_active' using errcode = 'P0001';
  end if;
  if not v_bundle.preassembly_enabled then
    raise exception 'preassembly_disabled' using errcode = 'P0001';
  end if;
  v_org := v_bundle.organization_id;

  -- C9: tightened from 'staff' to 'manager' to match service gate
  -- `bundles:manage`. The service layer's assertWarehouseAccess adds
  -- warehouse-scope; this assert is the org-role floor.
  if not public.has_org_role(v_org, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Verify warehouse belongs to org
  if not exists (
    select 1 from public.warehouses
    where id = p_warehouse_id and organization_id = v_org
  ) then
    raise exception 'warehouse_not_found' using errcode = 'P0002';
  end if;

  -- Lock or create phantom
  if v_bundle.phantom_item_id is not null then
    select * into v_phantom
    from public.inventory_items
    where id = v_bundle.phantom_item_id for update;
    if v_phantom.warehouse_id is not null and v_phantom.warehouse_id <> p_warehouse_id then
      raise exception 'phantom_warehouse_mismatch' using errcode = 'P0001';
    end if;
  else
    -- SKU is internal, never user-facing. Truncated UUID guarantees
    -- uniqueness without colliding with any real SKU pattern.
    v_phantom_sku := '__BUNDLE__' || substr(p_bundle_id::text, 1, 8);
    insert into public.inventory_items (
      organization_id, sku, name, description, status,
      quantity_on_hand, warehouse_id, is_bundle,
      created_by, updated_by
    ) values (
      v_org, v_phantom_sku, v_bundle.name,
      'Pre-assembled bundle stock for ' || v_bundle.name,
      'active', 0, p_warehouse_id, true, v_user, v_user
    )
    returning * into v_phantom;

    update public.bundles
      set phantom_item_id = v_phantom.id, updated_at = now()
      where id = p_bundle_id;
  end if;

  -- Decrement components in deterministic order to avoid deadlocks
  -- between concurrent assemble/distribute calls.
  for v_component in
    select bc.item_id, bc.quantity, bc.is_optional, ii.quantity_on_hand, ii.id as ii_id
    from public.bundle_components bc
    join public.inventory_items ii on ii.id = bc.item_id
    where bc.bundle_id = p_bundle_id
    order by bc.item_id
    for update of ii
  loop
    v_needed := v_component.quantity * p_quantity;
    if v_component.quantity_on_hand < v_needed then
      if not v_component.is_optional then
        raise exception 'insufficient_stock' using detail = v_component.item_id::text;
      else
        continue;
      end if;
    end if;

    v_prev := v_component.quantity_on_hand;
    v_new  := v_prev - v_needed;
    update public.inventory_items
      set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
      where id = v_component.item_id;

    insert into public.stock_movements (
      organization_id, item_id, movement_type, quantity_change,
      previous_quantity, new_quantity, reason, reference_type,
      reference_id, user_id, notes
    ) values (
      v_org, v_component.item_id, 'bundle_assembly', -v_needed,
      v_prev, v_new, 'bundle_assembly', 'bundle',
      p_bundle_id, v_user, p_notes
    );
  end loop;

  -- Increment phantom
  v_prev := v_phantom.quantity_on_hand;
  v_new  := v_prev + p_quantity;
  update public.inventory_items
    set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
    where id = v_phantom.id;

  insert into public.stock_movements (
    organization_id, item_id, movement_type, quantity_change,
    previous_quantity, new_quantity, reason, reference_type,
    reference_id, user_id, notes
  ) values (
    v_org, v_phantom.id, 'bundle_assembly', p_quantity,
    v_prev, v_new, 'bundle_assembly', 'bundle',
    p_bundle_id, v_user, p_notes
  );

  return query select v_phantom.id, v_new;
end;
$$;

create or replace function public.distribute_bundle(
  p_bundle_id          uuid,
  p_quantity           numeric,
  p_warehouse_id       uuid,
  p_allow_shortage     boolean,
  p_schedule_event_id  uuid default null,
  p_notes              text default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_bundle    public.bundles%rowtype;
  v_org       uuid;
  v_distribution_id uuid;
  v_phantom_qty numeric(14,4) := 0;
  v_use_phantom numeric(14,4) := 0;
  v_use_virtual numeric(14,4);
  v_shortage  boolean := false;
  v_user      uuid := auth.uid();
  v_component record;
  v_needed    numeric(14,4);
  v_have      numeric(14,4);
  v_draw      numeric(14,4);
  v_short     numeric(14,4);
  v_prev      numeric(14,4);
  v_new       numeric(14,4);
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity_must_be_positive' using errcode = '22023';
  end if;

  select * into v_bundle
  from public.bundles where id = p_bundle_id for update;
  if not found then raise exception 'bundle_not_found' using errcode = 'P0002'; end if;
  if not v_bundle.is_active or v_bundle.archived_at is not null then
    raise exception 'bundle_not_active' using errcode = 'P0001';
  end if;
  v_org := v_bundle.organization_id;

  -- C9: tightened from 'staff' to 'manager' to match service gate
  -- `bundles:distribute`. The service layer's assertWarehouseAccess
  -- adds warehouse-scope; this assert is the org-role floor.
  if not public.has_org_role(v_org, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Verify warehouse belongs to org
  if not exists (
    select 1 from public.warehouses
    where id = p_warehouse_id and organization_id = v_org
  ) then
    raise exception 'warehouse_not_found' using errcode = 'P0002';
  end if;

  -- Phantom allocation
  if v_bundle.phantom_item_id is not null then
    select quantity_on_hand into v_phantom_qty
    from public.inventory_items
    where id = v_bundle.phantom_item_id for update;
    v_phantom_qty := greatest(0, coalesce(v_phantom_qty, 0));
  end if;

  v_use_phantom := least(p_quantity, v_phantom_qty);
  v_use_virtual := p_quantity - v_use_phantom;

  -- Drain phantom
  if v_use_phantom > 0 then
    v_prev := v_phantom_qty;
    v_new  := v_prev - v_use_phantom;
    update public.inventory_items
      set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
      where id = v_bundle.phantom_item_id;

    insert into public.stock_movements (
      organization_id, item_id, movement_type, quantity_change,
      previous_quantity, new_quantity, reason, reference_type,
      reference_id, user_id, notes
    ) values (
      v_org, v_bundle.phantom_item_id, 'bundle_distribution', -v_use_phantom,
      v_prev, v_new, 'bundle_distribution', 'bundle',
      p_bundle_id, v_user, p_notes
    );
  end if;

  -- Component allocation for the virtual portion
  if v_use_virtual > 0 then
    for v_component in
      select bc.item_id, bc.quantity, bc.is_optional, ii.quantity_on_hand
      from public.bundle_components bc
      join public.inventory_items ii on ii.id = bc.item_id
      where bc.bundle_id = p_bundle_id
      order by bc.item_id
      for update of ii
    loop
      v_needed := v_component.quantity * v_use_virtual;
      v_have   := greatest(0, v_component.quantity_on_hand);
      v_draw   := least(v_needed, v_have);
      v_short  := v_needed - v_draw;

      if v_draw > 0 then
        v_prev := v_component.quantity_on_hand;
        v_new  := v_prev - v_draw;
        update public.inventory_items
          set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
          where id = v_component.item_id;

        insert into public.stock_movements (
          organization_id, item_id, movement_type, quantity_change,
          previous_quantity, new_quantity, reason, reference_type,
          reference_id, user_id, notes
        ) values (
          v_org, v_component.item_id, 'bundle_distribution', -v_draw,
          v_prev, v_new, 'bundle_distribution', 'bundle',
          p_bundle_id, v_user, p_notes
        );
      end if;

      if v_short > 0 then
        if not p_allow_shortage and not v_component.is_optional then
          raise exception 'insufficient_stock' using detail = v_component.item_id::text;
        end if;
        if not v_component.is_optional then
          v_shortage := true;
          insert into public.stock_movements (
            organization_id, item_id, movement_type, quantity_change,
            previous_quantity, new_quantity, reason, reference_type,
            reference_id, user_id, notes
          ) values (
            v_org, v_component.item_id, 'bundle_shortage', 0,
            v_component.quantity_on_hand, v_component.quantity_on_hand,
            'no_stock', 'bundle', p_bundle_id, v_user,
            'short ' || v_short::text || ' units during bundle distribution'
          );
        end if;
      end if;
    end loop;
  end if;

  insert into public.bundle_distributions (
    organization_id, bundle_id, warehouse_id, quantity,
    schedule_event_id, notes, shortage_recorded, distributed_by
  ) values (
    v_org, p_bundle_id, p_warehouse_id, p_quantity,
    p_schedule_event_id, p_notes, v_shortage, v_user
  )
  returning id into v_distribution_id;

  return v_distribution_id;
end;
$$;
