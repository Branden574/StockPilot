-- 0011_vendor_item_mappings.sql
-- ─────────────────────────────────────────────────────────────────────
-- Persistent vendor-item-number → internal-item-id mappings, plus
-- extending the purchase_orders status enum so an approved PO import
-- can sit in 'expected_inbound' before any receipt has been posted.
-- ─────────────────────────────────────────────────────────────────────

set check_function_bodies = off;

-- ─────────────────────────────────────────────────────────────────────
-- vendor_item_mappings
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.vendor_item_mappings (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  vendor_id             uuid not null references public.suppliers(id) on delete cascade,
  item_id               uuid not null references public.inventory_items(id) on delete cascade,
  vendor_item_number    text,
  vendor_product_number text,
  auxiliary_number      text,
  vendor_description    text,
  vendor_uom            text,
  pack_qty              numeric(18,4),
  conversion_factor     numeric(18,4),
  confidence_score      numeric(4,3),
  match_source          text not null default 'manual'
                          check (match_source in ('manual','learned','imported')),
  approved_by           uuid references public.user_profiles(id) on delete set null,
  approved_at           timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- A vendor cannot have two mappings pointing to different items for the
-- same vendor_item_number (case-insensitive).
create unique index if not exists vim_vendor_itemnum_uniq
  on public.vendor_item_mappings(organization_id, vendor_id, lower(vendor_item_number))
  where vendor_item_number is not null;

create index if not exists vim_item_idx
  on public.vendor_item_mappings(item_id);

create trigger vendor_item_mappings_updated_at
  before update on public.vendor_item_mappings
  for each row execute function public.tg_set_updated_at();

alter table public.vendor_item_mappings enable row level security;

drop policy if exists vim_select on public.vendor_item_mappings;
create policy vim_select on public.vendor_item_mappings
  for select using (
    exists (
      select 1 from public.organization_members m
      where m.user_id = auth.uid()
        and m.organization_id = vendor_item_mappings.organization_id
        and m.accepted_at is not null
    )
  );

drop policy if exists vim_admin_write on public.vendor_item_mappings;
create policy vim_admin_write on public.vendor_item_mappings
  for all using (public.has_org_role(organization_id, 'manager'));

-- ─────────────────────────────────────────────────────────────────────
-- purchase_orders status: add 'expected_inbound'
-- Original CHECK was: status in ('draft','ordered','partially_received','received','cancelled')
-- Replace with one that includes the new value AND keeps every old value
-- for backward compat. 'expected_inbound' is the post-approval state used
-- by imports; 'ordered' remains for manually-created POs.
-- ─────────────────────────────────────────────────────────────────────
alter table public.purchase_orders drop constraint if exists purchase_orders_status_check;
alter table public.purchase_orders
  add constraint purchase_orders_status_check
  check (status in (
    'draft',
    'expected_inbound',
    'ordered',
    'partially_received',
    'received',
    'cancelled'
  ));
