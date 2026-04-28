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
