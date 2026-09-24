-- 0367: cycle-count lines, AI-scan evidence and count status are no longer
-- forgeable through direct API writes (Phase 0 S5, security).
--
-- THE HOLE (verified against production 2026-09-24):
--
--   1. `authenticated` held a TABLE-level UPDATE grant on cycle_count_lines.
--      The row policy checks only role, an in-progress parent and the
--      assignee. The rebase trigger (0339) fires only on UPDATE OF
--      counted_quantity. So a direct PATCH of expected_quantity, item_id,
--      warehouse_id, counted_location_id or cycle_count_id skipped every
--      check, and ledger.post_cycle_count TRUSTS those columns:
--        v_diff := counted_quantity - expected_quantity;  v_new := v_prev + v_diff
--      and moves the stock to counted_location_id. A counter could set
--      expected 0 against counted 10 and the manager's post would add 10
--      units that were never there.
--
--   2. cycle_count_ai_scans: the creating staff member could UPDATE every
--      column, including gemini_response and photo_storage_path, which are
--      the evidence a reviewer relies on, and confirmed_by (anyone's id).
--
--   3. cycle_counts: a manager could PATCH a completed or canceled count
--      back to in_progress, which re-opens its lines to edits and lets it
--      be posted a SECOND time (the variance applied twice), or mark a
--      count completed without posting it.
--
-- THE FIX:
--
--   1 + 2. Column-level grants. UPDATE is narrowed to exactly the columns
--      the legitimate writers set. The writer map:
--        - CycleCountsService.recordCount: counted_quantity, reason, notes,
--          counted_by, counted_at, ai_scan_id (behind the web action and
--          /api/v1 .../record, which every phone uses).
--        - CycleCountsService.clearCount: counted_quantity, reason, notes,
--          counted_by, counted_at.
--        - CycleCountsService.markAiScanConfirmed: confirmed_at, confirmed_by.
--        - Phone builds before 2026-05-28 (30e9a3e8) PATCHed cycle_count_lines
--          directly with counted_quantity, counted_by, counted_at only. All
--          three stay granted, so any phone still on that code keeps working.
--        - No SQL function UPDATEs either table (pg_proc scan). Trigger-set
--          columns (expected_quantity, expected_at_start, counted_location_id
--          from the 0339 rebase; updated_at) need no column privilege.
--      The ai-scan UPDATE policy additionally requires confirmed_by to be the
--      caller (or null), so a scan cannot be "confirmed" in someone else's name.
--
--   3. A status-transition guard on cycle_counts for API roles:
--        - completed and canceled are final; they cannot be reopened;
--        - a count becomes completed only inside the post (ledger.active(),
--          which only public.post_cycle_count's wrapper sets for its own
--          transaction).
--      in_progress -> canceled (CycleCountsService.cancel) is unchanged.
--      SECURITY DEFINER bodies (assign/release/force_reassign run as the
--      owner), service_role and postgres are not policed, same as every
--      0359-0364 guard.
--
-- anon: every grant on both tables is revoked (it never had a policy, so
-- this changes nothing observable; it removes the latent grant).
--
-- Installed phones: unaffected. They record counts through /api/v1, and the
-- only direct writes old builds ever made use granted columns.

-- ── 1. cycle_count_lines ───────────────────────────────────────────────────
revoke insert, update, delete on table public.cycle_count_lines from anon;
revoke update on table public.cycle_count_lines from authenticated;
grant update (counted_quantity, reason, notes, counted_by, counted_at, ai_scan_id)
  on table public.cycle_count_lines to authenticated;

-- ── 2. cycle_count_ai_scans ────────────────────────────────────────────────
revoke insert, update, delete on table public.cycle_count_ai_scans from anon;
revoke update on table public.cycle_count_ai_scans from authenticated;
grant update (confirmed_at, confirmed_by)
  on table public.cycle_count_ai_scans to authenticated;

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

-- ── 3. cycle_counts status transitions ─────────────────────────────────────
create or replace function public.tg_cycle_counts_status_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if new.status is not distinct from old.status then
    return new;
  end if;
  if old.status <> 'in_progress' then
    raise exception 'This count is already %, so it cannot be reopened. Start a new count instead.', old.status
      using errcode = '42501', hint = 'cycle_count_closed';
  end if;
  if new.status = 'completed' and not ledger.active() then
    raise exception 'A count is completed only by posting it.'
      using errcode = '42501', hint = 'cycle_count_post_only';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_cycle_counts_status_guard() from public, anon, authenticated;

drop trigger if exists trg_zz_cycle_counts_status_guard on public.cycle_counts;
create trigger trg_zz_cycle_counts_status_guard
  before update of status on public.cycle_counts
  for each row execute function public.tg_cycle_counts_status_guard();
