-- ============================================================================
-- 0120_drop_signature_requested_dead_state.sql
-- ============================================================================
-- The 'signature_requested' status was defined in the 0109 state machine
-- and listed as a valid signature-page status in 0112's confirm_order_signature
-- RPC, but no code path ever transitions an order INTO it. Orders move from
-- 'staged_for_pickup' or 'in_transit' directly to 'completed' via the signature
-- submission. This migration removes the dead state so the schema reflects
-- the actual workflow.
--
-- Plan:
--   1. Defensive backfill — rewind any orphan rows stuck in
--      'signature_requested' (none expected; this is paranoia) to their
--      parent state so the normal /orders/sign/<token> flow can still
--      complete them.
--   2. Rebuild the CHECK constraint without 'signature_requested'.
--   3. Replace _validate_order_request_status_transition to drop the
--      transitions involving the dead state.
--   4. Replace _notify_order_request_changes to drop the dead state
--      from the "silent operational statuses" guard list.
--   5. Replace confirm_order_signature to drop the dead state from the
--      WHERE clause.
--
-- The /orders/sign/<token> page accepts orders in staged_for_pickup or
-- in_transit today; the signature flow doesn't change.
-- ============================================================================

begin;

-- ─────────────────────────────────────────────────────────────────────
-- 1. Defensive backfill. If somehow a row landed in 'signature_requested'
--    (manual SQL, a now-removed code path, etc.), rewind it to the
--    parent state so the rebuilt CHECK constraint doesn't reject it.
--    Disable the transition trigger for the rewind — it would otherwise
--    refuse "signature_requested → staged_for_pickup" as a non-whitelisted
--    transition.
-- ─────────────────────────────────────────────────────────────────────
alter table public.order_requests
  disable trigger trg_order_requests_validate_transition;

update public.order_requests
   set status = case
                  when fulfillment_type = 'delivery' then 'in_transit'
                  else 'staged_for_pickup'
                end
 where status = 'signature_requested';

alter table public.order_requests
  enable trigger trg_order_requests_validate_transition;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Rebuild the CHECK constraint without 'signature_requested'.
-- ─────────────────────────────────────────────────────────────────────
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
    'completed',
    'denied',
    'cancelled'
  ));

-- ─────────────────────────────────────────────────────────────────────
-- 3. Drop the signature_requested transitions from the state machine.
--    staged_for_pickup and in_transit now go straight to completed.
-- ─────────────────────────────────────────────────────────────────────
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
    when 'staged_for_pickup'       then v_new in ('completed', 'cancelled')
    when 'staged_for_delivery'     then v_new in ('in_transit', 'cancelled')
    when 'in_transit'              then v_new in ('completed', 'cancelled')
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

-- ─────────────────────────────────────────────────────────────────────
-- 4. Drop 'signature_requested' from the notification trigger's silent
--    list. Replaces the function definition from 0109 with the same
--    body minus the dead status.
-- ─────────────────────────────────────────────────────────────────────
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

    -- Operational statuses do NOT trigger a requester-side bell ping.
    -- 'signature_requested' dropped from this list per 0120.
    if new.status in (
      'pick_slip_generated',
      'picking_in_progress',
      'picking_complete',
      'packing_slip_generated',
      'staged_for_pickup',
      'staged_for_delivery',
      'in_transit'
    ) then
      return new;
    end if;

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

-- ─────────────────────────────────────────────────────────────────────
-- 5. Drop 'signature_requested' from confirm_order_signature's accepted
--    statuses. Pickup orders sign from staged_for_pickup; delivery
--    orders sign from in_transit. Same signable surface as today —
--    just minus the dead state.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.confirm_order_signature(
  p_id                uuid,
  p_signature_token   text,
  p_signer_name       text,
  p_signer_email      text,
  p_signature_data_url text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  if p_id is null
     or coalesce(length(p_signature_token), 0) = 0
     or coalesce(length(trim(p_signer_name)), 0) = 0
     or coalesce(length(trim(p_signer_email)), 0) = 0
     or coalesce(length(p_signature_data_url), 0) = 0
  then
    return null;
  end if;

  update public.order_requests
     set status              = 'completed',
         signed_by_name      = p_signer_name,
         signed_by_email     = p_signer_email,
         signature_data_url  = p_signature_data_url,
         signed_at           = now(),
         completed_at        = now(),
         completed_by        = null
   where id = p_id
     and signature_token = p_signature_token
     and signed_at is null
     and status in ('staged_for_pickup', 'in_transit')
     and (
       signature_token_expires_at is null
       or signature_token_expires_at > now()
     )
   returning organization_id into v_org;

  return v_org;
end;
$$;

revoke all on function public.confirm_order_signature(uuid, text, text, text, text)
  from public, anon, authenticated;

grant execute on function public.confirm_order_signature(uuid, text, text, text, text)
  to service_role;

comment on function public.confirm_order_signature(uuid, text, text, text, text) is
  'Validates a signature token + signer details and atomically promotes the '
  'order from staged_for_pickup / in_transit to completed. Service-role only — '
  'phase 5 public page hashes the URL token before calling. The signed_at IS NULL '
  'clause inside WHERE guarantees no double-completion on replay clicks. '
  '0120 removed the orphaned signature_requested intermediate state.';

commit;
