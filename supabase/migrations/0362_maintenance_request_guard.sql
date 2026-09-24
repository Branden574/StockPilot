-- 0362_maintenance_request_guard.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Maintenance requests: who may open, resolve, cancel, archive and assign a
-- request is enforced in the database, not only in MaintenanceRequestsService.
-- Every rule here is one the service already follows, so it needs no app
-- change and no deploy ordering.
--
-- THE PROBLEM. maintenance_requests_insert and _update check who the row
-- belongs to and that the module is on, and nothing about the columns:
--   * a requester can PATCH their own open request to status 'resolved' with
--     any resolved_by and resolved_by_name_snapshot (a forged close-out,
--     which the requester notification and the share link then present);
--   * a requester can assign a local owner, clear or rewrite a cancellation,
--     or fake the Outlook draft counters;
--   * an insert can arrive already resolved, archived or assigned, carry
--     another person's name in the requester snapshot, or attach charters,
--     warehouses, items, orders, rentals and locations from another org;
--   * an insert can supply request_number itself. The numbering trigger
--     passes an explicit number through and numbers the next request
--     max + 1, so one row at 9223372036854775807 makes every later request
--     in the org fail (bigint overflow).
--
-- THE GUARD (API roles only; the service role writes the email bookkeeping
-- and restores explicit numbers). On INSERT the request starts open,
-- unassigned and unnumbered, its requester snapshot comes from the caller's
-- profile, and its references are this org's. On UPDATE:
--   * organization, number, requester and creation time never change; the
--     email bookkeeping columns are the service role's;
--   * resolving needs maintenance_requests:manage on an open request and
--     records the caller as resolver, with the name from their profile;
--   * cancelling needs the requester (own request) or manage, on a request
--     that is not resolved or archived;
--   * archiving needs manage; assigning a local owner needs manage and an
--     accepted member of the org (or clearing it);
--   * none of resolved_*, cancelled_at, archived_at is ever cleared or
--     rewritten once set (history is kept);
--   * the Outlook draft is opened at most once and counted one at a time;
--   * status follows the stamps: saved -> draft_opened -> resolved /
--     cancelled -> archived.
-- Named trg_aa_* so it fires BEFORE trg_assign_maintenance_request_number:
-- the guard must see whether the caller supplied a number, not the one the
-- numbering trigger assigns.

-- ── Helpers ─────────────────────────────────────────────────────────────────

-- Null-tolerant org membership checks for the two references that had none
-- (item_in_org's shape), answered only to members of p_org_id so they are not
-- an existence oracle for other orgs' ids. The guard asks only about the
-- caller's own org, where the answer is unchanged.
create or replace function public.order_request_in_org(p_order_request_id uuid, p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_order_request_id is null or (
    (auth.uid() is null or public.is_org_member(p_org_id))
    and exists (
      select 1 from public.order_requests
       where id = p_order_request_id and organization_id = p_org_id
    )
  );
$$;

create or replace function public.rental_in_org(p_rental_id uuid, p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_rental_id is null or (
    (auth.uid() is null or public.is_org_member(p_org_id))
    and exists (
      select 1 from public.rentals
       where id = p_rental_id and organization_id = p_org_id
    )
  );
$$;

-- The caller's own display name and email, the way the service builds its
-- snapshots (trimmed full name, else email).
create or replace function public.caller_profile_name_email()
returns table(full_name text, email text)
language sql
stable
security definer
set search_path = public
as $$
  select nullif(btrim(p.full_name), ''), p.email
    from public.user_profiles p
   where p.id = auth.uid();
$$;

-- ── The guard ───────────────────────────────────────────────────────────────

create or replace function public.tg_maintenance_requests_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_manage   boolean;
  v_name     text;
  v_email    text;
  v_resolving  boolean;
  v_cancelling boolean;
  v_archiving  boolean;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.request_number is not null then
      raise exception 'Request numbers are assigned by the database.'
        using errcode = '42501';
    end if;
    if new.status is distinct from 'saved'
       or new.resolved_at is not null or new.resolved_by is not null
       or new.resolved_by_name_snapshot is not null or new.resolution_note is not null
       or new.cancelled_at is not null or new.archived_at is not null
       or new.local_owner_user_id is not null
       or new.outlook_draft_opened_at is not null
       or coalesce(new.outlook_draft_open_count, 0) <> 0
       or new.resolution_email_sent_at is not null or new.draft_reminder_sent_at is not null then
      raise exception 'A new maintenance request starts open and unassigned.'
        using errcode = '42501';
    end if;
    select c.full_name, c.email into v_name, v_email from public.caller_profile_name_email() c;
    new.requester_name_snapshot := coalesce(v_name, v_email, 'Unknown requester');
    new.requester_email_snapshot := v_email;
    if not (public.charter_in_org(new.charter_id, new.organization_id)
            and public.warehouse_in_org(new.warehouse_id, new.organization_id)
            and public.item_in_org(new.related_item_id, new.organization_id)
            and public.location_in_org(new.related_location_id, new.organization_id)
            and public.order_request_in_org(new.related_order_request_id, new.organization_id)
            and public.rental_in_org(new.related_rental_id, new.organization_id)) then
      raise exception 'A linked record is not part of this organization.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- UPDATE ------------------------------------------------------------------
  if new.organization_id is distinct from old.organization_id
     or new.request_number is distinct from old.request_number
     or new.requester_user_id is distinct from old.requester_user_id
     or new.created_at is distinct from old.created_at
     or new.requester_name_snapshot is distinct from old.requester_name_snapshot
     or new.requester_email_snapshot is distinct from old.requester_email_snapshot
     or new.resolution_email_sent_at is distinct from old.resolution_email_sent_at
     or new.draft_reminder_sent_at is distinct from old.draft_reminder_sent_at then
    raise exception 'That part of a maintenance request cannot be changed.'
      using errcode = '42501';
  end if;

  -- Only references this update CHANGES are checked, so a row that predates
  -- the guard can still be resolved, cancelled or archived as it stands.
  if (new.charter_id is distinct from old.charter_id
        and not public.charter_in_org(new.charter_id, new.organization_id))
     or (new.warehouse_id is distinct from old.warehouse_id
        and not public.warehouse_in_org(new.warehouse_id, new.organization_id))
     or (new.related_item_id is distinct from old.related_item_id
        and not public.item_in_org(new.related_item_id, new.organization_id))
     or (new.related_location_id is distinct from old.related_location_id
        and not public.location_in_org(new.related_location_id, new.organization_id))
     or (new.related_order_request_id is distinct from old.related_order_request_id
        and not public.order_request_in_org(new.related_order_request_id, new.organization_id))
     or (new.related_rental_id is distinct from old.related_rental_id
        and not public.rental_in_org(new.related_rental_id, new.organization_id)) then
    raise exception 'A linked record is not part of this organization.'
      using errcode = '42501';
  end if;

  v_manage := public.has_permission(new.organization_id, 'maintenance_requests:manage');

  -- Closed-state stamps are history: set once, never cleared or rewritten.
  if (old.resolved_at is not null
      and (new.resolved_at, new.resolved_by, new.resolved_by_name_snapshot, new.resolution_note)
          is distinct from (old.resolved_at, old.resolved_by, old.resolved_by_name_snapshot, old.resolution_note))
     or (old.cancelled_at is not null and new.cancelled_at is distinct from old.cancelled_at)
     or (old.archived_at is not null and new.archived_at is distinct from old.archived_at) then
    raise exception 'A resolved, cancelled or archived request keeps that record.'
      using errcode = '42501';
  end if;

  v_resolving  := old.resolved_at is null and new.resolved_at is not null;
  v_cancelling := old.cancelled_at is null and new.cancelled_at is not null;
  v_archiving  := old.archived_at is null and new.archived_at is not null;

  if not v_resolving and old.resolved_at is null
     and (new.resolved_by, new.resolved_by_name_snapshot, new.resolution_note)
         is distinct from (old.resolved_by, old.resolved_by_name_snapshot, old.resolution_note) then
    raise exception 'Resolution details are recorded by resolving the request.'
      using errcode = '42501';
  end if;

  if v_resolving then
    if not v_manage then
      raise exception 'Only a maintenance manager can resolve a request.'
        using errcode = '42501';
    end if;
    if old.cancelled_at is not null or old.archived_at is not null or v_cancelling or v_archiving then
      raise exception 'Only an open request can be resolved.'
        using errcode = '42501';
    end if;
    select c.full_name, c.email into v_name, v_email from public.caller_profile_name_email() c;
    new.resolved_at := now();
    new.resolved_by := v_uid;
    new.resolved_by_name_snapshot := left(coalesce(v_name, v_email, 'Unknown'), 200);
  end if;

  if v_cancelling then
    if not (v_manage or old.requester_user_id = v_uid) then
      raise exception 'Only the requester or a maintenance manager can cancel a request.'
        using errcode = '42501';
    end if;
    if old.resolved_at is not null or old.archived_at is not null or v_resolving or v_archiving then
      raise exception 'Only an open request can be cancelled.'
        using errcode = '42501';
    end if;
    new.cancelled_at := now();
  end if;

  if v_archiving then
    if not v_manage then
      raise exception 'Only a maintenance manager can archive a request.'
        using errcode = '42501';
    end if;
    new.archived_at := now();
  end if;

  if new.local_owner_user_id is distinct from old.local_owner_user_id then
    if not v_manage then
      raise exception 'Only a maintenance manager can assign a local owner.'
        using errcode = '42501';
    end if;
    if new.local_owner_user_id is not null and not exists (
         select 1 from public.organization_members m
          where m.organization_id = new.organization_id
            and m.user_id = new.local_owner_user_id
            and m.accepted_at is not null) then
      raise exception 'That user is not an active member of this organization.'
        using errcode = '42501';
    end if;
  end if;

  if new.outlook_draft_opened_at is distinct from old.outlook_draft_opened_at
     and old.outlook_draft_opened_at is not null then
    raise exception 'The first draft-open time is kept.'
      using errcode = '42501';
  end if;
  if new.outlook_draft_open_count is distinct from old.outlook_draft_open_count
     and new.outlook_draft_open_count is distinct from coalesce(old.outlook_draft_open_count, 0) + 1 then
    raise exception 'Draft opens are counted one at a time.'
      using errcode = '42501';
  end if;

  -- Status follows the stamps.
  if new.status is distinct from old.status then
    if not (
         (new.status = 'resolved'     and v_resolving)
      or (new.status = 'cancelled'    and v_cancelling)
      or (new.status = 'archived'     and v_archiving)
      or (new.status = 'draft_opened' and old.status = 'saved')
    ) then
      raise exception 'That status change is not allowed.'
        using errcode = '42501';
    end if;
  elsif v_resolving or v_cancelling or v_archiving then
    raise exception 'That status change is not allowed.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.tg_maintenance_requests_guard() is
  'BEFORE INSERT OR UPDATE guard (0362): API-role maintenance requests start '
  'open and unnumbered with a profile-sourced requester snapshot; resolve, '
  'cancel, archive and owner changes follow the service''s gates; closed-state '
  'stamps are never cleared; references stay in the org.';

drop trigger if exists trg_aa_maintenance_requests_guard on public.maintenance_requests;
create trigger trg_aa_maintenance_requests_guard
  before insert or update on public.maintenance_requests
  for each row execute function public.tg_maintenance_requests_guard();

-- ── Grants ──────────────────────────────────────────────────────────────────

revoke all on function public.order_request_in_org(uuid, uuid) from public, anon;
grant execute on function public.order_request_in_org(uuid, uuid) to authenticated, service_role;
revoke all on function public.rental_in_org(uuid, uuid) from public, anon;
grant execute on function public.rental_in_org(uuid, uuid) to authenticated, service_role;
revoke all on function public.caller_profile_name_email() from public, anon;
grant execute on function public.caller_profile_name_email() to authenticated, service_role;
revoke all on function public.tg_maintenance_requests_guard() from public, anon, authenticated;

-- Nothing deletes a maintenance request (archive is the end of its life), and
-- anon writes none.
revoke delete, truncate, trigger, references on public.maintenance_requests from authenticated, anon;
revoke insert, update on public.maintenance_requests from anon;
