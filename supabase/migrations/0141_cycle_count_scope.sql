-- 0141_cycle_count_scope.sql
-- Distinguishes a hand-picked "selection" cycle count from the existing
-- warehouse / org-wide count. A selection count stores warehouse_id = null at
-- the header (it may span warehouses) but each cycle_count_lines row keeps its
-- own warehouse_id snapshot, which is all post_cycle_count (0079) needs for
-- variance + the mid-count move guard. Existing rows default to 'warehouse',
-- so behavior is unchanged for everything created before this migration.

alter table public.cycle_counts
  add column if not exists scope text not null default 'warehouse'
    check (scope in ('warehouse', 'selection'));

comment on column public.cycle_counts.scope is
  'warehouse = snapshot of all active items in the warehouse/org (default); '
  'selection = an explicit hand-picked item set. Selection counts set '
  'warehouse_id = null and rely on per-line warehouse_id for posting scope.';
