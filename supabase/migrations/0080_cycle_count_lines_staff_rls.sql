-- 0080_cycle_count_lines_staff_rls.sql
-- ============================================================================
-- Cycle-count RLS: loosen line writes from manager+ to staff+, since the
-- application gates the start/cancel/post lifecycle on stock:adjust and
-- staff are the people who physically walk the warehouse and enter counts.
-- v1 RLS forced every counted qty to come from a manager, which mismatched
-- the permissions matrix and silently swallowed staff writes (the UI never
-- saw the rejected update — fixed in cycle-counts.ts via .select().single()).
--
-- The cycle_counts header still requires manager+ for INSERT/UPDATE so
-- start(), cancel(), and post() (which transitions status) remain a
-- manager-gated decision. The header is set once at start() and on
-- cancel/post — staff never need to touch it.
--
-- cycle_count_lines:
--   SELECT  → any org member (unchanged).
--   INSERT  → manager+ (start() inserts the snapshot).
--   UPDATE  → staff+   (record/clear the counted qty).
--   DELETE  → manager+ (rare; via cascade only in practice).
-- ============================================================================

drop policy if exists cycle_count_lines_write on public.cycle_count_lines;

drop policy if exists cycle_count_lines_insert on public.cycle_count_lines;
create policy cycle_count_lines_insert on public.cycle_count_lines
  for insert with check (
    exists (
      select 1 from public.cycle_counts cc
      where cc.id = cycle_count_lines.cycle_count_id
        and public.has_org_role(cc.organization_id, 'manager')
    )
  );

drop policy if exists cycle_count_lines_update on public.cycle_count_lines;
create policy cycle_count_lines_update on public.cycle_count_lines
  for update
  using (
    exists (
      select 1 from public.cycle_counts cc
      where cc.id = cycle_count_lines.cycle_count_id
        and public.has_org_role(cc.organization_id, 'staff')
    )
  )
  with check (
    exists (
      select 1 from public.cycle_counts cc
      where cc.id = cycle_count_lines.cycle_count_id
        and public.has_org_role(cc.organization_id, 'staff')
    )
  );

drop policy if exists cycle_count_lines_delete on public.cycle_count_lines;
create policy cycle_count_lines_delete on public.cycle_count_lines
  for delete using (
    exists (
      select 1 from public.cycle_counts cc
      where cc.id = cycle_count_lines.cycle_count_id
        and public.has_org_role(cc.organization_id, 'manager')
    )
  );
