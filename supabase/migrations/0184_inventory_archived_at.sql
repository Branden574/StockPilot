-- 0184_inventory_archived_at.sql
--
-- Track WHEN an item was archived, so the opt-in "auto-delete archived items"
-- cron can soft-delete items that have sat archived past an org's chosen
-- retention window.
--
-- A BEFORE INSERT/UPDATE trigger maintains archived_at for EVERY archive path
-- (manual archive, bulk archive, PO-cancel cleanup, receipt auto-unarchive),
-- so no service code has to remember to set/clear it:
--   * status -> 'archived'  sets archived_at = now()
--   * status leaves 'archived' clears archived_at (so re-archiving later starts
--     a fresh clock and an un-archived item is never auto-deleted)
--
-- Soft-delete only (deleted_at) — never a hard delete — so historical POs /
-- receipts that reference the item still resolve and an admin can recover it.

alter table public.inventory_items
  add column if not exists archived_at timestamptz;

create or replace function public.tg_inventory_set_archived_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'archived' and new.archived_at is null then
      new.archived_at := now();
    end if;
    return new;
  end if;
  -- UPDATE
  if new.status = 'archived' and old.status is distinct from 'archived' then
    new.archived_at := now();
  elsif new.status <> 'archived' and old.status = 'archived' then
    new.archived_at := null;
  end if;
  return new;
end$$;

drop trigger if exists inventory_items_set_archived_at on public.inventory_items;
create trigger inventory_items_set_archived_at
  before insert or update on public.inventory_items
  for each row execute function public.tg_inventory_set_archived_at();

-- Backfill existing archived rows with a best-effort proxy (last-touched time).
-- Conservative: a recently-edited archived item won't be eligible for deletion
-- until the retention window passes from its updated_at.
update public.inventory_items
  set archived_at = updated_at
  where status = 'archived' and archived_at is null and deleted_at is null;

-- Supports the cron's per-org "archived older than N days" scan.
create index if not exists inventory_items_archived_at_idx
  on public.inventory_items (organization_id, archived_at)
  where status = 'archived' and deleted_at is null;
