-- 0111_orders_pick_slip_rpcs.sql
--
-- Phase 3 of the orders workflow refactor: introduces atomic picking.
--   * approve_order_request now also writes assigned_picker_id
--   * partial_pick_line — per-line save-as-you-go for the digital pick UI
--   * complete_picking — atomic stock decrement + reservation release +
--     status flip from pick_slip_generated/picking_in_progress to
--     picking_complete. Ports the post_shipment_shipped (0054) pattern.
--   * order_email_log — dedup table behind sendOrderEmail() so a retry
--     can't double-send the same status email.
--
-- All functions are SECURITY DEFINER + search_path locked; the
-- transition guard from 0109 mirrors the legal source statuses.

begin;

-- ────────────────────────────────────────────────────────────────────
-- 1. Auto-assign picker on approve
--
-- The approver becomes the default picker (manager+ can reassign via
-- a separate UI action). Drop in to the existing approve_order_request
-- body and add the assignment to the final UPDATE.
-- ────────────────────────────────────────────────────────────────────
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
    set status              = 'approved',
        approved_by         = v_user,
        approved_at         = now(),
        assigned_picker_id  = v_user
    where id = p_id;

  select * into v_req from public.order_requests where id = p_id;
  return v_req;
end;
$$;

-- ────────────────────────────────────────────────────────────────────
-- 2. partial_pick_line — record progress as the picker walks the shelves.
-- ────────────────────────────────────────────────────────────────────
create or replace function public.partial_pick_line(
  p_line_id uuid,
  p_qty     numeric
)
returns public.order_request_lines
language plpgsql
security definer
set search_path = public
as $$
declare
  v_line public.order_request_lines%rowtype;
  v_req  public.order_requests%rowtype;
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if p_qty is null or p_qty < 0 then
    raise exception 'invalid_quantity' using errcode = 'P0001';
  end if;

  -- Lock the line + the parent order to serialize concurrent saves.
  select * into v_line from public.order_request_lines where id = p_line_id for update;
  if not found then
    raise exception 'order_request_line_not_found' using errcode = 'P0002';
  end if;
  select * into v_req from public.order_requests where id = v_line.order_request_id for update;

  if not public.has_org_role(v_req.organization_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_req.status not in ('pick_slip_generated', 'picking_in_progress') then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;
  if p_qty > v_line.quantity_requested then
    raise exception 'over_pick' using errcode = 'P0001',
      detail = format('Picked %s exceeds requested %s', p_qty, v_line.quantity_requested);
  end if;

  update public.order_request_lines
    set quantity_picked = p_qty,
        picked_at       = now(),
        picked_by       = v_user
    where id = p_line_id;

  -- First non-zero pick flips the order to picking_in_progress.
  if v_req.status = 'pick_slip_generated' and p_qty > 0 then
    update public.order_requests
      set status = 'picking_in_progress'
      where id = v_req.id;
  end if;

  select * into v_line from public.order_request_lines where id = p_line_id;
  return v_line;
end;
$$;

-- ────────────────────────────────────────────────────────────────────
-- 3. complete_picking — atomic stock decrement + reservation release
--                       + flip to picking_complete.
--
-- Ports the locking + per-line adjust_stock pattern from
-- post_shipment_shipped (0054). The whole sequence runs in one
-- transaction; any insufficient_stock failure rolls back every
-- prior deduction.
-- ────────────────────────────────────────────────────────────────────
create or replace function public.complete_picking(p_order_id uuid)
returns public.order_requests
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_req  public.order_requests%rowtype;
  v_line record;
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  select * into v_req from public.order_requests where id = p_order_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  if not public.has_org_role(v_req.organization_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_req.status not in ('pick_slip_generated', 'picking_in_progress') then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  -- For each line, decrement quantity_picked from on-hand. Lines with
  -- quantity_picked IS NULL or 0 are treated as "not picked at all" —
  -- the row stays at 0 fulfilled and stock is untouched for that item.
  for v_line in
    select l.id as line_id, l.item_id, coalesce(l.quantity_picked, 0) as qty
    from public.order_request_lines l
    where l.order_request_id = p_order_id
    order by l.item_id
  loop
    if v_line.qty > 0 then
      perform public.adjust_stock(
        v_line.item_id,
        -v_line.qty,
        'transfer',
        null,
        'Order pick (order_request ' || p_order_id::text || ')',
        null
      );
      -- Mirror picked qty into quantity_fulfilled so existing
      -- analytics (which read quantity_fulfilled) reflect picks.
      update public.order_request_lines
        set quantity_fulfilled = v_line.qty
        where id = v_line.line_id;
    end if;
  end loop;

  -- Release all open reservations for this order.
  update public.stock_reservations
    set released_at = now()
    where order_request_id = p_order_id
      and released_at is null;

  update public.order_requests
    set status               = 'picking_complete',
        picking_completed_at = now(),
        picking_completed_by = v_user
    where id = p_order_id;

  select * into v_req from public.order_requests where id = p_order_id;
  return v_req;
end;
$$;

-- ────────────────────────────────────────────────────────────────────
-- 4. order_email_log — dedup keyed by (order, kind, recipient).
--
-- Phase 3+ status emails INSERT into this table with ON CONFLICT DO
-- NOTHING; a 0-rowcount means "already sent, skip the Resend call."
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.order_email_log (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.order_requests(id) on delete cascade,
  email_type      text not null,
  recipient_email citext not null,
  sent_at         timestamptz not null default now(),
  message_id      text,
  unique (order_id, email_type, recipient_email)
);

create index if not exists order_email_log_order_idx
  on public.order_email_log(order_id, sent_at desc);

alter table public.order_email_log enable row level security;

-- Service role only — application reads via the admin client for the
-- dedup INSERT, and we don't expose this to direct authenticated
-- queries (the inbox UI joins via the order_requests row instead).
revoke all on table public.order_email_log from public, anon, authenticated;
grant select, insert on table public.order_email_log to service_role;

-- ────────────────────────────────────────────────────────────────────
-- 5. Grants for the new functions
-- ────────────────────────────────────────────────────────────────────
grant execute on function public.partial_pick_line(uuid, numeric) to authenticated;
grant execute on function public.complete_picking(uuid) to authenticated;
-- approve_order_request grant already exists (0044/0055); no change needed.

comment on function public.partial_pick_line(uuid, numeric) is
  'Save-as-you-go: writes quantity_picked / picked_at / picked_by for a '
  'single line, and (first non-zero pick only) flips the parent order '
  'from pick_slip_generated to picking_in_progress. Rejects over-picks '
  'and out-of-range statuses; serializes via row lock on the order.';

comment on function public.complete_picking(uuid) is
  'Atomic finish for the picking phase: decrements on-hand stock by '
  'each line''s quantity_picked, releases stock_reservations, and flips '
  'order_requests.status to picking_complete. Whole sequence is one '
  'transaction — any insufficient_stock failure rolls back every prior '
  'deduction. Ports the post_shipment_shipped pattern from migration 0054.';

commit;
