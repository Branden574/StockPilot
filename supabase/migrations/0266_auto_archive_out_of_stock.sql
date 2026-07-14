-- 0266_auto_archive_out_of_stock.sql
-- Per-org auto-archive of items that stay out of stock (quantity_on_hand<=0)
-- past a grace period. This migration adds the state columns + the two triggers
-- that maintain them; the daily cron (app-layer) does the actual archiving.

alter table public.inventory_items
  add column if not exists zero_since    timestamptz,
  add column if not exists auto_archived boolean not null default false;

comment on column public.inventory_items.zero_since is
  'When quantity_on_hand last crossed from >0 to <=0. NULL while in stock. Set/cleared by _track_zero_since; the dwell clock for auto-archive.';
comment on column public.inventory_items.auto_archived is
  'True only when the system auto-archived this item on zero-stock. Cleared on restore. Distinguishes system vs manual archives; gates auto-restore-on-restock.';

-- Cron scan index: only active, never-auto-archived, currently-at-zero rows.
create index if not exists inventory_items_auto_archive_idx
  on public.inventory_items (organization_id, zero_since)
  where status = 'active' and auto_archived = false and zero_since is not null;

-- BEFORE trigger: maintain zero_since. Pure NEW mutation, no status change, so
-- it never touches the 0184 archived_at trigger and cannot recurse.
create or replace function public._track_zero_since()
returns trigger
language plpgsql
as $$
begin
  if old.quantity_on_hand > 0 and new.quantity_on_hand <= 0 then
    new.zero_since := now();
  elsif old.quantity_on_hand <= 0 and new.quantity_on_hand > 0 then
    new.zero_since := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_inventory_track_zero_since on public.inventory_items;
create trigger trg_inventory_track_zero_since
  before update of quantity_on_hand on public.inventory_items
  for each row execute function public._track_zero_since();

-- AFTER trigger: instant restore of SYSTEM-archived items on restock. Guarded
-- self-UPDATE (AFTER can't mutate NEW). The self-UPDATE changes status only, so
-- it does NOT re-fire the OF quantity_on_hand triggers (this one, _track_zero_since,
-- or the 0091 low-stock trigger) and DOES fire 0184 to clear archived_at.
-- NOT gated on the org toggle: restoring a restocked item is always safe.
create or replace function public._auto_restock_restore()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.quantity_on_hand <= 0 and new.quantity_on_hand > 0 then
    update public.inventory_items
       set status = 'active', auto_archived = false, updated_by = new.updated_by
     where id = new.id and status = 'archived' and auto_archived = true;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_inventory_auto_restock_restore on public.inventory_items;
create trigger trg_inventory_auto_restock_restore
  after update of quantity_on_hand on public.inventory_items
  for each row execute function public._auto_restock_restore();
