-- 0395_order_stock_guards.sql
--
-- Small fixes, slice 2 (stockpilot-work/six/small-fixes-plan-2026-10-05.md):
-- order and stock guards the web app already applied, now applied by the
-- database for every caller (a phone's own client, a raw REST call, an old
-- bundle). One change per restated body; each body is copied verbatim from
-- its latest definition (named above it), whose md5(prosrc) equals
-- production's, and the pgTAP R-section proves that removing the added text
-- gives production's body exactly. Signatures, SECURITY mode, SET clauses,
-- volatility, owner and grants are unchanged (CREATE OR REPLACE keeps the
-- owner and grants; each header restates production's attributes). Inside the
-- bodies each added block is tagged "S2" (small fixes slice 2) rather than
-- with this file's number, so every md5 pin survives the push-time
-- renumbering.
--
--   1. N1   cancel_order_request: the person who placed an order cancels it
--           only while it is pending approval (42501 forbidden, hint
--           requester_pending_only). Someone with orders:approve still cancels
--           at any open status. svc refused this already; the function did
--           not (the phone's own client could cancel an approved, picked or
--           in-transit order, releasing holds or restocking units on a truck).
--   2. L115 cancel_order_request and reopen_picking link the movements they
--           write to the order (reference_type order_request, reference_id the
--           order), as complete_picking does. Rows already written are left as
--           history (owner decision Q13, default: no backfill). Display is
--           unchanged: Activity and Movements already read the order from the
--           reason text of these rows.
--   3. L8   the ledger wrappers adjust_stock, transfer_stock, post_cycle_count,
--           post_receipt_v2, reverse_receipt and assemble_bundle refuse an API
--           role's direct call when the caller lacks the permission the app
--           checks before calling them (42501 forbidden, hint permission):
--           stock:adjust (adjust, count post, receipt post and reverse),
--           stock:transfer, bundles:manage. A call inside another ledger call
--           of the same transaction (post_receipt_v2 and reverse_receipt reach
--           adjust_stock that way) is not asked again, and the order functions
--           (cancel, complete_picking, reopen) run as postgres, so neither is
--           held. ledger.<name> bodies are untouched (their pins do not move).
--           Census (production 2026-10-05): no ledger body checks a
--           permission; adjust and transfer admit staff (1 staff member has
--           stock:adjust revoked and 1 stock:transfer, so both are live), the
--           other bodies admit a manager whose permission is revoked (0 today).
--           Each wrapper has exactly one app caller, which asserts that same
--           permission first. Left out on purpose: distribute_bundle (the
--           Schedule completion path calls it behind the schedule permission,
--           not bundles:distribute, so a gate would refuse what the app
--           allows) and process_return_disposition (returns RX-1 moves its
--           body to has_permission(returns:manage)).
--   4. L15  a new trigger refuses a soft delete (deleted_at null -> set) of an
--           item with stock on record or any non-zero holding, for every role
--           (23514, hint item_holds_stock). The daily auto-delete runs as the
--           admin client and is the live path (slice 1 filters its candidates
--           first; this is the backstop). The 11 items it deleted with 78 units
--           on record stay as history (owner decision Q4, default); the
--           trigger fires only on the delete itself, so their other updates
--           pass.
--   5. L129a order_requests_update, USING and WITH CHECK: also
--           user_can_access_warehouse(auth.uid(), warehouse_id, 'write'), the
--           rule the service applies (requireWarehouseAccess 'write') before
--           deny, pick slip, staging and approve-with-notes. That helper
--           (0310's body, equal to production's) answers true for an owner,
--           admin or manager of the warehouse's organization with no
--           assignment needed, for staff only on an assigned warehouse, and
--           never for a viewer; the app's rule is the same. No manager-by-role
--           arm: has_permission already requires the membership, so such an
--           arm would admit no one more, and 0390 keeps every policy from
--           pairing has_org_role with orders:approve (0390 suite H2). The
--           0280 all-warehouses flag keeps an assignment row per warehouse (0
--           gaps in production). The plan's "warehouse_id is null" arm is
--           left out: the column is NOT NULL. The service's notes editor moves
--           from 'read' to 'write' in the same change (only a viewer granted
--           orders:approve differed: 0 in production).
--   6. L129b confirm_physical_signature: the assigned driver must still be a
--           member of the order's organization, with the Orders module on.
--           The manager branch is unchanged.
--   7. L11  order_request_lines_insert also refuses a kit (is_bundle) item.
--   8. L86  the requester's "approved" notification (in the app and as the
--           push, which carries the notification's body) says "Part of your
--           order is held; the rest is waiting for stock." when any item is
--           held for less than the order still owes (approve_partial), "Nothing
--           is held yet; your order is waiting for stock." when approve_partial
--           could hold nothing at all (it approves anyway; production has one
--           such order, approved 2026-06-30), and keeps "Stock has been
--           reserved." otherwise. approve_partial and approve_order_request
--           write their holds before the status, so the AFTER trigger reads
--           them.
--
-- WHO CHANGES TODAY (production, read-only, 2026-10-05): open orders at a
-- user-client edge outside a scoped approver's warehouses 0; open orders with
-- a driver who is no longer a member 0 (0 with any driver); kit order lines 0
-- (0 kit items); archived items with stock in the one org with auto-delete on
-- 0; members with stock:adjust revoked 1 and stock:transfer revoked 1 (staff;
-- the app refuses them first, so only a raw call is refused); 0 role
-- overrides on these permissions. Nothing anyone uses today changes.
--
-- LOCKS. Functions, grants and comments take no table lock. CREATE TRIGGER
-- takes SHARE ROW EXCLUSIVE on inventory_items and ALTER POLICY takes ACCESS
-- EXCLUSIVE on its table (and, on this image, supautils 3.4.0 takes ACCESS
-- EXCLUSIVE on every table supautils.policy_grants lists), all held to commit.
-- As in 0390, one prelude takes all of them first, NOWAIT, inside a
-- subtransaction that retries up to 40 times with a 50-150 ms pause holding
-- nothing; after it no statement takes a new table lock, so the file never
-- waits while holding one and is never part of a deadlock. lock_timeout 900ms
-- (below deadlock_timeout) bounds anything unforeseen. Stock writes and order
-- writes queue for the few milliseconds the file holds. Push off-peak.
-- scripts/db-concurrency/0395_migration_lock_footprint.sh measures it.
--
-- DATA SAFETY: no row changes. The file restates bodies, comments and two
-- policies and adds one trigger.
--
-- ERRORS: the functions raise 42501 (hints requester_pending_only,
-- permission) and the trigger 23514 (hint item_holds_stock); the push raises
-- only 55P03 (busy, nothing applied). Never 40001 or 40P01 (PostgREST retries
-- those forever).

set lock_timeout = '900ms';

-- ═══ N1 and L115. cancel_order_request: the requester's window, and its restocks linked ═══
-- cancel_order_request: restated from 0390_approval_follows_permission.sql; md5(prosrc) 47cabcd1fe4f52fb7b2b6b6b64b68da1 -> 535fc49935f15adc8d7dfa78836a06af.
CREATE OR REPLACE FUNCTION public.cancel_order_request(p_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS order_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_req public.order_requests%rowtype;
  v_user uuid := auth.uid();
  v_is_manager boolean;
  v_is_owner boolean;
  v_line record;
  v_stock_drawn boolean;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  select * into v_req from public.order_requests where id = p_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  if v_req.status in ('completed', 'denied', 'cancelled') then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  -- *** 0348 grant-aware approval gate — see the migration header. The name
  -- stays v_is_manager (it feeds the manager-or-requester rule below); it now
  -- means "may act on someone else's order", which an explicit
  -- 'orders:approve' grant also confers. ***
  v_is_manager := public.has_permission(v_req.organization_id, 'orders:approve');
  v_is_owner   := v_req.requester_user_id = v_user;
  if not v_is_manager and not v_is_owner then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- S2 (N1): the person who placed the order cancels it only while it is
  -- pending approval. After that only someone who approves orders cancels
  -- it: an approved order holds stock, a picked one has drawn it and an
  -- order in transit is on the truck. The web service already refused this
  -- before calling here; now every caller gets the same answer.
  if not v_is_manager and v_req.status <> 'pending_approval' then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'requester_pending_only',
            detail  = 'Only a pending order can be cancelled by the person who placed it.';
  end if;

  -- Are this order's quantity_picked units currently OUT of quantity_on_hand?
  -- See the status table at the top of this migration.
  --
  -- EXHAUSTIVE BY CONSTRUCTION. Every value of order_requests_status_check is
  -- classified explicitly and an unrecognised one RAISES — see the note on
  -- asymmetric failure at the top of this migration.
  case v_req.status
    -- DRAWN. complete_picking is the only writer of 'picking_complete' and it
    -- calls adjust_stock(-batch) in the same transaction; nothing between there
    -- and the signature touches quantity_picked or stock.
    when 'picking_complete', 'packing_slip_generated', 'staged_for_pickup',
         'staged_for_delivery', 'in_transit' then
      v_stock_drawn := true;

    -- NOT DRAWN. pending_confirmation / pending_approval / approved /
    -- pick_slip_generated carry no batch yet, so the loop no-ops regardless.
    -- picking_in_progress is the exclusion that matters: partial_pick_line
    -- never drew, and reopen_picking already gave its draw back. backordered
    -- had quantity_picked nulled at hand-over.
    when 'pending_confirmation', 'pending_approval', 'approved',
         'pick_slip_generated', 'picking_in_progress', 'backordered' then
      v_stock_drawn := false;

    -- completed / denied / cancelled never reach here — the
    -- invalid_status_transition refusal above rejects them first — so this
    -- branch fires only for a status that did not exist when this was written.
    else
      raise exception 'unclassified_order_status_for_restock'
        using errcode = 'P0001',
              detail  = v_req.status,
              hint    = 'order_requests has a status that cancel_order_request '
                        'does not classify. Decide whether an order in this '
                        'status has its quantity_picked units OUT of '
                        'quantity_on_hand, then add it to the drawn or the '
                        'not-drawn branch of the case in cancel_order_request '
                        '(latest definition: supabase/migrations/'
                        '0290_cancel_restock_guard.sql) and cover it in '
                        'supabase/tests/0290_cancel_restock_guard.test.sql. Do '
                        'not let it fall through to the not-drawn branch '
                        'without checking: skipping a restock that was owed '
                        'destroys stock with no stock_movements row.';
  end case;

  -- Restock the CURRENT staged batch (quantity_picked) — units complete_picking
  -- pulled off the shelf that are still in the building. quantity_fulfilled
  -- (already handed to the customer across prior batches) is NEVER restocked and
  -- is preserved as the record of what was provided. A backordered order has
  -- quantity_picked = null on every line, so this loop no-ops for it — the
  -- backorder-aware branch the spec calls for, expressed by the column split.
  for v_line in
    select l.id as line_id, l.item_id, l.quantity_picked
    from public.order_request_lines l
    where l.order_request_id = p_id
      and coalesce(l.quantity_picked, 0) > 0
    order by l.item_id
  loop
    if v_stock_drawn then
      perform public.adjust_stock(
        v_line.item_id,
        v_line.quantity_picked,
        'return',
        null,
        'Order cancelled (order_request ' || p_id::text || ')',
        null
      );
    end if;
    -- Clear the staged batch so the restock can never be replayed. Runs in BOTH
    -- branches: a cancelled order never carries a live staged batch.
    update public.order_request_lines
      set quantity_picked = null
      where id = v_line.line_id;
  end loop;

  -- S2 (L115): link the restock movements this call just wrote to the
  -- order, as complete_picking links its own. adjust_stock takes no
  -- reference, so the rows are found by what only these restocks share:
  -- this organization, this transaction's time, a 'return' by this caller
  -- with no reference yet, and the reason that names this order. An order
  -- is cancelled once, so nothing else in the transaction matches.
  update public.stock_movements
     set reference_type = 'order_request',
         reference_id   = p_id
   where organization_id = v_req.organization_id
     and created_at      = now()
     and movement_type   = 'return'
     and user_id         = v_user
     and reference_type is null
     and reason          = 'Order cancelled (order_request ' || p_id::text || ')';

  update public.stock_reservations
    set released_at = now(), released_reason = 'cancelled'
    where order_request_id = p_id and released_at is null;

  -- I1 from 0077: clear-or-replace. NEVER preserve a prior denied_reason when a
  -- later cancel arrives without its own reason — the prior text is leaked via
  -- the public track endpoint otherwise.
  update public.order_requests
    set status = 'cancelled',
        cancelled_at = now(),
        cancelled_by = v_user,
        denied_reason = p_reason
    where id = p_id;

  select * into v_req from public.order_requests where id = p_id;
  return v_req;
end;
$function$;

comment on function public.cancel_order_request(uuid, text) is
  'Cancel an order request. Restocks the current staged batch (quantity_picked) ONLY when the order status says those units are actually out of quantity_on_hand: picking_complete, packing_slip_generated, staged_for_pickup, staged_for_delivery, in_transit. A mid-pick (picking_in_progress) order has not drawn yet, and a reopen_picking order has already had its draw returned — restocking either would invent stock. quantity_picked is cleared either way; quantity_fulfilled is never restocked. The status classification is exhaustive over order_requests_status_check: an unrecognised status raises unclassified_order_status_for_restock rather than defaulting to skip-the-restock, because a skipped restock destroys stock silently while a refused cancel is retryable. Since 0395: the person who placed the order may cancel it only while it is pending approval (42501 forbidden, hint requester_pending_only); someone with orders:approve cancels it at any open status; the restock movements carry reference_type order_request and the order id.';

-- ═══ L115. reopen_picking: its movements linked ═══
-- reopen_picking: restated from 0390_approval_follows_permission.sql; md5(prosrc) 293ce0e76d195bb13105cfd1c067de82 -> 14e49293fa670dc2e05a1c1b6930bce5.
CREATE OR REPLACE FUNCTION public.reopen_picking(p_id uuid, p_reason text)
 RETURNS order_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_req  public.order_requests%rowtype;
  v_user uuid := auth.uid();
  v_line record;
  v_loc  uuid;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'reopen_reason_required' using errcode = 'P0001';
  end if;

  select * into v_req from public.order_requests where id = p_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  -- *** 0348 grant-aware approval gate — see the migration header. ***
  -- has_org_role is a pure ROLE-RANK lookup; it never reads
  -- user_permission_overrides / role_permission_overrides. has_permission is
  -- the only helper that does, so an admin who grants 'orders:approve' to
  -- staff in the matrix reaches this body. The has_org_role term is RETAINED
  -- so a manager with an explicit granted=false override keeps today's
  -- behaviour and no existing role test changes.
  if not (public.has_permission(v_req.organization_id, 'orders:approve')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- signed_at is the ONLY correct is-signed predicate (physical signatures
  -- leave signature_data_url NULL). Defence in depth: these statuses are
  -- pre-signature already, but never let a signed order rewind.
  if v_req.signed_at is not null then
    raise exception 'already_signed' using errcode = 'P0001';
  end if;
  if v_req.status not in ('picking_complete', 'packing_slip_generated') then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  -- Reverse complete_picking's per-line stock draw. quantity_picked holds the
  -- exact drawn amount (complete_picking sets quantity_picked = v_batch after
  -- adjust_stock(-v_batch)). This writes a visible +movement, the inverse of
  -- the "Order pick" movement.
  --
  -- The units land in the item's Unplaced bucket, NOT the null-location default
  -- (see note (a) at the top): Staging is invisible to the 'placed' draw-down
  -- complete_picking uses, so a Staging reversal makes the order unfinishable.
  for v_line in
    select l.id                as line_id,
           l.item_id           as item_id,
           coalesce(l.quantity_picked, 0) as picked,
           ii.organization_id  as item_org,
           ii.warehouse_id     as item_warehouse
    from public.order_request_lines l
    join public.inventory_items ii on ii.id = l.item_id
    where l.order_request_id = p_id
    order by l.item_id
  loop
    if v_line.picked > 0 then
      v_loc := null;
      if v_line.item_warehouse is not null then
        perform public.ensure_warehouse_placement_locations(v_line.item_warehouse);
        select id into v_loc from public.locations
          where warehouse_id = v_line.item_warehouse
            and kind = 'unplaced'
            and deleted_at is null
          limit 1;
      end if;
      if v_loc is null then
        perform public.ensure_org_placement_locations(v_line.item_org);
        select id into v_loc from public.locations
          where organization_id = v_line.item_org
            and warehouse_id is null
            and kind = 'unplaced'
            and deleted_at is null
          limit 1;
      end if;

      -- Both lookups failed to resolve an Unplaced bucket: refuse instead of
      -- falling through to adjust_stock's null-location default, which would
      -- silently land the reversal in Staging (see note (a) at the top) — the
      -- exact unfinishable-order failure mode this migration exists to prevent.
      if v_loc is null then
        raise exception 'unplaced_location_not_found'
          using errcode = 'P0002', detail = v_line.item_id::text;
      end if;

      perform public.adjust_stock(
        v_line.item_id,
        v_line.picked,
        'transfer',
        v_loc,
        'Reopen picking (order_request ' || p_id::text || ')',
        null
      );
    end if;
  end loop;

  -- S2 (L115): link the movements this call just wrote back to the order,
  -- as cancel_order_request and complete_picking link theirs: this
  -- organization, this transaction's time, a 'transfer' by this caller with
  -- no reference yet, and the reason that names this order. An order leaves
  -- picking_complete once per transaction, so nothing else matches.
  update public.stock_movements
     set reference_type = 'order_request',
         reference_id   = p_id
   where organization_id = v_req.organization_id
     and created_at      = now()
     and movement_type   = 'transfer'
     and user_id         = v_user
     and reference_type is null
     and reason          = 'Reopen picking (order_request ' || p_id::text || ')';

  -- Restore the reservations complete_picking released for THIS picking cycle.
  -- Scoped by picking_completed_at (see note (b) at the top) so a previously
  -- superseded generation of holds — left behind by a backorder resume — is not
  -- resurrected on top of the current one.
  update public.stock_reservations
    set released_at = null
    where order_request_id = p_id
      and released_at is not null
      and (v_req.picking_completed_at is null
           or released_at >= v_req.picking_completed_at);

  -- Rewind to picking_in_progress; preserve quantity_picked + assigned_picker_id;
  -- clear the packing-slip / signature-token cycle (voids the packing slip when
  -- reopening from packing_slip_generated; no-op columns are already NULL when
  -- reopening from picking_complete).
  update public.order_requests
    set status                     = 'picking_in_progress',
        picking_completed_at       = null,
        picking_completed_by       = null,
        packing_slip_generated_at  = null,
        packing_slip_generated_by  = null,
        signature_token            = null,
        signature_token_expires_at = null
    where id = p_id;

  select * into v_req from public.order_requests where id = p_id;
  return v_req;
end;
$function$;

comment on function public.reopen_picking(uuid, text) is
  'Manager override: rewind a picked/packed (pre-signature) order to picking_in_progress to fix a miscount. Reverses complete_picking''s stock draw (adjust_stock +quantity_picked into the item''s Unplaced bucket, so the units stay drawable by the re-pick), restores the reservations released by this picking cycle, preserves quantity_picked + assigned_picker_id, clears packing-slip/token fields. Refuses when signed_at is set. Reason required. Since 0395 its movements carry reference_type order_request and the order id.';

-- ═══ L129b. confirm_physical_signature: the driver is still a member, with Orders on ═══
-- confirm_physical_signature: restated from 0248_physical_signature.sql; md5(prosrc) f7a14a46d2c70f635c3da844c786ce67 -> c0d1c11d31dd86e072f05b72f299535c.
CREATE OR REPLACE FUNCTION public.confirm_physical_signature(p_id uuid, p_signer_name text)
 RETURNS order_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_req        public.order_requests%rowtype;
  v_user       uuid := auth.uid();
  v_owed       numeric(14,4);
  v_new_status text;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if coalesce(length(trim(p_signer_name)), 0) = 0 then
    raise exception 'signer_name_required' using errcode = 'P0001';
  end if;

  select * into v_req from public.order_requests where id = p_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;

  -- Who may record a paper signature: manager+ (same floor as the other order
  -- actions) OR the assigned delivery driver (they're the one holding the pen
  -- at the door). Mirrors who the UI shows Collect-signature to.
  if not public.has_org_role(v_req.organization_id, 'manager')
     and (v_req.assigned_delivery_user_id is null or v_req.assigned_delivery_user_id <> v_user
          -- S2 (L129b): the driver must still be a member, with Orders on.
          or not public.is_org_member(v_req.organization_id)
          or not public.module_enabled(v_req.organization_id, 'orders')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_req.signed_at is not null then
    raise exception 'already_signed' using errcode = 'P0001';
  end if;
  if v_req.status not in ('staged_for_pickup', 'in_transit') then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  -- Identical hand-over accounting to the digital RPC: ship the staged batch…
  update public.order_request_lines
    set quantity_fulfilled = coalesce(quantity_fulfilled, 0) + coalesce(quantity_picked, 0),
        quantity_picked    = null
    where order_request_id = p_id;

  -- …then fork on what's still owed.
  select coalesce(sum(greatest(coalesce(quantity_requested, 0) - coalesce(quantity_fulfilled, 0), 0)), 0)
    into v_owed
    from public.order_request_lines
    where order_request_id = p_id;

  v_new_status := case when v_owed > 0 then 'backordered' else 'completed' end;

  update public.order_requests
     set status              = v_new_status,
         signed_by_name      = trim(p_signer_name),
         signed_by_email     = null,
         signature_data_url  = null,
         signature_method    = 'physical',
         signed_at           = now(),
         completed_at        = case when v_new_status = 'completed' then now() else null end,
         completed_by        = v_user
   where id = p_id;

  select * into v_req from public.order_requests where id = p_id;
  return v_req;
end;
$function$;

comment on function public.confirm_physical_signature(uuid, text) is
  'Records a paper signature at hand-over (0248): the same hand-over accounting as confirm_order_signature, no image. Who: a manager by role, or the assigned driver while they are still a member of the order''s organization and the Orders module is on (0395).';

-- ═══ L86. The approved notification says when only part is held ═══
-- _notify_order_request_changes: restated from 0265_notify_order_request_created_pref.sql; md5(prosrc) a223ae83810149728156b8e299c7425e -> 8d9de81d81de84af3e2589e6044506bf.
CREATE OR REPLACE FUNCTION public._notify_order_request_changes()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      -- Per-user opt-out (0092 pattern) for the "New order request" ping.
      if exists (
        select 1 from public.notification_preferences
        where user_id = v_recipients_loop.user_id and push_order_request_created = true
      ) or not exists (
        select 1 from public.notification_preferences where user_id = v_recipients_loop.user_id
      ) then
        insert into public.notifications (
          organization_id, user_id, type, title, body, link, metadata
        ) values (
          new.organization_id, v_recipients_loop.user_id,
          'order_request.created', v_title, v_body, v_link, v_metadata
        );
      end if;
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
        -- Per-user opt-out (0092 pattern) for the "New order request" ping.
        if exists (
          select 1 from public.notification_preferences
          where user_id = v_recipients_loop.user_id and push_order_request_created = true
        ) or not exists (
          select 1 from public.notification_preferences where user_id = v_recipients_loop.user_id
        ) then
          insert into public.notifications (
            organization_id, user_id, type, title, body, link, metadata
          ) values (
            new.organization_id, v_recipients_loop.user_id,
            'order_request.created', v_title, v_body, v_link, v_metadata
          );
        end if;
      end loop;
      return new;
    end if;

    -- Internal-only operational statuses do NOT trigger a requester ping.
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

    -- Default-on pref gate (0092 pattern) for the requester's own status pings.
    case new.status
      when 'approved' then
        v_title := 'Your order request was approved';
        v_body := 'Stock has been reserved.';
        -- S2 (L86): approve_partial holds only what is free, which may be
        -- nothing. Say so when any item is held for less than the order
        -- still owes for it, and say nothing is held when no hold is.
        if exists (
          select 1
            from public.order_request_lines l
           where l.order_request_id = new.id
           group by l.item_id
          having sum(greatest(coalesce(l.quantity_requested, 0) - coalesce(l.quantity_fulfilled, 0), 0))
                 > coalesce((select sum(r.quantity)
                               from public.stock_reservations r
                              where r.order_request_id = new.id
                                and r.item_id = l.item_id
                                and r.released_at is null), 0)
        ) then
          if exists (select 1
                       from public.stock_reservations r
                      where r.order_request_id = new.id
                        and r.released_at is null
                        and r.quantity > 0) then
            v_body := 'Part of your order is held; the rest is waiting for stock.';
          else
            v_body := 'Nothing is held yet; your order is waiting for stock.';
          end if;
        end if;
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
$function$;

-- ═══ L8. The ledger wrappers answer to the app's permission ═══
-- Each: the 0359 wrapper body with one gate before the flag is raised.

-- adjust_stock: restated from 0359_ledger_flag_carriers.sql; md5(prosrc) c8cdaf566ec1ed69b8e9ae56791822da -> 329b71a0add8df3e1a13bdd609e7e652.
CREATE OR REPLACE FUNCTION public.adjust_stock(p_item_id uuid, p_quantity_change numeric, p_movement_type text, p_location_id uuid DEFAULT NULL::uuid, p_reason text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_mode text DEFAULT 'placed'::text)
 RETURNS inventory_items
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_prev text := current_setting('stockpilot.ledger', true);
  v_row  public.inventory_items;
begin
  -- S2 (L8): a direct call answers to the permission the app checks
  -- first (stock:adjust). Only an API role's own call is held here: a call
  -- made inside another ledger call of this transaction was answered by
  -- that call, and the order functions run as postgres. A row the caller
  -- cannot read is left to the body, which refuses it as before.
  if current_user in ('authenticated', 'anon')
     and not ledger.active()
     and exists (select 1
                   from public.inventory_items x
                  where x.id = p_item_id
                    and not public.has_permission(x.organization_id, 'stock:adjust')) then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'permission',
            detail  = 'Adjusting stock needs the stock:adjust permission.';
  end if;
  perform set_config('stockpilot.ledger', pg_current_xact_id()::text, true);
  v_row := ledger.adjust_stock(
    p_item_id, p_quantity_change, p_movement_type, p_location_id, p_reason, p_notes, p_mode);
  perform set_config('stockpilot.ledger', coalesce(v_prev, ''), true);
  return v_row;
end;
$function$;

comment on function public.adjust_stock(uuid, numeric, text, uuid, text, text, text) is
  'Stock-ledger RPC (0359 wrapper): raises stockpilot.ledger for the call, runs ledger.adjust_stock as the caller, then restores the previous value. Name, signature, return type, INVOKER and grants are frozen: installed phones call it. Since 0395 an API role''s direct call needs stock:adjust (42501 forbidden, hint permission); a call made inside another ledger call of the same transaction is not asked again.';

-- transfer_stock: restated from 0359_ledger_flag_carriers.sql; md5(prosrc) 849690c9313d2d8abfc70eb2b3120d90 -> a95dbf8d8fc9e0450aa5a2d733197843.
CREATE OR REPLACE FUNCTION public.transfer_stock(p_item_id uuid, p_from_location_id uuid, p_to_location_id uuid, p_quantity numeric, p_notes text DEFAULT NULL::text)
 RETURNS inventory_items
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_prev text := current_setting('stockpilot.ledger', true);
  v_row  public.inventory_items;
begin
  -- S2 (L8): a direct call answers to the permission the app checks
  -- first (stock:transfer). Only an API role's own call is held here: a call
  -- made inside another ledger call of this transaction was answered by
  -- that call, and the order functions run as postgres. A row the caller
  -- cannot read is left to the body, which refuses it as before.
  if current_user in ('authenticated', 'anon')
     and not ledger.active()
     and exists (select 1
                   from public.inventory_items x
                  where x.id = p_item_id
                    and not public.has_permission(x.organization_id, 'stock:transfer')) then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'permission',
            detail  = 'Moving stock needs the stock:transfer permission.';
  end if;
  perform set_config('stockpilot.ledger', pg_current_xact_id()::text, true);
  v_row := ledger.transfer_stock(
    p_item_id, p_from_location_id, p_to_location_id, p_quantity, p_notes);
  perform set_config('stockpilot.ledger', coalesce(v_prev, ''), true);
  return v_row;
end;
$function$;

comment on function public.transfer_stock(uuid, uuid, uuid, numeric, text) is
  'Stock-ledger RPC (0359 wrapper): raises stockpilot.ledger for the call, runs ledger.transfer_stock as the caller, then restores the previous value. Name, signature, return type, INVOKER and grants are frozen: installed phones call it. Since 0395 an API role''s direct call needs stock:transfer (42501 forbidden, hint permission); a call made inside another ledger call of the same transaction is not asked again.';

-- post_cycle_count: restated from 0359_ledger_flag_carriers.sql; md5(prosrc) ecc566f4079270480df1d9504358ea73 -> b6b00e4d720aad8032a76ec122c4612c.
CREATE OR REPLACE FUNCTION public.post_cycle_count(p_cycle_count_id uuid)
 RETURNS cycle_counts
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_prev text := current_setting('stockpilot.ledger', true);
  v_row  public.cycle_counts;
begin
  -- S2 (L8): a direct call answers to the permission the app checks
  -- first (stock:adjust). Only an API role's own call is held here: a call
  -- made inside another ledger call of this transaction was answered by
  -- that call, and the order functions run as postgres. A row the caller
  -- cannot read is left to the body, which refuses it as before.
  if current_user in ('authenticated', 'anon')
     and not ledger.active()
     and exists (select 1
                   from public.cycle_counts x
                  where x.id = p_cycle_count_id
                    and not public.has_permission(x.organization_id, 'stock:adjust')) then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'permission',
            detail  = 'Posting a count needs the stock:adjust permission.';
  end if;
  perform set_config('stockpilot.ledger', pg_current_xact_id()::text, true);
  v_row := ledger.post_cycle_count(p_cycle_count_id);
  perform set_config('stockpilot.ledger', coalesce(v_prev, ''), true);
  return v_row;
end;
$function$;

comment on function public.post_cycle_count(uuid) is
  'Stock-ledger RPC (0359 wrapper): raises stockpilot.ledger for the call, runs ledger.post_cycle_count as the caller, then restores the previous value. Name, signature, return type, INVOKER and grants are frozen: installed phones call it. Since 0395 an API role''s direct call needs stock:adjust (42501 forbidden, hint permission); a call made inside another ledger call of the same transaction is not asked again.';

-- assemble_bundle: restated from 0359_ledger_flag_carriers.sql; md5(prosrc) 7b3f769cb33ef6767557e0b9c4377ddb -> bcc4fbe7461ba3c02b5e0c2d18988fcf.
CREATE OR REPLACE FUNCTION public.assemble_bundle(p_bundle_id uuid, p_quantity numeric, p_warehouse_id uuid, p_notes text DEFAULT NULL::text)
 RETURNS TABLE(phantom_item_id uuid, phantom_qty numeric)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_prev text := current_setting('stockpilot.ledger', true);
begin
  -- S2 (L8): a direct call answers to the permission the app checks
  -- first (bundles:manage). Only an API role's own call is held here: a call
  -- made inside another ledger call of this transaction was answered by
  -- that call, and the order functions run as postgres. A row the caller
  -- cannot read is left to the body, which refuses it as before.
  if current_user in ('authenticated', 'anon')
     and not ledger.active()
     and exists (select 1
                   from public.bundles x
                  where x.id = p_bundle_id
                    and not public.has_permission(x.organization_id, 'bundles:manage')) then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'permission',
            detail  = 'Assembling a kit needs the bundles:manage permission.';
  end if;
  perform set_config('stockpilot.ledger', pg_current_xact_id()::text, true);
  -- RETURN QUERY runs the body to completion before the next line, so the
  -- flag is restored only after every write inside it has happened.
  return query
    select b.phantom_item_id, b.phantom_qty
      from ledger.assemble_bundle(p_bundle_id, p_quantity, p_warehouse_id, p_notes) b;
  perform set_config('stockpilot.ledger', coalesce(v_prev, ''), true);
  return;
end;
$function$;

comment on function public.assemble_bundle(uuid, numeric, uuid, text) is
  'Stock-ledger RPC (0359 wrapper): raises stockpilot.ledger for the call, runs ledger.assemble_bundle as the caller, then restores the previous value. Name, signature, return type, INVOKER and grants are frozen: installed phones call it. Since 0395 an API role''s direct call needs bundles:manage (42501 forbidden, hint permission); a call made inside another ledger call of the same transaction is not asked again.';

-- post_receipt_v2: restated from 0359_ledger_flag_carriers.sql; md5(prosrc) efc01e2e0ea98531c92c7db27f17695c -> 15f5db367d297a58acc1065bae4ffe69.
CREATE OR REPLACE FUNCTION public.post_receipt_v2(p_purchase_order_id uuid, p_warehouse_id uuid, p_lines jsonb, p_idempotency_key text, p_request_hash text, p_notes text DEFAULT NULL::text)
 RETURNS receipts
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_prev text := current_setting('stockpilot.ledger', true);
  v_row  public.receipts;
begin
  -- S2 (L8): a direct call answers to the permission the app checks
  -- first (stock:adjust). Only an API role's own call is held here: a call
  -- made inside another ledger call of this transaction was answered by
  -- that call, and the order functions run as postgres. A row the caller
  -- cannot read is left to the body, which refuses it as before.
  if current_user in ('authenticated', 'anon')
     and not ledger.active()
     and exists (select 1
                   from public.purchase_orders x
                  where x.id = p_purchase_order_id
                    and not public.has_permission(x.organization_id, 'stock:adjust')) then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'permission',
            detail  = 'Posting a receipt needs the stock:adjust permission.';
  end if;
  perform set_config('stockpilot.ledger', pg_current_xact_id()::text, true);
  v_row := ledger.post_receipt_v2(
    p_purchase_order_id, p_warehouse_id, p_lines, p_idempotency_key, p_request_hash, p_notes);
  perform set_config('stockpilot.ledger', coalesce(v_prev, ''), true);
  return v_row;
end;
$function$;

comment on function public.post_receipt_v2(uuid, uuid, jsonb, text, text, text) is
  'Stock-ledger RPC (0359 wrapper): raises stockpilot.ledger for the call, runs ledger.post_receipt_v2 as the caller, then restores the previous value. Name, signature, return type, INVOKER and grants are frozen: installed phones call it. Since 0395 an API role''s direct call needs stock:adjust (42501 forbidden, hint permission); a call made inside another ledger call of the same transaction is not asked again.';

-- reverse_receipt: restated from 0359_ledger_flag_carriers.sql; md5(prosrc) e277d737103a5cb561860c229f6631e7 -> f2f13dc2951ad3a5de4aaf034487cac9.
CREATE OR REPLACE FUNCTION public.reverse_receipt(p_receipt_id uuid, p_reason text)
 RETURNS receipts
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_prev text := current_setting('stockpilot.ledger', true);
  v_row  public.receipts;
begin
  -- S2 (L8): a direct call answers to the permission the app checks
  -- first (stock:adjust). Only an API role's own call is held here: a call
  -- made inside another ledger call of this transaction was answered by
  -- that call, and the order functions run as postgres. A row the caller
  -- cannot read is left to the body, which refuses it as before.
  if current_user in ('authenticated', 'anon')
     and not ledger.active()
     and exists (select 1
                   from public.receipts x
                  where x.id = p_receipt_id
                    and not public.has_permission(x.organization_id, 'stock:adjust')) then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'permission',
            detail  = 'Reversing a receipt needs the stock:adjust permission.';
  end if;
  perform set_config('stockpilot.ledger', pg_current_xact_id()::text, true);
  v_row := ledger.reverse_receipt(p_receipt_id, p_reason);
  perform set_config('stockpilot.ledger', coalesce(v_prev, ''), true);
  return v_row;
end;
$function$;

comment on function public.reverse_receipt(uuid, text) is
  'Stock-ledger RPC (0359 wrapper): raises stockpilot.ledger for the call, runs ledger.reverse_receipt as the caller, then restores the previous value. Name, signature, return type, INVOKER and grants are frozen: installed phones call it. Since 0395 an API role''s direct call needs stock:adjust (42501 forbidden, hint permission); a call made inside another ledger call of the same transaction is not asked again.';

-- ═══ L15. An item that holds stock is never soft-deleted ═══
-- SECURITY DEFINER on purpose: the holdings are read past the caller's row
-- level security, so a caller who cannot see a warehouse's holdings still
-- cannot delete the stock they hold. It reads only and decides only from the
-- row being deleted. It is a separate trigger from tg_inventory_items_guard,
-- whose pins (0359, 0364) do not move. EXECUTE is revoked from every API role
-- (a trigger needs none to fire).
create or replace function public.tg_inventory_items_no_delete_with_stock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- The trigger's WHEN clause fires this only when deleted_at goes from null
  -- to a value: a deleted row's other updates, and an undelete, never reach it.
  if new.quantity_on_hand <> 0
     or exists (select 1
                  from public.item_stock_levels l
                 where l.item_id = new.id
                   and l.quantity <> 0) then
    raise exception 'item_holds_stock'
      using errcode = '23514',
            hint    = 'item_holds_stock',
            detail  = 'An item is deleted only once it has no stock on record and none on any location. Adjust its stock to zero or write it off first.';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_inventory_items_no_delete_with_stock() from public, anon, authenticated, service_role;

comment on function public.tg_inventory_items_no_delete_with_stock() is
  'BEFORE UPDATE OF deleted_at guard (0395): refuses a soft delete (deleted_at null -> set) of an item whose quantity_on_hand is not 0 or that has any non-zero item_stock_levels row, for every role (23514, hint item_holds_stock). Reads only; SECURITY DEFINER so holdings the caller cannot see still count.';

-- ═══ The lock prelude (see LOCKS above) ═══
-- Every table lock the trigger and the two ALTER POLICY statements take, at
-- once and without waiting. Inside DO because the CLI batch is not a
-- transaction block (a top-level LOCK TABLE refuses there, 0373); the locks
-- last until the batch commits.
--   * inventory_items: SHARE ROW EXCLUSIVE (CREATE TRIGGER; it also covers the
--     lines policy's read of the table).
--   * order_request_lines and order_requests: ACCESS EXCLUSIVE (ALTER POLICY).
--   * every existing table supautils.policy_grants lists for this role, the
--     parent only of a partitioned one (supautils 3.4.0 takes ACCESS EXCLUSIVE
--     on each whenever this role runs ALTER POLICY; fixed upstream in #228).
-- A busy table fails the attempt at once; the rollback releases what it took
-- and the next attempt starts after 50 to 150 ms holding no table lock. After
-- the 40th busy attempt the 55P03 is raised as it is (never 40001/40P01) and
-- nothing in the file is applied.
do $lock$
declare
  v_grants text := nullif(current_setting('supautils.policy_grants', true), '');
  v_name   text;
  v_rel    regclass;
  v_try    integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.inventory_items in share row exclusive mode nowait;
      lock table only public.order_request_lines, public.order_requests in access exclusive mode nowait;
      if v_grants is not null then
        for v_name in
          select jsonb_array_elements_text(coalesce(v_grants::jsonb -> current_user::text, '[]'::jsonb))
        loop
          v_rel := to_regclass(v_name);
          if v_rel is not null then
            execute format('lock table only %s in access exclusive mode nowait', v_rel);
          end if;
        end loop;
      end if;
      exit;
    exception when lock_not_available then
      if v_try >= 40 then
        raise;
      end if;
    end;
    perform pg_sleep(0.05 + random() * 0.1);
  end loop;
end $lock$;

create or replace trigger trg_zz_inventory_items_no_delete_with_stock
  before update of deleted_at on public.inventory_items
  for each row
  when (old.deleted_at is null and new.deleted_at is not null)
  execute function public.tg_inventory_items_no_delete_with_stock();

-- ═══ L11. order_request_lines_insert never takes a kit ═══
-- 0390's text with one term added.
alter policy order_request_lines_insert on public.order_request_lines
  with check (
    exists (
      select 1
        from public.order_requests r
        join public.inventory_items ii
          on ii.id = order_request_lines.item_id
         and ii.organization_id = r.organization_id
       where r.id = order_request_lines.order_request_id
         and ((r.requester_user_id = (select auth.uid()))
              or (select public.has_permission(r.organization_id, 'orders:approve')))
         and ii.warehouse_id = r.warehouse_id
         -- 0363: the service's ship gate (loadEditableOrderHeader).
         and r.status not in ('in_transit', 'completed', 'denied', 'cancelled')
         -- 0395: never a kit (the service and place_order_request refuse one).
         and not coalesce(ii.is_bundle, false)
    )
  );

-- ═══ L129a. order_requests_update follows the order's warehouse ═══
-- 0390's text with one term added to USING and to WITH CHECK: write access to
-- the order's warehouse (WITH CHECK: the new row's), as the service asks
-- (requireWarehouseAccess 'write'). user_can_access_warehouse gives an owner,
-- admin or manager every warehouse of their organization with no assignment,
-- so no manager-by-role arm is needed (and 0390 keeps has_org_role out of
-- every policy that names orders:approve).
alter policy order_requests_update on public.order_requests
  using (
    ( SELECT public.has_permission(order_requests.organization_id, 'orders:approve') )
    and ( SELECT public.user_can_access_warehouse(( SELECT auth.uid() ), order_requests.warehouse_id, 'write') )
  )
  with check (
    ( SELECT public.has_permission(order_requests.organization_id, 'orders:approve') )
    and ( SELECT public.warehouse_in_org(order_requests.warehouse_id, order_requests.organization_id) )
    and ( SELECT public.charter_in_org(order_requests.delivery_charter_id, order_requests.organization_id) )
    and ( SELECT public.user_can_access_warehouse(( SELECT auth.uid() ), order_requests.warehouse_id, 'write') )
  );

reset lock_timeout;
