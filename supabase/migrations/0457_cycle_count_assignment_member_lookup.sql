-- 0457_cycle_count_assignment_member_lookup.sql
--
-- release_cycle_count, assign_cycle_count and force_reassign_cycle_count
-- look the count up in the organizations the caller is an active member of
-- first, and answer a count outside them as they answer an id that does not
-- exist: P0002 cycle_count_not_found, no detail, no hint (docket item S87).
-- The status and permission checks come after that lookup, unchanged. No row
-- of any table changes.
--
-- ── WHAT ──────────────────────────────────────────────────────────────────
-- 0. Preflight (the block tagged $s87_pre$): each of the three functions must
--    be the one this file was written against, or the file stops with 55000
--    (hint s87_preflight) before changing anything. Checked for each: one
--    function of the name in public, md5(prosrc), arguments, result,
--    language, SECURITY DEFINER, volatility, search_path, owner, and the
--    EXECUTE grantees (authenticated, service_role and the owner postgres;
--    not anon, nothing to PUBLIC). A second run is a difference: the bodies
--    are this file's then.
-- 1. The three bodies are restated from their latest definitions, each with
--    one block tagged "S87" added before the row lock; taking that block out
--    gives the body it replaced exactly (pgTAP R1). The block is the same
--    text in all three:
--      if the count does not exist in an organization where
--      is_org_member(organization_id) holds -> P0002 cycle_count_not_found.
--    is_org_member (0310) is true for an accepted membership whose "act as"
--    seat has not expired, of an account that is not disabled. The lookup
--    takes no row lock, so a count outside the caller's organizations is
--    never locked by the call.
--      assign_cycle_count:         0282_cycle_count_assignment_lock.sql,
--                                  md5(prosrc) 21db42cd037f504513bf134b938b721a
--                                  -> eef39c210b77433fb1630dd5a8ee7674
--      force_reassign_cycle_count: 0282_cycle_count_assignment_lock.sql,
--                                  md5(prosrc) d887f4a5510a0cd438be17e744cff51d
--                                  -> 05bab946f50f1e7e90dbcd023cc3b6a2
--      release_cycle_count:        0419_release_cycle_count_assignee_check.sql,
--                                  md5(prosrc) 168808f20dd326d3710e1900c7d029a4
--                                  -> bbbb2ddd68a6076be0dbd754d7ad38b8
--    Signature, result, volatility, SECURITY DEFINER, search_path and owner
--    are unchanged (CREATE OR REPLACE keeps the owner and the ACL; the
--    headers restate the live attributes).
-- 2. release_cycle_count's comment is restated with the not-found rule.
-- 3. Grants, restated explicitly as they are today (the preflight checks
--    that): EXECUTE revoked from PUBLIC and anon, granted to authenticated
--    and service_role, for each function. No blanket grant.
--
-- ── WHO CHANGES ───────────────────────────────────────────────────────────
-- A member of the count's organization gets every answer they got before:
-- success, 42501 forbidden, P0001 invalid_status_transition (detail the
-- status), P0001 invalid_assignee, the reason refusals, and P0002 for an id
-- that does not exist (pgTAP I1-I8). A caller who is not an active member of
-- the count's organization (another organization's member, a member removed
-- from it, a disabled account, an expired "act as" seat, an invitation not
-- yet accepted, an account with no organization) gets P0002
-- cycle_count_not_found from each function. The app reads the count in the active organization before
-- each call and maps cycle_count_not_found to "Cycle count not found." (web
-- CycleCountsService assign, release and forceReassign), so no screen
-- changes.
--
-- ── LOCKS ─────────────────────────────────────────────────────────────────
-- The preflight reads catalogs only. Checking each body compiles it
-- (check_function_bodies, on in the push); the bodies declare
-- public.cycle_counts%rowtype, so the compile takes an AccessShareLock on
-- public.cycle_counts and releases it at once (as 0419). AccessShareLock
-- conflicts only with ACCESS EXCLUSIVE: no read, write or row lock waits for
-- it. COMMENT holds a ShareUpdateExclusiveLock on release_cycle_count to
-- commit, and REVOKE / GRANT write the functions' catalog rows; only other
-- DDL on the same functions waits for them. A call already running finishes
-- on the body it started with. lock_timeout 900ms ends the file with 55P03
-- and nothing applied if an ACCESS EXCLUSIVE on cycle_counts is held or
-- queued; run it again once that statement has finished.
--
-- ── DATA SAFETY ───────────────────────────────────────────────────────────
-- Tier A: three bodies, one comment and the unchanged grants are restated.
-- No row is written, no table, view, sequence or policy is created, dropped
-- or changed.
--
-- ── ERRORS ────────────────────────────────────────────────────────────────
-- The push raises 55000 hint s87_preflight (drift or a second run: nothing
-- applied) or 55P03 (busy: nothing applied). The functions' refusals are the
-- ones listed above. Never 40001 or 40P01 (PostgREST retries those forever).

set lock_timeout = '900ms';

-- ═══ 0. Preflight ══════════════════════════════════════════════════════════
do $s87_pre$
declare
  v_bad text := '';
  v_n   integer;
  r     record;
  e     record;
begin
  for e in
    select * from (values
      ('assign_cycle_count',         'public.assign_cycle_count(uuid, uuid)',
       '21db42cd037f504513bf134b938b721a', 'p_count_id uuid, p_user_id uuid'),
      ('force_reassign_cycle_count', 'public.force_reassign_cycle_count(uuid, uuid, text)',
       'd887f4a5510a0cd438be17e744cff51d', 'p_count_id uuid, p_user_id uuid, p_reason text'),
      ('release_cycle_count',        'public.release_cycle_count(uuid, text)',
       '168808f20dd326d3710e1900c7d029a4', 'p_count_id uuid, p_reason text')
    ) t(want_name, want_sig, want_src, want_args)
  loop
    select count(*) into v_n
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname = e.want_name;
    if v_n <> 1 then
      v_bad := v_bad || format(' %s functions named public.%s;', v_n, e.want_name);
    end if;

    select md5(p.prosrc) as got_src, pg_get_function_identity_arguments(p.oid) as got_args,
           pg_get_function_result(p.oid) as got_res, l.lanname as got_lang, p.prokind::text as got_kind,
           p.prosecdef as got_secdef, p.provolatile::text as got_vol,
           coalesce(array_to_string(p.proconfig, ';'), '') as got_cfg,
           pg_get_userbyid(p.proowner) as got_owner,
           coalesce((select string_agg(g.v, ',' order by g.v)
                       from (select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end
                                    || ':' || a.privilege_type as v
                               from aclexplode(p.proacl) a) g), '') as got_acl
      into r
      from pg_proc p
      join pg_language l on l.oid = p.prolang
     where p.oid = to_regprocedure(e.want_sig);
    if not found then
      v_bad := v_bad || format(' %s missing;', e.want_sig);
      continue;
    end if;
    if r.got_src <> e.want_src or r.got_args <> e.want_args or r.got_res <> 'cycle_counts'
       or r.got_lang <> 'plpgsql' or r.got_kind <> 'f' or not r.got_secdef or r.got_vol <> 'v'
       or r.got_cfg <> 'search_path=public' or r.got_owner <> 'postgres' then
      v_bad := v_bad || format(' %s drifted (md5 %s, arguments %L, returns %s, language %s, kind %s,'
                               ' definer %s, volatility %s, %s, owner %s);',
                               e.want_sig, r.got_src, r.got_args, r.got_res, r.got_lang, r.got_kind,
                               r.got_secdef, r.got_vol, r.got_cfg, r.got_owner);
    end if;
    if r.got_acl <> 'authenticated:EXECUTE,postgres:EXECUTE,service_role:EXECUTE' then
      v_bad := v_bad || format(' %s grants drifted (%s);', e.want_sig, r.got_acl);
    end if;
  end loop;

  if v_bad <> '' then
    raise exception 's87_preflight:%', v_bad
      using errcode = '55000', hint = 's87_preflight';
  end if;
end
$s87_pre$;

-- ═══ 1. The three bodies ══════════════════════════════════════════════════
-- assign_cycle_count: restated from 0282_cycle_count_assignment_lock.sql; md5(prosrc) 21db42cd037f504513bf134b938b721a -> eef39c210b77433fb1630dd5a8ee7674.
create or replace function public.assign_cycle_count(p_count_id uuid, p_user_id uuid)
 returns cycle_counts
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_count public.cycle_counts%rowtype;
  v_user  uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  -- S87: the count is looked up first in the organizations the caller is an
  -- active member of (is_org_member: an accepted membership, not an expired
  -- "act as" seat, of an account that is not disabled). A count outside
  -- them gets the answer an id that does not exist gets, with nothing
  -- locked; the status and permission checks below come after this one.
  if not exists (
    select 1
      from public.cycle_counts c
     where c.id = p_count_id
       and public.is_org_member(c.organization_id)
  ) then
    raise exception 'cycle_count_not_found' using errcode = 'P0002';
  end if;
  -- Row lock: concurrent assigns serialize; the loser reads the updated row.
  select * into v_count from public.cycle_counts where id = p_count_id for update;
  if not found then
    raise exception 'cycle_count_not_found' using errcode = 'P0002';
  end if;
  if not public.has_org_role(v_count.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Warehouse write when the header carries one (null = org-wide/selection,
  -- gated per-line by the service layer).
  if v_count.warehouse_id is not null
     and not public.user_can_access_inventory(v_user, v_count.warehouse_id, null, 'write') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_count.status <> 'in_progress' then
    raise exception 'invalid_status_transition' using errcode = 'P0001',
      detail = v_count.status;
  end if;
  -- Target must be an accepted member of the same org.
  if not exists (
    select 1 from public.organization_members
    where organization_id = v_count.organization_id
      and user_id = p_user_id
      and accepted_at is not null
  ) then
    raise exception 'invalid_assignee' using errcode = 'P0001';
  end if;

  update public.cycle_counts
    set assigned_to           = p_user_id,
        assignment_claimed_at = now(),
        assignment_claimed_by = v_user,
        assignment_version    = assignment_version + 1
    where id = p_count_id;

  select * into v_count from public.cycle_counts where id = p_count_id;
  return v_count;
end;
$function$;

-- force_reassign_cycle_count: restated from 0282_cycle_count_assignment_lock.sql; md5(prosrc) d887f4a5510a0cd438be17e744cff51d -> 05bab946f50f1e7e90dbcd023cc3b6a2.
create or replace function public.force_reassign_cycle_count(
  p_count_id uuid, p_user_id uuid, p_reason text)
 returns cycle_counts
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_count public.cycle_counts%rowtype;
  v_user  uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reassign_reason_required' using errcode = 'P0001';
  end if;

  -- S87: the count is looked up first in the organizations the caller is an
  -- active member of (is_org_member: an accepted membership, not an expired
  -- "act as" seat, of an account that is not disabled). A count outside
  -- them gets the answer an id that does not exist gets, with nothing
  -- locked; the status and permission checks below come after this one.
  if not exists (
    select 1
      from public.cycle_counts c
     where c.id = p_count_id
       and public.is_org_member(c.organization_id)
  ) then
    raise exception 'cycle_count_not_found' using errcode = 'P0002';
  end if;
  select * into v_count from public.cycle_counts where id = p_count_id for update;
  if not found then
    raise exception 'cycle_count_not_found' using errcode = 'P0002';
  end if;
  if not public.has_org_role(v_count.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_count.warehouse_id is not null
     and not public.user_can_access_inventory(v_user, v_count.warehouse_id, null, 'write') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_count.status <> 'in_progress' then
    raise exception 'invalid_status_transition' using errcode = 'P0001',
      detail = v_count.status;
  end if;
  if not exists (
    select 1 from public.organization_members
    where organization_id = v_count.organization_id
      and user_id = p_user_id
      and accepted_at is not null
  ) then
    raise exception 'invalid_assignee' using errcode = 'P0001';
  end if;

  update public.cycle_counts
    set assigned_to           = p_user_id,
        assignment_claimed_at = now(),
        assignment_claimed_by = v_user,
        assignment_version    = assignment_version + 1
    where id = p_count_id;

  select * into v_count from public.cycle_counts where id = p_count_id;
  return v_count;
end;
$function$;

-- release_cycle_count: restated from 0419_release_cycle_count_assignee_check.sql; md5(prosrc) 168808f20dd326d3710e1900c7d029a4 -> bbbb2ddd68a6076be0dbd754d7ad38b8.
CREATE OR REPLACE FUNCTION public.release_cycle_count(p_count_id uuid, p_reason text)
 RETURNS cycle_counts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_count public.cycle_counts%rowtype;
  v_user  uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'release_reason_required' using errcode = 'P0001';
  end if;

  -- S87: the count is looked up first in the organizations the caller is an
  -- active member of (is_org_member: an accepted membership, not an expired
  -- "act as" seat, of an account that is not disabled). A count outside
  -- them gets the answer an id that does not exist gets, with nothing
  -- locked; the status and permission checks below come after this one.
  if not exists (
    select 1
      from public.cycle_counts c
     where c.id = p_count_id
       and public.is_org_member(c.organization_id)
  ) then
    raise exception 'cycle_count_not_found' using errcode = 'P0002';
  end if;
  select * into v_count from public.cycle_counts where id = p_count_id for update;
  if not found then
    raise exception 'cycle_count_not_found' using errcode = 'P0002';
  end if;
  if v_count.status <> 'in_progress' then
    raise exception 'invalid_status_transition' using errcode = 'P0001',
      detail = v_count.status;
  end if;
  -- S42: a count nobody is assigned to is nobody's own. The check below
  -- compares assigned_to with the caller, which is NULL for such a count,
  -- and an IF treats NULL as false, so that check refused no one: any
  -- signed-in caller, of any organization, who knew the count's id could
  -- release it and read the whole row back past row level security. Only a
  -- manager of the count's organization releases an unassigned count, the
  -- rule release_picking has for an order with no picker. Decided on the
  -- row locked above, so someone whose count a manager released a moment
  -- earlier is refused too.
  if v_count.assigned_to is null
     and not public.has_org_role(v_count.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- S42: the assignee's release is for someone who may still count in the
  -- count's organization: has_permission 'stock:adjust', which the app asks
  -- before every release (CycleCountsService.release) and the line update
  -- policy asks before every count. It is false without an accepted
  -- membership that has not expired, of an account that is not disabled,
  -- and when stock:adjust is revoked or never held (a viewer). Without it,
  -- a member removed from the organization (removal keeps the account and
  -- the assignment), a disabled account (its access token outlives the
  -- disable), an expired "act as" seat, a viewer and a member whose
  -- stock:adjust was revoked could each release a count still assigned to
  -- them by calling this function. A manager without stock:adjust still
  -- releases as a manager (below).
  if v_count.assigned_to = v_user
     and not public.has_permission(v_count.organization_id, 'stock:adjust')
     and not public.has_org_role(v_count.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Self-release (I am the assignee) OR a manager+ releasing anyone's.
  if not (
    v_count.assigned_to = v_user
    or public.has_org_role(v_count.organization_id, 'manager')
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Counted lines are preserved (owner decision) — only the assignment clears.
  update public.cycle_counts
    set assigned_to           = null,
        assignment_claimed_at = null,
        assignment_claimed_by = null,
        assignment_version    = assignment_version + 1
    where id = p_count_id;

  select * into v_count from public.cycle_counts where id = p_count_id;
  return v_count;
end;
$function$;

-- ═══ 2. release_cycle_count's comment ═════════════════════════════════════
comment on function public.release_cycle_count(uuid, text) is
  'Releases a cycle count''s assignment: counted lines stay; assigned_to, assignment_claimed_at and '
  'assignment_claimed_by clear and assignment_version goes up. Needs a non-blank reason and a count in progress. '
  'A manager of the count''s organization releases any count, assigned or not (has_org_role manager: its '
  'owners, admins and managers). Anyone else releases only a count assigned to them, and only while they may '
  'count in the count''s organization (has_permission stock:adjust: an accepted, unexpired membership of an '
  'account that is not disabled, holding it). Refusals, in this order: 42501 unauthenticated; P0001 '
  'release_reason_required; P0002 cycle_count_not_found, for an id that does not exist and for a count in an '
  'organization the caller is not an active member of (is_org_member), with nothing locked; P0001 '
  'invalid_status_transition (DETAIL the status); 42501 forbidden. The service writes the audit row with the reason.';

-- ═══ 3. Grants, as they are today ═════════════════════════════════════════
revoke execute on function public.assign_cycle_count(uuid, uuid)               from public, anon;
grant  execute on function public.assign_cycle_count(uuid, uuid)               to authenticated, service_role;
revoke execute on function public.force_reassign_cycle_count(uuid, uuid, text) from public, anon;
grant  execute on function public.force_reassign_cycle_count(uuid, uuid, text) to authenticated, service_role;
revoke execute on function public.release_cycle_count(uuid, text)              from public, anon;
grant  execute on function public.release_cycle_count(uuid, text)              to authenticated, service_role;

reset lock_timeout;
