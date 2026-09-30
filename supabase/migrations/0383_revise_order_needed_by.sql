-- 0383_revise_order_needed_by.sql
--
-- F2-4 (Order Readiness, lean): "Revise the needed-by date (order and
-- schedule stay in step)". One function, its grants and its comment. No
-- table, column, index, policy or data change.
--
-- ── WHY ────────────────────────────────────────────────────────────────────
-- An order's needed-by could be set only while it was pending
-- (setOrderNeededByAction, a user-client UPDATE of order_requests), and
-- approval copied it into a Schedule event (autoScheduleFromOrder, 0255). Once
-- approved, the order and its event could drift apart: the order kept the old
-- date, or someone moved the event on the Schedule page and the order never
-- knew. The event's description also carries the date ("Needed by Oct 3,
-- 2026, 2:00 PM."), and the reminder emails print it, so moving only the
-- start left the old date in the text. And moving an event never re-armed its
-- reminders: the cron sends a day-ahead reminder only while reminded_24h_at
-- and reminded_1h_at are both null, so an event reminded for its old time was
-- never reminded for its new one (plan correction 16; the Schedule page's own
-- edit is fixed in ScheduleService.update in the same change, through the
-- user client: authenticated holds UPDATE on both stamp columns and
-- schedule_events_update is a row gate only, so it needs no SQL).
--
-- ── WHAT IT DOES ───────────────────────────────────────────────────────────
-- revise_order_needed_by(order, new needed-by, the needed-by the caller saw,
-- reason, event description), in one transaction:
--   1. gates (below);
--   2. refuses a closed order: pending_confirmation (a public request not yet
--      confirmed), completed, denied, cancelled (P0001 order_closed, detail =
--      the status);
--   3. refuses a needed-by that is not in the future (22023
--      needed_by_in_past; a null one: 22023 needed_by_required, clearing a
--      needed-by is not supported) and a reason that is empty or longer than
--      500 characters after trimming (22023 reason_required). The event
--      description has its control characters stripped and is cut to 1000
--      characters;
--   4. STALE VERSION: when the order's needed-by is not the value the caller
--      saw (IS DISTINCT FROM p_expected_needed_by), P0001 needed_by_changed
--      with the current value as the detail (ISO 8601, '' for none), so a
--      screen can load it and say "Someone changed this date to … while you
--      were editing." Two approvers editing at once: exactly one wins
--      (scripts/db-concurrency/0383_needed_by_race.sh);
--   5. an EQUAL value writes nothing: {changed: false};
--   6. otherwise updates order_requests.needed_by (never the status, so the
--      order notification trigger sends nothing);
--   7. THE EVENT: the order's Schedule event (schedule_events.order_request_id,
--      at most one: schedule_events_order_request_uniq), when it is scheduled
--      or in progress, moves with the order: starts_at = the new needed-by,
--      ends_at shifted by the same amount when it has one (the
--      schedule_events_end_after_start CHECK would refuse a start past the
--      end), details = the description given (when not null),
--      reminded_24h_at = null and reminded_1h_at = null (its reminders are
--      armed again for the new time), updated_by = the caller. A completed or
--      cancelled event is left as it is. An order with no event is left
--      without one: the ONE writer of new events is autoScheduleFromOrder
--      (approval, and the service after a revision of an approved order that
--      has none);
--   8. returns {changed, previous, neededBy, eventId, eventUpdated, status}
--      (status is the order's, read under its lock: the service decides from
--      it whether an approved order still needs its event created).
-- Nothing is emailed or notified: the requester's delivery-request draft is
-- unchanged and opens only on their tap (Outlook rule 1). The service writes
-- the audit entry (order_request.needed_by_revised {from, to, reason}).
--
-- ── GATES, IN ITS OWN BODY (SECURITY DEFINER, INV-25) ──────────────────────
-- DEFINER because schedule_events_update is creator-or-manager: a staff
-- member with an orders:approve override passes order_requests_update but
-- would fail the event update (pattern #4). So the function checks for
-- itself, as hold_order_stock (0378) does:
--   1. auth.uid() null: 42501 unauthenticated.
--   2. the order missing, or the caller not an accepted, enabled member of its
--      organization (is_org_member): P0002 order_request_not_found, the same
--      answer for both (existence is not disclosed).
--   3. module_enabled(org, 'orders') false: P0001 module_disabled.
--   4. has_org_role(org, 'manager') or has_permission(org, 'orders:approve'),
--      the 0348 approve gate word for word: else 42501 forbidden, hint
--      orders_approve.
--   5. user_can_access_inventory(caller, order warehouse, null, 'write'):
--      else 42501 forbidden, hint warehouse_write (a scoped manager outside
--      the order's warehouse, staff assigned elsewhere, a viewer).
-- Gates 2 to 4 are answered from an UNLOCKED read, before any lock is taken
-- (0378's order): a caller who may not revise never waits on, or holds, the
-- order row. The order row is then locked FOR UPDATE, and gate 5, the status,
-- the stale-version check and the write all read it under that lock.
-- Refusals are 42501, P0001, P0002 and 22023 only, each with a stable hint.
-- It never raises 40001 or 40P01 (0367): PostgREST retries 40001 forever.
--
-- ── LOCK ORDER ─────────────────────────────────────────────────────────────
-- The order row, then its event row. No function locks an event and then its
-- order; the other event writers (ScheduleService.update, the order-close
-- sync, the reminder cron's stamp) touch the event row alone. lock_timeout
-- 5s: a caller waits at most 5 s, then gets 55P03 (the service says "try
-- again").
--
-- ── WHO CALLS IT ───────────────────────────────────────────────────────────
-- OrderRequestsService.reviseNeededBy (web reviseOrderNeededByAction, the
-- AI-suggestion apply setOrderNeededByAction, and POST
-- /api/v1/orders/[id]/needed-by for the phone). The service converts the wall
-- clock the screens send in the ORGANIZATION's time zone and builds the event
-- description with core orderScheduleEventDetails, the text approval writes.
--
-- ── FROZEN ─────────────────────────────────────────────────────────────────
-- approve_order_request, approve_partial, resume_fulfillment, close_partial,
-- complete_picking, partial_pick_line, reopen_picking, cancel_order_request,
-- hold_order_stock, order_readiness_facts, confirm_order_signature,
-- confirm_physical_signature, create_order_request,
-- save_purchase_order_draft, next_po_number, post_receipt_v2 (public and
-- ledger), ledger.*, tg_order_requests_insert_guard,
-- tg_order_request_lines_guard, caller_can_read_item, the 0380 report
-- functions, the 0381 photo functions and policies, the 0382 book
-- functions, and every policy and grant on order_requests and
-- schedule_events are untouched (pgTAP 0383 Z1 and Z2 pin them).
--
-- ── PROD PUSH NOTE ─────────────────────────────────────────────────────────
-- CREATE FUNCTION, COMMENT, GRANT and REVOKE only: catalog-only, no table
-- lock. lock_timeout makes the push fail fast instead of queueing (retry is
-- the remedy).

-- PLAIN `set`, not `set local` (0303/0358/0370/0374/0377/0378). Reset at the end.
set lock_timeout = '5s';

create or replace function public.revise_order_needed_by(
  p_id                 uuid,
  p_needed_by          timestamptz,
  p_expected_needed_by timestamptz,
  p_reason             text,
  p_event_details      text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_uid           uuid := auth.uid();
  v_org           uuid;
  v_org2          uuid;
  v_wh            uuid;
  v_status        text;
  v_current       timestamptz;
  v_reason        text;
  v_details       text;
  v_event_id      uuid;
  v_event_status  text;
  v_event_updated boolean := false;
begin
  -- Gate 1: a signed-in caller.
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  -- Gate 2: the order exists and the caller is an accepted, enabled member of
  -- its org. One answer for both. Read WITHOUT a lock: a caller who may not
  -- revise must not queue on (or hold) the order row.
  select o.organization_id into v_org
    from public.order_requests o
   where o.id = p_id;
  if v_org is null or not public.is_org_member(v_org) then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;

  -- Gate 3: the Orders module.
  if not public.module_enabled(v_org, 'orders') then
    raise exception 'module_disabled' using errcode = 'P0001', hint = 'module_disabled';
  end if;

  -- Gate 4: the approve gate (0348): whoever may approve may change the date.
  if not (public.has_org_role(v_org, 'manager')
          or public.has_permission(v_org, 'orders:approve')) then
    raise exception 'forbidden' using errcode = '42501', hint = 'orders_approve';
  end if;

  -- LOCK 1 of 2: the order row.
  select o.organization_id, o.warehouse_id, o.status, o.needed_by
    into v_org2, v_wh, v_status, v_current
    from public.order_requests o
   where o.id = p_id
     for update;
  if v_org2 is null or v_org2 is distinct from v_org then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;

  -- Gate 5: write access to the order's warehouse.
  if not public.user_can_access_inventory(v_uid, v_wh, null, 'write') then
    raise exception 'forbidden' using errcode = '42501', hint = 'warehouse_write';
  end if;

  -- Closed orders keep their date.
  if v_status in ('pending_confirmation', 'completed', 'denied', 'cancelled') then
    raise exception 'order_closed'
      using errcode = 'P0001', hint = 'order_closed', detail = v_status;
  end if;

  -- The arguments.
  if p_needed_by is null then
    raise exception 'needed_by_required' using errcode = '22023', hint = 'needed_by_required';
  end if;
  if p_needed_by <= now() then
    raise exception 'needed_by_in_past' using errcode = '22023', hint = 'needed_by_in_past';
  end if;
  v_reason := regexp_replace(coalesce(p_reason, ''), '^\s+|\s+$', '', 'g');
  if char_length(v_reason) < 1 or char_length(v_reason) > 500 then
    raise exception 'reason_required' using errcode = '22023', hint = 'reason_required';
  end if;
  v_details := nullif(left(btrim(regexp_replace(p_event_details, '[[:cntrl:]]', '', 'g')), 1000), '');

  -- Stale version: the caller must have seen the value it is replacing.
  if v_current is distinct from p_expected_needed_by then
    raise exception 'needed_by_changed'
      using errcode = 'P0001', hint = 'needed_by_changed',
            detail = coalesce(to_jsonb(v_current) #>> '{}', '');
  end if;

  -- LOCK 2 of 2: the order's event (at most one), when it has one.
  select e.id, e.status
    into v_event_id, v_event_status
    from public.schedule_events e
   where e.order_request_id = p_id
     and e.organization_id = v_org
     for update;

  -- An equal value writes nothing.
  if p_needed_by = v_current then
    return jsonb_build_object('changed', false, 'previous', v_current, 'neededBy', v_current,
                              'eventId', v_event_id, 'eventUpdated', false, 'status', v_status);
  end if;

  update public.order_requests
     set needed_by = p_needed_by
   where id = p_id;

  if v_event_id is not null and v_event_status in ('scheduled', 'in_progress') then
    update public.schedule_events e
       set starts_at       = p_needed_by,
           ends_at         = case when e.ends_at is null then null
                                  else p_needed_by + (e.ends_at - e.starts_at) end,
           details         = coalesce(v_details, e.details),
           reminded_24h_at = null,
           reminded_1h_at  = null,
           updated_by      = v_uid
     where e.id = v_event_id;
    v_event_updated := true;
  end if;

  return jsonb_build_object('changed', true, 'previous', v_current, 'neededBy', p_needed_by,
                            'eventId', v_event_id, 'eventUpdated', v_event_updated,
                            'status', v_status);
end;
$$;

revoke all on function public.revise_order_needed_by(uuid, timestamptz, timestamptz, text, text)
  from public, anon, service_role;
grant execute on function public.revise_order_needed_by(uuid, timestamptz, timestamptz, text, text)
  to authenticated;

comment on function public.revise_order_needed_by(uuid, timestamptz, timestamptz, text, text) is
  'F2-4 (0383): changes an open order''s needed-by and moves its Schedule event '
  'with it, in one transaction. Refuses a closed order (P0001 order_closed), a '
  'needed-by that is null or not in the future (22023 needed_by_required, '
  'needed_by_in_past), a reason that is empty or over 500 characters after '
  'trimming (22023 reason_required), and a stale edit: the order''s needed-by '
  'must be p_expected_needed_by (P0001 needed_by_changed, detail = the current '
  'value). An equal value writes nothing. The order''s scheduled or in-progress '
  'event gets starts_at = the new needed-by, ends_at shifted by the same amount, '
  'details = p_event_details (control characters stripped, 1000 characters at '
  'most; unchanged when null) and both reminder stamps cleared, so its reminders '
  'go out again for the new time; a completed or cancelled event is untouched and '
  'a missing one is not created here (autoScheduleFromOrder is the one writer of '
  'new events). Returns {changed, previous, neededBy, eventId, eventUpdated, '
  'status}. Gates in its body: signed in (42501), member of the order''s org '
  '(P0002 order_request_not_found, the same for a missing order), the orders '
  'module (P0001 module_disabled), manager or orders:approve (42501, hint '
  'orders_approve), write access to the order''s warehouse (42501, hint '
  'warehouse_write). Locks the order row, then its event. Never notifies or '
  'emails; never raises 40001/40P01. SECURITY DEFINER (schedule_events_update is '
  'creator-or-manager), lock_timeout 5s, EXECUTE to authenticated only.';

reset lock_timeout;
