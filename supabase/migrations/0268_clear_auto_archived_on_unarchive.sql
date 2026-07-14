-- 0268_clear_auto_archived_on_unarchive.sql
--
-- Invariant: inventory_items.auto_archived = true must ONLY hold while
-- status = 'archived'. auto_archived is a system-vs-manual flag (0266) that
-- the cron uses to pick auto-archive candidates (inventory_items_auto_archive_idx
-- filters on auto_archived = false), that the "Auto-archived" badge reads to
-- distinguish system archives from manual ones, and that receiving's
-- revive-guard checks before silently reactivating an item. If an item ever
-- leaves 'archived' with auto_archived left true, all three break: the cron
-- would skip re-flagging it correctly, the badge would show on an active
-- item, and the revive-guard's assumptions would be wrong.
--
-- Today the invariant is only enforced on the two paths that were built
-- alongside it: _auto_restock_restore's self-UPDATE (0266) and
-- InventoryService.bulkUpdate's explicit archive/unarchive branches. It is
-- NOT enforced for a plain status-only write — set_status(), or update()
-- with a status patch — because no UI control exercises those paths today.
-- That makes the gap dormant, not safe: the moment any status control (a
-- manual "Unarchive" button, an admin tool, a future API) is wired to one of
-- those generic paths, it would flip status back to 'active' while leaving
-- auto_archived = true, corrupting the cron candidate query, the badge, and
-- the revive-guard with no error anywhere.
--
-- Close it centrally instead of hunting down every call site: a single
-- BEFORE UPDATE OF status trigger normalizes auto_archived on every write,
-- present or future, in TS services, the REST API, or the platform admin
-- console. Pure NEW mutation, no self-UPDATE, so it cannot recurse and it
-- composes cleanly with the other BEFORE triggers on this column set:
--   * 0266's trg_inventory_track_zero_since fires on quantity_on_hand, not
--     status — disjoint column set, no interaction.
--   * 0184's inventory_items_set_archived_at fires on insert-or-update and
--     maintains archived_at, a different column — no conflict, both BEFORE
--     triggers apply their own NEW mutation independently.
--   * The cron's own archive write (status -> 'archived', auto_archived ->
--     true) leaves new.status = 'archived', so this trigger's condition is
--     false and auto_archived is left exactly as the cron set it.
--   * _auto_restock_restore's self-UPDATE (status -> 'active', auto_archived
--     -> false) already sets auto_archived to false, so this trigger is a
--     no-op there too — it only ever *changes* behavior for a write that
--     leaves 'archived' while (bug-prone) still carrying auto_archived = true.

create or replace function public._clear_auto_archived_on_unarchive()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from 'archived' and new.auto_archived then
    new.auto_archived := false;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_inventory_clear_auto_archived on public.inventory_items;
create trigger trg_inventory_clear_auto_archived
  before update of status on public.inventory_items
  for each row execute function public._clear_auto_archived_on_unarchive();
