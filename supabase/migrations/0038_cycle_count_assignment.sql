-- 0038_cycle_count_assignment.sql
-- Adds an "assigned_to" pointer to cycle_counts so a manager / admin /
-- owner can route a count session to a specific person on the team.
-- Staff and viewers cannot set this field (gated by the
-- 'cycle_counts:assign' permission added to packages/core in the
-- same change set). RLS on cycle_counts already enforces org scope.
--
-- Default null = unassigned; a count is only "owned" when explicitly
-- assigned. Existing rows stay unassigned.

alter table public.cycle_counts
  add column if not exists assigned_to uuid references public.user_profiles(id) on delete set null;

comment on column public.cycle_counts.assigned_to is
  'User responsible for completing this cycle count. Set by managers+ via assignCycleCountAction. Null = unassigned.';

-- Hot path: "show me my cycle counts" filtered by the current user.
create index if not exists cycle_counts_assigned_to_idx
  on public.cycle_counts(organization_id, assigned_to, status, started_at desc)
  where assigned_to is not null;
