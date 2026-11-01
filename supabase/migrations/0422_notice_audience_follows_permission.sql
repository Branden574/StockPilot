-- 0422_notice_audience_follows_permission.sql
--
-- NOTICES FOLLOW THE PERMISSION AND THE MEMBERSHIP, NOT THE ROLE (docket S36,
-- part a). The migration number is provisional and set in ship order: it
-- appears only in this file's name, this line and the COMMENT strings, never
-- in a function body, so no fingerprint recorded here changes when the file
-- is renumbered.
--
-- ── WHY ────────────────────────────────────────────────────────────────────
-- The database can ask a permission question only about the caller:
-- has_permission(org, perm) reads auth.uid() (0310). No SQL function answered
-- "which members hold this permission", so the trigger writers kept the role
-- list from before configurable permissions: _notify_recipients is the
-- accepted owners, admins and managers (0313). The New order request alert
-- ('A request is waiting for approval.') used it on both of its paths. Since
-- 0390 approving follows orders:approve alone, an override winning either
-- way, and the app also asks write access to the request's warehouse
-- (OrderRequestsService.requireWarehouseAccess 'write'; slice E puts the same
-- term in the order functions). So:
--   * a manager or admin whose orders:approve was removed was still told about
--     every new request, although they could approve none of them;
--   * a staff member given orders:approve was never told about a request in a
--     warehouse they work in, and had to keep checking the Orders list.
-- And a support "Act as" seat (a real owner membership, accepted, with
-- impersonation_expires_at set, for 45 minutes) matched _notify_recipients,
-- so during a session the platform admin's own account received the
-- organization's notices, in the app and as a push. The app's recipient reads
-- already leave such a seat out (schedule-reminders, daily-briefing,
-- auto-reorder, recurring purchase orders, purchase order updated).
--
-- Separately, the person a notice names by a stored id was told with no
-- membership check: a purchase order's creator on every status change
-- (_notify_po_status, 0092) and every posted receipt (_notify_receipt_posted,
-- 0157), and an order's requester on its status changes
-- (_notify_order_request_changes, 0395; a replacement order's,
-- _notify_replacement_order_changes, 0396). Removing a member, or leaving,
-- deletes only the membership row: purchase_orders.created_by and
-- order_requests.requester_user_id stay, and notifications and push tokens
-- belong to the person, not the organization. So someone who had left kept
-- getting in-app rows and lock-screen pushes about the organization's
-- purchase orders and orders.
--
-- ── WHAT IT DOES ───────────────────────────────────────────────────────────
--   1. public._notify_recipients_with_permission(org, perm): the accepted
--      members of org who hold perm, resolved with has_permission's own
--      precedence (0310): the owner always; anyone else by their user
--      override, then their role's override, then their role's default.
--      Never an Act-as seat (live or expired), an invite not yet accepted or a
--      disabled account: a notice is not an authorization, and has_permission
--      admits a live seat. Nobody for a platform-managed key (0413): for those
--      an explicit deny also binds the owner, and no notice uses one.
--   2. public._notify_is_current_member(org, user): an accepted membership of
--      org that is not an Act-as seat, on an account that is not disabled;
--      _notify_recipients' own membership rule without its role list. False
--      for a null user.
--      Both new functions are SECURITY DEFINER and STABLE, with EXECUTE to
--      service_role only, as _notify_recipients since 0318: each is a roster
--      or membership oracle for any id. Their only callers are the notify
--      triggers, which are SECURITY DEFINER and reach them as their owner.
--   3. _notify_order_request_changes: the New order request alert, on insert
--      and on the move from pending_confirmation to pending_approval, goes to
--      everyone the resolver answers for orders:approve who may write in the
--      order's warehouse, user_can_access_warehouse(user, warehouse, 'write')
--      (0310): owners, admins and managers in every warehouse, staff in the
--      warehouses they are assigned to (a charter row counts; the 0280
--      all-warehouses flag keeps a row per warehouse), never a viewer, a
--      disabled account or an invite. The requester's status pings go to the
--      requester only while 2 holds. The body is 0395's, verbatim, except
--      those three places; the preference gates, the cancelled-after-approval
--      branch (still _notify_recipients) and every title and body are byte
--      for byte as they were.
--   4. _notify_recipients: one added line, `and om.impersonation_expires_at
--      is null`. Subtractive: every recipient it answered before, but an
--      Act-as seat. Its other callers (low or out of stock 0091, bundle
--      shortage 0042, purchase order status 0092, purchase order received
--      0157 and cancelled after approval) stop telling a seat too.
--   5. _notify_po_status and _notify_receipt_posted: the purchase order's
--      creator is told only while 2 holds. The owners, admins and managers
--      (_notify_recipients) and the push_po_status gate are unchanged.
--   6. _notify_replacement_order_changes: the replacement order's requester
--      is pinged only while 2 holds; nothing else changes.
--
-- ── WHO CHANGES ────────────────────────────────────────────────────────────
-- Staff members given orders:approve start getting the alert for requests in
-- their warehouses. An admin or manager whose orders:approve was removed
-- stops getting it (the release's read-only census counts both before the
-- push). A viewer given orders:approve is still never told: the app refuses
-- a viewer every write.
-- Someone removed from the organization, or who left it, stops getting the
-- notices this file writes about the purchase orders they created and the
-- orders they requested. So does a customer portal buyer, who is never a
-- member (0250): the portal has no notification list, and the buyer hears
-- about an order by email, which this file does not touch. The app writes
-- its own notices about such orders (a partial hand-over, backordered items
-- shipped, a line changed or removed by someone else, return events), all
-- through createNotification, and the same release limits that function to
-- current members by the same rule: neither half alone stops the notices. A
-- disabled account is no longer written an in-app row as a creator or
-- requester; its push was already suppressed (0313). Everyone who keeps
-- orders:approve by their role, every current member's own notices, and
-- every "New order requests" opt-out, are unchanged.
--
-- ── PARITY ─────────────────────────────────────────────────────────────────
-- The resolver restates has_permission's precedence for a subject other than
-- the caller. It must change whenever has_permission does; this file's pgTAP
-- suite (T2) compares the two for every persona and key it plants.
--
-- ── LOCKS ──────────────────────────────────────────────────────────────────
-- Functions and comments only. No table lock is taken on order_requests,
-- purchase_orders or receipts. Three bodies are plain SQL (the two new
-- functions and _notify_recipients), and checking a SQL body when it is
-- created (check_function_bodies, on by default) parses it, which takes
-- ACCESS SHARE on the tables it names (organization_members, user_profiles
-- and the three permission tables) until the file commits. ACCESS SHARE
-- conflicts only with ACCESS EXCLUSIVE, so no read, write, row lock or
-- autovacuum waits for it; only a held or queued ALTER TABLE, VACUUM FULL or
-- another migration on one of those tables makes the file wait, and
-- lock_timeout then ends it with 55P03 and nothing applied. The four plpgsql
-- bodies are checked for syntax only. COMMENT holds a
-- ShareUpdateExclusiveLock on its function (only other DDL on the same
-- function waits). A call already running finishes on the body it started
-- with, and a row written while the file runs is told by the old body until
-- the file commits. The lock footprint script beside the other migrations'
-- (scripts/db-concurrency/, this file's number) checks each of these.
--
-- ── GRANTS ─────────────────────────────────────────────────────────────────
-- No table, view or sequence is created, so no table GRANT is needed. Each
-- new function's EXECUTE is revoked from public, anon, authenticated and
-- service_role and granted to service_role only (the 0318 idiom). CREATE OR
-- REPLACE keeps the owner and the grants of the five restated functions
-- (_notify_recipients: service_role only since 0318; the four trigger
-- functions: no API-role EXECUTE since 0329 and 0396). No schema-wide GRANT,
-- no ALTER DEFAULT PRIVILEGES.
--
-- ── DATA SAFETY ────────────────────────────────────────────────────────────
-- No row is written, changed or removed. The preflight below stops the file
-- before any change unless every body it restates or relies on is the one it
-- was written against.
--
-- ── ERRORS ─────────────────────────────────────────────────────────────────
-- None new at run time: the two new functions are plain SQL with no raise;
-- the resolver answers nobody for a platform-managed key and the member
-- check answers false for a null user. The preflight raises 55000 with hint
-- notice_audience_preflight. Never 40001 or 40P01 (PostgREST retries those
-- forever).

set lock_timeout = '5s';

-- ═══ 0. Preflight ══════════════════════════════════════════════════════════
-- The five bodies restated here, and the two this file's new code calls,
-- must be the ones it was written against (main at 0414; production's md5s
-- are read again by the release kit before the push). Anything else is
-- drift: stop before changing anything.
do $preflight$
declare
  v_bad text := '';
  r record;
begin
  for r in
    select v.sig, v.want_src, p.oid as poid, md5(p.prosrc) as got_src, p.prosecdef as got_secdef,
           pg_get_userbyid(p.proowner) as got_owner
      from (values
        ('public._notify_order_request_changes()',           '438e676429dda6fb9d2b8faee8d6dd59'),
        ('public._notify_recipients(uuid)',                  '679e6193e3dbe5644055e835e8209043'),
        ('public._notify_po_status()',                       'e80cc4f94048040e8a9d7daf83179f60'),
        ('public._notify_receipt_posted()',                  '6fe68d1a1461d9d08cf69497f10dd070'),
        ('public._notify_replacement_order_changes()',       '543131721dbd9c04bb954b447e389972'),
        ('public.has_permission(uuid,text)',                 'cc0accdad7e2fdf4f88aa82aa887e85f'),
        ('public.user_can_access_warehouse(uuid,uuid,text)', '76b4170f3d393e8a1f293ca3d4895955')
      ) v(sig, want_src)
      left join pg_proc p on p.oid = to_regprocedure(v.sig)
  loop
    if r.poid is null then
      v_bad := v_bad || format(' %s missing;', r.sig);
    elsif r.got_src <> r.want_src or not r.got_secdef or r.got_owner <> 'postgres' then
      v_bad := v_bad || format(' %s drifted (md5 %s, definer %s, owner %s);', r.sig, r.got_src, r.got_secdef, r.got_owner);
    end if;
  end loop;

  if to_regprocedure('public._platform_managed_permissions()') is null then
    v_bad := v_bad || ' public._platform_managed_permissions() missing (push 0413 first);';
  end if;

  -- Already applied (or half applied by hand): the new names must be free.
  if to_regprocedure('public._notify_recipients_with_permission(uuid,text)') is not null then
    v_bad := v_bad || ' public._notify_recipients_with_permission(uuid,text) already exists;';
  end if;
  if to_regprocedure('public._notify_is_current_member(uuid,uuid)') is not null then
    v_bad := v_bad || ' public._notify_is_current_member(uuid,uuid) already exists;';
  end if;

  if v_bad <> '' then
    raise exception 'notice_audience_preflight: %', v_bad
      using errcode = '55000', hint = 'notice_audience_preflight';
  end if;
end
$preflight$;

-- ═══ 1. Who holds a permission ═════════════════════════════════════════════
-- has_permission's precedence (0310), for a subject other than the caller:
-- the owner always; else the user override, then the role override, then the
-- role default, else false. Keep it equal to has_permission: the parity test
-- (T2 of this file's suite) fails when they part.
create function public._notify_recipients_with_permission(p_org uuid, p_perm text)
returns table(user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select om.user_id
    from public.organization_members om
   where om.organization_id = p_org
     and om.accepted_at is not null
     and om.impersonation_expires_at is null
     and not exists (select 1 from public.user_profiles up
                      where up.id = om.user_id and up.disabled_at is not null)
     and not (p_perm = any (public._platform_managed_permissions()))
     and (om.role = 'owner' or coalesce(
           (select upo.granted from public.user_permission_overrides upo
             where upo.organization_id = p_org and upo.user_id = om.user_id
               and upo.permission = p_perm),
           (select rpo.granted from public.role_permission_overrides rpo
             where rpo.organization_id = p_org and rpo.role = om.role
               and rpo.permission = p_perm),
           exists (select 1 from public.role_default_permissions rdp
                    where rdp.role = om.role and rdp.permission = p_perm)))
$$;

revoke all on function public._notify_recipients_with_permission(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public._notify_recipients_with_permission(uuid, text) to service_role;

comment on function public._notify_recipients_with_permission(uuid, text) is
  'Who is told (0422): the accepted members of the organization who hold the permission, by has_permission''s '
  'precedence (0310): the owner always; anyone else by their user override, then their role''s override, then '
  'their role''s default. Never an Act-as seat (impersonation_expires_at set, live or expired), an invite not yet '
  'accepted or a disabled account: a notice is not an authorization. Nobody for a platform-managed key. Must change '
  'whenever has_permission does; the 0422 pgTAP suite pins the parity (T2). SECURITY DEFINER, EXECUTE to '
  'service_role only: a roster oracle for any organization id. Its only callers are the notify triggers, which '
  'are SECURITY DEFINER and reach it as its owner.';

-- ═══ 2. Who is still a member ══════════════════════════════════════════════
-- The person a notice names by a stored id (a purchase order's creator, an
-- order's requester) is told only while this holds. It is
-- _notify_recipients' membership rule (0313, and the Act-as line in section
-- 4) without the role list: a member of any role who created the purchase
-- order or placed the order is told about it, and nobody else is.
create function public._notify_is_current_member(p_org uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.organization_members om
     where om.organization_id = p_org
       and om.user_id = p_user
       and om.accepted_at is not null
       and om.impersonation_expires_at is null
       and not exists (select 1 from public.user_profiles up
                        where up.id = om.user_id and up.disabled_at is not null))
$$;

revoke all on function public._notify_is_current_member(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public._notify_is_current_member(uuid, uuid) to service_role;

comment on function public._notify_is_current_member(uuid, uuid) is
  'Is this person still a member who may be told (0422): an accepted membership of the organization that is not '
  'an Act-as seat, on an account that is not disabled (_notify_recipients'' membership rule without its role '
  'list). False for a null user. The purchase order and order notifiers ask it before telling the creator or the '
  'requester they stored: removing a member deletes only the membership row. SECURITY DEFINER, EXECUTE to '
  'service_role only: a membership oracle for any pair of ids. Its only callers are the notify triggers.';

-- ═══ 3. The New order request alert follows approving ═════════════════════
-- Three places change: the two loop sources, and the requester's status
-- pings, which now need the requester to be a current member (section 2).
-- pgTAP T7: putting 0395's texts back gives its md5 exactly. The third loop,
-- cancelled after approval, keeps _notify_recipients: owners, admins and
-- managers are told when an approver below manager rank cancels an approved
-- order.
-- _notify_order_request_changes: restated from 0395_order_stock_guards.sql; md5(prosrc) 438e676429dda6fb9d2b8faee8d6dd59 -> ca103ffa6669cdb7b885099c9a794fb5.
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
      select r.user_id
        from public._notify_recipients_with_permission(new.organization_id, 'orders:approve') r
       where public.user_can_access_warehouse(r.user_id, new.warehouse_id, 'write')
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
        select r.user_id
          from public._notify_recipients_with_permission(new.organization_id, 'orders:approve') r
         where public.user_can_access_warehouse(r.user_id, new.warehouse_id, 'write')
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
    if v_recipient is null
       -- The requester only while still a member of the organization:
       -- removing someone keeps requester_user_id, and a portal buyer
       -- never was a member.
       or not public._notify_is_current_member(new.organization_id, v_recipient) then
      return new;
    end if;

    -- Default-on pref gate (0092 pattern) for the requester's own status pings.
    case new.status
      when 'approved' then
        v_title := 'Your order request was approved';
        v_body := 'Stock has been reserved.';
        -- S2 (L86): approve_partial holds only what is free, which may be
        -- nothing. Say so when any item is held for less than the order
        -- still owes for it, and say nothing is reserved yet when no hold
        -- is. The requester's word is "reserved", as above.
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
            v_body := 'Part of your order is reserved; the rest is waiting for stock.';
          else
            v_body := 'Nothing is reserved yet; your order is waiting for stock.';
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

comment on function public._notify_order_request_changes() is
  'The order notifications (0422). New order request, on insert in any status but pending_confirmation and on the '
  'move from pending_confirmation to pending_approval: everyone who holds orders:approve '
  '(_notify_recipients_with_permission: overrides apply, never an Act-as seat, an invite or a disabled account) and '
  'may write in the order''s warehouse (user_can_access_warehouse write: owners, admins and managers in every '
  'warehouse, staff in their assigned ones, never a viewer), unless they turned New order requests off. Cancelled '
  'after approval, when an approver below manager rank cancels an approved order: the owners, admins and managers '
  '(_notify_recipients). Every other status change: the requester, under their own preferences, only while they '
  'are still a member (_notify_is_current_member). Replacement orders have their own trigger '
  '(_notify_replacement_order_changes, 0396).';

-- ═══ 4. No notice for an Act-as seat ══════════════════════════════════════
-- One added line; the rest is 0313's body byte for byte (pgTAP T7).
-- _notify_recipients: restated from 0313_stop_notifying_disabled_accounts.sql; md5(prosrc) 679e6193e3dbe5644055e835e8209043 -> 7b53d7d107211e42620800cb1de7d476.
create or replace function public._notify_recipients(p_org uuid)
returns table(user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select om.user_id
  from public.organization_members om
  where om.organization_id = p_org
    and om.accepted_at is not null
    and om.impersonation_expires_at is null
    and om.role in ('owner', 'admin', 'manager')
    and not exists (
      select 1 from public.user_profiles up
      where up.id = om.user_id and up.disabled_at is not null
    );
$$;

comment on function public._notify_recipients(uuid) is
  'The owners, admins and managers who are told an organization''s operational notices (low or out of stock, bundle '
  'shortage, purchase order status and received, an order cancelled after approval): accepted, not disabled (0313), '
  'and never an Act-as seat (0422). EXECUTE to service_role only (0318); its callers are SECURITY DEFINER triggers. '
  'The New order request alert uses _notify_recipients_with_permission instead (0422).';

-- ═══ 5. A purchase order's creator, only while a member ═══════════════════
-- One added clause in each: the creator's row of the recipient union now
-- needs _notify_is_current_member. The owners, admins and managers, the
-- push_po_status gate and every title and body are byte for byte as they
-- were (pgTAP T7 removes the added text and gets the old md5).
-- _notify_po_status: restated from 0092_notify_po_status_respect_pref.sql; md5(prosrc) e80cc4f94048040e8a9d7daf83179f60 -> fd39932ad6c3c21b3e4e8d19a219845c.
create or replace function public._notify_po_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  link_url text;
  notif_title text;
  notif_body text;
begin
  if old.status is null or new.status is null then
    return new;
  end if;
  if old.status = new.status then
    return new;
  end if;

  link_url := '/dashboard/purchase-orders/' || new.id::text;
  notif_title := 'PO ' || coalesce(new.po_number, new.id::text) ||
                 ' is now ' || new.status;
  notif_body := 'Status changed from ' || old.status || ' to ' || new.status || '.';

  for uid in
    select distinct u
    from (
      select new.created_by as u
       -- The creator only while still a member of the organization:
       -- removing someone, or their leaving, deletes only the membership row.
       where public._notify_is_current_member(new.organization_id, new.created_by)
      union
      select user_id from public._notify_recipients(new.organization_id)
    ) s
    where u is not null
  loop
    -- Honor the per-user push_po_status opt-out. Treat a missing prefs
    -- row as opt-in for backwards-compat with existing accounts that
    -- haven't touched the (currently unsurfaced) settings UI.
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
        'purchase_order.status_changed',
        notif_title,
        notif_body,
        link_url,
        jsonb_build_object(
          'po_id', new.id,
          'po_number', new.po_number,
          'from_status', old.status,
          'to_status', new.status
        )
      );
    end if;
  end loop;
  return new;
end;
$$;

comment on function public._notify_po_status() is
  'Purchase order status changed (0422): the purchase order''s creator while they are still a member of the '
  'organization (_notify_is_current_member), and the owners, admins and managers (_notify_recipients), once each, '
  'under each one''s push_po_status (no preferences row: on, 0092).';

-- _notify_receipt_posted: restated from 0157_notify_ready_intransit_and_po_received.sql; md5(prosrc) 6fe68d1a1461d9d08cf69497f10dd070 -> bddb6f437039c85464cf9de3f96cb86a.
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
       -- The creator only while still a member of the organization.
       where public._notify_is_current_member(new.organization_id, v_po.created_by)
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

comment on function public._notify_receipt_posted() is
  'Items received against a purchase order (0157, 0422): emits a po.received notification when a receipt becomes '
  'posted, to the purchase order''s creator while they are still a member of the organization '
  '(_notify_is_current_member) and to the owners, admins and managers (_notify_recipients), under push_po_status '
  '(default on). Receiving does not change purchase_orders.status on partial receipts, so _notify_po_status cannot '
  'cover it.';

-- ═══ 6. A replacement order's requester, only while a member ══════════════
-- One added clause in the requester check; the rest is 0396's body byte for
-- byte (pgTAP T7). CREATE OR REPLACE keeps 0396's grants (none to the API
-- roles) and both triggers' bindings.
-- _notify_replacement_order_changes: restated from 0396_returns_exchange_staff.sql; md5(prosrc) 543131721dbd9c04bb954b447e389972 -> 6bdc770d07726e3ee527562d395427e3.
create or replace function public._notify_replacement_order_changes()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_recipient uuid;
  v_title     text;
  v_body      text;
  v_pref_ok   boolean;
  v_rma       record;
  v_counter   boolean;
begin
  if tg_op = 'INSERT' or old.status is not distinct from new.status then
    return new;
  end if;
  if new.status not in ('staged_for_pickup', 'staged_for_delivery', 'in_transit', 'backordered', 'completed') then
    return new;
  end if;
  v_recipient := new.requester_user_id;
  if v_recipient is null
     -- The requester only while still a member of the organization:
     -- removing someone keeps requester_user_id, and a portal buyer
     -- never was a member.
     or not public._notify_is_current_member(new.organization_id, v_recipient) then
    return new;
  end if;
  select r.id, r.return_number, r.status into v_rma from public.returns r where r.id = new.replacement_for_return_id;
  -- At the counter the requester is standing there: "ready for pickup" is
  -- noise (plan 3.6.7, G11). A delivery still says it is ready or on its way.
  v_counter := exists (select 1 from public.return_decisions d
                        where d.return_id = new.replacement_for_return_id and d.kind = 'received' and d.channel = 'counter');
  if v_counter and new.status = 'staged_for_pickup' then
    return new;
  end if;

  case new.status
    when 'staged_for_pickup' then
      select coalesce(np.email_order_status_changed, true) into v_pref_ok
        from public.notification_preferences np where np.user_id = v_recipient;
      v_title := 'Your replacement is ready';
      v_body := 'Ready for pickup.';
    when 'staged_for_delivery' then
      select coalesce(np.email_order_status_changed, true) into v_pref_ok
        from public.notification_preferences np where np.user_id = v_recipient;
      v_title := 'Your replacement is ready';
      v_body := 'Ready for delivery.';
    when 'in_transit' then
      select coalesce(np.email_order_in_transit, true) into v_pref_ok
        from public.notification_preferences np where np.user_id = v_recipient;
      v_title := 'Your replacement is on the way';
      v_body := 'It''s out for delivery.';
    when 'backordered' then
      select coalesce(np.email_order_status_changed, true) into v_pref_ok
        from public.notification_preferences np where np.user_id = v_recipient;
      v_title := 'Part of your replacement was handed over';
      v_body := 'The rest will follow.';
    else
      -- completed: ungated, as the original body's completion ping. Closed
      -- with something never sent (delivered-partial; desk check F9) says so.
      v_pref_ok := true;
      if exists (select 1 from public.order_request_lines l
                  where l.order_request_id = new.id
                    and coalesce(l.quantity_requested, 0) > coalesce(l.quantity_fulfilled, 0)) then
        v_title := 'Your replacement order was closed';
        v_body := 'Part of it was handed over. The rest will not be sent.';
      elsif v_rma.status = 'closed' then
        v_title := 'Your exchange is complete';
        v_body := 'Your replacement was handed over and your return is done.';
      else
        v_title := 'Your replacement was handed over';
        v_body := 'Pickup or delivery is finalized.';
      end if;
  end case;
  if not coalesce(v_pref_ok, true) then
    return new;
  end if;

  insert into public.notifications (organization_id, user_id, type, title, body, link, metadata)
  values (new.organization_id, v_recipient, 'order_request.' || new.status, v_title, v_body,
          '/dashboard/orders/' || new.id::text,
          jsonb_build_object('order_request_id', new.id, 'warehouse_id', new.warehouse_id, 'source', new.source,
                             'requester_user_id', new.requester_user_id, 'requester_email', new.requester_email,
                             'return_id', v_rma.id, 'return_number', v_rma.return_number,
                             'replacement', true));
  return new;
end;
$$;

comment on function public._notify_replacement_order_changes() is
  'RX-2 (plan 3.6.7): the requester pings of a replacement order, with _notify_order_request_changes'' type strings, '
  'link and preference gates, reworded, and the RMA in the metadata: staged for pickup or delivery, in transit, '
  'backordered, completed ("Your exchange is complete" once the RMA is closed; "Your replacement order was closed" '
  'with "the rest will not be sent" when it closed with something never sent, desk check F9). Silent on insert, '
  'approval, cancellation, denial and the picking statuses, and on ready for pickup after a counter receipt. Staff '
  'are never pinged for a replacement. Since 0422 the requester is pinged only while still a member of the '
  'organization (_notify_is_current_member). SECURITY DEFINER, no EXECUTE.';

reset lock_timeout;
