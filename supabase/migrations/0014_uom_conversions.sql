-- 0014_uom_conversions.sql
-- ─────────────────────────────────────────────────────────────────────
-- Per-item UoM conversions. Vendors ship items in PK / BX / CT, but we
-- track stock in a base UoM (usually EA). A receipt of "1 PK" needs
-- to bump stock by N in the base UoM, where N is item-specific.
--
-- Design rules:
--   • Conversions are PER-ITEM, not global. "1 PK" is 24 EA for AA
--     batteries, 6 EA for envelopes, 250 EA for paper plates.
--   • Numerator/denominator stored as integers to avoid float drift.
--   • Missing conversion = block the receipt. We never silently guess.
--   • Identity (EA → EA) and inverse (EA → PK) are derived in code,
--     not stored, to keep this table single-direction.
-- ─────────────────────────────────────────────────────────────────────

set check_function_bodies = off;

create table if not exists public.uom_conversions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  item_id         uuid not null references public.inventory_items(id) on delete cascade,
  from_uom        text not null,              -- e.g. 'PK'
  to_uom          text not null,              -- e.g. 'EA'
  numerator       integer not null check (numerator > 0),     -- 24 in "1 PK = 24 EA"
  denominator     integer not null default 1 check (denominator > 0),
  rounding_rule   text not null default 'exact'
                    check (rounding_rule in ('exact','floor','ceil','round')),
  created_by      uuid references public.user_profiles(id),
  approved_by     uuid references public.user_profiles(id),
  approved_at     timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, item_id, from_uom, to_uom)
);

create index if not exists uom_conversions_item_idx
  on public.uom_conversions(item_id);

create trigger uom_conversions_updated_at
  before update on public.uom_conversions
  for each row execute function public.tg_set_updated_at();

alter table public.uom_conversions enable row level security;

drop policy if exists uom_conversions_select on public.uom_conversions;
create policy uom_conversions_select on public.uom_conversions
  for select using (
    exists (
      select 1 from public.organization_members m
      where m.user_id = auth.uid()
        and m.organization_id = uom_conversions.organization_id
        and m.accepted_at is not null
    )
  );

drop policy if exists uom_conversions_write on public.uom_conversions;
create policy uom_conversions_write on public.uom_conversions
  for all using (public.has_org_role(organization_id, 'manager'));
