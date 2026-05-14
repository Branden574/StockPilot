-- 0089_procedure_videos_unique_order_idx.sql
-- ============================================================================
-- procedure_videos: unique (procedure_id, order_idx)
-- ----------------------------------------------------------------------------
-- The service layer defaults `order_idx` for a new row to `max(order_idx)+1`
-- with a separate read-then-write pattern. Two concurrent uploads on the
-- same procedure could both read max=N and both insert at N+1, producing
-- two rows with identical `order_idx` and an unstable list-order in the
-- UI.
--
-- A unique constraint on (procedure_id, order_idx) collapses the race into
-- a 23505 conflict that the service can retry deterministically (next call
-- reads the now-incremented max). Cheap, and prevents permanent corruption.
--
-- A pre-flight de-dupe collapses any pre-existing duplicates by giving
-- later-uploaded rows a fresh, monotonically-increasing order_idx anchored
-- above the current max per procedure.
-- ============================================================================

-- De-dupe existing rows (if any) before the constraint goes on.
-- Strategy: per procedure, walk rows ordered by (uploaded_at, id) and
-- assign order_idx = row_number()-1.
with renumbered as (
  select
    id,
    procedure_id,
    row_number() over (
      partition by procedure_id
      order by order_idx, uploaded_at, id
    ) - 1 as new_idx
  from public.procedure_videos
)
update public.procedure_videos v
set order_idx = r.new_idx
from renumbered r
where v.id = r.id
  and v.order_idx is distinct from r.new_idx;

alter table public.procedure_videos
  add constraint procedure_videos_procedure_order_unique
  unique (procedure_id, order_idx);
