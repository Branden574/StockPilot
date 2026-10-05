-- 0394_account_deletion_for_everyone.sql
--
-- SECURITY slice A3: every member can delete their own account (owner
-- decision O-A2-3, 2026-10-03; A3-plan.md as corrected by its critique and the
-- orchestrator's decisions). Before this file 5 production accounts could not
-- be deleted: business-record keys to the person refused (RESTRICT or NO
-- ACTION), one SET NULL key sat on a NOT NULL column, and a NOT VALID CHECK
-- refused the SET NULL on 5 legacy orders.
--
--   1. The keys that refused become ON DELETE SET NULL: approvals.requested_by,
--      cycle_count_ai_scans.created_by, po_imports.uploaded_by,
--      putaway_moves.performed_by, receipts.received_by,
--      size_count_training_samples.captured_by (RESTRICT);
--      schedule_events.created_by and updated_by, returns (5 columns),
--      uom_conversions (2), org_connections.created_by,
--      organization_modules.enabled_by, carrier_shipments.purchased_by (NO
--      ACTION); organization_invites.invited_by moves from CASCADE to SET NULL
--      so accepted-invite history survives. Nine NOT NULL person columns lose
--      NOT NULL behind an exactly-one CHECK: the person is named, or the row's
--      deleted_users records that their account was deleted.
--   2. deleted_users jsonb ({column: when}) on those 14 tables plus audit_logs
--      and stock_movements (the narrow scope, orchestrator decision O-A3-1).
--      A trigger pair per table (zzz_deleted_users_ins/_upd, WHEN clauses, so
--      an ordinary write never calls the function) runs tg_mark_deleted_users
--      (SECURITY INVOKER), which stamps a column when a non-API role nulls it
--      because the account no longer exists (a foreign key action of an
--      account deletion). API roles can never set or clear a stamp; a stamp is
--      dropped when the column names a live person again. The app shows
--      "Deleted user" for a stamped column. Every other table's SET NULL key
--      is unchanged and keeps today's behaviour.
--   3. on_auth_user_before_delete (tg_auth_users_before_delete, SECURITY
--      DEFINER) runs before any cascade, on every path (web, phone, platform
--      console, the Supabase dashboard). It locks the person's membership rows
--      and the owner rows of the organizations they own, then refuses the
--      deletion of the only owner of an organization that has other members
--      (P0001, constraint organization_last_owner; an "Act as" impersonation
--      seat is neither an owner nor a member), then releases the person's open
--      work as the release functions do: counts in progress, open picks, open
--      deliveries, scheduled and in-progress schedule entries, open
--      maintenance requests, escalation claims and warehouse manager. Pending
--      invites the person sent, and those of an organization left with no
--      member, stop working; the person's id leaves the maintenance
--      notification audience. Released work reads as unassigned.
--   4. _enforce_schedule_events_writer reset created_by to its old value on
--      every update, which would have reverted the SET NULL and left a
--      dangling key; a null now stands when a non-API role nulls it and the
--      account is gone. Every other change of created_by is still undone.
--   5. transfer_org_ownership locks both membership rows (FOR UPDATE), ignores
--      impersonation seats, and checks that both updates happened, so a
--      transfer racing an account deletion cannot leave an organization with
--      members and no owner (critique C2).
--   6. F12: order_requests_delivery_target_chk was NOT VALID because 5 legacy
--      delivery orders (created 2026-05-12..15, before the rule) have no
--      charter (owner decision 2026-08-11: leave them as they are). Postgres
--      re-checks a NOT VALID CHECK on every update of a row, the foreign
--      key's SET NULL included, so their requester and approver could never
--      be deleted. The check is now VALIDATED and exactly as strict as before
--      for every other row: the legacy rows are exempt by primary key, and
--      only while they keep their legacy shape. Their data is not touched.
--      Why the primary key: authenticated may update created_at (owner Q4),
--      so a date cutoff could be re-dated into; id is neither insertable nor
--      updatable by an API role and no API role may delete an order
--      (order_requests_no_delete), so the five ids can never move to another
--      row. The exemption arm is never NULL (id is NOT NULL), so it changes
--      nothing for any other row.
--   7. New keys on person ids that had none: user_permission_overrides and
--      role_permission_overrides.updated_by, user_profiles.disabled_by (SET
--      NULL); order_submissions.user_id (0391) ON DELETE CASCADE: the person's
--      own submission log (part of the key, so it cannot be SET NULL; kept, it
--      would re-link a deleted person's id to the order 0388 un-links).
--      delivery_locations.driver_user_id moves from SET NULL to CASCADE: the
--      row is the driver's live GPS point, personal data (critique C4).
--
-- DATA: the file writes no row. Every new CHECK and key is validated against
-- the existing rows (the largest table it validates is
-- size_count_training_samples, 2,171 rows in production), and no row carries
-- deleted_users afterwards.
--
-- LOCKS: one prelude takes every table lock the file needs at once, NOWAIT,
-- in a bounded retry (the 0390/0391 pattern): ACCESS EXCLUSIVE on the 16
-- marked tables, order_requests (the CHECK swap), delivery_locations (key
-- swap), user_profiles (the key swaps drop and add RI triggers on it) and
-- auth.users (schedule_events' keys reference it; the new trigger); SHARE ROW
-- EXCLUSIVE on user_permission_overrides, role_permission_overrides and
-- order_submissions (a new key each). A busy table fails the attempt at once,
-- its subtransaction releases what it took, and the next attempt starts after
-- 50 to 150 ms holding nothing; after 40 busy attempts the file raises 55P03
-- and applies nothing. No later statement takes a lock on a new table, so the
-- file never waits while holding one (no deadlock with live traffic). The
-- locks are held from the successful attempt to commit (the DDL below; tens
-- of milliseconds), during which sign-ins and most requests wait: push
-- off-peak. scripts/db-concurrency/0394_migration_lock_footprint.sh.
--
-- ERRORS: P0001 (last_owner, from the trigger), 42501 and 22023 (transfer, as
-- before), 55P03 (the prelude). No function here raises 40001 or 40P01
-- (PostgREST retries those forever; 0367).

set lock_timeout = '900ms';

-- ═══ 0. The lock prelude (see LOCKS) ══════════════════════════════════════
-- Inside DO because the CLI batch is not a transaction block (a top-level
-- LOCK TABLE refuses there, as 0373 found); the locks last until the batch
-- commits.
do $lock$
declare
  v_try integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.order_requests, public.stock_movements, public.audit_logs,
                      public.approvals, public.cycle_count_ai_scans, public.po_imports,
                      public.putaway_moves, public.receipts, public.size_count_training_samples,
                      public.organization_invites, public.platform_admin_audit, public.returns,
                      public.uom_conversions, public.org_connections, public.organization_modules,
                      public.carrier_shipments, public.delivery_locations, public.user_profiles,
                      public.schedule_events, auth.users
        in access exclusive mode nowait;
      lock table only public.user_permission_overrides, public.role_permission_overrides,
                      public.order_submissions
        in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if v_try >= 40 then
        raise;
      end if;
    end;
    perform pg_sleep(0.05 + random() * 0.1);
  end loop;
end $lock$;

-- ═══ 1. Functions ═════════════════════════════════════════════════════════

create or replace function public._account_exists(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from auth.users u where u.id = p_user_id)
$$;
revoke all on function public._account_exists(uuid) from public, anon, authenticated;
grant execute on function public._account_exists(uuid) to service_role;

create or replace function public.tg_mark_deleted_users()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_api   boolean := current_user in ('authenticated', 'anon');
  v_marks jsonb;
  v_old   jsonb;
  v_new   jsonb;
  v_col   text;
begin
  if tg_op = 'INSERT' then
    if new.deleted_users is null then
      return new;
    end if;
    if v_api then
      new.deleted_users := null;
      return new;
    end if;
    v_marks := new.deleted_users;
  else
    v_marks := case when v_api then old.deleted_users else new.deleted_users end;
    v_old := to_jsonb(old);
  end if;

  v_new := to_jsonb(new);
  if v_marks is not null and jsonb_typeof(v_marks) = 'object' then
    select jsonb_object_agg(e.key, e.value) into v_marks
      from jsonb_each(v_marks) e
     where e.key = any (tg_argv)
       and v_new ->> e.key is null;
  else
    v_marks := null;
  end if;

  if tg_op = 'UPDATE' and not v_api then
    foreach v_col in array tg_argv loop
      if v_new ->> v_col is null and v_old ->> v_col is not null then
        if not public._account_exists((v_old ->> v_col)::uuid) then
          v_marks := coalesce(v_marks, '{}'::jsonb) || jsonb_build_object(v_col, now());
        end if;
      end if;
    end loop;
  end if;

  new.deleted_users := v_marks;
  return new;
end;
$$;
revoke all on function public.tg_mark_deleted_users() from public, anon, authenticated;

create or replace function public.tg_auth_users_before_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_orgs   uuid[];
  v_orphan uuid[];
begin
  perform 1
     from public.organization_members m
    where m.user_id = old.id
       or (m.role = 'owner'
           and m.organization_id in (select x.organization_id
                                       from public.organization_members x
                                      where x.user_id = old.id
                                        and x.role = 'owner'))
    order by m.id
    for no key update;

  select array_agg(m.organization_id order by m.organization_id)
    into v_orgs
    from public.organization_members m
   where m.user_id = old.id
     and m.role = 'owner'
     and m.accepted_at is not null
     and m.impersonation_expires_at is null
     and not exists (select 1 from public.organization_members o
                      where o.organization_id = m.organization_id
                        and o.user_id <> old.id
                        and o.role = 'owner'
                        and o.accepted_at is not null
                        and o.impersonation_expires_at is null)
     and exists (select 1 from public.organization_members o
                  where o.organization_id = m.organization_id
                    and o.user_id <> old.id
                    and o.accepted_at is not null
                    and o.impersonation_expires_at is null);
  if v_orgs is not null then
    raise exception 'last_owner'
      using errcode = 'P0001',
            constraint = 'organization_last_owner',
            schema = 'public',
            table = 'organization_members',
            detail = 'The account is the only owner of an organization that has other members.',
            hint = 'Transfer ownership before deleting the account.';
  end if;

  update public.cycle_counts
     set assigned_to = null,
         assignment_claimed_at = null,
         assignment_claimed_by = null,
         assignment_version = assignment_version + 1
   where assigned_to = old.id
     and status = 'in_progress';

  update public.order_requests
     set assigned_picker_id = null,
         picking_claimed_at = null,
         picking_claimed_by = null
   where assigned_picker_id = old.id
     and status in ('pick_slip_generated', 'picking_in_progress');

  update public.order_requests
     set assigned_delivery_user_id = null,
         assigned_delivery_at = null,
         assigned_delivery_by = null
   where assigned_delivery_user_id = old.id
     and status not in ('completed', 'cancelled', 'denied');

  update public.schedule_events
     set assigned_user_id = null
   where assigned_user_id = old.id
     and status in ('scheduled', 'in_progress');

  update public.maintenance_requests
     set local_owner_user_id = null
   where local_owner_user_id = old.id
     and resolved_at is null
     and cancelled_at is null
     and archived_at is null;

  update public.exception_occurrences
     set escalation_claimed_by = null,
         escalation_claimed_at = null
   where escalation_claimed_by = old.id
     and resolved_at is null;

  update public.warehouses
     set manager_user_id = null
   where manager_user_id = old.id;

  select array_agg(m.organization_id order by m.organization_id)
    into v_orphan
    from public.organization_members m
   where m.user_id = old.id
     and m.accepted_at is not null
     and m.impersonation_expires_at is null
     and not exists (select 1 from public.organization_members o
                      where o.organization_id = m.organization_id
                        and o.user_id <> old.id
                        and o.accepted_at is not null
                        and o.impersonation_expires_at is null);

  update public.organization_invites
     set revoked_at = now(),
         expires_at = least(expires_at, now() - interval '1 minute')
   where accepted_at is null
     and revoked_at is null
     and (invited_by = old.id or organization_id = any (coalesce(v_orphan, '{}'::uuid[])));

  update public.organization_modules
     set settings = jsonb_set(settings, '{notifyAudience}', (settings -> 'notifyAudience') - old.id::text)
   where jsonb_typeof(settings -> 'notifyAudience') in ('object', 'array')
     and (settings -> 'notifyAudience') ? old.id::text;

  return old;
end;
$$;
revoke all on function public.tg_auth_users_before_delete() from public, anon, authenticated;

create or replace function public._enforce_schedule_events_writer()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (tg_op = 'INSERT') then
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.updated_by := coalesce(auth.uid(), new.updated_by, new.created_by);
  elsif (tg_op = 'UPDATE') then
    if new.created_by is distinct from old.created_by then
      if new.created_by is not null or current_user in ('authenticated', 'anon') then
        new.created_by := old.created_by;
      elsif public._account_exists(old.created_by) then
        new.created_by := old.created_by;
      end if;
    end if;
    new.updated_by := coalesce(auth.uid(), new.updated_by);
  end if;
  return new;
end;
$$;
revoke all on function public._enforce_schedule_events_writer() from public, anon, authenticated;

create or replace function public.transfer_org_ownership(
  p_organization_id uuid,
  p_caller_user_id uuid,
  p_target_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_member_id uuid;
  v_target_member_id uuid;
  v_target_role text;
begin
  select id into v_caller_member_id
    from public.organization_members
   where organization_id = p_organization_id
     and user_id = p_caller_user_id
     and role = 'owner'
     and accepted_at is not null
     and impersonation_expires_at is null
   for update;
  if v_caller_member_id is null then
    raise exception 'caller is not the current owner'
      using errcode = 'insufficient_privilege';
  end if;

  if p_target_user_id = p_caller_user_id then
    raise exception 'cannot transfer ownership to yourself'
      using errcode = 'invalid_parameter_value';
  end if;

  select id, role into v_target_member_id, v_target_role
    from public.organization_members
   where organization_id = p_organization_id
     and user_id = p_target_user_id
     and accepted_at is not null
     and impersonation_expires_at is null
   for update;
  if v_target_member_id is null then
    raise exception 'target user is not an active member of this organization'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_target_role = 'owner' then
    raise exception 'target is already the owner'
      using errcode = 'invalid_parameter_value';
  end if;

  update public.organization_members
     set role = 'admin'
   where id = v_caller_member_id;
  if not found then
    raise exception 'caller is not the current owner'
      using errcode = 'insufficient_privilege';
  end if;

  update public.organization_members
     set role = 'owner'
   where id = v_target_member_id;
  if not found then
    raise exception 'target user is not an active member of this organization'
      using errcode = 'invalid_parameter_value';
  end if;

  return p_target_user_id;
end;
$$;
revoke all on function public.transfer_org_ownership(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.transfer_org_ownership(uuid, uuid, uuid) to service_role;

comment on function public._account_exists(uuid) is
  'Whether an auth account exists (0394). For tg_mark_deleted_users and _enforce_schedule_events_writer '
  '(service_role cannot read auth.users); EXECUTE for postgres and service_role only.';
comment on function public.tg_mark_deleted_users() is
  'zzz_deleted_users_ins/_upd (0394): stamps deleted_users {column: now()} when a non-API role nulls a '
  'person column whose account no longer exists (a foreign key action of an account deletion). API roles '
  'cannot set or clear a stamp; a stamp is dropped when the column names a live person again. Arguments: '
  'the table''s person columns. SECURITY INVOKER: an FK action runs as the table owner.';
comment on function public.tg_auth_users_before_delete() is
  'on_auth_user_before_delete (0394): locks the person''s membership rows and the owner rows of the '
  'organizations they own, refuses deleting the only owner of an organization that has other members '
  '(P0001, constraint organization_last_owner; impersonation seats are neither owners nor members), then '
  'releases the person''s open work as release_cycle_count and release_picking do, before any cascade: '
  'counts in progress, open picks, open deliveries, scheduled and in-progress schedule entries, open '
  'maintenance requests, escalation claims, warehouse manager. Pending invites the person sent, and those '
  'of an organization left with no member, stop working; the person''s id leaves notifyAudience.';
comment on function public._enforce_schedule_events_writer() is
  'Schedule writer (0084, 0256; 0394): created_by and updated_by follow the signed-in caller. created_by '
  'never changes on update, except that a null stands when a non-API role nulls it and the account is gone '
  '(the ON DELETE SET NULL of an account deletion); before 0394 the reset left a dangling key.';
comment on function public.transfer_org_ownership(uuid, uuid, uuid) is
  'Atomically transfers org ownership from p_caller_user_id to p_target_user_id and returns the new owner '
  'user_id (0107). Since 0394 it locks the caller''s and the target''s membership rows FOR UPDATE, ignores '
  'impersonation seats, and checks that both updates happened, so a transfer racing an account deletion or a '
  'second transfer cannot leave an organization with no owner. Service-role only: the application layer must '
  'verify the caller IS the owner (and require AAL2 and a password re-confirm) before invoking.';

-- ═══ 2. F12: the delivery target check, validated, legacy rows exempt ═════

alter table public.order_requests
  drop constraint order_requests_delivery_target_chk,
  add constraint order_requests_delivery_target_chk check (
    (fulfillment_type = 'delivery' and delivery_charter_id is not null)
    or (fulfillment_type = 'pickup' and delivery_charter_id is null)
    or (id = any ('{20ad4cb9-733e-4348-a4fd-074f43ce2025,5cf416da-e6ee-47a1-bbfd-34a473f920d4,76f4f559-3947-4f75-b389-1bde004bfcce,8827813a-b336-4b22-93f4-00134069a322,989b85ca-0e72-492b-af62-01340aab0219}'::uuid[])
        and fulfillment_type = 'delivery'
        and delivery_charter_id is null));
comment on constraint order_requests_delivery_target_chk on public.order_requests is
  'A delivery names its charter and a pickup names none (0110, 0254). Validated since 0394: the 5 legacy '
  'delivery orders created 2026-05-12..15 without a charter (owner decision 2026-08-11: left as they are) '
  'are exempt by primary key, only while they keep that shape; every other row is held to the rule.';

-- ═══ 3. The marker on the two log tables (no key change) ══════════════════

alter table public.stock_movements add column deleted_users jsonb;
create trigger zzz_deleted_users_ins before insert on public.stock_movements
  for each row when (new.deleted_users is not null)
  execute function public.tg_mark_deleted_users('user_id');
create trigger zzz_deleted_users_upd before update on public.stock_movements
  for each row when (old.deleted_users is not null or new.deleted_users is not null
                     or (old.user_id is not null and new.user_id is null))
  execute function public.tg_mark_deleted_users('user_id');

alter table public.audit_logs add column deleted_users jsonb;
create trigger zzz_deleted_users_ins before insert on public.audit_logs
  for each row when (new.deleted_users is not null)
  execute function public.tg_mark_deleted_users('user_id');
create trigger zzz_deleted_users_upd before update on public.audit_logs
  for each row when (old.deleted_users is not null or new.deleted_users is not null
                     or (old.user_id is not null and new.user_id is null))
  execute function public.tg_mark_deleted_users('user_id');

-- ═══ 4. The keys that refused: RESTRICT -> SET NULL, NOT NULL relaxed ═════

alter table public.approvals
  drop constraint approvals_requested_by_fkey,
  add constraint approvals_requested_by_fkey foreign key (requested_by)
    references public.user_profiles(id) on delete set null,
  alter column requested_by drop not null,
  add column deleted_users jsonb,
  add constraint approvals_requested_by_deleted_chk
    check ((requested_by is not null) <> coalesce(deleted_users ? 'requested_by', false));
create trigger zzz_deleted_users_ins before insert on public.approvals
  for each row when (new.deleted_users is not null)
  execute function public.tg_mark_deleted_users('decided_by', 'requested_by');
create trigger zzz_deleted_users_upd before update on public.approvals
  for each row when (old.deleted_users is not null or new.deleted_users is not null
                     or (old.decided_by is not null and new.decided_by is null)
                     or (old.requested_by is not null and new.requested_by is null))
  execute function public.tg_mark_deleted_users('decided_by', 'requested_by');

alter table public.cycle_count_ai_scans
  drop constraint cycle_count_ai_scans_created_by_fkey,
  add constraint cycle_count_ai_scans_created_by_fkey foreign key (created_by)
    references public.user_profiles(id) on delete set null,
  alter column created_by drop not null,
  add column deleted_users jsonb,
  add constraint cycle_count_ai_scans_created_by_deleted_chk
    check ((created_by is not null) <> coalesce(deleted_users ? 'created_by', false)),
  drop constraint cc_ai_scans_confirm_chk,
  add constraint cc_ai_scans_confirm_chk check (
    (confirmed_at is null and confirmed_by is null)
    or (confirmed_at is not null
        and (confirmed_by is not null or coalesce(deleted_users ? 'confirmed_by', false))));
create trigger zzz_deleted_users_ins before insert on public.cycle_count_ai_scans
  for each row when (new.deleted_users is not null)
  execute function public.tg_mark_deleted_users('confirmed_by', 'created_by');
create trigger zzz_deleted_users_upd before update on public.cycle_count_ai_scans
  for each row when (old.deleted_users is not null or new.deleted_users is not null
                     or (old.confirmed_by is not null and new.confirmed_by is null)
                     or (old.created_by is not null and new.created_by is null))
  execute function public.tg_mark_deleted_users('confirmed_by', 'created_by');

alter table public.po_imports
  drop constraint po_imports_uploaded_by_fkey,
  add constraint po_imports_uploaded_by_fkey foreign key (uploaded_by)
    references public.user_profiles(id) on delete set null,
  alter column uploaded_by drop not null,
  add column deleted_users jsonb,
  add constraint po_imports_uploaded_by_deleted_chk
    check ((uploaded_by is not null) <> coalesce(deleted_users ? 'uploaded_by', false));
create trigger zzz_deleted_users_ins before insert on public.po_imports
  for each row when (new.deleted_users is not null)
  execute function public.tg_mark_deleted_users('approved_by', 'uploaded_by');
create trigger zzz_deleted_users_upd before update on public.po_imports
  for each row when (old.deleted_users is not null or new.deleted_users is not null
                     or (old.approved_by is not null and new.approved_by is null)
                     or (old.uploaded_by is not null and new.uploaded_by is null))
  execute function public.tg_mark_deleted_users('approved_by', 'uploaded_by');

alter table public.putaway_moves
  drop constraint putaway_moves_performed_by_fkey,
  add constraint putaway_moves_performed_by_fkey foreign key (performed_by)
    references public.user_profiles(id) on delete set null,
  alter column performed_by drop not null,
  add column deleted_users jsonb,
  add constraint putaway_moves_performed_by_deleted_chk
    check ((performed_by is not null) <> coalesce(deleted_users ? 'performed_by', false));
create trigger zzz_deleted_users_ins before insert on public.putaway_moves
  for each row when (new.deleted_users is not null)
  execute function public.tg_mark_deleted_users('performed_by');
create trigger zzz_deleted_users_upd before update on public.putaway_moves
  for each row when (old.deleted_users is not null or new.deleted_users is not null
                     or (old.performed_by is not null and new.performed_by is null))
  execute function public.tg_mark_deleted_users('performed_by');

alter table public.receipts
  drop constraint receipts_received_by_fkey,
  add constraint receipts_received_by_fkey foreign key (received_by)
    references public.user_profiles(id) on delete set null,
  alter column received_by drop not null,
  add column deleted_users jsonb,
  add constraint receipts_received_by_deleted_chk
    check ((received_by is not null) <> coalesce(deleted_users ? 'received_by', false));
create trigger zzz_deleted_users_ins before insert on public.receipts
  for each row when (new.deleted_users is not null)
  execute function public.tg_mark_deleted_users('received_by');
create trigger zzz_deleted_users_upd before update on public.receipts
  for each row when (old.deleted_users is not null or new.deleted_users is not null
                     or (old.received_by is not null and new.received_by is null))
  execute function public.tg_mark_deleted_users('received_by');

alter table public.size_count_training_samples
  drop constraint size_count_training_samples_captured_by_fkey,
  add constraint size_count_training_samples_captured_by_fkey foreign key (captured_by)
    references public.user_profiles(id) on delete set null,
  alter column captured_by drop not null,
  add column deleted_users jsonb,
  add constraint size_count_training_samples_captured_by_deleted_chk
    check ((captured_by is not null) <> coalesce(deleted_users ? 'captured_by', false));
create trigger zzz_deleted_users_ins before insert on public.size_count_training_samples
  for each row when (new.deleted_users is not null)
  execute function public.tg_mark_deleted_users('captured_by');
create trigger zzz_deleted_users_upd before update on public.size_count_training_samples
  for each row when (old.deleted_users is not null or new.deleted_users is not null
                     or (old.captured_by is not null and new.captured_by is null))
  execute function public.tg_mark_deleted_users('captured_by');

-- invited_by: CASCADE -> SET NULL. Pending invites the person sent are
-- expired by on_auth_user_before_delete; the rows and accepted history stay.
alter table public.organization_invites
  drop constraint organization_invites_invited_by_fkey,
  add constraint organization_invites_invited_by_fkey foreign key (invited_by)
    references public.user_profiles(id) on delete set null,
  alter column invited_by drop not null,
  add column deleted_users jsonb,
  add constraint organization_invites_invited_by_deleted_chk
    check ((invited_by is not null) <> coalesce(deleted_users ? 'invited_by', false));
create trigger zzz_deleted_users_ins before insert on public.organization_invites
  for each row when (new.deleted_users is not null)
  execute function public.tg_mark_deleted_users('invited_by');
create trigger zzz_deleted_users_upd before update on public.organization_invites
  for each row when (old.deleted_users is not null or new.deleted_users is not null
                     or (old.invited_by is not null and new.invited_by is null))
  execute function public.tg_mark_deleted_users('invited_by');

-- actor_user_id was SET NULL on a NOT NULL column (always 23502). actor_email
-- (NOT NULL) is kept: the platform audit still says who acted.
alter table public.platform_admin_audit
  alter column actor_user_id drop not null,
  add column deleted_users jsonb,
  add constraint platform_admin_audit_actor_user_id_deleted_chk
    check ((actor_user_id is not null) <> coalesce(deleted_users ? 'actor_user_id', false));
create trigger zzz_deleted_users_ins before insert on public.platform_admin_audit
  for each row when (new.deleted_users is not null)
  execute function public.tg_mark_deleted_users('actor_user_id', 'target_user_id');
create trigger zzz_deleted_users_upd before update on public.platform_admin_audit
  for each row when (old.deleted_users is not null or new.deleted_users is not null
                     or (old.actor_user_id is not null and new.actor_user_id is null)
                     or (old.target_user_id is not null and new.target_user_id is null))
  execute function public.tg_mark_deleted_users('actor_user_id', 'target_user_id');

-- ═══ 5. NO ACTION -> SET NULL on nullable columns (no CHECK) ═════════════

alter table public.returns
  drop constraint returns_approved_by_fkey,
  drop constraint returns_closed_by_fkey,
  drop constraint returns_denied_by_fkey,
  drop constraint returns_received_by_fkey,
  drop constraint returns_requested_by_fkey,
  add constraint returns_approved_by_fkey foreign key (approved_by)
    references public.user_profiles(id) on delete set null,
  add constraint returns_closed_by_fkey foreign key (closed_by)
    references public.user_profiles(id) on delete set null,
  add constraint returns_denied_by_fkey foreign key (denied_by)
    references public.user_profiles(id) on delete set null,
  add constraint returns_received_by_fkey foreign key (received_by)
    references public.user_profiles(id) on delete set null,
  add constraint returns_requested_by_fkey foreign key (requested_by)
    references public.user_profiles(id) on delete set null,
  add column deleted_users jsonb;
create trigger zzz_deleted_users_ins before insert on public.returns
  for each row when (new.deleted_users is not null)
  execute function public.tg_mark_deleted_users('approved_by', 'closed_by', 'denied_by', 'received_by', 'requested_by');
create trigger zzz_deleted_users_upd before update on public.returns
  for each row when (old.deleted_users is not null or new.deleted_users is not null
                     or (old.approved_by is not null and new.approved_by is null)
                     or (old.closed_by is not null and new.closed_by is null)
                     or (old.denied_by is not null and new.denied_by is null)
                     or (old.received_by is not null and new.received_by is null)
                     or (old.requested_by is not null and new.requested_by is null))
  execute function public.tg_mark_deleted_users('approved_by', 'closed_by', 'denied_by', 'received_by', 'requested_by');

alter table public.uom_conversions
  drop constraint uom_conversions_approved_by_fkey,
  drop constraint uom_conversions_created_by_fkey,
  add constraint uom_conversions_approved_by_fkey foreign key (approved_by)
    references public.user_profiles(id) on delete set null,
  add constraint uom_conversions_created_by_fkey foreign key (created_by)
    references public.user_profiles(id) on delete set null,
  add column deleted_users jsonb;
create trigger zzz_deleted_users_ins before insert on public.uom_conversions
  for each row when (new.deleted_users is not null)
  execute function public.tg_mark_deleted_users('approved_by', 'created_by');
create trigger zzz_deleted_users_upd before update on public.uom_conversions
  for each row when (old.deleted_users is not null or new.deleted_users is not null
                     or (old.approved_by is not null and new.approved_by is null)
                     or (old.created_by is not null and new.created_by is null))
  execute function public.tg_mark_deleted_users('approved_by', 'created_by');

alter table public.org_connections
  drop constraint org_connections_created_by_fkey,
  add constraint org_connections_created_by_fkey foreign key (created_by)
    references public.user_profiles(id) on delete set null,
  add column deleted_users jsonb;
create trigger zzz_deleted_users_ins before insert on public.org_connections
  for each row when (new.deleted_users is not null)
  execute function public.tg_mark_deleted_users('created_by');
create trigger zzz_deleted_users_upd before update on public.org_connections
  for each row when (old.deleted_users is not null or new.deleted_users is not null
                     or (old.created_by is not null and new.created_by is null))
  execute function public.tg_mark_deleted_users('created_by');

alter table public.organization_modules
  drop constraint organization_modules_enabled_by_fkey,
  add constraint organization_modules_enabled_by_fkey foreign key (enabled_by)
    references public.user_profiles(id) on delete set null,
  add column deleted_users jsonb;
create trigger zzz_deleted_users_ins before insert on public.organization_modules
  for each row when (new.deleted_users is not null)
  execute function public.tg_mark_deleted_users('enabled_by');
create trigger zzz_deleted_users_upd before update on public.organization_modules
  for each row when (old.deleted_users is not null or new.deleted_users is not null
                     or (old.enabled_by is not null and new.enabled_by is null))
  execute function public.tg_mark_deleted_users('enabled_by');

alter table public.carrier_shipments
  drop constraint carrier_shipments_purchased_by_fkey,
  add constraint carrier_shipments_purchased_by_fkey foreign key (purchased_by)
    references public.user_profiles(id) on delete set null,
  add column deleted_users jsonb;
create trigger zzz_deleted_users_ins before insert on public.carrier_shipments
  for each row when (new.deleted_users is not null)
  execute function public.tg_mark_deleted_users('purchased_by');
create trigger zzz_deleted_users_upd before update on public.carrier_shipments
  for each row when (old.deleted_users is not null or new.deleted_users is not null
                     or (old.purchased_by is not null and new.purchased_by is null))
  execute function public.tg_mark_deleted_users('purchased_by');

-- ═══ 6. Personal rows and new keys ════════════════════════════════════════

-- The driver's live GPS point for one in-transit order: personal data, so it
-- goes with the account instead of keeping the last coordinates (C4).
alter table public.delivery_locations
  drop constraint delivery_locations_driver_user_id_fkey,
  add constraint delivery_locations_driver_user_id_fkey foreign key (driver_user_id)
    references public.user_profiles(id) on delete cascade;

-- The person's own submission log (0391); the order it placed stays.
alter table public.order_submissions
  add constraint order_submissions_user_id_fkey foreign key (user_id)
    references public.user_profiles(id) on delete cascade;

alter table public.user_permission_overrides
  add constraint user_permission_overrides_updated_by_fkey foreign key (updated_by)
    references public.user_profiles(id) on delete set null;
alter table public.role_permission_overrides
  add constraint role_permission_overrides_updated_by_fkey foreign key (updated_by)
    references public.user_profiles(id) on delete set null;
alter table public.user_profiles
  add constraint user_profiles_disabled_by_fkey foreign key (disabled_by)
    references public.user_profiles(id) on delete set null;

-- ═══ 7. schedule_events (its keys reference auth.users) ═══════════════════

alter table public.schedule_events
  drop constraint schedule_events_created_by_fkey,
  drop constraint schedule_events_updated_by_fkey,
  add constraint schedule_events_created_by_fkey foreign key (created_by)
    references auth.users(id) on delete set null,
  add constraint schedule_events_updated_by_fkey foreign key (updated_by)
    references auth.users(id) on delete set null,
  alter column created_by drop not null,
  add column deleted_users jsonb,
  add constraint schedule_events_created_by_deleted_chk
    check ((created_by is not null) <> coalesce(deleted_users ? 'created_by', false));
create trigger zzz_deleted_users_ins before insert on public.schedule_events
  for each row when (new.deleted_users is not null)
  execute function public.tg_mark_deleted_users('assigned_user_id', 'created_by', 'updated_by');
create trigger zzz_deleted_users_upd before update on public.schedule_events
  for each row when (old.deleted_users is not null or new.deleted_users is not null
                     or (old.assigned_user_id is not null and new.assigned_user_id is null)
                     or (old.created_by is not null and new.created_by is null)
                     or (old.updated_by is not null and new.updated_by is null))
  execute function public.tg_mark_deleted_users('assigned_user_id', 'created_by', 'updated_by');

-- ═══ 8. The account trigger ═══════════════════════════════════════════════

create trigger on_auth_user_before_delete
  before delete on auth.users
  for each row execute function public.tg_auth_users_before_delete();

-- ═══ 9. Comments (catalog only; every table here is locked by the prelude) ═

comment on column public.approvals.deleted_users is
  'People named on this row whose accounts were deleted (0394): {column: when}. Set only by zzz_deleted_users '
  'when an account deletion nulls the column; API roles cannot set or clear it. The app shows "Deleted user".';
comment on column public.audit_logs.deleted_users is
  'People named on this row whose accounts were deleted (0394): {column: when}. Set only by zzz_deleted_users '
  'when an account deletion nulls the column, or by the server''s own account-deletion row; API roles cannot '
  'set or clear it. The app shows "Deleted user" instead of "System".';
comment on column public.carrier_shipments.deleted_users is
  'People named on this row whose accounts were deleted (0394): {column: when}. Set only by zzz_deleted_users '
  'when an account deletion nulls the column; API roles cannot set or clear it. The app shows "Deleted user".';
comment on column public.cycle_count_ai_scans.deleted_users is
  'People named on this row whose accounts were deleted (0394): {column: when}. Set only by zzz_deleted_users '
  'when an account deletion nulls the column; API roles cannot set or clear it. The app shows "Deleted user".';
comment on column public.org_connections.deleted_users is
  'People named on this row whose accounts were deleted (0394): {column: when}. Set only by zzz_deleted_users '
  'when an account deletion nulls the column; API roles cannot set or clear it. The app shows "Deleted user".';
comment on column public.organization_invites.deleted_users is
  'People named on this row whose accounts were deleted (0394): {column: when}. Set only by zzz_deleted_users '
  'when an account deletion nulls the column; API roles cannot set or clear it. The app shows "Deleted user".';
comment on column public.organization_modules.deleted_users is
  'People named on this row whose accounts were deleted (0394): {column: when}. Set only by zzz_deleted_users '
  'when an account deletion nulls the column; API roles cannot set or clear it. The app shows "Deleted user".';
comment on column public.platform_admin_audit.deleted_users is
  'People named on this row whose accounts were deleted (0394): {column: when}. Set only by zzz_deleted_users '
  'when an account deletion nulls the column; API roles cannot set or clear it. actor_email is kept, so the '
  'platform audit still says who acted.';
comment on column public.po_imports.deleted_users is
  'People named on this row whose accounts were deleted (0394): {column: when}. Set only by zzz_deleted_users '
  'when an account deletion nulls the column; API roles cannot set or clear it. The app shows "Deleted user".';
comment on column public.putaway_moves.deleted_users is
  'People named on this row whose accounts were deleted (0394): {column: when}. Set only by zzz_deleted_users '
  'when an account deletion nulls the column; API roles cannot set or clear it. The app shows "Deleted user".';
comment on column public.receipts.deleted_users is
  'People named on this row whose accounts were deleted (0394): {column: when}. Set only by zzz_deleted_users '
  'when an account deletion nulls the column; API roles cannot set or clear it. The app shows "Deleted user".';
comment on column public.returns.deleted_users is
  'People named on this row whose accounts were deleted (0394): {column: when}. Set only by zzz_deleted_users '
  'when an account deletion nulls the column; API roles cannot set or clear it. The app shows "Deleted user".';
comment on column public.schedule_events.deleted_users is
  'People named on this row whose accounts were deleted (0394): {column: when}. Set only by zzz_deleted_users '
  'when an account deletion nulls the column; authenticated may read it and may not insert or update it. '
  'The app shows "Deleted user".';
comment on column public.size_count_training_samples.deleted_users is
  'People named on this row whose accounts were deleted (0394): {column: when}. Set only by zzz_deleted_users '
  'when an account deletion nulls the column; API roles cannot set or clear it. The app shows "Deleted user".';
comment on column public.stock_movements.deleted_users is
  'People named on this row whose accounts were deleted (0394): {column: when}. Set only by zzz_deleted_users '
  'when an account deletion nulls the column; API roles cannot set or clear it. The app shows "Deleted user" '
  'instead of "System".';
comment on column public.uom_conversions.deleted_users is
  'People named on this row whose accounts were deleted (0394): {column: when}. Set only by zzz_deleted_users '
  'when an account deletion nulls the column; API roles cannot set or clear it. The app shows "Deleted user".';

comment on constraint approvals_requested_by_deleted_chk on public.approvals is
  'Exactly one (0394): the requester is named, or deleted_users records that their account was deleted.';
comment on constraint cycle_count_ai_scans_created_by_deleted_chk on public.cycle_count_ai_scans is
  'Exactly one (0394): the creator is named, or deleted_users records that their account was deleted.';
comment on constraint cc_ai_scans_confirm_chk on public.cycle_count_ai_scans is
  'A confirmed scan names who confirmed it, or records that their account was deleted (0394).';
comment on constraint po_imports_uploaded_by_deleted_chk on public.po_imports is
  'Exactly one (0394): the uploader is named, or deleted_users records that their account was deleted.';
comment on constraint putaway_moves_performed_by_deleted_chk on public.putaway_moves is
  'Exactly one (0394): the person is named, or deleted_users records that their account was deleted.';
comment on constraint receipts_received_by_deleted_chk on public.receipts is
  'Exactly one (0394): the receiver is named, or deleted_users records that their account was deleted.';
comment on constraint size_count_training_samples_captured_by_deleted_chk on public.size_count_training_samples is
  'Exactly one (0394): the person is named, or deleted_users records that their account was deleted.';
comment on constraint organization_invites_invited_by_deleted_chk on public.organization_invites is
  'Exactly one (0394): the inviter is named, or deleted_users records that their account was deleted.';
comment on constraint platform_admin_audit_actor_user_id_deleted_chk on public.platform_admin_audit is
  'Exactly one (0394): the acting admin is named, or deleted_users records that their account was deleted '
  '(actor_email still names them).';
comment on constraint schedule_events_created_by_deleted_chk on public.schedule_events is
  'Exactly one (0394): the creator is named, or deleted_users records that their account was deleted.';
comment on constraint order_submissions_user_id_fkey on public.order_submissions is
  'The placer''s own submission log goes with their account (0394); the order it placed stays.';
comment on constraint delivery_locations_driver_user_id_fkey on public.delivery_locations is
  'The driver''s live position is personal data and goes with their account (0394).';
comment on constraint user_permission_overrides_updated_by_fkey on public.user_permission_overrides is
  'Who last changed the override (0394): nulled when that account is deleted, never left dangling.';
comment on constraint role_permission_overrides_updated_by_fkey on public.role_permission_overrides is
  'Who last changed the override (0394): nulled when that account is deleted, never left dangling.';
comment on constraint user_profiles_disabled_by_fkey on public.user_profiles is
  'The platform admin who disabled the account (0394): nulled when that account is deleted.';
comment on table public.order_submissions is
  'One private record per order submission key (0391): (organization, placer, key) -> placed (with the '
  'order), refused (with the reason) or withdrawn, decided under the key''s advisory lock in the '
  'transaction that creates the order. Rows never change (no UPDATE or DELETE policy). Each member reads '
  'only their own rows. INSERT only while stockpilot.order_submit holds this transaction''s id, raised '
  'inline by place_order_request and withdraw_order_submission alone. The placer''s rows go with their '
  'account (0394, ON DELETE CASCADE: never blocks a deletion); the organization and the order cascade.';

reset lock_timeout;
