-- 0008_warehouse_charters.sql
-- ─────────────────────────────────────────────────────────────────────
-- Pivot warehouse ↔ charter from 1:1 to many-to-many.
--
-- Why:
--   • A warehouse may service several charters out of one physical site.
--   • Inventory carried at a warehouse may be earmarked for one charter
--     OR be "generic" stock usable by any charter the warehouse services
--     (consumables, packaging, shared tools).
--   • Users may be scoped to (warehouse, charter) intersections, or to a
--     warehouse as a whole (all charters there).
--
-- Shape after this migration:
--   warehouse_charters (warehouse_id, charter_id)        — junction
--   inventory_items.charter_id (NULLABLE)                — generic if null
--                  + composite FK → warehouse_charters   — non-null pairs only
--   user_warehouse_assignments.charter_id                — NULL = all charters
--                  + composite FK → warehouse_charters
-- ─────────────────────────────────────────────────────────────────────

set check_function_bodies = off;

-- ─────────────────────────────────────────────────────────────────────
-- 1) Junction table: warehouse_charters
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.warehouse_charters (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  warehouse_id    uuid not null references public.warehouses(id)    on delete cascade,
  charter_id      uuid not null references public.charters(id)      on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (warehouse_id, charter_id)
);
create index if not exists warehouse_charters_org_idx
  on public.warehouse_charters(organization_id);
create index if not exists warehouse_charters_charter_idx
  on public.warehouse_charters(charter_id);

-- ─────────────────────────────────────────────────────────────────────
-- 2) Backfill from the existing 1:1 warehouses.charter_id
-- ─────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'warehouses'
      and column_name  = 'charter_id'
  ) then
    insert into public.warehouse_charters (organization_id, warehouse_id, charter_id)
    select w.organization_id, w.id, w.charter_id
    from public.warehouses w
    where w.charter_id is not null
    on conflict do nothing;
  end if;
end$$;

-- ─────────────────────────────────────────────────────────────────────
-- 3) Add inventory_items.charter_id (NULLABLE — null = generic stock).
-- ─────────────────────────────────────────────────────────────────────
alter table public.inventory_items
  add column if not exists charter_id uuid references public.charters(id) on delete restrict;

-- Backfill items: pick the warehouse's prior single charter as a starting
-- point. Items in unmapped warehouses stay NULL (generic).
update public.inventory_items i
set charter_id = wc.charter_id
from public.warehouse_charters wc
where i.charter_id is null
  and i.warehouse_id is not null
  and wc.warehouse_id = i.warehouse_id;

create index if not exists inventory_items_charter_idx
  on public.inventory_items(organization_id, charter_id)
  where deleted_at is null;
create index if not exists inventory_items_wh_charter_idx
  on public.inventory_items(organization_id, warehouse_id, charter_id)
  where deleted_at is null;

-- Composite FK: if charter_id is NOT NULL, the (warehouse, charter) pair
-- must exist in warehouse_charters. NULL charter_id is a permitted
-- "generic" case — MATCH SIMPLE skips the check when any column is null.
alter table public.inventory_items
  drop constraint if exists inventory_items_warehouse_charter_fk;
alter table public.inventory_items
  add constraint inventory_items_warehouse_charter_fk
  foreign key (warehouse_id, charter_id)
  references public.warehouse_charters(warehouse_id, charter_id)
  on update cascade
  on delete restrict;

-- ─────────────────────────────────────────────────────────────────────
-- 4) Drop the obsolete 1:1 warehouses.charter_id column.
-- ─────────────────────────────────────────────────────────────────────
alter table public.warehouses drop column if exists charter_id;

-- ─────────────────────────────────────────────────────────────────────
-- 5) user_warehouse_assignments: allow either one "all charters" row
--    (charter_id null) per (user, warehouse) OR multiple specific-charter
--    rows per (user, warehouse). Never duplicates of either.
-- ─────────────────────────────────────────────────────────────────────
alter table public.user_warehouse_assignments
  drop constraint if exists user_warehouse_assignments_user_id_warehouse_id_key;

create unique index if not exists uwa_user_wh_no_charter_uniq
  on public.user_warehouse_assignments(user_id, warehouse_id)
  where charter_id is null;
create unique index if not exists uwa_user_wh_charter_uniq
  on public.user_warehouse_assignments(user_id, warehouse_id, charter_id)
  where charter_id is not null;

-- Composite FK so a charter-scoped assignment is forced to be a charter
-- the warehouse actually services.
alter table public.user_warehouse_assignments
  drop constraint if exists uwa_warehouse_charter_fk;
alter table public.user_warehouse_assignments
  add constraint uwa_warehouse_charter_fk
  foreign key (warehouse_id, charter_id)
  references public.warehouse_charters(warehouse_id, charter_id)
  on update cascade
  on delete cascade;
-- ^ MATCH SIMPLE: NULL charter_id (the "all charters" case) is exempted.

-- ─────────────────────────────────────────────────────────────────────
-- 6) New access helper: user_can_access_inventory(uid, wh, ch, op)
--
-- Rules:
--   • owner / admin / manager in the org → always true.
--   • Otherwise: there must be a user_warehouse_assignment for this user
--     and warehouse where:
--       (assignment.charter_id IS NULL  -- assignment grants all charters)
--       OR (p_charter_id IS NULL        -- item is generic stock)
--       OR (assignment.charter_id = p_charter_id)
--   • Viewers can only read.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.user_can_access_inventory(
  p_user_id      uuid,
  p_warehouse_id uuid,
  p_charter_id   uuid,
  p_op           text default 'read'
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with wh as (
    select organization_id from public.warehouses where id = p_warehouse_id
  ),
  member as (
    select m.role
    from public.organization_members m
    join wh on wh.organization_id = m.organization_id
    where m.user_id = p_user_id
      and m.accepted_at is not null
  )
  select
    -- Manager+ has full access
    exists (select 1 from member where role in ('owner', 'admin', 'manager'))
    or exists (
      select 1
      from public.user_warehouse_assignments uwa
      join member on true
      where uwa.user_id = p_user_id
        and uwa.warehouse_id = p_warehouse_id
        and (
              uwa.charter_id is null
           or p_charter_id is null
           or uwa.charter_id = p_charter_id
        )
        and (p_op = 'read' or member.role <> 'viewer')
    );
$$;

grant execute on function public.user_can_access_inventory(uuid, uuid, uuid, text)
  to authenticated, anon, service_role;

-- ─────────────────────────────────────────────────────────────────────
-- 7) RLS on inventory_items uses the new helper (replaces warehouse-only)
-- ─────────────────────────────────────────────────────────────────────
drop policy if exists inventory_items_select on public.inventory_items;
create policy inventory_items_select on public.inventory_items
  for select using (
    public.user_can_access_inventory(auth.uid(), warehouse_id, charter_id, 'read')
  );

drop policy if exists inventory_items_insert on public.inventory_items;
create policy inventory_items_insert on public.inventory_items
  for insert with check (
    public.user_can_access_inventory(auth.uid(), warehouse_id, charter_id, 'write')
  );

drop policy if exists inventory_items_update on public.inventory_items;
create policy inventory_items_update on public.inventory_items
  for update
  using      (public.user_can_access_inventory(auth.uid(), warehouse_id, charter_id, 'write'))
  with check (public.user_can_access_inventory(auth.uid(), warehouse_id, charter_id, 'write'));

drop policy if exists inventory_items_delete on public.inventory_items;
create policy inventory_items_delete on public.inventory_items
  for delete using (
    public.user_can_access_inventory(auth.uid(), warehouse_id, charter_id, 'write')
  );

-- ─────────────────────────────────────────────────────────────────────
-- 8) RLS on the new junction table
-- ─────────────────────────────────────────────────────────────────────
alter table public.warehouse_charters enable row level security;

drop policy if exists wc_select on public.warehouse_charters;
create policy wc_select on public.warehouse_charters
  for select using (
    exists (
      select 1 from public.organization_members m
      where m.user_id = auth.uid()
        and m.organization_id = warehouse_charters.organization_id
        and m.accepted_at is not null
    )
  );

drop policy if exists wc_admin_write on public.warehouse_charters;
create policy wc_admin_write on public.warehouse_charters
  for all using (
    exists (
      select 1 from public.organization_members m
      where m.user_id = auth.uid()
        and m.organization_id = warehouse_charters.organization_id
        and m.role in ('owner', 'admin')
        and m.accepted_at is not null
    )
  );
