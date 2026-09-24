-- 0367: cycle-count lines, AI-scan evidence and count status can no longer be
-- forged through direct API writes (Phase 0 S5, security).
--
-- THE HOLES (verified against production 2026-09-24, then widened by an
-- adversarial review of the first draft of this migration):
--
--   1. cycle_count_lines UPDATE. `authenticated` held a TABLE-level UPDATE
--      grant. The row policy checked only role, an in-progress parent and the
--      assignee, and the 0339 rebase trigger fires only on UPDATE OF
--      counted_quantity. A direct PATCH of expected_quantity, item_id,
--      warehouse_id, counted_location_id or cycle_count_id skipped every
--      check, and ledger.post_cycle_count TRUSTS those columns:
--        v_diff := counted_quantity - expected_quantity;  v_new := v_prev + v_diff
--      and moves the stock to counted_location_id. A counter could set
--      expected 0 against counted 10 and the manager's post would add 10.
--      The granted columns also skipped the app's own checks: no stock:adjust
--      permission, no warehouse scope (a staff member limited to one
--      warehouse could count lines in another), and no bounds (a negative
--      count blocks the whole post with cycle_count_negative_result).
--
--   2. cycle_count_lines INSERT / DELETE (manager). A line could be inserted
--      with counted_location_id pointing at a rack in ANOTHER warehouse and a
--      NULL warehouse_id (which skips the post's scope checks), or with an
--      item from ANOTHER ORG (the SECURITY DEFINER rebase trigger then read
--      that org's on-hand into the returned row). Lines could be inserted into
--      or deleted from COMPLETED counts, rewriting a posted record.
--
--   3. cycle_count_ai_scans. The creating staff member could UPDATE every
--      column, including gemini_response and photo_storage_path (the evidence
--      a reviewer relies on), and could INSERT a scan already "confirmed" by
--      a manager. A line's ai_scan_id could point at another count's scan.
--
--   4. cycle_counts. A manager could PATCH a completed or canceled count back
--      to in_progress, re-opening its lines and letting it be posted a SECOND
--      time (the variance applied twice), mark a count completed without
--      posting it, insert a count that was already completed, or rewrite the
--      completed_by / completed_at of a closed count.
--
-- THE WRITER MAP (every legitimate writer; nothing below is refused):
--   - CycleCountsService.recordCount: UPDATE counted_quantity, reason, notes,
--     counted_by, counted_at, ai_scan_id (web action and /api/v1 .../record,
--     which every current phone uses). Checks stock:adjust and warehouse write.
--   - CycleCountsService.clearCount: UPDATE counted_quantity, reason, notes,
--     counted_by, counted_at.
--   - Phone builds before 2026-05-28 (30e9a3e8) PATCHed lines directly with
--     counted_quantity, counted_by, counted_at only.
--   - public.start_cycle_count (SECURITY INVOKER): INSERT cycle_counts
--     (organization_id, warehouse_id, scope, status 'in_progress', notes,
--     started_by) and INSERT lines (cycle_count_id, item_id, warehouse_id =
--     the item's own warehouse, expected_quantity).
--   - CycleCountsService.createAiScan: INSERT scans (organization_id,
--     cycle_count_id, created_by = caller, photo_storage_path,
--     gemini_response, model_version); markAiScanConfirmed: UPDATE
--     confirmed_at, confirmed_by = caller.
--   - CycleCountsService.cancel: in_progress -> canceled; the unassign path
--     updates assignment columns only on an open count.
--   - ledger.post_cycle_count (through public.post_cycle_count, which sets the
--     ledger flag): in_progress -> completed.
--   - assign / release / force_reassign are SECURITY DEFINER (run as owner).
--   - No SQL function updates lines or scans; nothing upserts these tables.
--     Trigger-set columns (the 0339 rebase: expected_quantity,
--     expected_at_start, counted_location_id; updated_at) need no privilege.
--
-- Production data was checked first: 1,937 lines, counted 0..480, no reason
-- or notes, no NULL-warehouse lines, no cross-org lines, no AI scans, no
-- closed count carrying open stamps. Every constraint below validates.
--
-- anon loses INSERT, UPDATE, DELETE and TRUNCATE on the three tables it had
-- latent grants on (it never had a policy, so nothing observable changes);
-- authenticated loses TRUNCATE (not reachable through the API, and it
-- ignores RLS). SELECT posture is unchanged.
--
-- Installed phones: unaffected. They record through /api/v1, and the only
-- direct writes old builds ever made use granted columns under a policy
-- (staff with stock:adjust on their own warehouse) that they satisfy.

-- ── 1. cycle_count_lines: grants ───────────────────────────────────────────
revoke insert, update, delete, truncate on table public.cycle_count_lines from anon;
revoke truncate on table public.cycle_count_lines from authenticated;
revoke insert, update on table public.cycle_count_lines from authenticated;
grant insert (cycle_count_id, item_id, warehouse_id, expected_quantity)
  on table public.cycle_count_lines to authenticated;
grant update (counted_quantity, reason, notes, counted_by, counted_at, ai_scan_id)
  on table public.cycle_count_lines to authenticated;

-- ── 2. cycle_count_lines: policies ─────────────────────────────────────────
-- INSERT: a manager, into an OPEN count, an item of the count's own org, on
-- the item's own warehouse (so a line can never carry a NULL or foreign
-- warehouse its item does not have).
drop policy if exists cycle_count_lines_insert on public.cycle_count_lines;
create policy cycle_count_lines_insert on public.cycle_count_lines
  for insert to authenticated
  with check (
    exists (
      select 1
        from public.cycle_counts cc
        join public.inventory_items ii
          on ii.id = cycle_count_lines.item_id
         and ii.organization_id = cc.organization_id
       where cc.id = cycle_count_lines.cycle_count_id
         and cc.status = 'in_progress'
         and (select public.has_org_role(cc.organization_id, 'manager'))
         and ii.warehouse_id is not distinct from cycle_count_lines.warehouse_id
    )
  );

-- DELETE: a manager, from an OPEN count only. A posted count's lines are its
-- record.
drop policy if exists cycle_count_lines_delete on public.cycle_count_lines;
create policy cycle_count_lines_delete on public.cycle_count_lines
  for delete to authenticated
  using (
    exists (
      select 1 from public.cycle_counts cc
       where cc.id = cycle_count_lines.cycle_count_id
         and cc.status = 'in_progress'
         and (select public.has_org_role(cc.organization_id, 'manager'))
    )
  );

-- UPDATE: the 0282 assignee lock, plus what recordCount checks in the app
-- (stock:adjust, write access to the line's warehouse; a line with no
-- warehouse needs manager), plus: a linked AI scan must belong to this count.
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
         and (select public.has_permission(cc.organization_id, 'stock:adjust'))
         and (
           (cycle_count_lines.warehouse_id is null
              and (select public.has_org_role(cc.organization_id, 'manager')))
           or public.user_can_access_warehouse((select auth.uid()), cycle_count_lines.warehouse_id, 'write')
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
         and (select public.has_permission(cc.organization_id, 'stock:adjust'))
         and (
           (cycle_count_lines.warehouse_id is null
              and (select public.has_org_role(cc.organization_id, 'manager')))
           or public.user_can_access_warehouse((select auth.uid()), cycle_count_lines.warehouse_id, 'write')
         )
    )
    and (counted_by is null or counted_by = (select auth.uid()))
    and (
      ai_scan_id is null
      or exists (
        select 1 from public.cycle_count_ai_scans s
         where s.id = cycle_count_lines.ai_scan_id
           and s.cycle_count_id = cycle_count_lines.cycle_count_id
      )
    )
  );

-- ── 3. cycle_count_lines: bounds the API already enforces ──────────────────
alter table public.cycle_count_lines
  drop constraint if exists cycle_count_lines_counted_quantity_bounds,
  add constraint cycle_count_lines_counted_quantity_bounds
    check (counted_quantity is null or (counted_quantity >= 0 and counted_quantity <= 1000000000)),
  drop constraint if exists cycle_count_lines_reason_length,
  add constraint cycle_count_lines_reason_length
    check (reason is null or char_length(reason) <= 200),
  drop constraint if exists cycle_count_lines_notes_length,
  add constraint cycle_count_lines_notes_length
    check (notes is null or char_length(notes) <= 2000);

-- ── 4. cycle_count_ai_scans ────────────────────────────────────────────────
revoke insert, update, delete, truncate on table public.cycle_count_ai_scans from anon;
revoke truncate on table public.cycle_count_ai_scans from authenticated;
revoke update on table public.cycle_count_ai_scans from authenticated;
grant update (confirmed_at, confirmed_by)
  on table public.cycle_count_ai_scans to authenticated;

-- INSERT: the caller's own, unconfirmed scan, for an OPEN count of the same org.
drop policy if exists cc_ai_scans_insert on public.cycle_count_ai_scans;
create policy cc_ai_scans_insert on public.cycle_count_ai_scans
  for insert to authenticated
  with check (
    (select public.has_org_role(organization_id, 'staff'))
    and created_by = (select auth.uid())
    and confirmed_at is null
    and confirmed_by is null
    and exists (
      select 1 from public.cycle_counts cc
       where cc.id = cycle_count_ai_scans.cycle_count_id
         and cc.organization_id = cycle_count_ai_scans.organization_id
         and cc.status = 'in_progress'
    )
  );

-- UPDATE (confirm): creator or manager, and only in the caller's own name.
drop policy if exists cc_ai_scans_update on public.cycle_count_ai_scans;
create policy cc_ai_scans_update on public.cycle_count_ai_scans
  for update to authenticated
  using (
    (select public.has_org_role(organization_id, 'staff'))
    and (created_by = (select auth.uid()) or (select public.has_org_role(organization_id, 'manager')))
  )
  with check (
    (select public.has_org_role(organization_id, 'staff'))
    and (created_by = (select auth.uid()) or (select public.has_org_role(organization_id, 'manager')))
    and (confirmed_by is null or confirmed_by = (select auth.uid()))
  );

-- ── 5. cycle_counts: anon + the status/closure guard ───────────────────────
revoke insert, update, delete, truncate on table public.cycle_counts from anon;
revoke truncate on table public.cycle_counts from authenticated;

create or replace function public.tg_cycle_counts_status_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Only the API roles are policed. SECURITY DEFINER bodies (they run as the
  -- owner), service_role and postgres pass, as with every 0359-0365 guard.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status is distinct from 'in_progress'
       or new.completed_at is not null or new.completed_by is not null
       or new.canceled_at is not null or new.canceled_by is not null then
      raise exception 'A count starts in progress.'
        using errcode = '42501', hint = 'cycle_count_starts_open';
    end if;
    return new;
  end if;

  -- A closed count is final: nothing about it changes through the API.
  if old.status <> 'in_progress' then
    raise exception 'This count is already %, so it cannot be changed or reopened. Start a new count instead.', old.status
      using errcode = '42501', hint = 'cycle_count_closed';
  end if;

  -- Completing happens only inside the post (public.post_cycle_count sets the
  -- ledger flag for its own transaction; no API caller can).
  if new.status = 'completed' and not ledger.active() then
    raise exception 'A count is completed only by posting it.'
      using errcode = '42501', hint = 'cycle_count_post_only';
  end if;

  -- An open count carries no closing stamps.
  if new.status = 'in_progress'
     and (new.completed_at is not null or new.completed_by is not null
          or new.canceled_at is not null or new.canceled_by is not null) then
    raise exception 'An open count cannot carry completion or cancellation stamps.'
      using errcode = '42501', hint = 'cycle_count_open_stamps';
  end if;

  return new;
end;
$$;

revoke all on function public.tg_cycle_counts_status_guard() from public, anon, authenticated;

drop trigger if exists trg_zz_cycle_counts_status_guard on public.cycle_counts;
create trigger trg_zz_cycle_counts_status_guard
  before insert or update on public.cycle_counts
  for each row execute function public.tg_cycle_counts_status_guard();
