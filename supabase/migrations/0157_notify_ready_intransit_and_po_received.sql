-- ============================================================================
-- 0157_notify_ready_intransit_and_po_received.sql
-- ============================================================================
-- Notifications gap-fill. Two changes, both additive — no existing
-- behavior regresses.
--
-- 1. _notify_order_request_changes (latest body in 0120) silences ALL
--    operational statuses for the requester, including the three the
--    requester actually cares about:
--      - staged_for_pickup  / staged_for_delivery  ("your order is ready")
--      - in_transit                                 ("on the way")
--    The internal-only steps (pick_slip_generated, picking_in_progress,
--    picking_complete, packing_slip_generated) stay silent. We move the
--    three customer-facing statuses out of the silent early-return list
--    and add requester cases in the same case-statement that already
--    handles approved / denied / completed / cancelled.
--
--    The 0120 requester cases (approved/denied/completed/cancelled) do
--    NOT consult notification_preferences. Rather than retrofit those
--    untouched cases, we gate ONLY the new pings on the relevant 0113
--    per-event pref, using the _notify_po_status (0092) default-on
--    pattern: a missing prefs row => notify; an explicit `false` => skip.
--      - staged_for_pickup / staged_for_delivery -> email_order_status_changed
--      - in_transit                              -> email_order_in_transit
--    (These columns are the only order-lifecycle prefs that map to these
--    statuses; there is no generic push_order_status column. Gating the
--    in-app ping on the matching email pref keeps a single user-facing
--    opt-out per event, consistent with the prefs UI semantics.)
--
-- 2. Posting a receipt (receipts.status -> 'posted') does NOT change
--    purchase_orders.status (it only rolls the PO to partially_received /
--    received via recompute_po_status, and only on the *crossing* edge —
--    a partial receipt against an already-partially_received PO produces
--    NO purchase_orders.status change). So _notify_po_status (0092) never
--    fires for receiving activity. We add _notify_receipt_posted to ping
--    the PO creator + the org notify-recipient set on each posted receipt,
--    reusing the 0092 push_po_status default-on gate. One notification per
--    recipient per receipt (fan-out is de-duped via DISTINCT).
--
-- Both functions are CREATE OR REPLACE / additive; no grants change.
-- ============================================================================

begin;

-- ─────────────────────────────────────────────────────────────────────
-- 1. Requester pings for ready / in-transit.
--    Verbatim copy of the 0120 body, with these edits:
--      - removed staged_for_pickup / staged_for_delivery / in_transit
--        from the silent operational early-return list
--      - added their requester cases to the status case-statement, each
--        gated on the relevant 0113 pref (default-on when no prefs row)
--    Everything else (INSERT path, pending_approval re-ping,
--    cancelled-after-approval staff ping, approved/denied/completed/
--    cancelled requester cases) is unchanged from 0120.
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
  v_pref_ok boolean;
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

    -- Internal-only operational statuses do NOT trigger a requester ping.
    -- 0157 removed staged_for_pickup / staged_for_delivery / in_transit
    -- from this list — those are customer-facing and handled below.
    if new.status in (
      'pick_slip_generated',
      'picking_in_progress',
      'picking_complete',
      'packing_slip_generated'
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

    -- Default-on pref gate (0092 pattern): row exists AND pref = true OR
    -- no prefs row => notify; row exists AND pref = false => skip.
    -- Only the NEW ready / in-transit cases consult this; the legacy
    -- approved/denied/completed/cancelled cases stay pref-agnostic as in 0120.
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
      when 'staged_for_pickup' then
        select coalesce(np.email_order_status_changed, true)
          into v_pref_ok
          from public.notification_preferences np
          where np.user_id = v_recipient;
        if not coalesce(v_pref_ok, true) then
          return new;
        end if;
        v_title := 'Your order is ready';
        v_body := 'Ready for pickup.';
      when 'staged_for_delivery' then
        select coalesce(np.email_order_status_changed, true)
          into v_pref_ok
          from public.notification_preferences np
          where np.user_id = v_recipient;
        if not coalesce(v_pref_ok, true) then
          return new;
        end if;
        v_title := 'Your order is ready';
        v_body := 'Ready for delivery.';
      when 'in_transit' then
        select coalesce(np.email_order_in_transit, true)
          into v_pref_ok
          from public.notification_preferences np
          where np.user_id = v_recipient;
        if not coalesce(v_pref_ok, true) then
          return new;
        end if;
        v_title := 'Your order is on the way';
        v_body := 'It''s out for delivery.';
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
-- 2. PO-received notification on posted receipts.
--    Fires on INSERT (receipts default status = 'posted', see 0012) and
--    on a draft -> posted UPDATE. Reversals transition to 'reversed', not
--    'posted', so they never re-trigger — one notification per posted
--    receipt. Recipients = PO.created_by ∪ _notify_recipients(org),
--    de-duped, gated by push_po_status (0092 default-on pattern).
-- ─────────────────────────────────────────────────────────────────────
create or replace function public._notify_receipt_posted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  v_po record;
  link_url text;
  notif_title text;
  notif_body text;
begin
  -- Only act when the receipt becomes 'posted'. On INSERT that means the
  -- new row is posted; on UPDATE that means it crossed into posted.
  if new.status is distinct from 'posted' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status is not distinct from 'posted' then
    return new;
  end if;

  select id, po_number, created_by, organization_id
    into v_po
    from public.purchase_orders
    where id = new.purchase_order_id;

  if v_po.id is null then
    return new;
  end if;

  link_url := '/dashboard/purchase-orders/' || v_po.id::text;
  notif_title := 'Items received against PO ' ||
                 coalesce(v_po.po_number, v_po.id::text);
  notif_body := 'A receipt was posted against this purchase order.';

  for uid in
    select distinct u
    from (
      select v_po.created_by as u
      union
      select user_id from public._notify_recipients(new.organization_id)
    ) s
    where u is not null
  loop
    -- Honor push_po_status opt-out; missing prefs row => opt-in (legacy).
    if exists (
      select 1 from public.notification_preferences
      where user_id = uid and push_po_status = true
    ) or not exists (
      select 1 from public.notification_preferences where user_id = uid
    ) then
      insert into public.notifications (
        organization_id, user_id, type, title, body, link, metadata
      ) values (
        new.organization_id,
        uid,
        'po.received',
        notif_title,
        notif_body,
        link_url,
        jsonb_build_object(
          'po_id', v_po.id,
          'po_number', v_po.po_number,
          'receipt_id', new.id,
          'receipt_number', new.receipt_number
        )
      );
    end if;
  end loop;

  return new;
end;
$$;

drop trigger if exists trg_notify_receipt_posted on public.receipts;
create trigger trg_notify_receipt_posted
  after insert or update of status on public.receipts
  for each row execute function public._notify_receipt_posted();

commit;

comment on function public._notify_receipt_posted() is
  '0157: emits a po.received notification (PO creator + org notify-recipients, '
  'push_po_status default-on gate) when a receipt becomes posted. Receiving does '
  'not change purchase_orders.status on partial receipts, so _notify_po_status '
  '(0092) cannot cover it.';
