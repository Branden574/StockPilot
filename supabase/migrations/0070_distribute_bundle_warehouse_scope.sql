-- 0070_distribute_bundle_warehouse_scope.sql
-- Fix: distribute_bundle (added in 0040) updates the components'
-- quantity_on_hand WITHOUT checking that the component lives in
-- p_warehouse_id. A bundle "distributed at warehouse A" silently
-- drains the same component from warehouse B if that's where the
-- component lives. This migration restricts the component update
-- to rows whose `warehouse_id = p_warehouse_id`.
--
-- The phantom-item path is unchanged because phantom items are
-- created per-bundle and their warehouse is already validated by
-- the existing `phantom_warehouse_mismatch` check in assemble_bundle.
--
-- Note: this changes behavior for any bundle whose components are
-- stored across multiple warehouses. After this migration, you can
-- only distribute a bundle FROM a warehouse that has all needed
-- components. If the component lives elsewhere, you'll need to
-- transfer it first or distribute from the warehouse that holds it.

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

  if not public.has_org_role(v_org, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.warehouses
    where id = p_warehouse_id and organization_id = v_org
  ) then
    raise exception 'warehouse_not_found' using errcode = 'P0002';
  end if;

  -- Phantom allocation (unchanged — phantom items are warehouse-scoped
  -- by construction via assemble_bundle's phantom_warehouse_mismatch).
  if v_bundle.phantom_item_id is not null then
    select quantity_on_hand into v_phantom_qty
    from public.inventory_items
    where id = v_bundle.phantom_item_id for update;
    v_phantom_qty := greatest(0, coalesce(v_phantom_qty, 0));
  end if;

  v_use_phantom := least(p_quantity, v_phantom_qty);
  v_use_virtual := p_quantity - v_use_phantom;

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

  -- Component allocation. NEW: the join now scopes the inventory_items
  -- read to rows whose warehouse_id matches p_warehouse_id. A
  -- component stored only in another warehouse will not be found here,
  -- so v_have stays 0 and the shortage path kicks in (rejecting unless
  -- allow_shortage=true). Stops cross-warehouse stock drain.
  if v_use_virtual > 0 then
    for v_component in
      select bc.item_id, bc.quantity, bc.is_optional,
             coalesce(ii.quantity_on_hand, 0) as quantity_on_hand,
             ii.id as inventory_row_id
      from public.bundle_components bc
      left join public.inventory_items ii
        on ii.id = bc.item_id
       and ii.warehouse_id = p_warehouse_id
       and ii.deleted_at is null
      where bc.bundle_id = p_bundle_id
      order by bc.item_id
      for update of ii
    loop
      v_needed := v_component.quantity * v_use_virtual;
      v_have   := greatest(0, v_component.quantity_on_hand);
      v_draw   := least(v_needed, v_have);
      v_short  := v_needed - v_draw;

      if v_draw > 0 and v_component.inventory_row_id is not null then
        v_prev := v_component.quantity_on_hand;
        v_new  := v_prev - v_draw;
        update public.inventory_items
          set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
          where id = v_component.inventory_row_id;

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
            v_have, v_have,
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
