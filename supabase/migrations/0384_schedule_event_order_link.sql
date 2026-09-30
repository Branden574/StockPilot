-- 0384_schedule_event_order_link.sql
--
-- SECURITY: a Schedule event's order link (schedule_events.order_request_id)
-- and its assignee (assigned_user_id) can be set only by the server paths that
-- own them, and a linked order is always in the event's own organization: the
-- event cannot move away from its order, and the order cannot move away from
-- its event. Grants on schedule_events and order_requests, the schedule_events
-- insert and update policies, and three column comments. No table, column,
-- index, trigger, function or data change.
--
-- ── THE HOLE (pre-existing: 0255 added the columns; the policies are 0033,
--    0203) ─────────────────────────────────────────────────────────────────
-- `authenticated` held TABLE-level INSERT and UPDATE on schedule_events, and
-- schedule_events_insert / schedule_events_update never looked at either
-- column. Reproduced on the local stack at 0383, rolled back
-- (stockpilot-work/sec-schedule-link/probes):
--   V1  A VIEWER inserted an event linked to an approved order of their org.
--       The order then had "its" event, and the unique index
--       schedule_events_order_request_uniq (one event per order) gave the
--       order's real event, made at approval by autoScheduleFromOrder, a 23505:
--       the order never got its own entry.
--   V2  An approver's revise_order_needed_by (0383, SECURITY DEFINER) then
--       moved the viewer's event and wrote its description, trusting the link.
--   V3  The viewer re-linked their own event to another order (column UPDATE).
--   P9  An org B MANAGER linked an org B event to an org A order id. It took
--       org A's slot in the unique index (org A's order can never get its own
--       event: 23505, the service answers not_moved), and the order flows'
--       admin writes, which key on the link alone, reached into org B:
--       assignDelivery copied org A's driver into org B's event (so org B's
--       reminders, title and description written by org B, went to org A's
--       driver) and syncOrderScheduleEvent closes it when org A's order closes.
--   A1  Any member, a viewer included, set assigned_user_id to ANY user id.
--       The reminder cron (api/cron/schedule-reminders) emails and notifies
--       the assignee whatever their organization, with the event's title as
--       the subject and its description in the body.
-- Found by the review of the first cut (local stack with that cut, rolled back):
--   D1  The ORDER side: order_requests_update checks the caller's rights in
--       the old org (USING) and in the new org (WITH CHECK), and order_requests
--       has no org-pin trigger (unlike purchase_orders, inventory_items,
--       product_groups, maintenance_requests). A manager of both orgs moved an
--       approved org A order, whose event is in org A, to org B: the event was
--       then linked across orgs, org A could no longer edit it (the new policy
--       term), and org B's own event for that order got 23505.
--   A2  The assignee through the order row: a manager or an orders:approve
--       holder set order_requests.assigned_delivery_user_id to another org's
--       user (only assignDelivery checks membership, in the service), and
--       autoScheduleFromOrder copied it into the event's assignee.
--   U4  A viewer re-keyed their own event (UPDATE ... SET id), detaching it
--       from its audit rows and notification links.
--
-- ── WHO WRITES THESE TWO COLUMNS (read 2026-09-30 on ae799d94) ────────────
--   - autoScheduleFromOrder (services/order-requests.ts, admin client):
--     INSERT with order_request_id = the order, organization_id = the order's
--     org, assigned_user_id = the order's driver. THE one writer of the link.
--   - assignDelivery (same file, admin client): UPDATE assigned_user_id where
--     order_request_id = the order.
--   - syncOrderScheduleEvent, bringOrderEventInStep (admin client) and
--     revise_order_needed_by (0383, DEFINER, runs as its owner): move or close
--     the order's event, keyed on the link; they never change it.
--   - The reminder cron (admin client): the reminder stamps only.
--   - Nothing on the user client writes either column: ScheduleService.create
--     and .update (the Schedule page, its server actions and the AI tools'
--     schedule tools, all through core's schedule schemas, which have neither
--     field and strip unknown keys), the phone's New event
--     (apps/mobile/app/schedule/new.tsx: organization_id, title, starts_at,
--     ends_at, all_day, location_text, warehouse_id, requester_name), and no
--     /api/v1 route, import, edge function or SQL function (only 0383's).
--     git history: no client ever wrote either column.
--
-- ── PRODUCTION (read-only, 2026-09-30) ────────────────────────────────────
-- 27 events in 2 orgs, none open. 22 linked: 0 cross-org, 0 dangling, 0
-- duplicate; creators owner 9, admin 7, manager 6 (no viewer or staff). 21
-- carry every mark of autoScheduleFromOrder (creator = the approver, its title
-- and description, 0.1-3.8 s after approval); 1 is a Schedule-page event from
-- the day 0255 was built that names the same order, same warehouse, linked by
-- hand. 9 assignees, all on linked events, all the order's driver, all members.
-- order_requests: 58 columns, the same as local (column-list md5 23e19ed9...);
-- 0 orders whose warehouse is in another org; 46 drivers, 0 non-members; 1
-- user is owner, admin or manager of 2+ orgs; no SECURITY INVOKER function
-- updates order_requests.
-- No bad existing link: no data change is needed, and every existing row
-- satisfies the new policy terms.
--
-- ── WHAT IT DOES ──────────────────────────────────────────────────────────
-- 1. GRANTS. authenticated loses table-level INSERT and UPDATE and gets them
--    back on every column EXCEPT order_request_id and assigned_user_id
--    (0368's shape). A direct POST or PATCH naming either column is 42501
--    "permission denied for table schedule_events"; every current user-client
--    write names neither, so it is unchanged. service_role (the admin client)
--    keeps its table grants, and a DEFINER function writes as its owner.
--    anon loses INSERT, UPDATE, DELETE and TRUNCATE (it never had a policy,
--    so nothing observable changes); authenticated loses TRUNCATE (not
--    reachable through the API, and it ignores RLS). SELECT, and
--    authenticated's DELETE, are unchanged.
--    UPDATE also leaves out id and created_at (U4): no client writes either
--    (ScheduleService.update and the phone never send them); an insert may
--    still name them, as before.
-- 2. POLICIES. schedule_events_insert and schedule_events_update keep every
--    term they had (restated verbatim) and gain
--    order_request_in_org(order_request_id, organization_id): 0362's
--    null-safe predicate (the maintenance-request guard's), unchanged here.
--    With the grants above a signed-in caller can no longer set the link, so
--    a cross-org link could still come only from moving one side of it to
--    another org. This term refuses the event side (a member of both orgs,
--    who created the event or manages both, updating its organization_id),
--    and it keeps holding if a column grant is ever restored; section 4
--    refuses the order side. Asked by a signed-in caller, it answers true
--    only to a member of the org it names, so it is no existence oracle for
--    other orgs' order ids. A manual event (no link) passes as before.
-- 3. COMMENTS on both columns: who sets them, and that authenticated may not.
-- 4. order_requests (D1). authenticated loses table-level UPDATE and gets it
--    back on every column EXCEPT organization_id, so an order cannot be
--    moved to another org by a signed-in caller (42501). Every user-client
--    order write leaves it out (services/order-requests.ts: assignDelivery,
--    the notes save, deny, the pick slip, the packing slip, staging, in
--    transit; read 2026-09-30), the phone writes orders only through
--    /api/v1, and every SQL function that updates order_requests (approve,
--    approve_partial, cancel, the picking functions, the signatures,
--    revise_order_needed_by, ...) is SECURITY DEFINER and writes as its
--    owner; production and local have no SECURITY INVOKER one. The admin
--    client (the public order link, the portal, the return prompt) keeps its
--    table grants. INSERT, SELECT, the order_requests policies and every
--    other column's UPDATE are unchanged (parity). created_at and
--    warehouse_id stay editable on purpose: whether an order's date and
--    warehouse are fixed after submission is the open owner question Q4
--    (Book Order Totals plan), pinned as current behaviour by pgTAP 0379
--    C1/C2; only the organization, a tenant boundary, is fixed here, under
--    the security rule. A column grant, not a pin trigger, because this
--    migration changes grants, policies and comments only; a Q4 guard can be
--    a trigger in its own migration.
--
-- A2 (the order's driver) is closed where it is used, not here: the reminder
-- cron, the one place that contacts an event's assignee, now adds them only
-- while an accepted, non-act-as member of the event's org (web, same change),
-- which also covers a driver who left the org after being named. A write-time
-- check would need a trigger (a WITH CHECK term cannot tell a changed driver
-- from a driver who left later, so it would block every later write to that
-- order). Production has 46 orders with a driver, none a non-member.
--
-- ── NOT DONE, AND WHY ─────────────────────────────────────────────────────
--   - A WITH CHECK term alone ("the order is in the event's org, and the
--     actor may read it"): it stops P9 but not V1, V2 or V3. Every member
--     may read every order of their org (order_requests_select is
--     is_org_member), so "may read" is the same-org term; a viewer's link to
--     an order of their own org passes it. Only removing the column
--     privilege keeps a person from linking at all.
--   - A trigger for every writer (service_role and DEFINER included): the
--     server writers are same-org by construction (autoScheduleFromOrder
--     takes both ids from the one order row; nothing else changes the link),
--     production has none, and changing _enforce_schedule_events_writer would
--     touch every event write, the reminder cron's included. A composite
--     foreign key (order_request_id, organization_id) would be the structural
--     form, but it is table DDL, which this migration does not do.
--   - schedule_events.organization_id stays updatable (parity); the policy
--     term above is what keeps a linked event in its order's org.
--   - order_requests: anon keeps its table grants (it has no policy on the
--     table, so it reaches no row) and authenticated keeps TRUNCATE (not
--     reachable through the API); the other columns a signed-in approver may
--     write are unchanged. Neither is part of this fix.
--
-- ── A NEW COLUMN ON schedule_events OR order_requests ─────────────────────
-- Column grants do not follow new columns. A column the Schedule page or the
-- phone must write needs `grant insert (col), update (col) on
-- public.schedule_events to authenticated` in its migration; a server-owned
-- one needs nothing. pgTAP 0384 G1 fails until one of the two is decided.
-- Likewise a new order_requests column the app updates through the user
-- client needs `grant update (col) on public.order_requests to
-- authenticated` (inserts keep the table grant); pgTAP 0384 GO1 fails until
-- it is granted (organization_id is the one column left out).
--
-- ── PROD PUSH NOTE ────────────────────────────────────────────────────────
-- GRANT, REVOKE, DROP/CREATE POLICY and COMMENT only: catalog changes, no
-- rewrite, no data. The policy DDL takes a brief ACCESS EXCLUSIVE lock on
-- schedule_events (27 rows), and the order_requests grants a brief lock on
-- order_requests; lock_timeout makes the push fail fast instead of queueing
-- behind a long reader (retry is the remedy). Nothing raises 40001/40P01.

-- PLAIN `set`, not `set local` (0303/0358/0370/0374/0377/0378/0383). Reset at the end.
set lock_timeout = '5s';

-- ── 1. Grants ─────────────────────────────────────────────────────────────
revoke insert, update, delete, truncate on table public.schedule_events from anon;
revoke truncate on table public.schedule_events from authenticated;
revoke insert, update on table public.schedule_events from authenticated;
grant insert (id, organization_id, title, starts_at, ends_at, all_day, location_text,
              warehouse_id, requester_name, details, status, created_by, updated_by,
              created_at, updated_at, bundle_id, bundle_quantity, bundle_warehouse_id,
              reminded_24h_at, reminded_1h_at)
  on table public.schedule_events to authenticated;
-- UPDATE also leaves out id and created_at (U4).
grant update (organization_id, title, starts_at, ends_at, all_day, location_text,
              warehouse_id, requester_name, details, status, created_by, updated_by,
              updated_at, bundle_id, bundle_quantity, bundle_warehouse_id,
              reminded_24h_at, reminded_1h_at)
  on table public.schedule_events to authenticated;

-- ── 2. Policies (every earlier term restated verbatim, then the link) ─────
drop policy if exists schedule_events_insert on public.schedule_events;
create policy schedule_events_insert on public.schedule_events
  for insert to authenticated
  with check (
    (( SELECT public.is_org_member(schedule_events.organization_id) AS is_org_member)
      AND (created_by = auth.uid())
      AND ((warehouse_id IS NULL) OR public.user_can_access_warehouse(auth.uid(), warehouse_id, 'write'::text))
      AND ( SELECT public.warehouse_in_org(schedule_events.bundle_warehouse_id, schedule_events.organization_id) AS warehouse_in_org))
    AND ( SELECT public.order_request_in_org(schedule_events.order_request_id, schedule_events.organization_id) AS order_request_in_org)
  );

drop policy if exists schedule_events_update on public.schedule_events;
create policy schedule_events_update on public.schedule_events
  for update to authenticated
  using (
    (( SELECT public.is_org_member(schedule_events.organization_id) AS is_org_member)
      AND ((created_by = auth.uid())
           OR ( SELECT public.has_org_role(schedule_events.organization_id, 'manager'::text) AS has_org_role)))
  )
  with check (
    (( SELECT public.is_org_member(schedule_events.organization_id) AS is_org_member)
      AND ((created_by = auth.uid())
           OR ( SELECT public.has_org_role(schedule_events.organization_id, 'manager'::text) AS has_org_role))
      AND ( SELECT public.warehouse_in_org(schedule_events.warehouse_id, schedule_events.organization_id) AS warehouse_in_org)
      AND ( SELECT public.warehouse_in_org(schedule_events.bundle_warehouse_id, schedule_events.organization_id) AS warehouse_in_org))
    AND ( SELECT public.order_request_in_org(schedule_events.order_request_id, schedule_events.organization_id) AS order_request_in_org)
  );

comment on policy schedule_events_insert on public.schedule_events is
  'Any accepted member inserts their own event (created_by = the caller), in a warehouse they may write, '
  'with a bundle source warehouse of the same org (0203) and, since 0384, no order of another org '
  '(order_request_in_org; authenticated cannot write order_request_id at all, the admin client links events).';
comment on policy schedule_events_update on public.schedule_events is
  'The creator or a manager updates an event; the new row keeps both warehouses in the org (0203) and, since '
  '0384, its linked order in the org (order_request_in_org), so a linked event cannot be moved to another org.';

-- ── 3. Column comments ────────────────────────────────────────────────────
comment on column public.schedule_events.order_request_id is
  'The order this event belongs to (0255). Set by the server only: autoScheduleFromOrder (admin client) '
  'creates the event with it and nothing changes it. authenticated holds no INSERT or UPDATE on this column '
  '(0384), and the row policies require the order to be in the event''s organization.';
comment on column public.schedule_events.assigned_user_id is
  'Who the event is for; the reminder cron emails and notifies this user. Set by the server only: '
  'autoScheduleFromOrder and assignDelivery (admin client) copy the order''s delivery driver. authenticated '
  'holds no INSERT or UPDATE on this column (0384).';

-- ── 4. order_requests: an order's organization is fixed ───────────────────
revoke update on table public.order_requests from authenticated;
grant update (id, warehouse_id, status, requester_user_id, requester_email, requester_name,
              requester_org_label, approved_by, approved_at, denied_reason, packaging_at,
              ready_at, delivered_at, cancelled_at, cancelled_by, notes, internal_notes,
              source, created_at, updated_at, confirmation_token_hash, confirmation_token_expires_at,
              fulfillment_type, pickup_location_notes, requester_phone, assigned_picker_id,
              pick_slip_generated_at, pick_slip_generated_by, picking_completed_at,
              picking_completed_by, packing_slip_generated_at, packing_slip_generated_by,
              staged_at, staged_by, assigned_delivery_user_id, assigned_delivery_by,
              assigned_delivery_at, in_transit_at, in_transit_by, signature_token,
              signature_token_expires_at, signed_by_name, signed_by_email, signature_data_url,
              signed_at, completed_at, completed_by, delivery_charter_id, return_token,
              picking_claimed_at, picking_claimed_by, signature_method, customer_id,
              order_number, needed_by, return_prompt_sent_at, public_track_token)
  on table public.order_requests to authenticated;

comment on column public.order_requests.organization_id is
  'The organization the order belongs to. Fixed once the order exists: authenticated holds no UPDATE on it '
  '(0384), so an order (and the Schedule event linked to it) cannot be moved to another organization by a '
  'signed-in caller. The admin client and SECURITY DEFINER functions never change it.';

reset lock_timeout;
