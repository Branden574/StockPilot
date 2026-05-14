-- 0081_cycle_count_warehouse_snapshot.sql
-- ============================================================================
-- Schema additions for the cycle-count hunter punch-list:
--
--   1) cycle_count_lines.warehouse_id  — snapshot of the item's warehouse
--      at start() time. post_cycle_count (v2, migration 0079) compares
--      this against the item's CURRENT warehouse_id and refuses to post
--      lines whose item moved out of scope mid-count. Nullable so the
--      "All warehouses" snapshot path can leave it null (no scope to
--      enforce).
--
--      Backfilled from inventory_items.warehouse_id for existing rows
--      so prior in-progress counts keep working. Index keeps the
--      out-of-scope check cheap when post() walks many lines.
--
--   2) cycle_counts.canceled_by / canceled_at — currently we only know
--      a count was canceled from status='canceled'; we lose WHO and
--      WHEN. Add the columns so the activity log surface (and the
--      future Recovery UI) can answer "who canceled this and at what
--      time" without joining audit_logs by free-form metadata.
-- ============================================================================

alter table public.cycle_count_lines
  add column if not exists warehouse_id uuid
    references public.warehouses(id) on delete set null;

comment on column public.cycle_count_lines.warehouse_id is
  'Snapshot of inventory_items.warehouse_id at start() time. post() compares against the item''s current warehouse and refuses to post if the item moved out of scope mid-count. Null = no warehouse scope (org-wide count).';

-- Backfill existing rows so in-flight counts keep posting correctly.
update public.cycle_count_lines l
   set warehouse_id = ii.warehouse_id
  from public.inventory_items ii
 where l.item_id = ii.id
   and l.warehouse_id is null;

create index if not exists cycle_count_lines_warehouse_idx
  on public.cycle_count_lines(cycle_count_id, warehouse_id);

-- Cancel attribution.
alter table public.cycle_counts
  add column if not exists canceled_by uuid
    references public.user_profiles(id) on delete set null;

alter table public.cycle_counts
  add column if not exists canceled_at timestamptz;

comment on column public.cycle_counts.canceled_by is
  'User who canceled the cycle count session via cancel(). Null for counts that were never canceled.';
comment on column public.cycle_counts.canceled_at is
  'Timestamp the cycle count was canceled. Null for counts that were never canceled.';
