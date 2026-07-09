-- Partial fulfillment / backorder — the non-terminal `backordered` status.
--
-- Mirrors the TS state machine (packages/core/src/order-state-machine.ts) into
-- the DB's two enforcement points: the status CHECK constraint gains the new
-- value, and the transition trigger gains the hand-over fork
-- (staged_for_pickup / in_transit → backordered) plus the three backorder exits
-- (resume → pick_slip_generated, close-partial → completed, cancel). See the
-- 2026-07-09 partial-fulfillment spec.
--
-- PURELY ADDITIVE: adds one allowed value + three new edges. Every existing row
-- and every previously-legal transition stays valid, so this is safe to apply
-- ahead of the behavioral phases (nothing sets `backordered` yet).

-- 1. Rebuild the CHECK constraint with the new value.
alter table public.order_requests
  drop constraint if exists order_requests_status_check;

alter table public.order_requests
  add constraint order_requests_status_check
  check (status in (
    'pending_confirmation',
    'pending_approval',
    'approved',
    'pick_slip_generated',
    'picking_in_progress',
    'picking_complete',
    'packing_slip_generated',
    'staged_for_pickup',
    'staged_for_delivery',
    'in_transit',
    'backordered',
    'completed',
    'denied',
    'cancelled'
  ));

-- 2. Transition validation — same body as 0120 plus the backorder edges.
create or replace function public._validate_order_request_status_transition()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_old text := old.status;
  v_new text := new.status;
  v_ok  boolean := false;
begin
  if v_old is not distinct from v_new then
    return new;
  end if;

  v_ok := case v_old
    when 'pending_confirmation'    then v_new in ('pending_approval', 'cancelled')
    when 'pending_approval'        then v_new in ('approved', 'denied', 'cancelled')
    when 'approved'                then v_new in ('pick_slip_generated', 'cancelled')
    when 'pick_slip_generated'     then v_new in ('picking_in_progress', 'picking_complete', 'cancelled')
    when 'picking_in_progress'     then v_new in ('picking_complete', 'cancelled')
    when 'picking_complete'        then v_new in ('packing_slip_generated', 'cancelled')
    when 'packing_slip_generated'  then v_new in ('staged_for_pickup', 'staged_for_delivery', 'cancelled')
    -- Hand-over forks to backordered when units are still owed.
    when 'staged_for_pickup'       then v_new in ('completed', 'backordered', 'cancelled')
    when 'staged_for_delivery'     then v_new in ('in_transit', 'cancelled')
    when 'in_transit'              then v_new in ('completed', 'backordered', 'cancelled')
    -- Backorder exits: resume, close-partial, cancel.
    when 'backordered'             then v_new in ('pick_slip_generated', 'completed', 'cancelled')
    when 'completed'               then false
    when 'denied'                  then false
    when 'cancelled'               then false
    else false
  end;

  if not v_ok then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001',
            detail  = format('Cannot move order_request from %s to %s', v_old, v_new);
  end if;

  return new;
end;
$$;
