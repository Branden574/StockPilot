-- 0072_deleted_by_columns.sql
-- Adds a `deleted_by uuid` column to every soft-deletable table so the
-- Recovery page can show WHO archived each row, not just when. Backfills
-- from audit_logs where possible (categories / locations / suppliers
-- already emit X.archived events with actor user_id). inventory_items
-- stays null on the backfill because the inventory service does not
-- yet emit an item.archived audit event — a separate follow-up will
-- add the emission, after which new soft-deletes will populate the
-- column live.
--
-- Tables touched:
--   - inventory_items  (soft-delete path: services/inventory.softDelete)
--   - categories       (soft-delete path: services/categories.archive)
--   - locations        (soft-delete path: services/locations.archive)
--   - suppliers        (soft-delete path: services/suppliers.archive)
--
-- ON DELETE SET NULL on the FK so removing a user doesn't cascade-
-- destroy the deletion history — the row stays restorable, just
-- "deleted by (former member)".

alter table public.inventory_items
  add column if not exists deleted_by uuid references public.user_profiles(id) on delete set null;

alter table public.categories
  add column if not exists deleted_by uuid references public.user_profiles(id) on delete set null;

alter table public.locations
  add column if not exists deleted_by uuid references public.user_profiles(id) on delete set null;

alter table public.suppliers
  add column if not exists deleted_by uuid references public.user_profiles(id) on delete set null;

-- Backfill: for categories / locations / suppliers, look up the most
-- recent X.archived audit event for each soft-deleted row and copy the
-- actor's user_id. The audit_logs.metadata JSONB has shape:
--   { entity_type: 'category' | 'location' | 'supplier', entity_id: '<uuid>' }
-- and the actor is `audit_logs.user_id`. Items skipped per header note.

with latest as (
  select distinct on ((al.metadata->>'entity_id')::uuid)
    (al.metadata->>'entity_id')::uuid as entity_id,
    al.user_id as actor_id
  from public.audit_logs al
  where al.event = 'category.archived'
    and al.metadata->>'entity_id' is not null
    and al.user_id is not null
  order by (al.metadata->>'entity_id')::uuid, al.created_at desc
)
update public.categories c
set deleted_by = latest.actor_id
from latest
where c.id = latest.entity_id
  and c.deleted_at is not null
  and c.deleted_by is null;

with latest as (
  select distinct on ((al.metadata->>'entity_id')::uuid)
    (al.metadata->>'entity_id')::uuid as entity_id,
    al.user_id as actor_id
  from public.audit_logs al
  where al.event = 'location.archived'
    and al.metadata->>'entity_id' is not null
    and al.user_id is not null
  order by (al.metadata->>'entity_id')::uuid, al.created_at desc
)
update public.locations l
set deleted_by = latest.actor_id
from latest
where l.id = latest.entity_id
  and l.deleted_at is not null
  and l.deleted_by is null;

with latest as (
  select distinct on ((al.metadata->>'entity_id')::uuid)
    (al.metadata->>'entity_id')::uuid as entity_id,
    al.user_id as actor_id
  from public.audit_logs al
  where al.event = 'supplier.archived'
    and al.metadata->>'entity_id' is not null
    and al.user_id is not null
  order by (al.metadata->>'entity_id')::uuid, al.created_at desc
)
update public.suppliers s
set deleted_by = latest.actor_id
from latest
where s.id = latest.entity_id
  and s.deleted_at is not null
  and s.deleted_by is null;
