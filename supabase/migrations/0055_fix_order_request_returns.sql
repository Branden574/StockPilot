-- ============================================================================
-- 0055_fix_order_request_returns.sql
--
-- approve_order_request / deliver_order_request / cancel_order_request all
-- ended with:
--
--   return (select * from public.order_requests where id = p_id);
--
-- Inside PL/pgSQL with a composite return type, that parenthesized SELECT is
-- evaluated as a SCALAR subquery and must return exactly one column. The
-- order_requests table has ~17 columns, so Postgres aborts the transaction
-- with:
--
--   ERROR: subquery must return only one column  (sqlstate 42601)
--
-- The error fires AFTER the UPDATE inside the function — but since the
-- whole function body runs in a single transaction, the rollback also
-- undoes the status flip, reservation insert, on-hand decrement, etc.
-- From the user's perspective: clicking Approve / Deliver / Cancel
-- toasts the SQL error and nothing happens.
--
-- Fix: replace the trailing scalar-subquery `return` with a re-`select *
-- into v_req` + `return v_req`. v_req is already declared as
-- public.order_requests%rowtype in each function, so this is a one-line
-- swap with no schema or behavior change beyond making the return actually
-- work.
-- ============================================================================

create or replace function public.approve_order_request(p_id uuid)
returns public.order_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.order_requests%rowtype;
  v_line record;
  v_active_reserved numeric(14,4);
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  select * into v_req from public.order_requests where id = p_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  if not public.has_org_role(v_req.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_req.status <> 'pending_approval' then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  for v_line in
    select l.id as line_id, l.item_id, l.quantity_requested,
           ii.quantity_on_hand, ii.warehouse_id as item_warehouse
    from public.order_request_lines l
    join public.inventory_items ii on ii.id = l.item_id
    where l.order_request_id = p_id
    order by l.item_id
    for update of ii
  loop
    if v_line.item_warehouse is distinct from v_req.warehouse_id then
      raise exception 'item_warehouse_mismatch'
        using errcode = 'P0001', detail = v_line.item_id::text;
    end if;
    select coalesce(sum(quantity), 0) into v_active_reserved
    from public.stock_reservations
    where item_id = v_line.item_id and released_at is null;
    if v_line.quantity_requested >
       greatest(0, v_line.quantity_on_hand - v_active_reserved) then
      raise exception 'insufficient_stock'
        using errcode = 'P0001', detail = v_line.item_id::text;
    end if;
  end loop;

  insert into public.stock_reservations (
    organization_id, item_id, warehouse_id, order_request_id, quantity
  )
  select v_req.organization_id, l.item_id, v_req.warehouse_id, p_id, l.quantity_requested
  from public.order_request_lines l
  where l.order_request_id = p_id;

  update public.order_requests
    set status = 'approved',
        approved_by = v_user,
        approved_at = now()
    where id = p_id;

  select * into v_req from public.order_requests where id = p_id;
  return v_req;
end;
$$;

create or replace function public.deliver_order_request(p_id uuid)
returns public.order_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.order_requests%rowtype;
  v_line record;
  v_user uuid := auth.uid();
  v_prev numeric(14,4);
  v_new  numeric(14,4);
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  select * into v_req from public.order_requests where id = p_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  if not public.has_org_role(v_req.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_req.status not in ('approved', 'packaging', 'ready_for_delivery') then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  for v_line in
    select l.id as line_id, l.item_id, l.quantity_requested,
           ii.quantity_on_hand
    from public.order_request_lines l
    join public.inventory_items ii on ii.id = l.item_id
    where l.order_request_id = p_id
    order by l.item_id
    for update of ii
  loop
    if v_line.quantity_requested > v_line.quantity_on_hand then
      raise exception 'insufficient_stock'
        using errcode = 'P0001', detail = v_line.item_id::text;
    end if;
    v_prev := v_line.quantity_on_hand;
    v_new  := v_prev - v_line.quantity_requested;
    update public.inventory_items
      set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
      where id = v_line.item_id;
    insert into public.stock_movements (
      organization_id, item_id, movement_type,
      quantity_change, previous_quantity, new_quantity,
      reason, reference_type, reference_id, user_id
    ) values (
      v_req.organization_id, v_line.item_id, 'remove',
      -v_line.quantity_requested, v_prev, v_new,
      'order_delivered', 'order_request', p_id, v_user
    );
    update public.order_request_lines
      set quantity_fulfilled = v_line.quantity_requested
      where id = v_line.line_id;
  end loop;

  update public.stock_reservations
    set released_at = now(), released_reason = 'delivered'
    where order_request_id = p_id and released_at is null;

  update public.order_requests
    set status = 'delivered', delivered_at = now()
    where id = p_id;

  select * into v_req from public.order_requests where id = p_id;
  return v_req;
end;
$$;

create or replace function public.cancel_order_request(
  p_id uuid,
  p_reason text default null
)
returns public.order_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.order_requests%rowtype;
  v_user uuid := auth.uid();
  v_is_manager boolean;
  v_is_owner boolean;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  select * into v_req from public.order_requests where id = p_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  if v_req.status in ('delivered', 'denied', 'cancelled') then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  v_is_manager := public.has_org_role(v_req.organization_id, 'manager');
  v_is_owner   := v_req.requester_user_id = v_user;
  if not v_is_manager and not v_is_owner then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.stock_reservations
    set released_at = now(), released_reason = 'cancelled'
    where order_request_id = p_id and released_at is null;

  update public.order_requests
    set status = 'cancelled',
        cancelled_at = now(),
        cancelled_by = v_user,
        denied_reason = coalesce(p_reason, denied_reason)
    where id = p_id;

  select * into v_req from public.order_requests where id = p_id;
  return v_req;
end;
$$;
