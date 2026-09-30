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
--      needed-by is not supported), one that is infinity or later than five
--      years from now (22023 needed_by_out_of_range: no screen can show it,
--      JavaScript's Date cannot hold the far end of timestamptz, and the
--      reminder cron's arithmetic would carry it onto the event), and a
--      reason that is empty or longer than 500 characters after trimming
--      (22023 reason_required);
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
--      end), its description's date sentence replaced (DESCRIPTION, below),
--      reminded_24h_at = null and reminded_1h_at = null (its reminders are
--      armed again for the new time), updated_by = the caller. A completed or
--      cancelled event is left as it is. An order with no event is left
--      without one: the ONE writer of new events is autoScheduleFromOrder
--      (approval, and the service after a revision of an approved order that
--      has none);
--   8. returns {changed, previous, neededBy, eventId, eventUpdated,
--      eventStatus, status}: eventStatus is the order's event's status (null
--      when it has none), so a screen says "its reminders are set" only for
--      an entry the reminder cron reminds (status scheduled); status is the
--      order's, read under its lock (the service decides from it whether an
--      approved order still needs its event created).
--
-- ── DESCRIPTION ────────────────────────────────────────────────────────────
-- The Schedule page lets anyone who may edit an event rewrite its
-- description, and the reminder emails print it. So only the date sentence
-- core writes (orderScheduleEventDetails: "Auto-created from order
-- SO-000016. Needed by Oct 3, 2026, 2:00 PM.") is ever replaced:
--   - p_event_details is taken only when, with its control characters
--     stripped, it IS that sentence (an order number SO- plus six or more
--     digits, or the 8-character id prefix; a date of at most 64 characters
--     with no period). Any other text is ignored: this function never writes
--     a caller's free text into an event's description or its reminders.
--   - In the event's description, the first sentence of that shape (the
--     older numeric format "Needed by 9/11/2026, 2:00:00 AM." included) is
--     replaced where it sits; whatever a person wrote around it stays.
--   - A description with no such sentence (rewritten by hand) is kept whole;
--     an empty one gets the sentence.
-- Production, 2026-09-30 (read-only): 21 of the 22 order events carry exactly
-- the sentence; one was rewritten by hand.
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
--      else 42501 forbidden, hint warehouse_write (staff assigned to another
--      warehouse, a viewer). There is no warehouse-scoped manager to refuse:
--      user_can_access_inventory answers true for every owner, admin and
--      manager of the org, whatever their assignment rows, as the app's
--      roleSeesEveryWarehouse does (pgTAP G12 pins a manager assigned only to
--      another warehouse succeeding).
-- Gates 2 to 4 are answered from an UNLOCKED read, before any lock is taken
-- (0378's order): a caller refused by them never waits on, or holds, the
-- order row. The order row is then locked FOR UPDATE, and gate 5, the status,
-- the stale-version check and the write all read it under that lock, so an
-- approver refused by gate 5 (no write access to the warehouse) does take
-- the row lock briefly before the refusal, as in hold_order_stock.
-- Refusals are 42501, P0001, P0002 and 22023 only, each with a stable hint.
-- It never raises 40001 or 40P01 (0367): PostgREST retries 40001 forever.
--
-- ── LOCK ORDER ─────────────────────────────────────────────────────────────
-- The order row, then its event row. No function locks an event and then its
-- order; the other event writers (ScheduleService.update, the order-close
-- sync, the reminder cron's stamp) touch the event row alone. lock_timeout
-- 5s applies to each lock: the order, then its event, so a caller can wait up
-- to 5 s on each, within the authenticated role's 8 s statement_timeout
-- (57014 past it). Either way the service says "try again" (55P03 and 57014
-- are both "busy").
--
-- ── WHO CALLS IT ───────────────────────────────────────────────────────────
-- OrderRequestsService.reviseNeededBy (web reviseOrderNeededByAction, the
-- AI-suggestion apply setOrderNeededByAction, and POST
-- /api/v1/orders/[id]/needed-by for the phone). The service converts the wall
-- clock the screens send in the ORGANIZATION's time zone and builds the event
-- description's sentence with core orderScheduleEventDetails, the text
-- approval writes.
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
  v_event_details text;
  v_event_updated boolean := false;
  v_at            integer;
  v_old_sentence  text;
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
  if not isfinite(p_needed_by) or p_needed_by > now() + interval '5 years' then
    raise exception 'needed_by_out_of_range' using errcode = '22023', hint = 'needed_by_out_of_range';
  end if;
  v_reason := regexp_replace(coalesce(p_reason, ''), '^\s+|\s+$', '', 'g');
  if char_length(v_reason) < 1 or char_length(v_reason) > 500 then
    raise exception 'reason_required' using errcode = '22023', hint = 'reason_required';
  end if;
  -- Only core's own date sentence is taken (DESCRIPTION, in the header).
  v_details := btrim(regexp_replace(coalesce(p_event_details, ''), '[[:cntrl:]]', '', 'g'));
  if v_details !~ '^Auto-created from order (SO-[0-9]{6,}|[0-9A-F]{8})\. Needed by [^.]{1,64}\.$' then
    v_details := null;
  end if;

  -- Stale version: the caller must have seen the value it is replacing.
  if v_current is distinct from p_expected_needed_by then
    raise exception 'needed_by_changed'
      using errcode = 'P0001', hint = 'needed_by_changed',
            detail = coalesce(to_jsonb(v_current) #>> '{}', '');
  end if;

  -- LOCK 2 of 2: the order's event (at most one), when it has one.
  select e.id, e.status, e.details
    into v_event_id, v_event_status, v_event_details
    from public.schedule_events e
   where e.order_request_id = p_id
     and e.organization_id = v_org
     for update;

  -- An equal value writes nothing.
  if p_needed_by = v_current then
    return jsonb_build_object('changed', false, 'previous', v_current, 'neededBy', v_current,
                              'eventId', v_event_id, 'eventUpdated', false,
                              'eventStatus', v_event_status, 'status', v_status);
  end if;

  update public.order_requests
     set needed_by = p_needed_by
   where id = p_id;

  if v_event_id is not null and v_event_status in ('scheduled', 'in_progress') then
    -- The description: the date sentence is replaced where it sits, and
    -- everything a person wrote around it stays; one rewritten by hand (no
    -- such sentence) is kept whole; an empty one gets the sentence.
    if v_details is not null then
      if v_event_details is null or btrim(v_event_details) = '' then
        v_event_details := v_details;
      else
        v_at := regexp_instr(v_event_details, 'Auto-created from order [^.\n]*\. Needed by [^.\n]*\.');
        if v_at > 0 then
          v_old_sentence := regexp_substr(v_event_details, 'Auto-created from order [^.\n]*\. Needed by [^.\n]*\.');
          v_event_details := left(v_event_details, v_at - 1) || v_details
                             || substr(v_event_details, v_at + char_length(v_old_sentence));
        end if;
      end if;
    end if;
    update public.schedule_events e
       set starts_at       = p_needed_by,
           ends_at         = case when e.ends_at is null then null
                                  else p_needed_by + (e.ends_at - e.starts_at) end,
           details         = v_event_details,
           reminded_24h_at = null,
           reminded_1h_at  = null,
           updated_by      = v_uid
     where e.id = v_event_id;
    v_event_updated := true;
  end if;

  return jsonb_build_object('changed', true, 'previous', v_current, 'neededBy', p_needed_by,
                            'eventId', v_event_id, 'eventUpdated', v_event_updated,
                            'eventStatus', v_event_status, 'status', v_status);
end;
$$;

revoke all on function public.revise_order_needed_by(uuid, timestamptz, timestamptz, text, text)
  from public, anon, service_role;
grant execute on function public.revise_order_needed_by(uuid, timestamptz, timestamptz, text, text)
  to authenticated;

comment on function public.revise_order_needed_by(uuid, timestamptz, timestamptz, text, text) is
  'F2-4 (0383): changes an open order''s needed-by and moves its Schedule event '
  'with it, in one transaction. Refuses a closed order (P0001 order_closed), a '
  'needed-by that is null, not in the future, infinity or later than five years '
  'from now (22023 needed_by_required, needed_by_in_past, needed_by_out_of_range), '
  'a reason that is empty or over 500 characters after '
  'trimming (22023 reason_required), and a stale edit: the order''s needed-by '
  'must be p_expected_needed_by (P0001 needed_by_changed, detail = the current '
  'value). An equal value writes nothing. The order''s scheduled or in-progress '
  'event gets starts_at = the new needed-by, ends_at shifted by the same amount, '
  'the date sentence in its description replaced by p_event_details (taken only '
  'when it is core''s sentence "Auto-created from order SO-…. Needed by …."; any '
  'text a person wrote around it is kept) and both reminder stamps cleared, so its reminders '
  'go out again for the new time; a completed or cancelled event is untouched and '
  'a missing one is not created here (autoScheduleFromOrder is the one writer of '
  'new events). Returns {changed, previous, neededBy, eventId, eventUpdated, '
  'eventStatus, status}. Gates in its body: signed in (42501), member of the order''s org '
  '(P0002 order_request_not_found, the same for a missing order), the orders '
  'module (P0001 module_disabled), manager or orders:approve (42501, hint '
  'orders_approve), write access to the order''s warehouse (42501, hint '
  'warehouse_write). Locks the order row, then its event. Never notifies or '
  'emails; never raises 40001/40P01. SECURITY DEFINER (schedule_events_update is '
  'creator-or-manager), lock_timeout 5s, EXECUTE to authenticated only.';

reset lock_timeout;
