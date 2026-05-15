-- 0109_orders_workflow_foundation.sql
--
-- Data foundation for the orders-workflow refactor. Adds every column
-- needed across phases 1-6, extends the status enum, rewrites the
-- transition guard, and migrates legacy status values to the new
-- canonical set. Zero user-facing UI changes ship in phase 1 — this
-- migration plus phase-1 TS code is the platform on which phases 2-6
-- build.
--
-- One transaction; any failure rolls back the entire change.

begin;

-- ────────────────────────────────────────────────────────────────────
-- 1. New columns on order_requests
-- ────────────────────────────────────────────────────────────────────

alter table public.order_requests
  add column if not exists fulfillment_type              text,
  add column if not exists delivery_address              jsonb,
  add column if not exists pickup_location_notes         text,
  add column if not exists requester_phone               text,
  add column if not exists assigned_picker_id            uuid references public.user_profiles(id) on delete set null,
  add column if not exists pick_slip_generated_at        timestamptz,
  add column if not exists pick_slip_generated_by        uuid references public.user_profiles(id) on delete set null,
  add column if not exists picking_completed_at          timestamptz,
  add column if not exists picking_completed_by          uuid references public.user_profiles(id) on delete set null,
  add column if not exists packing_slip_generated_at     timestamptz,
  add column if not exists packing_slip_generated_by     uuid references public.user_profiles(id) on delete set null,
  add column if not exists staged_at                     timestamptz,
  add column if not exists staged_by                     uuid references public.user_profiles(id) on delete set null,
  add column if not exists assigned_delivery_user_id     uuid references public.user_profiles(id) on delete set null,
  add column if not exists assigned_delivery_by          uuid references public.user_profiles(id) on delete set null,
  add column if not exists assigned_delivery_at          timestamptz,
  add column if not exists in_transit_at                 timestamptz,
  add column if not exists in_transit_by                 uuid references public.user_profiles(id) on delete set null,
  add column if not exists signature_token               text,
  add column if not exists signature_token_expires_at    timestamptz,
  add column if not exists signed_by_name                text,
  add column if not exists signed_by_email               citext,
  add column if not exists signature_data_url            text,
  add column if not exists signed_at                     timestamptz,
  add column if not exists completed_at                  timestamptz,
  add column if not exists completed_by                  uuid references public.user_profiles(id) on delete set null;

-- ────────────────────────────────────────────────────────────────────
-- 2. New columns on order_request_lines (picked/packed tracking)
-- ────────────────────────────────────────────────────────────────────

alter table public.order_request_lines
  add column if not exists quantity_picked  numeric(14,4),
  add column if not exists picked_at        timestamptz,
  add column if not exists picked_by        uuid references public.user_profiles(id) on delete set null,
  add column if not exists quantity_packed  numeric(14,4),
  add column if not exists packed_at        timestamptz,
  add column if not exists packed_by        uuid references public.user_profiles(id) on delete set null;

-- ────────────────────────────────────────────────────────────────────
-- 3. Backfill fulfillment_type and enforce NOT NULL + default
--    Every pre-existing row assumed delivery (shipments existed for them).
-- ────────────────────────────────────────────────────────────────────

update public.order_requests
   set fulfillment_type = 'delivery'
 where fulfillment_type is null;

alter table public.order_requests
  alter column fulfillment_type set default 'delivery',
  alter column fulfillment_type set not null,
  add constraint order_requests_fulfillment_type_chk
    check (fulfillment_type in ('pickup', 'delivery'));

-- ────────────────────────────────────────────────────────────────────
-- 4. Status enum: rewrite legacy values + extend the check constraint
--
-- Ordering note: the existing transition-guard trigger
-- (`trg_order_requests_validate_transition`, from migrations 0076 +
-- 0108) treats `delivered` as a terminal state and would reject the
-- `delivered → completed` data rewrite below. We DISABLE the trigger
-- for the rewrite, drop the old check constraint, run the UPDATEs,
-- add the new check constraint, and only then re-enable the trigger.
-- Section 5 immediately after replaces the trigger function body so
-- the next enable picks up the new state machine.
-- ────────────────────────────────────────────────────────────────────

alter table public.order_requests
  disable trigger trg_order_requests_validate_transition;

alter table public.order_requests
  drop constraint if exists order_requests_status_check;

update public.order_requests
   set status = 'packing_slip_generated'
 where status = 'packaging';

update public.order_requests
   set status = 'staged_for_delivery'
 where status = 'ready_for_delivery';

update public.order_requests
   set status = 'completed',
       completed_at = coalesce(delivered_at, updated_at)
 where status = 'delivered';

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
    'signature_requested',
    'completed',
    'denied',
    'cancelled'
  ));

-- Re-enable the trigger. Section 5 below replaces the function body
-- in place — the trigger references the function by name, so the
-- next status transition will use the new state machine.
alter table public.order_requests
  enable trigger trg_order_requests_validate_transition;

-- ────────────────────────────────────────────────────────────────────
-- 5. Rewrite _validate_order_request_status_transition to mirror the
--    centralized state machine in @stockpilot/core/order-state-machine.ts
-- ────────────────────────────────────────────────────────────────────

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
    when 'staged_for_pickup'       then v_new in ('signature_requested', 'completed', 'cancelled')
    when 'staged_for_delivery'     then v_new in ('in_transit', 'cancelled')
    when 'in_transit'              then v_new in ('signature_requested', 'completed', 'cancelled')
    when 'signature_requested'     then v_new in ('completed', 'cancelled')
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

  -- Fulfillment-type guards (mirrored from assertTransition in TS).
  if v_new = 'staged_for_delivery' and new.fulfillment_type <> 'delivery' then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001',
            detail  = 'staged_for_delivery requires fulfillment_type=delivery';
  end if;
  if v_new = 'staged_for_pickup' and new.fulfillment_type <> 'pickup' then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001',
            detail  = 'staged_for_pickup requires fulfillment_type=pickup';
  end if;
  if v_new = 'in_transit' and new.assigned_delivery_user_id is null then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001',
            detail  = 'in_transit requires assigned_delivery_user_id to be set first';
  end if;

  return new;
end;
$$;

-- ────────────────────────────────────────────────────────────────────
-- 6. Update _notify_order_request_changes to handle the new status set
--    Phase 1 only needs to ensure the new statuses don't trigger
--    notification errors — phase 6 will add per-status notification
--    bodies. For now, transitions to the new operational statuses
--    (pick_slip_generated, picking_in_progress, picking_complete,
--    packing_slip_generated, staged_for_*, in_transit, signature_requested)
--    fire NO requester-side notification. Approved / denied / completed
--    keep their existing copy (mapped from 'approved'/'denied'/'delivered').
-- ────────────────────────────────────────────────────────────────────

create or replace function public._notify_order_request_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link text;
  v_title text;
  v_body text;
  v_recipient uuid;
  v_recipients_loop record;
  v_metadata jsonb;
begin
  v_link := '/dashboard/orders/' || new.id::text;
  v_metadata := jsonb_build_object(
    'order_request_id', new.id,
    'warehouse_id', new.warehouse_id,
    'source', new.source,
    'requester_user_id', new.requester_user_id,
    'requester_email', new.requester_email
  );

  if (tg_op = 'INSERT') then
    if new.status = 'pending_confirmation' then
      return new;
    end if;
    v_title := 'New order request' ||
               case when new.requester_name is not null
                    then ' from ' || new.requester_name else '' end;
    v_body := 'A request is waiting for approval.';
    for v_recipients_loop in
      select user_id from public._notify_recipients(new.organization_id)
    loop
      insert into public.notifications (
        organization_id, user_id, type, title, body, link, metadata
      ) values (
        new.organization_id, v_recipients_loop.user_id,
        'order_request.created', v_title, v_body, v_link, v_metadata
      );
    end loop;
    return new;
  end if;

  if (tg_op = 'UPDATE') then
    if old.status is not distinct from new.status then
      return new;
    end if;

    -- pending_confirmation → pending_approval is the manager-visible
    -- "real creation" event (carries over from migration 0108).
    if old.status = 'pending_confirmation' and new.status = 'pending_approval' then
      v_title := 'New order request' ||
                 case when new.requester_name is not null
                      then ' from ' || new.requester_name else '' end;
      v_body := 'A request is waiting for approval.';
      for v_recipients_loop in
        select user_id from public._notify_recipients(new.organization_id)
      loop
        insert into public.notifications (
          organization_id, user_id, type, title, body, link, metadata
        ) values (
          new.organization_id, v_recipients_loop.user_id,
          'order_request.created', v_title, v_body, v_link, v_metadata
        );
      end loop;
      return new;
    end if;

    -- New operational statuses (pick_slip_generated, picking_*,
    -- packing_slip_generated, staged_*, in_transit, signature_requested)
    -- do NOT trigger a requester-side bell ping in phase 1. Phase 6
    -- will revisit this when notification_preferences toggles ship.
    if new.status in (
      'pick_slip_generated',
      'picking_in_progress',
      'picking_complete',
      'packing_slip_generated',
      'staged_for_pickup',
      'staged_for_delivery',
      'in_transit',
      'signature_requested'
    ) then
      return new;
    end if;

    -- Cancel-after-approval routes to managers (unchanged from 0044).
    if new.status = 'cancelled'
       and old.status in ('approved','packing_slip_generated','staged_for_pickup','staged_for_delivery','in_transit')
       and new.cancelled_by is not null
       and not public.has_org_role(new.organization_id, 'manager')
    then
      v_title := 'Order request cancelled after approval';
      v_body := 'Stop preparing this order if you started.';
      for v_recipients_loop in
        select user_id from public._notify_recipients(new.organization_id)
      loop
        insert into public.notifications (
          organization_id, user_id, type, title, body, link, metadata
        ) values (
          new.organization_id, v_recipients_loop.user_id,
          'order_request.cancelled_after_approval',
          v_title, v_body, v_link, v_metadata
        );
      end loop;
      return new;
    end if;

    -- Requester-side notifications.
    v_recipient := new.requester_user_id;
    if v_recipient is null then
      return new;
    end if;

    case new.status
      when 'approved' then
        v_title := 'Your order request was approved';
        v_body := 'Stock has been reserved.';
      when 'denied' then
        v_title := 'Your order request was denied';
        v_body := coalesce(new.denied_reason, 'See the order page for details.');
      when 'completed' then
        v_title := 'Your order was completed';
        v_body := 'Pickup or delivery is finalized.';
      when 'cancelled' then
        v_title := 'Your order was cancelled';
        v_body := coalesce(new.denied_reason, 'See the order page for details.');
      else
        return new;
    end case;

    insert into public.notifications (
      organization_id, user_id, type, title, body, link, metadata
    ) values (
      new.organization_id, v_recipient,
      'order_request.' || new.status,
      v_title, v_body, v_link, v_metadata
    );
  end if;
  return new;
end;
$$;

-- ────────────────────────────────────────────────────────────────────
-- 7. Indexes for the new columns we'll query in phases 3-5.
-- ────────────────────────────────────────────────────────────────────

create unique index if not exists order_requests_signature_token_idx
  on public.order_requests(signature_token)
  where signature_token is not null;

create index if not exists order_requests_assigned_picker_idx
  on public.order_requests(assigned_picker_id)
  where assigned_picker_id is not null;

create index if not exists order_requests_assigned_delivery_idx
  on public.order_requests(assigned_delivery_user_id)
  where assigned_delivery_user_id is not null;

commit;

comment on column public.order_requests.fulfillment_type is
  'pickup | delivery. Defaults to delivery; backfilled at migration time. Drives the state machine branch at packing_slip_generated → staged_for_*.';
comment on column public.order_requests.signature_token is
  'Random hex-64 token minted at packing_slip_generated. Hashed match drives /orders/sign/<token> public signature page.';
