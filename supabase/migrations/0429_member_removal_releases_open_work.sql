-- 0429_member_removal_releases_open_work.sql
--
-- B94 (owner go 2026-11-02, plans/B94.md): removing a member releases their
-- open work in the organization they leave, in the same transaction, the way
-- account deletion already does (0393's tg_auth_users_before_delete). The
-- number is PROVISIONAL: the kit assigns the final one.
--
-- THE PROBLEM. TeamService.removeMember deletes the membership row and never
-- touches cycle_counts or order_requests, and neither trigger on
-- organization_members releases anything (the role guard, 0393
-- _guard_organization_member_changes; the statement-level draw-scope clear,
-- 0373). So after Team's Remove:
--   * a count in progress still names the removed person: staff read
--     "Assigned to: Unassigned" (the profile is no longer readable), the
--     Unassigned filter misses it, and recording is refused because the
--     count "is assigned to another employee";
--   * an order they were picking reads "Being picked by someone" and other
--     pickers are refused;
--   * a delivery stays on them; it can be reassigned only while staged for
--     delivery.
-- Managers could release or reassign each one by hand, and nothing told them
-- to.
--
-- WHAT IT DOES
--   1. public.tg_organization_members_release_open_work(), fired AFTER DELETE
--      FOR EACH ROW on organization_members, releases the deleted row's
--      person's open work IN THAT ROW'S ORGANIZATION ONLY, with 0393's seven
--      predicates in 0393's order:
--        cycle counts in progress (assignee, claim time and claimer cleared,
--          assignment_version + 1);
--        picks at pick_slip_generated or picking_in_progress (picker and
--          claim cleared);
--        deliveries on any order not completed, cancelled or denied (driver,
--          assigned at and by cleared; in transit too, owner decision Q4: the
--          audit row keeps who held it);
--        schedule events scheduled or in progress;
--        the local owner of a maintenance request not resolved, cancelled or
--          archived;
--        an unresolved exception's escalation claim;
--        the manager of a warehouse.
--      Then it withdraws the invitations the person sent in THAT organization
--      that are not accepted and not revoked, with 0393's own predicate and
--      columns (revoked_at now, expires_at no later than a minute ago), so
--      an invitation a removed member sent cannot be accepted later; the
--      expired ones too, because a resend renews expires_at (the app now
--      refuses to resend or accept a withdrawn one too). Not for an
--      ended Act-as seat: a platform admin's invitation sent while acting is
--      support work for the organization and stays valid.
--      It never touches stock, a movement, a record's quantities or any other
--      organization. It writes one audit row per released count, pick,
--      delivery and maintenance request, then one user.open_work_released
--      summary with all seven numbers and pending_invites (the invitations
--      withdrawn), only when something was released or withdrawn.
--      Every row carries reason null (the order page prints a string reason
--      as "Reason: ...", and the app keeps reason for words a person typed)
--      and cause:
--        act_as_seat_ended  the row was an Act-as seat
--                           (impersonation_expires_at set: the stop and the
--                           sweep);
--        member_left        the deleted row is the caller's own (0140's
--                           delete policy lets a member leave);
--        member_removed     anything else (Team's Remove, the admin client).
--      user_id is the caller from the JWT (auth.uid()), never current_user:
--      inside a SECURITY DEFINER body current_user is the owner. It is null
--      for the admin client (no subject).
--      It covers every path that deletes a membership row: Team (the admin's
--      user client), a member leaving through the API, the Act-as stop and
--      sweep (admin client), and the two cascades, which it leaves alone:
--        * an organization being deleted: the organization row is gone
--          first, and an audit row naming it would fail audit_logs'
--          foreign key and stop the deletion, so the body returns first;
--        * an account being deleted: 0393's BEFORE trigger on auth.users has
--          already released everything, so the body returns when the
--          auth.users row is gone.
--      Keep those two returns FIRST in the body.
--   2. Trigger trg_organization_members_release_open_work. The BEFORE role
--      guard can still refuse first (an owner row through the API); then this
--      row trigger; then the statement-level trg_zz_forget_draw_scope. The
--      release changes only warehouses.manager_user_id on warehouses, so the
--      draw-scope trigger there (UPDATE OF id, organization_id) does not
--      fire.
--   3. public.member_open_work(p_member_id) returns jsonb: the same seven
--      numbers and pendingInvites (0 for an Act-as seat) for one membership
--      row, read before Remove is pressed (the Remove dialog names the
--      counts, picks and deliveries, and maintenance requests, warehouses
--      and invitations when there are any). pendingInvites counts only the
--      invitations still open (not expired either), the ones Team lists
--      under Pending invites; the release also withdraws expired ones no
--      admin can see, so the summary's pending_invites can be larger.
--      STABLE, SECURITY DEFINER,
--      EXECUTE for authenticated only. Refusals: 42501 unauthenticated (no
--      subject); P0002 member_not_found (no such row in an organization the
--      caller belongs to); 42501 forbidden unless the caller is an admin
--      (0140's delete policy floor) AND holds members:remove (the app's
--      gate) there.
--
-- PARITY (rule #26). The same seven predicates, and the invitation
-- predicate, now live in three places: 0393's tg_auth_users_before_delete,
-- this trigger and member_open_work. A change to one (a new order status, a
-- new kind of open work) changes all three; pgTAP C1b (the read equals the
-- release), C1c (the read's invitations are the release's still-open ones)
-- and PAR (the release equals account deletion's) fail otherwise.
--
-- NOT RELEASED: work already stranded on people removed before this file
-- (no bulk change; the read-only counts run before the push decide whether a
-- separate tier B item is needed). Not changed: the maintenance notify
-- audience, delivery GPS rows, and the warehouse
-- assignments and default organization that only Team's removeMember clears
-- (follow-ups for the self-leave and Act-as paths).
--
-- RESIDUAL RACE (documented in scripts/db-concurrency/0429_member_release_race.sh).
-- assign_cycle_count, force_reassign_cycle_count, assign_picking,
-- claim_picking and assign_order_delivery check membership without locking
-- the membership row, so an assignment that commits just after a removal can
-- still leave a row on a non-member: the state that exists today, and 0395
-- S2 keeps that case tested.
--
-- BUSY. The body runs with lock_timeout 5s. A count or order row held by a
-- long transaction makes the removal wait up to 5 s and then fail with 55P03,
-- and nothing is half done: the delete and the release are one transaction.
-- Team answers "Busy. Try again."; the Act-as stop and sweep leave the
-- session open so it is tried again.
--
-- GRANTS (Supabase stops auto-granting on 2026-10-30). This file creates no
-- table, view or sequence. EXECUTE on the trigger function is revoked from
-- public, anon, authenticated and service_role (a trigger function needs none
-- to fire). member_open_work: revoked from public, anon and service_role,
-- granted to authenticated.
--
-- LOCKS. CREATE TRIGGER takes SHARE ROW EXCLUSIVE on organization_members
-- until the file commits. The prelude takes it NOWAIT, retried up to 40 times
-- holding nothing between attempts, then 55P03 with nothing applied. Reads
-- and row locks (FOR SHARE, FOR NO KEY UPDATE) are not blocked by it;
-- membership writes wait for the commit. lock_timeout 900ms
-- (scripts/db-concurrency/0429_migration_lock_footprint.sh).
--
-- No row changes at push. Rows change only later, when someone is removed.
-- `create function` and `create trigger` (not `or replace`), so an existing
-- name stops the push. Never 40001 or 40P01.

set lock_timeout = '900ms';

do $b94_lock$
declare
  v_try integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.organization_members in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if v_try >= 40 then
        raise;
      end if;
    end;
    perform pg_sleep(0.05 + random() * 0.1);
  end loop;
end $b94_lock$;

-- ── 1. The release ──────────────────────────────────────────────────────────
create function public.tg_organization_members_release_open_work()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_org    uuid := old.organization_id;
  v_user   uuid := old.user_id;
  v_actor  uuid := auth.uid();
  v_cause  text;
  v_acting boolean := false;
  v_counts integer := 0;
  v_picks  integer := 0;
  v_drops  integer := 0;
  v_events integer := 0;
  v_mrs    integer := 0;
  v_claims integer := 0;
  v_whs    integer := 0;
  v_invs   integer := 0;
begin
  -- FIRST, and keep it first: the organization being deleted (its audit rows
  -- would fail audit_logs' key and stop the deletion) or the account being
  -- deleted (0393 already released everything) is left alone.
  if not exists (select 1 from public.organizations o where o.id = v_org)
     or not exists (select 1 from auth.users u where u.id = v_user) then
    return null;
  end if;

  -- Who, from the JWT and the deleted row itself; never current_user (the
  -- owner, inside this body).
  v_cause := case
    when old.impersonation_expires_at is not null then 'act_as_seat_ended'
    when v_actor is not null and v_actor = v_user then 'member_left'
    else 'member_removed'
  end;
  if v_actor is not null then
    v_acting := exists (select 1 from public.organization_members m
                         where m.organization_id = v_org and m.user_id = v_actor
                           and m.impersonation_expires_at is not null);
  end if;

  with r as (
    update public.cycle_counts c
       set assigned_to           = null,
           assignment_claimed_at = null,
           assignment_claimed_by = null,
           assignment_version    = c.assignment_version + 1
     where c.organization_id = v_org
       and c.assigned_to = v_user
       and c.status = 'in_progress'
    returning c.id, c.warehouse_id
  ), a as (
    insert into public.audit_logs (organization_id, user_id, event, metadata)
    select v_org, v_actor, 'cycle_count.released',
           jsonb_build_object('entity_type', 'cycle_count', 'entity_id', r.id, 'warehouse_id', r.warehouse_id,
                              'before', jsonb_build_object('assigned_to', v_user),
                              'after', jsonb_build_object('assigned_to', null),
                              'reason', null, 'cause', v_cause, 'released_user_id', v_user,
                              'membership_id', old.id, 'acting_as_platform', v_acting)
      from r
    returning 1
  )
  select count(*) into v_counts from a;

  with r as (
    update public.order_requests o
       set assigned_picker_id = null,
           picking_claimed_at = null,
           picking_claimed_by = null
     where o.organization_id = v_org
       and o.assigned_picker_id = v_user
       and o.status in ('pick_slip_generated', 'picking_in_progress')
    returning o.id, o.warehouse_id
  ), a as (
    insert into public.audit_logs (organization_id, user_id, event, metadata)
    select v_org, v_actor, 'order.picking_released',
           jsonb_build_object('entity_type', 'order_request', 'entity_id', r.id, 'warehouse_id', r.warehouse_id,
                              'before', jsonb_build_object('assigned_picker_id', v_user),
                              'after', jsonb_build_object('assigned_picker_id', null),
                              'reason', null, 'cause', v_cause, 'released_user_id', v_user,
                              'membership_id', old.id, 'acting_as_platform', v_acting)
      from r
    returning 1
  )
  select count(*) into v_picks from a;

  with r as (
    update public.order_requests o
       set assigned_delivery_user_id = null,
           assigned_delivery_at      = null,
           assigned_delivery_by      = null
     where o.organization_id = v_org
       and o.assigned_delivery_user_id = v_user
       and o.status not in ('completed', 'cancelled', 'denied')
    returning o.id, o.warehouse_id, o.status
  ), a as (
    insert into public.audit_logs (organization_id, user_id, event, metadata)
    select v_org, v_actor, 'order.delivery_unassigned',
           jsonb_build_object('entity_type', 'order_request', 'entity_id', r.id, 'warehouse_id', r.warehouse_id,
                              'before', jsonb_build_object('assigned_delivery_user_id', v_user),
                              'after', jsonb_build_object('assigned_delivery_user_id', null),
                              'status', r.status,
                              'reason', null, 'cause', v_cause, 'released_user_id', v_user,
                              'membership_id', old.id, 'acting_as_platform', v_acting)
      from r
    returning 1
  )
  select count(*) into v_drops from a;

  update public.schedule_events e
     set assigned_user_id = null
   where e.organization_id = v_org
     and e.assigned_user_id = v_user
     and e.status in ('scheduled', 'in_progress');
  get diagnostics v_events = row_count;

  with r as (
    update public.maintenance_requests q
       set local_owner_user_id = null
     where q.organization_id = v_org
       and q.local_owner_user_id = v_user
       and q.resolved_at is null
       and q.cancelled_at is null
       and q.archived_at is null
    returning q.id, q.warehouse_id
  ), a as (
    insert into public.audit_logs (organization_id, user_id, event, metadata)
    select v_org, v_actor, 'maintenance_request.owner_assigned',
           jsonb_build_object('entity_type', 'maintenance_request', 'entity_id', r.id, 'warehouse_id', r.warehouse_id,
                              'before', jsonb_build_object('local_owner_user_id', v_user),
                              'after', jsonb_build_object('local_owner_user_id', null),
                              'local_owner_user_id', null,
                              'reason', null, 'cause', v_cause, 'released_user_id', v_user,
                              'membership_id', old.id, 'acting_as_platform', v_acting)
      from r
    returning 1
  )
  select count(*) into v_mrs from a;

  update public.exception_occurrences x
     set escalation_claimed_by = null,
         escalation_claimed_at = null
   where x.organization_id = v_org
     and x.escalation_claimed_by = v_user
     and x.resolved_at is null;
  get diagnostics v_claims = row_count;

  update public.warehouses w
     set manager_user_id = null
   where w.organization_id = v_org
     and w.manager_user_id = v_user;
  get diagnostics v_whs = row_count;

  -- 0393's invitation predicate and columns, in this organization only; an
  -- ended Act-as seat's invitations stay (support work for the organization).
  if old.impersonation_expires_at is null then
    update public.organization_invites i
       set revoked_at = now(),
           expires_at = least(i.expires_at, now() - interval '1 minute')
     where i.organization_id = v_org
       and i.invited_by = v_user
       and i.accepted_at is null
       and i.revoked_at is null;
    get diagnostics v_invs = row_count;
  end if;

  if v_counts + v_picks + v_drops + v_events + v_mrs + v_claims + v_whs + v_invs > 0 then
    insert into public.audit_logs (organization_id, user_id, event, metadata)
    values (v_org, v_actor, 'user.open_work_released',
            jsonb_build_object('entity_type', 'organization_member', 'entity_id', old.id,
                               'warehouse_id', null, 'before', null, 'after', null,
                               'reason', null, 'cause', v_cause, 'released_user_id', v_user,
                               'membership_id', old.id,
                               'cycle_counts', v_counts, 'picks', v_picks, 'deliveries', v_drops,
                               'schedule_events', v_events, 'maintenance_requests', v_mrs,
                               'escalation_claims', v_claims, 'warehouses', v_whs,
                               'pending_invites', v_invs,
                               'acting_as_platform', v_acting));
  end if;

  return null;
end;
$$;

revoke all on function public.tg_organization_members_release_open_work() from public, anon, authenticated, service_role;

comment on function public.tg_organization_members_release_open_work() is
  '0429 (B94): after a membership row is deleted (Team''s Remove, a member leaving, an Act-as seat ended), releases '
  'that person''s open work in THAT organization only, in the same transaction: counts in progress (version + 1), '
  'picks, deliveries not completed, cancelled or denied, scheduled events, open maintenance local owner, unresolved '
  'escalation claims and warehouse manager, and withdraws the invitations the person sent there that are not accepted '
  'or revoked (not for an Act-as seat). Never stock, never another organization. Returns at once when the '
  'organization or the account is already gone (organization deletion; account deletion, which '
  'tg_auth_users_before_delete released). Audits each count, pick, delivery and maintenance request and one '
  'user.open_work_released summary (pending_invites: invitations withdrawn); reason null, cause member_removed, member_left or act_as_seat_ended; the actor '
  'is auth.uid(). PARITY: the same seven predicates and the invitation predicate live in tg_auth_users_before_delete '
  '(0393) and member_open_work; change all three together.';

-- ── 2. The trigger ──────────────────────────────────────────────────────────
create trigger trg_organization_members_release_open_work
  after delete on public.organization_members
  for each row execute function public.tg_organization_members_release_open_work();

comment on trigger trg_organization_members_release_open_work on public.organization_members is
  '0429 (B94): a deleted membership releases the person''s open work in that organization '
  '(tg_organization_members_release_open_work), on every path that deletes the row.';

-- ── 3. The Remove dialog's read ─────────────────────────────────────────────
create function public.member_open_work(p_member_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_org  uuid;
  v_user uuid;
  v_seat boolean;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  select m.organization_id, m.user_id, m.impersonation_expires_at is not null into v_org, v_user, v_seat
    from public.organization_members m
   where m.id = p_member_id;
  if v_org is null or not public.is_org_member(v_org) then
    raise exception 'member_not_found' using errcode = 'P0002';
  end if;
  if not (public.has_org_role(v_org, 'admin') and public.has_permission(v_org, 'members:remove')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'cycleCounts', (select count(*) from public.cycle_counts c
                     where c.organization_id = v_org and c.assigned_to = v_user and c.status = 'in_progress'),
    'picks', (select count(*) from public.order_requests o
               where o.organization_id = v_org and o.assigned_picker_id = v_user
                 and o.status in ('pick_slip_generated', 'picking_in_progress')),
    'deliveries', (select count(*) from public.order_requests o
                    where o.organization_id = v_org and o.assigned_delivery_user_id = v_user
                      and o.status not in ('completed', 'cancelled', 'denied')),
    'scheduleEvents', (select count(*) from public.schedule_events e
                        where e.organization_id = v_org and e.assigned_user_id = v_user
                          and e.status in ('scheduled', 'in_progress')),
    'maintenanceRequests', (select count(*) from public.maintenance_requests q
                             where q.organization_id = v_org and q.local_owner_user_id = v_user
                               and q.resolved_at is null and q.cancelled_at is null and q.archived_at is null),
    'escalationClaims', (select count(*) from public.exception_occurrences x
                          where x.organization_id = v_org and x.escalation_claimed_by = v_user
                            and x.resolved_at is null),
    'warehouses', (select count(*) from public.warehouses w
                    where w.organization_id = v_org and w.manager_user_id = v_user),
    'pendingInvites', case when v_seat then 0 else
                        (select count(*) from public.organization_invites i
                          where i.organization_id = v_org and i.invited_by = v_user
                            and i.accepted_at is null and i.revoked_at is null
                            and i.expires_at > now()) end);
end;
$$;

revoke all on function public.member_open_work(uuid) from public, anon, service_role;
grant execute on function public.member_open_work(uuid) to authenticated;

comment on function public.member_open_work(uuid) is
  '0429 (B94): what removing this membership would release, per kind (cycleCounts, picks, deliveries, '
  'scheduleEvents, maintenanceRequests, escalationClaims, warehouses), and the invitations it would withdraw '
  'that are still open (pendingInvites: not accepted, not revoked, not expired, as Team lists them; 0 for an Act-as '
  'seat; the release also withdraws expired ones), for the Remove dialog. Signed in; the row '
  'in an organization the caller belongs to (else P0002 member_not_found); admin there AND members:remove (else '
  '42501 forbidden). PARITY: the same seven predicates and the invitation predicate (plus expires_at > now() '
  'here) live in tg_organization_members_release_open_work and tg_auth_users_before_delete (0393); change all three together.';

reset lock_timeout;
