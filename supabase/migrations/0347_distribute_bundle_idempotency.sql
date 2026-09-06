-- 0347_distribute_bundle_idempotency.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- distribute_bundle gains an idempotency key so a replayed request cannot
-- distribute twice.
--
-- WHAT WAS WRONG. The mobile Distribute screen POSTs /api/v1/bundles/:id/
-- distribute and, on ANY error — including its own 20 s client timeout, which
-- fires after the server may already have committed — enqueues the same
-- distribution in the offline outbox and tells the operator it is saved. The
-- outbox replays it a minute later. Nothing on the server could recognise the
-- replay: the route's zod body had no key field, the service passed none, and
-- this function (0198) had no parameter for one. The only uniqueness on
-- bundle_distributions is (schedule_event_id) where not null (0082), and mobile
-- always sends null. Result on a slow warehouse network: component stock drawn
-- twice, two bundle_distributions rows, duplicate stock_movements — a duplicate
-- inventory event with no error anywhere. The same replay happens when the app
-- is killed between the server's 200 and the outbox marking the row ok.
--
-- THE FIX. p_idempotency_key text default null, using the idempotency_keys
-- table and the exact contract post_receipt_v2 (0013/0296) already gives PO
-- receipts, scope 'bundle_distribution':
--   * same key + same request  -> return the ORIGINAL distribution id, write
--     nothing (the replay is absorbed);
--   * same key + different request (quantity/warehouse/shortage/event changed)
--     -> raise idempotency_conflict (40001), the caller must mint a new key;
--   * null key -> historical behaviour, unchanged (the web modal path).
-- The request hash is computed HERE from the arguments (notes excluded — they
-- are commentary, not the request), so the client contract is just "send a
-- UUID you minted before the first attempt". The key row is inserted
-- in_progress before the stock writes and marked completed with the new
-- distribution id after; because the whole function is one transaction, any
-- failure rolls the key back too, so a refused attempt never poisons the key.
--
-- Postgres cannot change a function's parameter list in place — CREATE OR
-- REPLACE with a new signature would ADD an overload and leave the old six-
-- argument body callable — so the old signature is dropped first. Every SQL
-- caller passes named arguments through PostgREST / supabase-js and keeps
-- working through the default. SECURITY INVOKER as before: RLS still applies,
-- and idempotency_keys' write policy (manager, 0013) matches this function's
-- own manager floor.
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists public.distribute_bundle(uuid, numeric, uuid, boolean, uuid, text);

create or replace function public.distribute_bundle(
  p_bundle_id          uuid,
  p_quantity           numeric,
  p_warehouse_id       uuid,
  p_allow_shortage     boolean,
  p_schedule_event_id  uuid default null,
  p_notes              text default null,
  p_idempotency_key    text default null
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
  v_existing  public.idempotency_keys%rowtype;
  v_request_hash text;
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

  -- *** 0347 idempotency — see header. Runs after the role/warehouse checks so
  -- a refused caller cannot probe keys, and before any stock write so the
  -- replay short-circuits with nothing touched. ***
  if p_idempotency_key is not null then
    v_request_hash := md5(
      p_bundle_id::text || '|' || p_quantity::text || '|' || p_warehouse_id::text
      || '|' || coalesce(p_allow_shortage, false)::text
      || '|' || coalesce(p_schedule_event_id::text, '')
    );
    select * into v_existing
      from public.idempotency_keys
     where organization_id = v_org
       and scope = 'bundle_distribution'
       and key = p_idempotency_key
       for update;
    if found then
      if v_existing.request_hash = v_request_hash
         and v_existing.status = 'completed'
         and v_existing.resource_id is not null then
        return v_existing.resource_id;
      end if;
      raise exception 'idempotency_conflict' using errcode = '40001';
    end if;
    insert into public.idempotency_keys
      (organization_id, scope, key, request_hash, status, resource_type)
    values
      (v_org, 'bundle_distribution', p_idempotency_key, v_request_hash, 'in_progress', 'bundle_distribution');
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
    -- Maintain levels: pre-assembled stock sat in Staging; drain it there first.
    perform public.apply_level_delta(v_bundle.phantom_item_id, v_new - v_prev, 'staging_first');

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
        -- Maintain levels: virtual-portion consumption draws from placed stock.
        perform public.apply_level_delta(v_component.item_id, v_new - v_prev, 'placed');

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

  if p_idempotency_key is not null then
    update public.idempotency_keys
       set status = 'completed', resource_id = v_distribution_id, updated_at = now()
     where organization_id = v_org
       and scope = 'bundle_distribution'
       and key = p_idempotency_key;
  end if;

  return v_distribution_id;
end;
$$;

comment on function public.distribute_bundle(uuid, numeric, uuid, boolean, uuid, text, text) is
  'Distributes p_quantity kits of a bundle from a warehouse (phantom first, then components). 0347: optional p_idempotency_key (scope bundle_distribution) makes a replay return the original distribution id; same key with a different request raises idempotency_conflict (40001). SECURITY INVOKER; manager floor.';
