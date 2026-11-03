-- release_cycle_count: only a manager releases a count with no assignee, and
-- the assignee releases theirs only while they may still count in the
-- count's organization (docket item S42).
--
-- release_cycle_count (0282) decided who may release a count with one check,
-- after its reason, not-found and status refusals:
--
--   if not (v_count.assigned_to = v_user
--           or public.has_org_role(v_count.organization_id, 'manager')) then
--     raise exception 'forbidden' using errcode = '42501';
--
-- It is SECURITY DEFINER with EXECUTE to authenticated (0329), so any
-- signed-in account can call it through PostgREST /rpc, past the app's own
-- check (CycleCountsService.release asks the cycle_counts module and
-- stock:adjust in the caller's active organization, then calls it without
-- reading the count). The check had two holes:
--
--   1. A count with no assignee. assigned_to = v_user is NULL for it, and an
--      IF treats NULL as false, so for anyone but a manager the check
--      refused no one: any signed-in account, of any organization, that knew
--      an in-progress unassigned count's id could release it. The call moves
--      assignment_version and updated_at and returns the whole cycle_counts
--      row, read past row level security (cycle_counts_select asks
--      is_org_member; the body runs as its owner). release_picking had the
--      same shape and 0240 closed it. Now only a manager of the count's
--      organization releases a count with no assignee.
--   2. The assignee. The check compared identity only, so a member removed
--      from the organization (removal keeps the account and the
--      assignment), a disabled account (its access token outlives the
--      disable), an expired "act as" seat, a viewer and a member whose
--      stock:adjust was revoked could each release a count still assigned
--      to them. Now the assignee releases only while has_permission(the
--      count's organization, 'stock:adjust') holds: the gate the app asks
--      before every release and the line update policy asks before every
--      count (0368). It is false without an accepted, unexpired membership
--      of an account that is not disabled (0310). A manager releases as a
--      manager, as before, with or without stock:adjust.
--
-- Both are blocks tagged "S42", inserted just before the old check, which
-- stays as it is (it still refuses a non-manager on someone else's count).
-- Each is decided on the row the function locks, so an assignee whose count
-- a manager released a moment earlier is refused too. The body is otherwise
-- 0282's byte for byte (its non-ASCII dash included): removing the two
-- blocks gives production's body exactly (md5 below; the pgTAP suite's R1).
-- Signature, result, volatility, SECURITY DEFINER, search_path, owner and
-- grants are unchanged (CREATE OR REPLACE keeps the owner and the grants;
-- the header restates production's attributes). The function gets its first
-- COMMENT. Nothing here names this file's number, so the number it takes in
-- ship order is a rename only.
--
-- WHO CHANGES TODAY. Nobody the app serves loses anything they use. The
-- app's only caller (the phone's Release, through CycleCountsService.release)
-- asks an accepted, enabled membership of the caller's active organization
-- with the cycle_counts module and stock:adjust, and the phone offers Release
-- only on a count with an assignee, to that assignee or a manager. Three
-- edge cases are now refused, none of them a manager's (a manager's call
-- goes through as before); the ERRORS note below says what the app answers:
--   - An assignee who is not a manager and taps Release after a manager
--     already released the count: a silent success before, with a
--     "released" audit row for a no-op. Now the app says the count was
--     already released (when the manager reassigned it to someone else
--     instead, the app's answer is the generic refusal, as before).
--   - An assignee who is not a manager and taps Release count again after
--     their own release went through but its answer was lost (the phone
--     stops waiting after 20 seconds, or the connection drops): before, the
--     second call released the count again as a no-op, wrote a second
--     "released" audit row and closed the sheet; now the sheet stays open
--     and says the count was already released, and no second audit row is
--     written.
--   - A member removed from an organization who still belongs to another,
--     acting from a page left open: the generic refusal, which tells them
--     nothing about the count.
-- The release steps count, read-only, before the push: in-progress counts
-- with no assignee, counts assigned to someone who is no longer an accepted
-- member, and assignees without stock:adjust. No row changes whatever those
-- numbers are.
--
-- LOCKS. No table lock is held to commit, and a call already running
-- finishes on the body it started with. One table lock is taken briefly:
-- checking the body compiles it (check_function_bodies, on by default and in
-- the push), the body declares public.cycle_counts%rowtype, and the compile
-- loads that row type's description with an AccessShareLock on
-- public.cycle_counts, released at once. AccessShareLock conflicts only with
-- ACCESS EXCLUSIVE, so no read, write, row lock or autovacuum waits for it
-- or holds it up. Only an ACCESS EXCLUSIVE on cycle_counts that is held or
-- queued (an ALTER TABLE, VACUUM FULL, another migration) makes the file
-- wait; lock_timeout 900ms then ends it with 55P03 and nothing applied, and
-- the push can be run again once that statement has finished. COMMENT holds
-- a ShareUpdateExclusiveLock on the function to commit (only other DDL on
-- the same function waits for it). The lock footprint script that carries
-- this migration's number in scripts/db-concurrency/ checks each of these.
--
-- DATA SAFETY: no row changes. The file restates one body and gives it a
-- comment; no table, view, sequence, policy or grant is created or changed.
--
-- ERRORS: the new refusals are 42501 'forbidden' with no hint and no detail,
-- the refusal the old check raises, so a direct call's refusal says nothing
-- about whether the count is assigned. Through the app, the same change's
-- service code (S42b) reads the count after a 'forbidden', with the caller's
-- own client in their active organization. If that read finds it in progress
-- with no assignee (only a member of the count's organization can read it,
-- and could see that anyway), the answer is a conflict, "This count was
-- already released.", with no audit row; every other refusal stays "Only the
-- assigned employee or a manager can release this count." Everything else
-- is as before. Never 40001 or 40P01 (PostgREST retries those forever).

set lock_timeout = '900ms';

-- release_cycle_count: restated from 0282_cycle_count_assignment_lock.sql; md5(prosrc) a428c8f73f73ee31516dd186e47bc9f9 -> 168808f20dd326d3710e1900c7d029a4.
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

comment on function public.release_cycle_count(uuid, text) is
  'Releases a cycle count''s assignment: counted lines stay; assigned_to, assignment_claimed_at and '
  'assignment_claimed_by clear and assignment_version goes up. Needs a non-blank reason and a count in progress. '
  'A manager of the count''s organization releases any count, assigned or not (has_org_role manager: its '
  'owners, admins and managers). Anyone else releases only a count assigned to them, and only while they may '
  'count in the count''s organization (has_permission stock:adjust: an accepted, unexpired membership of an '
  'account that is not disabled, holding it). Refusals, in this order: 42501 unauthenticated; P0001 '
  'release_reason_required; P0002 cycle_count_not_found; P0001 invalid_status_transition (DETAIL the status); '
  '42501 forbidden. The service writes the audit row with the reason.';

reset lock_timeout;
