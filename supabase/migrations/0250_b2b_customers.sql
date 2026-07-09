-- B2B customer portal — Phase 1: identity + org-side management.
-- (Spec: docs/superpowers/specs/2026-07-09-b2b-portal-design.md)
--
-- Introduces the CUSTOMER principal: an org's B2B buyer (a company) whose
-- portal users are real auth users mapped through customer_users — never
-- organization_members, so they can never see the dashboard. Pricing is
-- EXPLICIT-ONLY via price lists (an item with no price-list row is invisible
-- to the portal — decided default), and each customer optionally gets a
-- catalog allowlist.
--
-- Phase 1 ships ONLY the org-side surface: org members read, managers (or
-- customers:manage grantees) write. The customer-principal SELECT policies
-- land with the portal itself (P2) so the new principal's read surface ships
-- together with the pgTAP that proves it.

-- ── 1. customers:manage permission seed (mirrors ROLE_PERMISSIONS in core;
--       the 0207 parity pgTAP counts these rows) ─────────────────────────────
insert into public.role_default_permissions (role, permission) values
  ('admin', 'customers:manage'),
  ('manager', 'customers:manage')
on conflict do nothing;

-- ── 2. Tables ────────────────────────────────────────────────────────────────
create table if not exists public.customers (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null check (length(name) between 1 and 200),
  status          text not null default 'active' check (status in ('active', 'archived')),
  price_list_id   uuid,
  notes           text check (notes is null or length(notes) <= 2000),
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.price_lists (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null check (length(name) between 1 and 200),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- customers.price_list_id → price_lists (added after both tables exist).
alter table public.customers
  add constraint customers_price_list_fk
  foreign key (price_list_id) references public.price_lists(id) on delete set null;

create table if not exists public.price_list_items (
  price_list_id uuid not null references public.price_lists(id) on delete cascade,
  item_id       uuid not null references public.inventory_items(id) on delete cascade,
  unit_price    numeric(14,4) not null check (unit_price >= 0),
  created_at    timestamptz not null default now(),
  primary key (price_list_id, item_id)
);

create table if not exists public.customer_users (
  customer_id uuid not null references public.customers(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  email       text not null,
  invited_by  uuid references auth.users(id) on delete set null,
  invited_at  timestamptz not null default now(),
  accepted_at timestamptz,
  primary key (customer_id, user_id)
);

create table if not exists public.customer_catalog (
  customer_id uuid not null references public.customers(id) on delete cascade,
  item_id     uuid not null references public.inventory_items(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (customer_id, item_id)
);

-- Portal orders hang off the existing pipeline: one nullable FK.
alter table public.order_requests
  add column if not exists customer_id uuid references public.customers(id) on delete set null;

-- ── 3. Indexes ───────────────────────────────────────────────────────────────
create index if not exists customers_org_idx on public.customers (organization_id, status);
create index if not exists price_lists_org_idx on public.price_lists (organization_id);
create index if not exists customer_users_user_idx on public.customer_users (user_id);
create index if not exists order_requests_customer_idx
  on public.order_requests (customer_id) where customer_id is not null;

-- updated_at maintenance (same trigger fn every other table uses).
create trigger trg_customers_updated_at
  before update on public.customers
  for each row execute function public.tg_set_updated_at();
create trigger trg_price_lists_updated_at
  before update on public.price_lists
  for each row execute function public.tg_set_updated_at();

-- ── 4. RLS — org-side only (customer-principal reads arrive in P2) ──────────
alter table public.customers enable row level security;
alter table public.price_lists enable row level security;
alter table public.price_list_items enable row level security;
alter table public.customer_users enable row level security;
alter table public.customer_catalog enable row level security;

-- Members read; manager-or-grantee writes (0208 additive posture).
create policy customers_select on public.customers for select
  using (( select public.is_org_member(customers.organization_id) ));
create policy customers_write on public.customers for all
  using (
    ( select public.has_org_role(customers.organization_id, 'manager') )
    or ( select public.has_permission(customers.organization_id, 'customers:manage') )
  )
  with check (
    ( select public.has_org_role(customers.organization_id, 'manager') )
    or ( select public.has_permission(customers.organization_id, 'customers:manage') )
  );

create policy price_lists_select on public.price_lists for select
  using (( select public.is_org_member(price_lists.organization_id) ));
create policy price_lists_write on public.price_lists for all
  using (
    ( select public.has_org_role(price_lists.organization_id, 'manager') )
    or ( select public.has_permission(price_lists.organization_id, 'customers:manage') )
  )
  with check (
    ( select public.has_org_role(price_lists.organization_id, 'manager') )
    or ( select public.has_permission(price_lists.organization_id, 'customers:manage') )
  );

-- Child tables resolve their org through the parent row (uncorrelated
-- one-row subqueries — cheap, and the parent's RLS already proved org scope).
create policy price_list_items_select on public.price_list_items for select
  using (exists (
    select 1 from public.price_lists pl
    where pl.id = price_list_items.price_list_id
      and ( select public.is_org_member(pl.organization_id) )
  ));
create policy price_list_items_write on public.price_list_items for all
  using (exists (
    select 1 from public.price_lists pl
    where pl.id = price_list_items.price_list_id
      and (
        ( select public.has_org_role(pl.organization_id, 'manager') )
        or ( select public.has_permission(pl.organization_id, 'customers:manage') )
      )
  ))
  with check (exists (
    select 1 from public.price_lists pl
    where pl.id = price_list_items.price_list_id
      and (
        ( select public.has_org_role(pl.organization_id, 'manager') )
        or ( select public.has_permission(pl.organization_id, 'customers:manage') )
      )
  ));

create policy customer_users_select on public.customer_users for select
  using (exists (
    select 1 from public.customers cu
    where cu.id = customer_users.customer_id
      and ( select public.is_org_member(cu.organization_id) )
  ));
create policy customer_users_write on public.customer_users for all
  using (exists (
    select 1 from public.customers cu
    where cu.id = customer_users.customer_id
      and (
        ( select public.has_org_role(cu.organization_id, 'manager') )
        or ( select public.has_permission(cu.organization_id, 'customers:manage') )
      )
  ))
  with check (exists (
    select 1 from public.customers cu
    where cu.id = customer_users.customer_id
      and (
        ( select public.has_org_role(cu.organization_id, 'manager') )
        or ( select public.has_permission(cu.organization_id, 'customers:manage') )
      )
  ));

create policy customer_catalog_select on public.customer_catalog for select
  using (exists (
    select 1 from public.customers cu
    where cu.id = customer_catalog.customer_id
      and ( select public.is_org_member(cu.organization_id) )
  ));
create policy customer_catalog_write on public.customer_catalog for all
  using (exists (
    select 1 from public.customers cu
    where cu.id = customer_catalog.customer_id
      and (
        ( select public.has_org_role(cu.organization_id, 'manager') )
        or ( select public.has_permission(cu.organization_id, 'customers:manage') )
      )
  ))
  with check (exists (
    select 1 from public.customers cu
    where cu.id = customer_catalog.customer_id
      and (
        ( select public.has_org_role(cu.organization_id, 'manager') )
        or ( select public.has_permission(cu.organization_id, 'customers:manage') )
      )
  ));
