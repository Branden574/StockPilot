-- Cycle-count assignment / lock — backend core (mirrors picking 0237).
--
-- ROOT CAUSE this fixes: cycle_counts.assigned_to (0038) was advisory only —
-- no route, service, or RLS layer read it back, so any same-warehouse staff
-- coworker could record/overwrite counts on a session assigned to someone
-- else. This adds the assignee predicate to the line-write RLS and a
-- manager-assign / self-or-manager-release / manager-force-reassign RPC set,
-- enforced server-side and race-safe.
--
-- Owner decisions: cycle counts are manager-ASSIGNED (no self-claim, unlike
-- picking); managers may act as override; released progress is preserved
-- (only the assignment clears); force-reassign of an active count is allowed
-- for managers with a required reason. Audit rows are written by the service
-- layer after the RPC returns (parity with picking).

-- ── 1) Assignment provenance + version columns (assigned_to exists, 0038) ────
alter table public.cycle_counts
  add column if not exists assignment_claimed_at timestamptz,
  add column if not exists assignment_claimed_by uuid
    references public.user_profiles(id) on delete set null,
  add column if not exists assignment_version integer not null default 0;

comment on column public.cycle_counts.assignment_claimed_at is
  'When the current assignment was made. Null = unassigned.';
comment on column public.cycle_counts.assignment_claimed_by is
  'Who made the current assignment (the manager who assigned/reassigned).';
comment on column public.cycle_counts.assignment_version is
  'Bumped on every assign/release/reassign — optimistic-lock token so a stale '
  'mobile screen cannot act on a since-reassigned count.';

-- ── 2) Assignee lock on cycle_count_lines UPDATE ────────────────────────────
-- Recurring-bug #24: `alter policy … with check` REPLACES only the WITH CHECK
-- and silently leaves USING behind — here we must change USING too, so we do a
-- full drop + recreate. Reproduces the effective 0143(USING)+0203(WITH CHECK)
-- policy verbatim, then adds the assignee predicate to BOTH clauses.
--
-- assignee predicate: the write is allowed only when the caller IS the
-- assignee, OR the count is unassigned (assigned_to IS NULL — preserves the
-- pre-lock open behavior for legacy/warehouse counts; closed by the
-- assign-before-count workflow), OR the caller is a manager+ (override).
drop policy if exists cycle_count_lines_update on public.cycle_count_lines;
create policy cycle_count_lines_update on public.cycle_count_lines
  for update to authenticated
  using (
    exists (
      select 1 from public.cycle_counts cc
      where cc.id = cycle_count_lines.cycle_count_id
        and (select public.has_org_role(cc.organization_id, 'staff'))
        and cc.status = 'in_progress'
        and (
          cc.assigned_to = (select auth.uid())
          or cc.assigned_to is null
          or (select public.has_org_role(cc.organization_id, 'manager'))
        )
    )
  )
  with check (
    exists (
      select 1 from public.cycle_counts cc
      where cc.id = cycle_count_lines.cycle_count_id
        and (select public.has_org_role(cc.organization_id, 'staff'))
        and cc.status = 'in_progress'
        and (
          cc.assigned_to = (select auth.uid())
          or cc.assigned_to is null
          or (select public.has_org_role(cc.organization_id, 'manager'))
        )
    )
    -- Audit-field integrity: counted_by may only be the calling user or null.
    and (counted_by is null or counted_by = (select auth.uid()))
    -- Warehouse scoping (0203): the line's warehouse must belong to the org.
    and (
      select public.warehouse_in_org(
        cycle_count_lines.warehouse_id,
        (select cc.organization_id from public.cycle_counts cc
         where cc.id = cycle_count_lines.cycle_count_id)
      )
    )
  );

-- ── 3) assign_cycle_count: manager+ assign OR reassign a released count ──────
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

-- ── 4) release_cycle_count: the assignee (self) OR a manager+, with reason ───
create or replace function public.release_cycle_count(p_count_id uuid, p_reason text)
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

-- ── 5) force_reassign_cycle_count: manager+ reassign an ACTIVE count, w/ reason ─
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

grant execute on function public.assign_cycle_count(uuid, uuid)               to authenticated;
grant execute on function public.release_cycle_count(uuid, text)              to authenticated;
grant execute on function public.force_reassign_cycle_count(uuid, uuid, text) to authenticated;
