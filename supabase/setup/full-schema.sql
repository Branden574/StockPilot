-- ============================================================================
-- 0001_init.sql — Extensions, helper functions, identity tables
-- Phase 1 foundation: organizations, user profiles, memberships, invites.
-- ============================================================================

-- Extensions ---------------------------------------------------------------
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";
create extension if not exists "citext";
-- pgvector available for AI features in Phase 9
create extension if not exists "vector" with schema extensions;

-- Common: updated_at trigger ----------------------------------------------
create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================================
-- ORGANIZATIONS
-- ============================================================================
create table public.organizations (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null check (length(name) between 1 and 200),
  slug                    citext unique not null check (length(slug) between 2 and 64),
  logo_url                text,
  industry                text,
  size                    text,
  timezone                text not null default 'UTC',
  currency                text not null default 'USD',
  plan                    text not null default 'free'
                          check (plan in ('free','pro','business','enterprise')),
  stripe_customer_id      text unique,
  stripe_subscription_id  text,
  trial_ends_at           timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function public.tg_set_updated_at();

create index organizations_plan_idx on public.organizations(plan);

-- ============================================================================
-- USER PROFILES (mirror of auth.users)
-- ============================================================================
create table public.user_profiles (
  id                       uuid primary key references auth.users(id) on delete cascade,
  email                    citext not null,
  full_name                text,
  avatar_url               text,
  default_organization_id  uuid references public.organizations(id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create trigger user_profiles_set_updated_at
  before update on public.user_profiles
  for each row execute function public.tg_set_updated_at();

create index user_profiles_email_idx on public.user_profiles(email);

-- Bootstrap a profile row whenever a new auth.users record is created.
create or replace function public.tg_handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do update
    set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.tg_handle_new_auth_user();

-- ============================================================================
-- ORGANIZATION MEMBERSHIPS
-- ============================================================================
create table public.organization_members (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  user_id          uuid not null references public.user_profiles(id) on delete cascade,
  role             text not null check (role in ('owner','admin','manager','staff','viewer')),
  invited_by       uuid references public.user_profiles(id) on delete set null,
  invited_at       timestamptz,
  accepted_at      timestamptz,
  created_at       timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index organization_members_user_idx on public.organization_members(user_id);
create index organization_members_org_idx  on public.organization_members(organization_id);

-- ============================================================================
-- ORGANIZATION INVITES
-- ============================================================================
create table public.organization_invites (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  email            citext not null,
  role             text not null check (role in ('admin','manager','staff','viewer')),
  token            text unique not null,
  expires_at       timestamptz not null,
  invited_by       uuid not null references public.user_profiles(id) on delete cascade,
  accepted_at      timestamptz,
  created_at       timestamptz not null default now()
);
create index organization_invites_token_idx on public.organization_invites(token);
create index organization_invites_org_email_idx on public.organization_invites(organization_id, email);

-- ============================================================================
-- HELPER FUNCTIONS — used by RLS and the application layer
-- ============================================================================

-- Returns true if the current auth.uid() is a member of the org.
create or replace function public.is_org_member(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1 from public.organization_members m
    where m.organization_id = org_id
      and m.user_id = auth.uid()
      and m.accepted_at is not null
  );
$$;

-- Returns the role of auth.uid() in the org, or null if not a member.
create or replace function public.user_org_role(org_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.organization_members
  where organization_id = org_id
    and user_id = auth.uid()
    and accepted_at is not null
  limit 1;
$$;

-- Returns true if auth.uid() has at least the requested role in the org.
create or replace function public.has_org_role(org_id uuid, min_role text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with role_rank(role, rank) as (
    values
      ('owner',   100),
      ('admin',    80),
      ('manager',  60),
      ('staff',    40),
      ('viewer',   20)
  ),
  user_role as (
    select rr.rank
    from public.organization_members m
    join role_rank rr on rr.role = m.role
    where m.organization_id = org_id
      and m.user_id = auth.uid()
      and m.accepted_at is not null
    limit 1
  )
  select coalesce((select rank from user_role), 0)
       >= coalesce((select rank from role_rank where role = min_role), 999);
$$;

-- ============================================================================
-- ENABLE RLS — policies defined in 0003_rls.sql
-- ============================================================================
alter table public.organizations         enable row level security;
alter table public.user_profiles         enable row level security;
alter table public.organization_members  enable row level security;
alter table public.organization_invites  enable row level security;
-- ============================================================================
-- 0002_inventory.sql — Core inventory schema
-- Categories, tags, locations, suppliers, items, stock movements,
-- purchase orders, notifications, activity logs, push tokens, imports.
-- ============================================================================

-- ============================================================================
-- TAXONOMY
-- ============================================================================
create table public.categories (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  parent_id        uuid references public.categories(id) on delete set null,
  name             text not null,
  description      text,
  color            text,
  icon             text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);
create trigger categories_set_updated_at
  before update on public.categories
  for each row execute function public.tg_set_updated_at();
create index categories_org_idx on public.categories(organization_id) where deleted_at is null;
create index categories_parent_idx on public.categories(parent_id);

create table public.tags (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  name             text not null,
  color            text,
  created_at       timestamptz not null default now(),
  unique (organization_id, name)
);
create index tags_org_idx on public.tags(organization_id);

-- ============================================================================
-- LOCATIONS
-- ============================================================================
create table public.locations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  parent_id        uuid references public.locations(id) on delete set null,
  name             text not null,
  type             text check (type in ('warehouse','room','shelf','bin','vehicle','jobsite','other')),
  address          jsonb,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);
create trigger locations_set_updated_at
  before update on public.locations
  for each row execute function public.tg_set_updated_at();
create index locations_org_idx on public.locations(organization_id) where deleted_at is null;

-- ============================================================================
-- SUPPLIERS
-- ============================================================================
create table public.suppliers (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  name             text not null,
  contact_name     text,
  email            citext,
  phone            text,
  website          text,
  address          jsonb,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);
create trigger suppliers_set_updated_at
  before update on public.suppliers
  for each row execute function public.tg_set_updated_at();
create index suppliers_org_idx on public.suppliers(organization_id) where deleted_at is null;

-- ============================================================================
-- INVENTORY ITEMS
-- ============================================================================
create table public.inventory_items (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete cascade,
  sku                  text not null,
  barcode              text,
  name                 text not null,
  description          text,
  category_id          uuid references public.categories(id) on delete set null,
  supplier_id          uuid references public.suppliers(id) on delete set null,
  primary_location_id  uuid references public.locations(id) on delete set null,
  unit_cost            numeric(14,4) not null default 0,
  retail_price         numeric(14,4) not null default 0,
  quantity_on_hand     numeric(14,4) not null default 0,
  reorder_point        numeric(14,4) not null default 0,
  reorder_quantity     numeric(14,4) not null default 0,
  unit_of_measure      text not null default 'unit',
  status               text not null default 'active'
                       check (status in ('active','archived','discontinued')),
  bin_location         text,
  custom_fields        jsonb not null default '{}'::jsonb,
  search_vector        tsvector,
  embedding            extensions.vector(1536),
  created_by           uuid references public.user_profiles(id) on delete set null,
  updated_by           uuid references public.user_profiles(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  unique (organization_id, sku)
);
create trigger inventory_items_set_updated_at
  before update on public.inventory_items
  for each row execute function public.tg_set_updated_at();
create index inventory_items_org_status_idx
  on public.inventory_items(organization_id, status) where deleted_at is null;
create index inventory_items_org_barcode_idx
  on public.inventory_items(organization_id, barcode) where barcode is not null;
create index inventory_items_search_idx
  on public.inventory_items using gin (search_vector);
create index inventory_items_low_stock_idx
  on public.inventory_items(organization_id, quantity_on_hand)
  where status = 'active' and deleted_at is null;

create or replace function public.tg_items_search_vector()
returns trigger
language plpgsql
as $$
begin
  new.search_vector :=
       setweight(to_tsvector('english', coalesce(new.name,'')), 'A')
    || setweight(to_tsvector('english', coalesce(new.sku,'')), 'A')
    || setweight(to_tsvector('english', coalesce(new.barcode,'')), 'B')
    || setweight(to_tsvector('english', coalesce(new.description,'')), 'C');
  return new;
end;
$$;

create trigger inventory_items_search_trigger
  before insert or update of name, sku, barcode, description on public.inventory_items
  for each row execute function public.tg_items_search_vector();

-- Per-location stock levels
create table public.item_stock_levels (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  item_id          uuid not null references public.inventory_items(id) on delete cascade,
  location_id      uuid not null references public.locations(id) on delete cascade,
  quantity         numeric(14,4) not null default 0,
  updated_at       timestamptz not null default now(),
  unique (item_id, location_id)
);
create trigger item_stock_levels_set_updated_at
  before update on public.item_stock_levels
  for each row execute function public.tg_set_updated_at();
create index item_stock_levels_org_loc_idx
  on public.item_stock_levels(organization_id, location_id);

create table public.item_images (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  item_id          uuid not null references public.inventory_items(id) on delete cascade,
  storage_path     text not null,
  alt              text,
  sort_order       int not null default 0,
  is_primary       boolean not null default false,
  created_at       timestamptz not null default now()
);
create index item_images_item_idx on public.item_images(item_id);

create table public.item_attachments (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  item_id          uuid not null references public.inventory_items(id) on delete cascade,
  storage_path     text not null,
  filename         text not null,
  mime_type        text,
  size_bytes       int,
  created_by       uuid references public.user_profiles(id) on delete set null,
  created_at       timestamptz not null default now()
);
create index item_attachments_item_idx on public.item_attachments(item_id);

create table public.item_tags (
  item_id  uuid not null references public.inventory_items(id) on delete cascade,
  tag_id   uuid not null references public.tags(id) on delete cascade,
  primary key (item_id, tag_id)
);

-- ============================================================================
-- STOCK MOVEMENTS — immutable ledger
-- ============================================================================
create table public.stock_movements (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  item_id             uuid not null references public.inventory_items(id) on delete cascade,
  movement_type       text not null check (movement_type in (
                        'add','remove','adjust','transfer','receive_po',
                        'return','damage','loss','correction','initial')),
  quantity_change     numeric(14,4) not null,
  previous_quantity   numeric(14,4) not null,
  new_quantity        numeric(14,4) not null,
  from_location_id    uuid references public.locations(id) on delete set null,
  to_location_id      uuid references public.locations(id) on delete set null,
  reason              text,
  reference_type      text,
  reference_id        uuid,
  user_id             uuid references public.user_profiles(id) on delete set null,
  notes               text,
  created_at          timestamptz not null default now()
);
create index stock_movements_org_created_idx
  on public.stock_movements(organization_id, created_at desc);
create index stock_movements_item_created_idx
  on public.stock_movements(item_id, created_at desc);

-- ============================================================================
-- PURCHASE ORDERS
-- ============================================================================
create table public.purchase_orders (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  po_number                text not null,
  supplier_id              uuid references public.suppliers(id) on delete set null,
  destination_location_id  uuid references public.locations(id) on delete set null,
  status                   text not null default 'draft' check (status in (
                              'draft','ordered','partially_received','received','cancelled')),
  expected_at              timestamptz,
  ordered_at               timestamptz,
  received_at              timestamptz,
  subtotal                 numeric(14,4) not null default 0,
  tax                      numeric(14,4) not null default 0,
  shipping                 numeric(14,4) not null default 0,
  total                    numeric(14,4) not null default 0,
  notes                    text,
  created_by               uuid references public.user_profiles(id) on delete set null,
  updated_by               uuid references public.user_profiles(id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (organization_id, po_number)
);
create trigger purchase_orders_set_updated_at
  before update on public.purchase_orders
  for each row execute function public.tg_set_updated_at();
create index purchase_orders_org_status_idx on public.purchase_orders(organization_id, status);

create table public.purchase_order_items (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  purchase_order_id   uuid not null references public.purchase_orders(id) on delete cascade,
  item_id             uuid not null references public.inventory_items(id),
  quantity_ordered    numeric(14,4) not null,
  quantity_received   numeric(14,4) not null default 0,
  unit_cost           numeric(14,4) not null,
  line_total          numeric(14,4) generated always as (quantity_ordered * unit_cost) stored
);
create index purchase_order_items_po_idx on public.purchase_order_items(purchase_order_id);

-- ============================================================================
-- NOTIFICATIONS, ACTIVITY, AUDIT, PUSH TOKENS
-- ============================================================================
create table public.notifications (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  user_id          uuid not null references public.user_profiles(id) on delete cascade,
  type             text not null,
  title            text not null,
  body             text,
  link             text,
  metadata         jsonb not null default '{}'::jsonb,
  read_at          timestamptz,
  created_at       timestamptz not null default now()
);
create index notifications_user_unread_idx
  on public.notifications(user_id, created_at desc) where read_at is null;

create table public.notification_preferences (
  user_id                  uuid primary key references public.user_profiles(id) on delete cascade,
  email_low_stock          boolean not null default true,
  email_po_status          boolean not null default true,
  email_weekly_digest      boolean not null default true,
  email_team_invites       boolean not null default true,
  push_low_stock           boolean not null default true,
  push_po_status           boolean not null default true,
  push_stock_transfer      boolean not null default true,
  updated_at               timestamptz not null default now()
);
create trigger notification_preferences_set_updated_at
  before update on public.notification_preferences
  for each row execute function public.tg_set_updated_at();

create table public.activity_logs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  user_id          uuid references public.user_profiles(id) on delete set null,
  entity_type      text not null,
  entity_id        uuid,
  action           text not null,
  diff             jsonb,
  ip               inet,
  user_agent       text,
  created_at       timestamptz not null default now()
);
create index activity_logs_org_created_idx
  on public.activity_logs(organization_id, created_at desc);

create table public.audit_logs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid references public.organizations(id) on delete cascade,
  user_id          uuid references public.user_profiles(id) on delete set null,
  event            text not null,
  metadata         jsonb,
  ip               inet,
  user_agent       text,
  created_at       timestamptz not null default now()
);
create index audit_logs_org_created_idx on public.audit_logs(organization_id, created_at desc);

create table public.push_tokens (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.user_profiles(id) on delete cascade,
  token           text unique not null,
  platform        text not null check (platform in ('ios','android','web')),
  device_id       text,
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz not null default now()
);

-- ============================================================================
-- IMPORTS & BILLING EVENTS
-- ============================================================================
create table public.import_jobs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  user_id          uuid not null references public.user_profiles(id) on delete cascade,
  entity           text not null check (entity in ('items','suppliers','locations')),
  status           text not null default 'pending'
                   check (status in ('pending','processing','completed','failed')),
  storage_path     text not null,
  rows_total       int not null default 0,
  rows_imported    int not null default 0,
  rows_failed      int not null default 0,
  started_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz not null default now()
);

create table public.import_job_errors (
  id              uuid primary key default gen_random_uuid(),
  import_job_id   uuid not null references public.import_jobs(id) on delete cascade,
  row_number      int,
  error_code      text,
  message         text,
  data            jsonb
);

create table public.billing_events (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid references public.organizations(id) on delete cascade,
  stripe_event_id   text unique not null,
  type              text not null,
  payload           jsonb not null,
  processed_at      timestamptz,
  created_at        timestamptz not null default now()
);

-- ============================================================================
-- ENABLE RLS
-- ============================================================================
alter table public.categories               enable row level security;
alter table public.tags                     enable row level security;
alter table public.locations                enable row level security;
alter table public.suppliers                enable row level security;
alter table public.inventory_items          enable row level security;
alter table public.item_stock_levels        enable row level security;
alter table public.item_images              enable row level security;
alter table public.item_attachments         enable row level security;
alter table public.item_tags                enable row level security;
alter table public.stock_movements          enable row level security;
alter table public.purchase_orders          enable row level security;
alter table public.purchase_order_items     enable row level security;
alter table public.notifications            enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.activity_logs            enable row level security;
alter table public.audit_logs               enable row level security;
alter table public.push_tokens              enable row level security;
alter table public.import_jobs              enable row level security;
alter table public.import_job_errors        enable row level security;
alter table public.billing_events           enable row level security;
-- ============================================================================
-- 0003_rls.sql — Row-Level Security policies
-- All tenant tables are scoped via organization_id + organization_members.
-- ============================================================================

-- ============================================================================
-- ORGANIZATIONS
-- ============================================================================
create policy organizations_select on public.organizations
  for select to authenticated
  using (public.is_org_member(id));

create policy organizations_insert on public.organizations
  for insert to authenticated
  with check (auth.uid() is not null);

create policy organizations_update on public.organizations
  for update to authenticated
  using (public.has_org_role(id, 'admin'))
  with check (public.has_org_role(id, 'admin'));

create policy organizations_delete on public.organizations
  for delete to authenticated
  using (public.has_org_role(id, 'owner'));

-- ============================================================================
-- USER PROFILES — readable by org-mates, writable only by self
-- ============================================================================
create policy user_profiles_select_self on public.user_profiles
  for select to authenticated
  using (id = auth.uid());

create policy user_profiles_select_orgmates on public.user_profiles
  for select to authenticated
  using (
    exists (
      select 1
      from public.organization_members me
      join public.organization_members them
        on them.organization_id = me.organization_id
      where me.user_id = auth.uid()
        and me.accepted_at is not null
        and them.user_id = public.user_profiles.id
    )
  );

create policy user_profiles_update_self on public.user_profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- ============================================================================
-- ORGANIZATION MEMBERS
-- ============================================================================
create policy organization_members_select on public.organization_members
  for select to authenticated
  using (public.is_org_member(organization_id));

create policy organization_members_insert on public.organization_members
  for insert to authenticated
  with check (
    -- Either the user is creating their own membership upon org creation/invite acceptance,
    -- or they are an admin/owner adding someone else.
    user_id = auth.uid()
    or public.has_org_role(organization_id, 'admin')
  );

create policy organization_members_update on public.organization_members
  for update to authenticated
  using (public.has_org_role(organization_id, 'admin'))
  with check (public.has_org_role(organization_id, 'admin'));

create policy organization_members_delete on public.organization_members
  for delete to authenticated
  using (
    user_id = auth.uid()
    or public.has_org_role(organization_id, 'admin')
  );

-- ============================================================================
-- ORGANIZATION INVITES
-- ============================================================================
create policy organization_invites_select on public.organization_invites
  for select to authenticated
  using (public.has_org_role(organization_id, 'admin'));

create policy organization_invites_insert on public.organization_invites
  for insert to authenticated
  with check (public.has_org_role(organization_id, 'admin'));

create policy organization_invites_delete on public.organization_invites
  for delete to authenticated
  using (public.has_org_role(organization_id, 'admin'));

-- Token lookups happen server-side via the service role; no anon select policy.

-- ============================================================================
-- TAXONOMY (categories, tags)
-- ============================================================================
create policy categories_select on public.categories
  for select to authenticated using (public.is_org_member(organization_id));
create policy categories_insert on public.categories
  for insert to authenticated with check (public.has_org_role(organization_id, 'manager'));
create policy categories_update on public.categories
  for update to authenticated
  using (public.has_org_role(organization_id, 'manager'))
  with check (public.has_org_role(organization_id, 'manager'));
create policy categories_delete on public.categories
  for delete to authenticated using (public.has_org_role(organization_id, 'admin'));

create policy tags_select on public.tags
  for select to authenticated using (public.is_org_member(organization_id));
create policy tags_write on public.tags
  for all to authenticated
  using (public.has_org_role(organization_id, 'manager'))
  with check (public.has_org_role(organization_id, 'manager'));

-- ============================================================================
-- LOCATIONS
-- ============================================================================
create policy locations_select on public.locations
  for select to authenticated using (public.is_org_member(organization_id));
create policy locations_insert on public.locations
  for insert to authenticated with check (public.has_org_role(organization_id, 'manager'));
create policy locations_update on public.locations
  for update to authenticated
  using (public.has_org_role(organization_id, 'manager'))
  with check (public.has_org_role(organization_id, 'manager'));
create policy locations_delete on public.locations
  for delete to authenticated using (public.has_org_role(organization_id, 'admin'));

-- ============================================================================
-- SUPPLIERS
-- ============================================================================
create policy suppliers_select on public.suppliers
  for select to authenticated using (public.is_org_member(organization_id));
create policy suppliers_write on public.suppliers
  for all to authenticated
  using (public.has_org_role(organization_id, 'manager'))
  with check (public.has_org_role(organization_id, 'manager'));

-- ============================================================================
-- INVENTORY ITEMS + RELATED
-- ============================================================================
create policy inventory_items_select on public.inventory_items
  for select to authenticated using (public.is_org_member(organization_id));
create policy inventory_items_insert on public.inventory_items
  for insert to authenticated with check (public.has_org_role(organization_id, 'staff'));
create policy inventory_items_update on public.inventory_items
  for update to authenticated
  using (public.has_org_role(organization_id, 'staff'))
  with check (public.has_org_role(organization_id, 'staff'));
create policy inventory_items_delete on public.inventory_items
  for delete to authenticated using (public.has_org_role(organization_id, 'admin'));

create policy item_stock_levels_select on public.item_stock_levels
  for select to authenticated using (public.is_org_member(organization_id));
create policy item_stock_levels_write on public.item_stock_levels
  for all to authenticated
  using (public.has_org_role(organization_id, 'staff'))
  with check (public.has_org_role(organization_id, 'staff'));

create policy item_images_select on public.item_images
  for select to authenticated using (public.is_org_member(organization_id));
create policy item_images_write on public.item_images
  for all to authenticated
  using (public.has_org_role(organization_id, 'staff'))
  with check (public.has_org_role(organization_id, 'staff'));

create policy item_attachments_select on public.item_attachments
  for select to authenticated using (public.is_org_member(organization_id));
create policy item_attachments_write on public.item_attachments
  for all to authenticated
  using (public.has_org_role(organization_id, 'staff'))
  with check (public.has_org_role(organization_id, 'staff'));

create policy item_tags_all on public.item_tags
  for all to authenticated
  using (
    exists (
      select 1 from public.inventory_items it
      where it.id = item_id and public.has_org_role(it.organization_id, 'staff')
    )
  )
  with check (
    exists (
      select 1 from public.inventory_items it
      where it.id = item_id and public.has_org_role(it.organization_id, 'staff')
    )
  );

-- ============================================================================
-- STOCK MOVEMENTS — append-only
-- ============================================================================
create policy stock_movements_select on public.stock_movements
  for select to authenticated using (public.is_org_member(organization_id));
create policy stock_movements_insert on public.stock_movements
  for insert to authenticated with check (public.has_org_role(organization_id, 'staff'));
-- intentionally no update or delete policies — ledger is immutable from the client side

-- ============================================================================
-- PURCHASE ORDERS
-- ============================================================================
create policy purchase_orders_select on public.purchase_orders
  for select to authenticated using (public.is_org_member(organization_id));
create policy purchase_orders_write on public.purchase_orders
  for all to authenticated
  using (public.has_org_role(organization_id, 'manager'))
  with check (public.has_org_role(organization_id, 'manager'));

create policy purchase_order_items_select on public.purchase_order_items
  for select to authenticated using (public.is_org_member(organization_id));
create policy purchase_order_items_write on public.purchase_order_items
  for all to authenticated
  using (public.has_org_role(organization_id, 'manager'))
  with check (public.has_org_role(organization_id, 'manager'));

-- ============================================================================
-- NOTIFICATIONS
-- ============================================================================
create policy notifications_select_own on public.notifications
  for select to authenticated using (user_id = auth.uid());
create policy notifications_update_own on public.notifications
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
-- inserts done via service role from server-side workers

create policy notification_preferences_self on public.notification_preferences
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ============================================================================
-- ACTIVITY + AUDIT — read by managers/admins, no client write
-- ============================================================================
create policy activity_logs_select on public.activity_logs
  for select to authenticated using (public.has_org_role(organization_id, 'manager'));
create policy audit_logs_select on public.audit_logs
  for select to authenticated using (public.has_org_role(organization_id, 'admin'));

-- ============================================================================
-- PUSH TOKENS — self only
-- ============================================================================
create policy push_tokens_self on public.push_tokens
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ============================================================================
-- IMPORTS — managers manage, staff can see their own
-- ============================================================================
create policy import_jobs_select on public.import_jobs
  for select to authenticated using (public.is_org_member(organization_id));
create policy import_jobs_write on public.import_jobs
  for all to authenticated
  using (public.has_org_role(organization_id, 'manager'))
  with check (public.has_org_role(organization_id, 'manager'));

create policy import_job_errors_select on public.import_job_errors
  for select to authenticated
  using (
    exists (
      select 1 from public.import_jobs j
      where j.id = import_job_id and public.is_org_member(j.organization_id)
    )
  );

-- ============================================================================
-- BILLING EVENTS — service role only; no client policies (RLS enabled but no allows)
-- ============================================================================

-- ============================================================================
-- STORAGE BUCKETS — RLS on storage.objects per bucket
-- Path convention: {bucket}/{organization_id}/...
-- ============================================================================
create policy "item-images authenticated read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'item-images'
    and public.is_org_member((storage.foldername(name))[1]::uuid)
  );

create policy "item-images staff write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'item-images'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'staff')
  );

create policy "item-images staff update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'item-images'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'staff')
  );

create policy "item-images staff delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'item-images'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'staff')
  );

create policy "item-attachments authenticated read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'item-attachments'
    and public.is_org_member((storage.foldername(name))[1]::uuid)
  );

create policy "item-attachments staff write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'item-attachments'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'staff')
  );

create policy "org-logos public read"
  on storage.objects for select to anon, authenticated
  using (bucket_id = 'org-logos');

create policy "org-logos admin write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'org-logos'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'admin')
  );
-- ============================================================================
-- 0004_phase2_helpers.sql — RPCs and helpers used by Phase 2 services
-- ============================================================================

-- ----------------------------------------------------------------------------
-- adjust_stock: atomic stock change + ledger row.
-- Returns the updated item row.
-- ----------------------------------------------------------------------------
create or replace function public.adjust_stock(
  p_item_id          uuid,
  p_quantity_change  numeric,
  p_movement_type    text,
  p_location_id      uuid default null,
  p_reason           text default null,
  p_notes            text default null
)
returns public.inventory_items
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_item        public.inventory_items%rowtype;
  v_prev        numeric;
  v_new         numeric;
  v_user        uuid := auth.uid();
begin
  -- Lock the row for update so concurrent adjustments serialize.
  select * into v_item
  from public.inventory_items
  where id = p_item_id
  for update;

  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  if not public.has_org_role(v_item.organization_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_prev := v_item.quantity_on_hand;
  v_new  := v_prev + p_quantity_change;

  if v_new < 0 then
    raise exception 'insufficient_stock' using errcode = 'P0001';
  end if;

  update public.inventory_items
    set quantity_on_hand = v_new,
        updated_at       = now(),
        updated_by       = v_user
  where id = p_item_id
  returning * into v_item;

  insert into public.stock_movements (
    organization_id, item_id, movement_type,
    quantity_change, previous_quantity, new_quantity,
    from_location_id, to_location_id, reason, notes, user_id
  ) values (
    v_item.organization_id, v_item.id, p_movement_type,
    p_quantity_change, v_prev, v_new,
    case when p_quantity_change < 0 then p_location_id else null end,
    case when p_quantity_change > 0 then p_location_id else null end,
    p_reason, p_notes, v_user
  );

  return v_item;
end;
$$;

-- ----------------------------------------------------------------------------
-- transfer_stock: move quantity between locations atomically.
-- ----------------------------------------------------------------------------
create or replace function public.transfer_stock(
  p_item_id           uuid,
  p_from_location_id  uuid,
  p_to_location_id    uuid,
  p_quantity          numeric,
  p_notes             text default null
)
returns public.inventory_items
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_item public.inventory_items%rowtype;
  v_from_qty numeric;
  v_to_qty   numeric;
begin
  if p_quantity <= 0 then
    raise exception 'quantity_must_be_positive' using errcode = '22023';
  end if;
  if p_from_location_id = p_to_location_id then
    raise exception 'same_location' using errcode = '22023';
  end if;

  select * into v_item from public.inventory_items where id = p_item_id for update;
  if not found then raise exception 'item_not_found' using errcode = 'P0002'; end if;
  if not public.has_org_role(v_item.organization_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Decrement source
  insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (v_item.organization_id, p_item_id, p_from_location_id, 0)
  on conflict (item_id, location_id) do nothing;

  update public.item_stock_levels
    set quantity = quantity - p_quantity, updated_at = now()
  where item_id = p_item_id and location_id = p_from_location_id
  returning quantity into v_from_qty;

  if v_from_qty < 0 then
    raise exception 'insufficient_stock' using errcode = 'P0001';
  end if;

  -- Increment destination
  insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (v_item.organization_id, p_item_id, p_to_location_id, p_quantity)
  on conflict (item_id, location_id) do update
    set quantity = public.item_stock_levels.quantity + excluded.quantity,
        updated_at = now()
  returning quantity into v_to_qty;

  -- Ledger entry (transfer doesn't change quantity_on_hand)
  insert into public.stock_movements (
    organization_id, item_id, movement_type,
    quantity_change, previous_quantity, new_quantity,
    from_location_id, to_location_id, notes, user_id
  ) values (
    v_item.organization_id, v_item.id, 'transfer',
    0, v_item.quantity_on_hand, v_item.quantity_on_hand,
    p_from_location_id, p_to_location_id, p_notes, auth.uid()
  );

  return v_item;
end;
$$;

-- ----------------------------------------------------------------------------
-- low_stock_count: items below their reorder_point.
-- ----------------------------------------------------------------------------
create or replace function public.low_stock_count(p_org_id uuid)
returns int
language sql
stable
security invoker
as $$
  select count(*)::int
  from public.inventory_items
  where organization_id = p_org_id
    and status = 'active'
    and deleted_at is null
    and reorder_point > 0
    and quantity_on_hand <= reorder_point
$$;

-- ----------------------------------------------------------------------------
-- low_stock_items: list items below reorder point with deficit.
-- ----------------------------------------------------------------------------
create or replace function public.low_stock_items(p_org_id uuid, p_limit int default 50)
returns table (
  id                uuid,
  name              text,
  sku               text,
  quantity_on_hand  numeric,
  reorder_point     numeric,
  reorder_quantity  numeric,
  primary_location  text
)
language sql
stable
security invoker
as $$
  select
    i.id,
    i.name,
    i.sku,
    i.quantity_on_hand,
    i.reorder_point,
    i.reorder_quantity,
    l.name as primary_location
  from public.inventory_items i
  left join public.locations l on l.id = i.primary_location_id
  where i.organization_id = p_org_id
    and i.status = 'active'
    and i.deleted_at is null
    and i.reorder_point > 0
    and i.quantity_on_hand <= i.reorder_point
  order by (i.quantity_on_hand - i.reorder_point) asc, i.name asc
  limit p_limit
$$;

-- ----------------------------------------------------------------------------
-- inventory_value: sum of unit_cost * quantity_on_hand for active items.
-- ----------------------------------------------------------------------------
create or replace function public.inventory_value(p_org_id uuid)
returns numeric
language sql
stable
security invoker
as $$
  select coalesce(sum(unit_cost * quantity_on_hand), 0)
  from public.inventory_items
  where organization_id = p_org_id
    and status = 'active'
    and deleted_at is null
$$;

-- ----------------------------------------------------------------------------
-- generate_sku: produces a unique SKU within an org.
-- Format: <PREFIX>-<base36 epoch>-<base36 rand>
-- ----------------------------------------------------------------------------
create or replace function public.generate_sku(p_org_id uuid, p_prefix text default 'SP')
returns text
language plpgsql
stable
as $$
declare
  v_candidate text;
  v_attempts  int := 0;
begin
  loop
    v_candidate := upper(p_prefix) || '-' ||
                   upper(to_hex(extract(epoch from now())::bigint))::text ||
                   '-' || upper(substr(md5(random()::text), 1, 4));
    if not exists (
      select 1 from public.inventory_items
      where organization_id = p_org_id and sku = v_candidate
    ) then
      return v_candidate;
    end if;
    v_attempts := v_attempts + 1;
    exit when v_attempts > 5;
  end loop;
  return v_candidate;
end;
$$;

-- Grant execute to authenticated users (RLS still applies to the underlying tables).
grant execute on function public.adjust_stock(uuid, numeric, text, uuid, text, text) to authenticated;
grant execute on function public.transfer_stock(uuid, uuid, uuid, numeric, text)        to authenticated;
grant execute on function public.low_stock_count(uuid)                                   to authenticated;
grant execute on function public.low_stock_items(uuid, int)                              to authenticated;
grant execute on function public.inventory_value(uuid)                                   to authenticated;
grant execute on function public.generate_sku(uuid, text)                                to authenticated;
-- ============================================================================
-- 0005_phase5_helpers.sql — Purchase order receive RPC + import helpers
-- ============================================================================

-- ----------------------------------------------------------------------------
-- receive_purchase_order: atomically post received quantities, increment item
-- on-hand, write stock_movement ledger entries, and update PO status.
--
-- p_lines is a jsonb array shaped like:
--   [{"line_id": "uuid", "quantity": 5}, ...]
-- ----------------------------------------------------------------------------
create or replace function public.receive_purchase_order(
  p_po_id   uuid,
  p_lines   jsonb,
  p_notes   text default null
)
returns public.purchase_orders
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_po          public.purchase_orders%rowtype;
  v_user        uuid := auth.uid();
  v_line        record;
  v_total_lines int;
  v_full        boolean := true;
begin
  select * into v_po
  from public.purchase_orders
  where id = p_po_id
  for update;

  if not found then
    raise exception 'po_not_found' using errcode = 'P0002';
  end if;
  if not public.has_org_role(v_po.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_po.status in ('received', 'cancelled') then
    raise exception 'po_already_closed' using errcode = '22023';
  end if;

  for v_line in
    select
      (elem->>'line_id')::uuid       as line_id,
      (elem->>'quantity')::numeric   as qty
    from jsonb_array_elements(p_lines) elem
  loop
    if v_line.qty is null or v_line.qty <= 0 then
      continue;
    end if;

    -- Update line and validate within bounds.
    update public.purchase_order_items
       set quantity_received = least(quantity_received + v_line.qty, quantity_ordered)
     where id = v_line.line_id
       and purchase_order_id = p_po_id
     returning item_id into v_line.line_id;

    if not found then
      raise exception 'line_not_found' using errcode = 'P0002';
    end if;

    -- Bump item quantity_on_hand and write a movement.
    perform public.adjust_stock(
      v_line.line_id,
      v_line.qty,
      'receive_po',
      v_po.destination_location_id,
      'PO ' || v_po.po_number,
      p_notes
    );
  end loop;

  -- Recompute status: full if every line is fully received.
  select count(*) into v_total_lines from public.purchase_order_items where purchase_order_id = p_po_id;

  if v_total_lines = 0 then
    v_full := false;
  else
    select bool_and(quantity_received >= quantity_ordered)
      into v_full
      from public.purchase_order_items
     where purchase_order_id = p_po_id;
  end if;

  update public.purchase_orders
     set status = case when v_full then 'received' else 'partially_received' end,
         received_at = case when v_full then now() else v_po.received_at end,
         updated_by = v_user,
         updated_at = now()
   where id = p_po_id
   returning * into v_po;

  return v_po;
end;
$$;

grant execute on function public.receive_purchase_order(uuid, jsonb, text) to authenticated;

-- ----------------------------------------------------------------------------
-- next_po_number: simple per-org sequential PO number generator.
-- Format: PO-YYYY-NNNN where NNNN is per-org count + 1.
-- ----------------------------------------------------------------------------
create or replace function public.next_po_number(p_org_id uuid)
returns text
language sql
stable
as $$
  select 'PO-' || to_char(now(), 'YYYY') || '-' || lpad(((
    select count(*) from public.purchase_orders where organization_id = p_org_id
  ) + 1)::text, 4, '0')
$$;

grant execute on function public.next_po_number(uuid) to authenticated;
-- ============================================================================
-- 0006_perf.sql — Performance helpers
-- Single-round-trip dashboard summary + covering index for the inventory list.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- get_dashboard_summary: replaces 4 separate queries (item count,
-- out-of-stock count, low-stock count via low_stock_count, inventory_value
-- via inventory_value) with one index scan that produces all four numbers.
-- ----------------------------------------------------------------------------
create or replace function public.get_dashboard_summary(p_org_id uuid)
returns table (
  item_count          int,
  out_of_stock_count  int,
  low_stock_count     int,
  inventory_value     numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    count(*) filter (
      where status = 'active' and deleted_at is null
    )::int as item_count,
    count(*) filter (
      where status = 'active' and deleted_at is null and quantity_on_hand <= 0
    )::int as out_of_stock_count,
    count(*) filter (
      where status = 'active'
        and deleted_at is null
        and reorder_point > 0
        and quantity_on_hand <= reorder_point
    )::int as low_stock_count,
    coalesce(
      sum(unit_cost * quantity_on_hand) filter (
        where status = 'active' and deleted_at is null
      ),
      0
    ) as inventory_value
  from public.inventory_items
  where organization_id = p_org_id
$$;

grant execute on function public.get_dashboard_summary(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Covering index for the inventory list's ORDER BY updated_at DESC.
-- Existing partial index on (organization_id, status) was forcing a sort
-- after the index scan; this one provides the sort order directly.
-- ----------------------------------------------------------------------------
create index if not exists inventory_items_org_updated_idx
  on public.inventory_items (organization_id, updated_at desc)
  where deleted_at is null and status = 'active';
-- ============================================================================
-- 0007_internal_company.sql — Internal-company inventory model
--
-- Pivots the app from public SaaS to invite-only internal tool:
--   • New entity: charters (top-level group, renamable per-org)
--   • New entity: warehouses (first-class, charter-scoped, contact info)
--   • Existing locations become bins/zones inside a warehouse
--   • New entity: user_warehouse_assignments (which warehouses a user can
--     access). Super admin / manager have implicit access to all.
--   • organizations gains a terminology JSONB so "Charter" can be relabeled
--     ("Region", "Division", "Branch") without schema changes.
--   • inventory_items gains warehouse_id for fast warehouse-scoped queries.
--   • RLS helper: user_can_access_warehouse() — used in policies + services.
--   • Audit log writer: log_audit() function, signature stable for app layer.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────
-- TERMINOLOGY: per-org configurable labels
-- ─────────────────────────────────────────────────────────────────────
alter table public.organizations
  add column if not exists terminology jsonb not null default jsonb_build_object(
    'charter_singular', 'Charter',
    'charter_plural',   'Charters',
    'warehouse_singular', 'Warehouse',
    'warehouse_plural',   'Warehouses'
  );

-- ─────────────────────────────────────────────────────────────────────
-- CHARTERS (a.k.a. region / division / branch)
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.charters (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null,
  code            text,
  description     text,
  status          text not null default 'active'
                  check (status in ('active', 'inactive', 'archived')),
  notes           text,
  created_by      uuid references public.user_profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, code)
);
create index if not exists charters_org_idx on public.charters(organization_id);
create trigger charters_set_updated_at
  before update on public.charters
  for each row execute function public.tg_set_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- WAREHOUSES (first-class)
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.warehouses (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  charter_id      uuid references public.charters(id) on delete set null,
  name            text not null,
  code            text not null,
  address         jsonb,
  contact_name    text,
  contact_email   citext,
  contact_phone   text,
  manager_user_id uuid references public.user_profiles(id) on delete set null,
  status          text not null default 'active'
                  check (status in ('active', 'inactive', 'archived')),
  notes           text,
  created_by      uuid references public.user_profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, code)
);
create index if not exists warehouses_org_idx on public.warehouses(organization_id);
create index if not exists warehouses_charter_idx on public.warehouses(charter_id);
create trigger warehouses_set_updated_at
  before update on public.warehouses
  for each row execute function public.tg_set_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- LOCATIONS gain a warehouse_id (existing rows get backfilled below)
-- ─────────────────────────────────────────────────────────────────────
alter table public.locations
  add column if not exists warehouse_id uuid references public.warehouses(id) on delete set null;
create index if not exists locations_warehouse_idx on public.locations(warehouse_id);

-- ─────────────────────────────────────────────────────────────────────
-- INVENTORY_ITEMS gain a warehouse_id (the item's home warehouse)
-- ─────────────────────────────────────────────────────────────────────
alter table public.inventory_items
  add column if not exists warehouse_id uuid references public.warehouses(id) on delete set null;
create index if not exists inventory_items_warehouse_idx
  on public.inventory_items(organization_id, warehouse_id)
  where deleted_at is null;

-- ─────────────────────────────────────────────────────────────────────
-- USER ↔ WAREHOUSE assignments
-- A user with role staff/viewer is restricted to these. Manager/admin/owner
-- have implicit access to all warehouses in their org.
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.user_warehouse_assignments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references public.user_profiles(id) on delete cascade,
  warehouse_id    uuid not null references public.warehouses(id) on delete cascade,
  charter_id      uuid references public.charters(id) on delete set null,
  is_primary      boolean not null default true,
  assigned_by     uuid references public.user_profiles(id) on delete set null,
  assigned_at     timestamptz not null default now(),
  unique (user_id, warehouse_id)
);
create index if not exists user_warehouse_assignments_user_idx
  on public.user_warehouse_assignments(user_id);
create index if not exists user_warehouse_assignments_wh_idx
  on public.user_warehouse_assignments(warehouse_id);

-- ─────────────────────────────────────────────────────────────────────
-- ORGANIZATION_INVITES gain warehouse + charter assignment fields
-- ─────────────────────────────────────────────────────────────────────
alter table public.organization_invites
  add column if not exists warehouse_id uuid references public.warehouses(id) on delete set null,
  add column if not exists charter_id   uuid references public.charters(id)   on delete set null,
  add column if not exists message      text;

-- ─────────────────────────────────────────────────────────────────────
-- BACKFILL: every org that already has locations gets a default
-- "Main Warehouse", and existing locations + items roll up to it.
-- ─────────────────────────────────────────────────────────────────────
do $$
declare
  org_row record;
  new_wh_id uuid;
begin
  for org_row in
    select id, name from public.organizations
    where exists (
      select 1 from public.locations l where l.organization_id = organizations.id
    ) and not exists (
      select 1 from public.warehouses w where w.organization_id = organizations.id
    )
  loop
    insert into public.warehouses (organization_id, name, code, status)
    values (org_row.id, 'Main Warehouse', 'MAIN', 'active')
    returning id into new_wh_id;

    update public.locations
       set warehouse_id = new_wh_id
     where organization_id = org_row.id and warehouse_id is null;

    update public.inventory_items
       set warehouse_id = new_wh_id
     where organization_id = org_row.id and warehouse_id is null;
  end loop;
end$$;

-- ─────────────────────────────────────────────────────────────────────
-- HELPER: user_can_access_warehouse(uid, wh_id, op)
-- op is 'read' or 'write'. Returns true if:
--   • user is owner/admin/manager in the warehouse's org
--   • OR user has a row in user_warehouse_assignments for this warehouse
--     AND (op = 'read' OR user role >= staff)
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.user_can_access_warehouse(
  p_user_id uuid,
  p_warehouse_id uuid,
  p_op text default 'read'
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
    from public.organization_members m, wh
    where m.user_id = p_user_id
      and m.organization_id = wh.organization_id
      and m.accepted_at is not null
    limit 1
  )
  select case
    -- super admin + manager: full access
    when (select role from member) in ('owner', 'admin', 'manager') then true
    -- staff/viewer: must be assigned, and viewer can only read
    when (select role from member) = 'staff' and exists (
      select 1 from public.user_warehouse_assignments
      where user_id = p_user_id and warehouse_id = p_warehouse_id
    ) then true
    when (select role from member) = 'viewer' and p_op = 'read' and exists (
      select 1 from public.user_warehouse_assignments
      where user_id = p_user_id and warehouse_id = p_warehouse_id
    ) then true
    else false
  end;
$$;

grant execute on function public.user_can_access_warehouse(uuid, uuid, text) to authenticated;

-- Convenience: warehouses the calling user can read
create or replace function public.my_warehouse_ids()
returns table (warehouse_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  with my_role as (
    select organization_id, role
    from public.organization_members
    where user_id = auth.uid() and accepted_at is not null
  )
  -- super_admin / manager: every warehouse in their org(s)
  select w.id
  from public.warehouses w
  join my_role mr on mr.organization_id = w.organization_id
  where mr.role in ('owner', 'admin', 'manager')
  union
  -- staff / viewer: only assigned warehouses
  select uwa.warehouse_id
  from public.user_warehouse_assignments uwa
  join my_role mr on mr.organization_id = uwa.organization_id
  where uwa.user_id = auth.uid()
    and mr.role in ('staff', 'viewer');
$$;

grant execute on function public.my_warehouse_ids() to authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- AUDIT LOG WRITER (callable from app layer)
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.log_audit(
  p_organization_id uuid,
  p_event text,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language sql
security invoker
as $$
  insert into public.audit_logs (organization_id, user_id, event, metadata)
  values (p_organization_id, auth.uid(), p_event, p_metadata);
$$;

grant execute on function public.log_audit(uuid, text, jsonb) to authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- RLS for the new tables
-- ─────────────────────────────────────────────────────────────────────
alter table public.charters enable row level security;
alter table public.warehouses enable row level security;
alter table public.user_warehouse_assignments enable row level security;

-- charters: org members can read; only admin+ can write
create policy charters_select on public.charters
  for select to authenticated
  using (public.is_org_member(organization_id));
create policy charters_admin_write on public.charters
  for all to authenticated
  using (public.has_org_role(organization_id, 'admin'))
  with check (public.has_org_role(organization_id, 'admin'));

-- warehouses: org members can read but only those they can access via the
-- helper; admin+ can write any.
create policy warehouses_select on public.warehouses
  for select to authenticated
  using (
    public.is_org_member(organization_id)
    and (
      public.has_org_role(organization_id, 'manager')
      or public.user_can_access_warehouse(auth.uid(), id, 'read')
    )
  );
create policy warehouses_admin_write on public.warehouses
  for all to authenticated
  using (public.has_org_role(organization_id, 'admin'))
  with check (public.has_org_role(organization_id, 'admin'));

-- user_warehouse_assignments: a user can read their own; admin+ can manage.
create policy uwa_select_own on public.user_warehouse_assignments
  for select to authenticated
  using (user_id = auth.uid() or public.has_org_role(organization_id, 'admin'));
create policy uwa_admin_write on public.user_warehouse_assignments
  for all to authenticated
  using (public.has_org_role(organization_id, 'admin'))
  with check (public.has_org_role(organization_id, 'admin'));

-- ─────────────────────────────────────────────────────────────────────
-- Tighten existing inventory RLS so warehouse_user/viewer can only see
-- items in warehouses they're assigned to. Manager/admin unchanged.
-- ─────────────────────────────────────────────────────────────────────
drop policy if exists inventory_items_select on public.inventory_items;
create policy inventory_items_select on public.inventory_items
  for select to authenticated
  using (
    public.is_org_member(organization_id)
    and (
      public.has_org_role(organization_id, 'manager')
      or warehouse_id is null  -- pre-migration items still visible
      or public.user_can_access_warehouse(auth.uid(), warehouse_id, 'read')
    )
  );

drop policy if exists inventory_items_insert on public.inventory_items;
create policy inventory_items_insert on public.inventory_items
  for insert to authenticated
  with check (
    public.has_org_role(organization_id, 'staff')
    and (
      public.has_org_role(organization_id, 'manager')
      or warehouse_id is null
      or public.user_can_access_warehouse(auth.uid(), warehouse_id, 'write')
    )
  );

drop policy if exists inventory_items_update on public.inventory_items;
create policy inventory_items_update on public.inventory_items
  for update to authenticated
  using (
    public.has_org_role(organization_id, 'staff')
    and (
      public.has_org_role(organization_id, 'manager')
      or warehouse_id is null
      or public.user_can_access_warehouse(auth.uid(), warehouse_id, 'write')
    )
  )
  with check (
    public.has_org_role(organization_id, 'staff')
    and (
      public.has_org_role(organization_id, 'manager')
      or warehouse_id is null
      or public.user_can_access_warehouse(auth.uid(), warehouse_id, 'write')
    )
  );

-- ─────────────────────────────────────────────────────────────────────
-- 0008_warehouse_charters.sql — Many-to-many warehouse↔charter, items
-- can be earmarked for a charter or carried as generic stock.
-- ─────────────────────────────────────────────────────────────────────

set check_function_bodies = off;

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

alter table public.inventory_items
  add column if not exists charter_id uuid references public.charters(id) on delete restrict;

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

alter table public.inventory_items
  drop constraint if exists inventory_items_warehouse_charter_fk;
alter table public.inventory_items
  add constraint inventory_items_warehouse_charter_fk
  foreign key (warehouse_id, charter_id)
  references public.warehouse_charters(warehouse_id, charter_id)
  on update cascade
  on delete restrict;

alter table public.warehouses drop column if exists charter_id;

alter table public.user_warehouse_assignments
  drop constraint if exists user_warehouse_assignments_user_id_warehouse_id_key;

create unique index if not exists uwa_user_wh_no_charter_uniq
  on public.user_warehouse_assignments(user_id, warehouse_id)
  where charter_id is null;
create unique index if not exists uwa_user_wh_charter_uniq
  on public.user_warehouse_assignments(user_id, warehouse_id, charter_id)
  where charter_id is not null;

alter table public.user_warehouse_assignments
  drop constraint if exists uwa_warehouse_charter_fk;
alter table public.user_warehouse_assignments
  add constraint uwa_warehouse_charter_fk
  foreign key (warehouse_id, charter_id)
  references public.warehouse_charters(warehouse_id, charter_id)
  on update cascade
  on delete cascade;

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

-- ─────────────────────────────────────────────────────────────────────
-- DONE
-- ─────────────────────────────────────────────────────────────────────
