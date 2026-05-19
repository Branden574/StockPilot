-- 0131_rentals.sql
--
-- Rentals: internal accountability checkout/return tracking for
-- circulating assets (canopies, supplies) that staff loan to
-- employees and vendors. No money — just "who has the canopy and
-- when's it coming back."
--
-- See docs/superpowers/specs/2026-05-19-rentals-design.md
--
-- Three changes:
-- 1. inventory_items.is_rental boolean — partitions items into
--    a regular inventory class (default) vs. a rental class. Every
--    existing read path will filter is_rental=false in a follow-up
--    commit so canopies never show up on /dashboard/inventory or
--    the order picker.
-- 2. rentals — one row per rental (borrower, dates, status).
-- 3. rental_lines — one row per item + qty within a rental.
--
-- Stock impact: rentals reuse the existing stock_reservations table
-- with reference_type='rental' so the order picker's
-- available-to-promise math (qty_on_hand - active_reservations)
-- automatically reflects rented-out items. No new math threaded
-- through other surfaces.

-- ─────────────────────────────────────────────────────────────────────
-- 1) inventory_items.is_rental flag
-- ─────────────────────────────────────────────────────────────────────
alter table public.inventory_items
  add column if not exists is_rental boolean not null default false;

create index if not exists inventory_items_is_rental_idx
  on public.inventory_items(organization_id, is_rental)
  where deleted_at is null;

-- ─────────────────────────────────────────────────────────────────────
-- 2) rentals — one row per rental transaction
--
-- borrower_user_id is nullable because most renters at this charter
-- school don't have system accounts (vendors, parent volunteers).
-- borrower_name is always populated — when borrower_user_id is set,
-- the service copies the member's display name into borrower_name
-- on create so list views never need to join across to user_profiles
-- just to render a row.
-- ─────────────────────────────────────────────────────────────────────
create table public.rentals (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  warehouse_id          uuid not null references public.warehouses(id) on delete restrict,
  borrower_user_id      uuid references public.user_profiles(id) on delete set null,
  borrower_name         text not null,
  borrower_email        text,
  checked_out_at        timestamptz not null default now(),
  expected_return_at    timestamptz not null,
  returned_at           timestamptz,
  status                text not null
                        check (status in ('out','returned','cancelled'))
                        default 'out',
  notes                 text,
  created_by            uuid references public.user_profiles(id) on delete set null,
  cancelled_by          uuid references public.user_profiles(id) on delete set null,
  cancelled_at          timestamptz,
  cancellation_reason   text,
  returned_by           uuid references public.user_profiles(id) on delete set null,
  return_notes          text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index rentals_org_status_idx     on public.rentals(organization_id, status);
create index rentals_warehouse_idx       on public.rentals(warehouse_id);
create index rentals_borrower_user_idx   on public.rentals(borrower_user_id)
  where borrower_user_id is not null;
-- Partial index supports "show me overdue rentals" — the only
-- expected return date queries we run filter status='out'.
create index rentals_expected_return_idx on public.rentals(expected_return_at)
  where status = 'out';

create trigger rentals_set_updated_at
  before update on public.rentals
  for each row execute function public.tg_set_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- 3) rental_lines — items within a rental
-- ─────────────────────────────────────────────────────────────────────
create table public.rental_lines (
  id           uuid primary key default gen_random_uuid(),
  rental_id    uuid not null references public.rentals(id) on delete cascade,
  item_id      uuid not null references public.inventory_items(id) on delete restrict,
  quantity     numeric(14,4) not null check (quantity > 0),
  notes        text,
  created_at   timestamptz not null default now()
);

create index rental_lines_rental_idx on public.rental_lines(rental_id);
create index rental_lines_item_idx   on public.rental_lines(item_id);

-- ─────────────────────────────────────────────────────────────────────
-- 4) RLS
--
-- Reads + writes both gate on warehouse access — same helper that
-- inventory_items uses. RLS doesn't enforce the staff/manager split
-- (that's the service layer's job via assertPermission), only the
-- warehouse-scope split.
-- ─────────────────────────────────────────────────────────────────────
alter table public.rentals enable row level security;
alter table public.rental_lines enable row level security;

create policy rentals_select on public.rentals
  for select to authenticated
  using (public.user_can_access_warehouse(auth.uid(), warehouse_id, 'read'));

create policy rentals_insert on public.rentals
  for insert to authenticated
  with check (public.user_can_access_warehouse(auth.uid(), warehouse_id, 'write'));

create policy rentals_update on public.rentals
  for update to authenticated
  using      (public.user_can_access_warehouse(auth.uid(), warehouse_id, 'write'))
  with check (public.user_can_access_warehouse(auth.uid(), warehouse_id, 'write'));

create policy rentals_delete on public.rentals
  for delete to authenticated
  using (public.user_can_access_warehouse(auth.uid(), warehouse_id, 'write'));

create policy rental_lines_select on public.rental_lines
  for select to authenticated
  using (
    exists (
      select 1 from public.rentals r
      where r.id = rental_lines.rental_id
        and public.user_can_access_warehouse(auth.uid(), r.warehouse_id, 'read')
    )
  );

create policy rental_lines_insert on public.rental_lines
  for insert to authenticated
  with check (
    exists (
      select 1 from public.rentals r
      where r.id = rental_lines.rental_id
        and public.user_can_access_warehouse(auth.uid(), r.warehouse_id, 'write')
    )
  );

create policy rental_lines_update on public.rental_lines
  for update to authenticated
  using (
    exists (
      select 1 from public.rentals r
      where r.id = rental_lines.rental_id
        and public.user_can_access_warehouse(auth.uid(), r.warehouse_id, 'write')
    )
  )
  with check (
    exists (
      select 1 from public.rentals r
      where r.id = rental_lines.rental_id
        and public.user_can_access_warehouse(auth.uid(), r.warehouse_id, 'write')
    )
  );

create policy rental_lines_delete on public.rental_lines
  for delete to authenticated
  using (
    exists (
      select 1 from public.rentals r
      where r.id = rental_lines.rental_id
        and public.user_can_access_warehouse(auth.uid(), r.warehouse_id, 'write')
    )
  );

grant select, insert, update, delete on public.rentals to authenticated;
grant select, insert, update, delete on public.rental_lines to authenticated;
