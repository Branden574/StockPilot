# StockPilot — Premium Inventory SaaS Blueprint

**Working name:** StockPilot
**Document version:** v1.0 — 2026-04-28
**Author:** Founding engineering plan

> Core promise: *"Know exactly what you have, where it is, who moved it, and when you need more."*

---

## 1. Product Overview

StockPilot is a multi-tenant SaaS for inventory management targeting SMBs, ecommerce sellers, warehouses, retail, schools, nonprofits, field-service, and multi-location operators. The product covers web (Next.js), iOS + Android native (Expo), and responsive mobile web, sharing a single Supabase Postgres backend.

### Differentiators
- **Apple/Linear-grade UI polish** — most competitors (Sortly, Cin7, Fishbowl) feel dated; we win on craft.
- **Mobile-first scanning workflow** — barcode/QR is a first-class interaction, not a bolt-on.
- **Real-time multi-user** — Supabase Realtime gives live stock levels across devices for free.
- **AI-ready architecture** — embeddings columns + event log enable forecasting/anomaly features in Phase 9 without rearchitecture.
- **Premium scrollytelling marketing site** — most competitors look like 2014.

### Positioning matrix
| Competitor | Strength | Our wedge |
|---|---|---|
| Sortly | Simple UI, mobile scan | We add real ERP features (POs, multi-loc, RBAC) without losing simplicity |
| Zoho Inventory | Cheap, integrated | Cleaner UX, native mobile, modern stack |
| Fishbowl/Cin7 | Deep ERP | We're 10x easier to onboard for SMBs |
| QuickBooks Commerce | Accounting-tied | Inventory-first, integrate to QBO not built on it |

---

## 2. Recommended Tech Stack

### Web app
- **Framework:** Next.js 16 (App Router, RSC, Server Actions, Turbopack)
- **Language:** TypeScript strict mode
- **Styling:** Tailwind CSS v4 + CSS variables for theming
- **Components:** shadcn/ui (Radix primitives) + custom design system layer
- **Animation:** Framer Motion 11 + Lenis (smooth scroll) for landing
- **Icons:** Lucide
- **Forms:** React Hook Form + Zod
- **Server state:** TanStack Query v5 (mutations, optimistic updates)
- **Client state:** Zustand (small UI slices, command palette)
- **Tables:** TanStack Table v8
- **Charts:** Recharts (sufficient + light) — upgrade to Visx later if needed
- **Cmd palette:** cmdk
- **Toast:** Sonner

### Backend
- **Database/Auth/Storage/Realtime:** Supabase (Postgres 16)
- **RLS:** All multi-tenant tables protected via `organization_id` policies
- **Edge functions:** Supabase Edge Functions for webhooks (Stripe), heavy reports
- **Server actions:** Next.js server actions for normal CRUD (cheaper than API routes)
- **Background jobs:** Vercel Cron + Supabase pg_cron for scheduled work; Inngest later if we outgrow

### Mobile
- **Framework:** Expo SDK 53 (RN 0.76, New Architecture)
- **Routing:** Expo Router (file-based)
- **Native modules:** `expo-camera` (barcode scanning), `expo-image-picker`, `expo-notifications`, `expo-secure-store`
- **Auth:** `@supabase/supabase-js` with secure-store session
- **Offline:** WatermelonDB or PowerSync (Phase 7+) — designed for from day one
- **State:** Same TanStack Query + Zustand pattern as web

### Payments
- **Stripe Billing** — products + prices for Free/Pro/Business; Enterprise via "contact sales"
- **Stripe Customer Portal** for self-service plan changes
- **Webhooks** via Supabase Edge Function (stricter signature validation than Vercel routes)

### Email & notifications
- **Email:** Resend + React Email templates
- **Push (mobile):** Expo Push Notifications -> store device tokens server-side
- **In-app:** `notifications` table + Supabase Realtime channel

### Infra & deployment
- **Web:** Vercel (Fluid Compute, Node.js 24 default, 300s timeout)
- **DB/Auth/Storage:** Supabase managed
- **Mobile builds:** EAS Build + EAS Submit
- **Monorepo:** Turborepo + pnpm workspaces
- **CI:** GitHub Actions (lint, typecheck, test, deploy preview)

### Observability
- **Errors:** Sentry (web + mobile + edge)
- **Product analytics:** PostHog
- **Logs:** Vercel + Supabase logs
- **Uptime:** BetterStack or Vercel native monitoring

### Why this stack (key tradeoffs)
- **Supabase over Firebase:** Postgres is the right primitive for inventory (joins, transactions, complex reports). RLS is enterprise-grade.
- **Next.js over Remix:** larger ecosystem, better Vercel integration, RSC works better for data-dense dashboards.
- **Expo over bare RN:** OTA updates, EAS, faster iteration. We can eject if we need.
- **Server Actions over tRPC:** less boilerplate, RSC native; mobile uses dedicated REST endpoints.
- **TanStack Query over SWR:** mutations + optimistic updates first-class, better for inventory writes.

---

## 3. App Architecture

### High-level

```
┌─────────────────────────────────────────────────────────────────┐
│                          Clients                                 │
│  Next.js Web  |  iOS (Expo)  |  Android (Expo)  |  Mobile Web   │
└────────────┬───────────────────┬───────────────────┬─────────────┘
             │                   │                   │
             ▼                   ▼                   ▼
        ┌──────────────────────────────────────────────────┐
        │     Vercel Edge / Fluid Compute (Next.js)        │
        │  - Server Actions (CRUD)                         │
        │  - Route handlers (REST for mobile, webhooks)    │
        │  - Middleware (auth, org-scoping)                │
        └────────────┬─────────────────────────────────────┘
                     │
                     ▼
        ┌──────────────────────────────────────────────────┐
        │            Supabase                              │
        │  Postgres 16  │  Auth  │  Storage  │  Realtime  │
        │  Edge Funcs (Stripe webhook, heavy reports)      │
        │  pg_cron (low-stock scan, weekly digest)         │
        └────────────┬─────────────────────────────────────┘
                     │
       ┌─────────────┼─────────────┐
       ▼             ▼             ▼
   Stripe       Resend       Expo Push
```

### Data flow patterns
- **Read-heavy dashboard** → RSC + Supabase server client → cached with `cacheLife` tags, invalidated by `updateTag('org:{id}:items')` on write
- **Mutations** → server action → Postgres txn → revalidate tag → Realtime broadcast for other tabs
- **Mobile** → REST endpoints under `/api/v1/*` (versioned) → same shared service layer
- **Scanning** → camera → SKU/barcode lookup endpoint → optimistic stock adjustment → write to `stock_movements`

---

## 4. Monorepo Folder Structure

```
stockpilot/
├── apps/
│   ├── web/                    # Next.js 16 marketing + dashboard
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── (marketing)/        # Landing, pricing, FAQ
│   │   │   │   ├── (auth)/             # signin, signup, reset
│   │   │   │   ├── (dashboard)/        # authed app
│   │   │   │   │   ├── dashboard/
│   │   │   │   │   ├── inventory/
│   │   │   │   │   ├── locations/
│   │   │   │   │   ├── suppliers/
│   │   │   │   │   ├── purchase-orders/
│   │   │   │   │   ├── reports/
│   │   │   │   │   ├── team/
│   │   │   │   │   └── settings/
│   │   │   │   ├── api/
│   │   │   │   │   ├── v1/             # Mobile-facing REST
│   │   │   │   │   └── webhooks/       # Stripe, Resend
│   │   │   │   └── layout.tsx
│   │   │   ├── components/
│   │   │   │   ├── ui/                 # shadcn primitives
│   │   │   │   ├── marketing/          # Landing scroll panels
│   │   │   │   ├── dashboard/          # App shell, sidebar
│   │   │   │   ├── inventory/          # Item table, drawer, forms
│   │   │   │   └── shared/
│   │   │   ├── lib/
│   │   │   │   ├── supabase/           # server, client, admin
│   │   │   │   ├── auth/
│   │   │   │   ├── stripe/
│   │   │   │   ├── email/              # React Email templates
│   │   │   │   ├── permissions/        # RBAC checker
│   │   │   │   └── utils/
│   │   │   ├── server/
│   │   │   │   ├── actions/            # server actions, grouped by domain
│   │   │   │   └── services/           # business logic, called by actions + REST
│   │   │   └── styles/
│   │   ├── public/
│   │   ├── next.config.ts
│   │   ├── tailwind.config.ts
│   │   └── package.json
│   │
│   └── mobile/                 # Expo app
│       ├── app/                # expo-router file-based routes
│       │   ├── (auth)/
│       │   ├── (tabs)/
│       │   │   ├── index.tsx           # Dashboard
│       │   │   ├── inventory.tsx
│       │   │   ├── scan.tsx            # Barcode scanner
│       │   │   └── settings.tsx
│       │   └── item/[id].tsx
│       ├── components/
│       ├── hooks/
│       ├── lib/
│       │   ├── supabase.ts
│       │   ├── api.ts                  # REST client to /api/v1/*
│       │   └── notifications.ts
│       ├── app.config.ts
│       └── package.json
│
├── packages/
│   ├── db/                     # Supabase types + migrations
│   │   ├── migrations/         # SQL migrations (source of truth)
│   │   ├── seed/
│   │   └── types.ts            # generated from `supabase gen types`
│   ├── ui/                     # shared UI primitives (web only for now)
│   ├── core/                   # shared business types, Zod schemas, constants
│   │   ├── schemas/            # Zod validators
│   │   ├── types/              # TS types
│   │   └── constants/          # plan limits, role definitions
│   ├── api-client/             # typed fetch client used by mobile + web
│   ├── email-templates/        # React Email templates
│   └── config/                 # eslint, tsconfig, tailwind presets
│
├── supabase/
│   ├── migrations/             # mirrored from packages/db/migrations
│   ├── functions/              # edge functions (stripe-webhook, etc.)
│   ├── config.toml
│   └── seed.sql
│
├── .github/workflows/
│   ├── ci.yml
│   └── deploy.yml
├── turbo.json
├── pnpm-workspace.yaml
├── package.json
└── README.md
```

---

## 5. Database Schema

### Design principles
- All tenant tables include `organization_id` (FK to `organizations`)
- Soft delete via `deleted_at TIMESTAMPTZ` for inventory items, locations, suppliers
- `created_by`, `updated_by` on every mutable table (audit trail)
- UUIDs (gen_random_uuid()) as primary keys
- Generated SKU column when not provided
- Full-text search on items via `tsvector` + GIN index

### Core tables

```sql
-- ===== Identity & multi-tenancy =====

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  logo_url text,
  industry text,
  size text,
  timezone text not null default 'UTC',
  currency text not null default 'USD',
  plan text not null default 'free' check (plan in ('free','pro','business','enterprise')),
  stripe_customer_id text unique,
  stripe_subscription_id text,
  trial_ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  avatar_url text,
  default_organization_id uuid references organizations(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references user_profiles(id) on delete cascade,
  role text not null check (role in ('owner','admin','manager','staff','viewer')),
  invited_by uuid references user_profiles(id),
  invited_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  unique(organization_id, user_id)
);

create table organization_invites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  email text not null,
  role text not null,
  token text unique not null,
  expires_at timestamptz not null,
  invited_by uuid not null references user_profiles(id),
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

-- ===== Inventory taxonomy =====

create table categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  parent_id uuid references categories(id) on delete set null,
  name text not null,
  description text,
  color text,
  icon text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index on categories (organization_id);
create index on categories (parent_id);

create table tags (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  color text,
  created_at timestamptz not null default now(),
  unique(organization_id, name)
);

create table locations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  parent_id uuid references locations(id) on delete set null,
  name text not null,
  type text check (type in ('warehouse','room','shelf','bin','vehicle','jobsite','other')),
  address jsonb,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index on locations (organization_id);

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  contact_name text,
  email text,
  phone text,
  website text,
  address jsonb,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index on suppliers (organization_id);

-- ===== Inventory items (the heart) =====

create table inventory_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  sku text not null,
  barcode text,
  name text not null,
  description text,
  category_id uuid references categories(id) on delete set null,
  supplier_id uuid references suppliers(id) on delete set null,
  primary_location_id uuid references locations(id) on delete set null,
  unit_cost numeric(14,4) default 0,
  retail_price numeric(14,4) default 0,
  quantity_on_hand numeric(14,4) not null default 0,
  reorder_point numeric(14,4) default 0,
  reorder_quantity numeric(14,4) default 0,
  unit_of_measure text default 'unit',
  status text not null default 'active' check (status in ('active','archived','discontinued')),
  bin_location text,
  custom_fields jsonb default '{}'::jsonb,
  search_vector tsvector,
  embedding vector(1536),                -- pgvector for AI search (Phase 9)
  created_by uuid references user_profiles(id),
  updated_by uuid references user_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique(organization_id, sku)
);
create index on inventory_items (organization_id, status) where deleted_at is null;
create index on inventory_items (organization_id, barcode) where barcode is not null;
create index on inventory_items using gin (search_vector);
create index on inventory_items (organization_id, quantity_on_hand)
  where status = 'active' and deleted_at is null;

-- Per-location stock for multi-location accuracy
create table item_stock_levels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  item_id uuid not null references inventory_items(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  quantity numeric(14,4) not null default 0,
  updated_at timestamptz not null default now(),
  unique(item_id, location_id)
);
create index on item_stock_levels (organization_id, location_id);

create table item_images (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  item_id uuid not null references inventory_items(id) on delete cascade,
  storage_path text not null,
  alt text,
  sort_order int default 0,
  is_primary boolean default false,
  created_at timestamptz not null default now()
);

create table item_attachments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  item_id uuid not null references inventory_items(id) on delete cascade,
  storage_path text not null,
  filename text not null,
  mime_type text,
  size_bytes int,
  created_by uuid references user_profiles(id),
  created_at timestamptz not null default now()
);

create table item_tags (
  item_id uuid not null references inventory_items(id) on delete cascade,
  tag_id uuid not null references tags(id) on delete cascade,
  primary key (item_id, tag_id)
);

create table custom_field_definitions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  entity text not null check (entity in ('item','supplier','location')),
  key text not null,
  label text not null,
  field_type text not null check (field_type in ('text','number','date','boolean','select')),
  options jsonb,
  required boolean default false,
  sort_order int default 0,
  unique (organization_id, entity, key)
);

-- ===== Stock movements (immutable ledger) =====

create table stock_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  item_id uuid not null references inventory_items(id) on delete cascade,
  movement_type text not null check (movement_type in (
    'add','remove','adjust','transfer','receive_po','return','damage','loss','correction','initial'
  )),
  quantity_change numeric(14,4) not null,
  previous_quantity numeric(14,4) not null,
  new_quantity numeric(14,4) not null,
  from_location_id uuid references locations(id),
  to_location_id uuid references locations(id),
  reason text,
  reference_type text,            -- 'purchase_order' | 'manual' | 'import'
  reference_id uuid,
  user_id uuid references user_profiles(id),
  notes text,
  created_at timestamptz not null default now()
);
create index on stock_movements (organization_id, created_at desc);
create index on stock_movements (item_id, created_at desc);

-- ===== Purchase orders =====

create table purchase_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  po_number text not null,
  supplier_id uuid references suppliers(id),
  destination_location_id uuid references locations(id),
  status text not null default 'draft' check (status in (
    'draft','ordered','partially_received','received','cancelled'
  )),
  expected_at timestamptz,
  ordered_at timestamptz,
  received_at timestamptz,
  subtotal numeric(14,4) default 0,
  tax numeric(14,4) default 0,
  shipping numeric(14,4) default 0,
  total numeric(14,4) default 0,
  notes text,
  created_by uuid references user_profiles(id),
  updated_by uuid references user_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id, po_number)
);

create table purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  purchase_order_id uuid not null references purchase_orders(id) on delete cascade,
  item_id uuid not null references inventory_items(id),
  quantity_ordered numeric(14,4) not null,
  quantity_received numeric(14,4) not null default 0,
  unit_cost numeric(14,4) not null,
  line_total numeric(14,4) generated always as (quantity_ordered * unit_cost) stored
);

-- ===== Notifications & activity =====

create table notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references user_profiles(id) on delete cascade,
  type text not null,             -- 'low_stock','out_of_stock','po_received','member_invited',...
  title text not null,
  body text,
  link text,
  metadata jsonb default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index on notifications (user_id, read_at) where read_at is null;

create table notification_preferences (
  user_id uuid primary key references user_profiles(id) on delete cascade,
  email_low_stock boolean default true,
  email_po_status boolean default true,
  email_weekly_digest boolean default true,
  email_team_invites boolean default true,
  push_low_stock boolean default true,
  push_po_status boolean default true,
  push_stock_transfer boolean default true
);

create table activity_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid references user_profiles(id),
  entity_type text not null,
  entity_id uuid,
  action text not null,
  diff jsonb,
  ip inet,
  user_agent text,
  created_at timestamptz not null default now()
);
create index on activity_logs (organization_id, created_at desc);

create table audit_logs (
  -- security/auth-grade audit (logins, role changes, billing)
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  user_id uuid references user_profiles(id),
  event text not null,
  metadata jsonb,
  ip inet,
  user_agent text,
  created_at timestamptz not null default now()
);

-- ===== Push tokens (mobile) =====

create table push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references user_profiles(id) on delete cascade,
  token text unique not null,
  platform text not null check (platform in ('ios','android','web')),
  device_id text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz default now()
);

-- ===== Imports =====

create table import_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references user_profiles(id),
  entity text not null check (entity in ('items','suppliers','locations')),
  status text not null default 'pending' check (status in ('pending','processing','completed','failed')),
  storage_path text not null,
  rows_total int default 0,
  rows_imported int default 0,
  rows_failed int default 0,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table import_job_errors (
  id uuid primary key default gen_random_uuid(),
  import_job_id uuid not null references import_jobs(id) on delete cascade,
  row_number int,
  error_code text,
  message text,
  data jsonb
);

-- ===== Billing =====

create table billing_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  stripe_event_id text unique not null,
  type text not null,
  payload jsonb not null,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

-- ===== Triggers =====

-- Auto-update search_vector
create function items_update_search_vector() returns trigger as $$
begin
  new.search_vector :=
    setweight(to_tsvector('english', coalesce(new.name,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(new.sku,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(new.barcode,'')), 'B') ||
    setweight(to_tsvector('english', coalesce(new.description,'')), 'C');
  new.updated_at := now();
  return new;
end $$ language plpgsql;

create trigger items_search_trigger
before insert or update on inventory_items
for each row execute function items_update_search_vector();

-- Stock movement -> update item quantity (atomic via txn in service layer instead)
-- We'll keep this in the service layer for transactional safety with multi-location stock.
```

---

## 6. RLS / Security Design

### Pattern
Every multi-tenant table uses the same template:

```sql
alter table inventory_items enable row level security;

create policy "members_can_select_items"
on inventory_items for select
using (organization_id in (
  select organization_id from organization_members
  where user_id = auth.uid() and accepted_at is not null
));

create policy "managers_can_insert_items"
on inventory_items for insert
with check (
  organization_id in (
    select organization_id from organization_members
    where user_id = auth.uid() and role in ('owner','admin','manager','staff')
  )
);

create policy "managers_can_update_items"
on inventory_items for update
using (
  organization_id in (
    select organization_id from organization_members
    where user_id = auth.uid() and role in ('owner','admin','manager')
  )
);

create policy "owners_admins_can_delete_items"
on inventory_items for delete
using (
  organization_id in (
    select organization_id from organization_members
    where user_id = auth.uid() and role in ('owner','admin')
  )
);
```

### Helper functions (set in `auth` schema, security-definer)
- `auth.user_org_role(org_id uuid) returns text` — used in policies & app layer
- `auth.user_orgs() returns setof uuid` — list of orgs user belongs to

### Permissions matrix
| Action | Owner | Admin | Manager | Staff | Viewer |
|---|:-:|:-:|:-:|:-:|:-:|
| Read all | ✓ | ✓ | ✓ | ✓ | ✓ |
| Add/edit items | ✓ | ✓ | ✓ | ✓ | – |
| Adjust stock | ✓ | ✓ | ✓ | ✓ | – |
| Manage suppliers | ✓ | ✓ | ✓ | – | – |
| Manage POs | ✓ | ✓ | ✓ | – | – |
| Manage locations/categories | ✓ | ✓ | ✓ | – | – |
| Invite/remove members | ✓ | ✓ | – | – | – |
| Manage billing | ✓ | – | – | – | – |
| Delete organization | ✓ | – | – | – | – |

### Security checklist (locked in before launch)
- [x] Strict TS, ESLint security plugin
- [x] Zod-validated inputs at every server-action / API entry
- [x] All Stripe webhooks signature-verified before processing
- [x] Resend webhooks signature-verified
- [x] Service-role key used only in edge functions / server, never in client
- [x] Storage bucket policies scoped by org id in path
- [x] Rate limiting on auth + scan endpoints (Upstash Redis or `@vercel/firewall`)
- [x] CSRF protection: Next.js server actions are CSRF-safe by default; REST endpoints require Bearer JWT
- [x] CSP headers via `next.config.ts`
- [x] Audit log for billing changes, role changes, member changes, export actions
- [x] Idempotency keys on Stripe webhooks (via `billing_events.stripe_event_id`)
- [x] Strict mime-type + size validation on uploads
- [x] Server-side plan-limit enforcement (not client-trusted)
- [x] Secure invite tokens: cryptographically random, single-use, 7-day TTL
- [x] Session: HttpOnly + Secure + SameSite cookies via Supabase Auth Helpers
- [x] All migrations reviewed for missing RLS (`tablename` should never be in `pg_tables` without policies)

---

## 7. API / Server Action Design

### Conventions
- **Web:** server actions co-located in `apps/web/src/server/actions/{domain}.ts`
- **Mobile/external:** `/api/v1/{resource}` REST endpoints (versioned)
- Both call the same `services/` layer for business logic — single source of truth
- Returns: `{ data, error }` discriminated union; never throw across the boundary
- Errors: typed error codes + i18n-friendly messages

### Server actions (web)
```ts
// apps/web/src/server/actions/inventory.ts
'use server';
export async function createItem(input: CreateItemInput): Promise<ActionResult<Item>>;
export async function updateItem(id: string, patch: UpdateItemInput): Promise<ActionResult<Item>>;
export async function archiveItem(id: string): Promise<ActionResult<void>>;
export async function adjustStock(id: string, input: AdjustStockInput): Promise<ActionResult<Item>>;
export async function transferStock(input: TransferInput): Promise<ActionResult<void>>;
export async function bulkImportItems(jobId: string): Promise<ActionResult<ImportJob>>;
```

### REST endpoints (mobile)
```
POST   /api/v1/auth/login
POST   /api/v1/auth/refresh
GET    /api/v1/me
GET    /api/v1/organizations/:orgId
GET    /api/v1/organizations/:orgId/items?cursor=&q=&category=&status=
POST   /api/v1/organizations/:orgId/items
GET    /api/v1/organizations/:orgId/items/:itemId
PATCH  /api/v1/organizations/:orgId/items/:itemId
POST   /api/v1/organizations/:orgId/items/:itemId/adjust-stock
POST   /api/v1/organizations/:orgId/items/lookup-by-barcode
GET    /api/v1/organizations/:orgId/locations
GET    /api/v1/organizations/:orgId/suppliers
GET    /api/v1/organizations/:orgId/purchase-orders
POST   /api/v1/organizations/:orgId/purchase-orders/:poId/receive
GET    /api/v1/organizations/:orgId/notifications
POST   /api/v1/organizations/:orgId/notifications/read-all
POST   /api/v1/push-tokens
POST   /api/webhooks/stripe
POST   /api/webhooks/resend
```

### Service layer pattern
```ts
// apps/web/src/server/services/inventory.ts
export class InventoryService {
  constructor(private ctx: AuthContext, private db: SupabaseClient) {}
  async create(input: CreateItemInput) {
    await this.ctx.assertPermission('items:create');
    await this.ctx.assertPlanLimit('items');
    return this.db.from('inventory_items').insert({...}).single();
  }
}
```

---

## 8. Main User Flows

### Onboarding
1. User signs up via email or Google OAuth
2. Email confirmation
3. Onboarding wizard (3 steps): org name → industry/use case → invite teammates (optional)
4. Default location "Main Warehouse" + 4 starter categories created
5. Lands on dashboard with sample empty state + "Add your first item" CTA

### Add inventory item (web)
1. Sidebar → "Inventory" → "+ New Item"
2. Drawer slides in (right side, 480px) with form
3. Image drop zone → upload to Supabase Storage with `org/{orgId}/items/{itemId}/...` path
4. Submit → server action → optimistic insert into TanStack Query cache → revalidate

### Mobile scan-to-adjust
1. Tap "Scan" tab → camera opens
2. Scan barcode → POST `/items/lookup-by-barcode` → item card slides up
3. Tap "+5" or "−1" or custom → POST `/items/:id/adjust-stock`
4. Confirmation haptic + toast → return to scanner

### Purchase order receive
1. PO view → "Receive" button → modal with line items, default to ordered qty
2. Adjust received qty per line if partial
3. Submit → txn: update PO status, create stock_movements, increment item qty
4. Notification fired to org members watching PO

### Team invite
1. Settings → Team → "Invite member"
2. Email + role → server creates `organization_invites` + sends email via Resend
3. Recipient clicks link → signs up or signs in → token redeemed → membership row created

---

## 9. Landing Page Scrollytelling Storyboard

Frame budget: 11 panels with sticky scroll-trigger sections. Total scroll length ~600vh.

| # | Panel | Animation | Key visual |
|---|---|---|---|
| 1 | Hero | Floating 3D inventory cards parallax; subtle gradient mesh; type-on headline | Headline: "Inventory you'll actually enjoy using." |
| 2 | Problem | Spreadsheet rows scatter, items go "missing" (faded out), stock numbers turn red | Chaos visual |
| 3 | Transformation | Same items snap into clean grid by category, color-coded by location | Order from chaos |
| 4 | Feature 1 — Scan | Phone mockup pinned, barcode lines animate, item card slides up | Live scan demo |
| 5 | Feature 2 — Real-time | Two browser windows side by side, edit on one shows on the other | Realtime sync |
| 6 | Feature 3 — POs | Purchase order auto-completes, stock numbers tick up | Auto receive |
| 7 | Feature 4 — Reports | Charts draw in as scroll progresses; stat cards count up | Analytics |
| 8 | Dashboard preview | Full mockup zoom-in with hotspots highlighting nav, table, charts | Hero dashboard |
| 9 | Mobile section | Twin iPhone + Pixel mockups tilted; swipe between flows on scroll | Native apps |
| 10 | Use cases | Horizontal scroller of 8 industries with custom illustrations | Versatility |
| 11 | AI peek | "Coming soon" — anomaly graph, "Reorder 24 units of X next Tuesday" suggestion | Future |
| 12 | Pricing | 4 cards, hover lift + glow on Pro (recommended) | Stripe-grade |
| 13 | FAQ | Accordion + answer fly-up | Standard |
| 14 | Final CTA | Big gradient, single CTA, footer | Convert |

Tech: Framer Motion `useScroll` + `useTransform`, GSAP ScrollTrigger only if needed, Lenis for smooth scroll, prefers-reduced-motion fallback that disables all parallax/transforms.

---

## 10. Dashboard Page Map

```
/dashboard                         Home — KPIs, low-stock cards, recent activity, charts
/dashboard/inventory               Items table (search, filter, bulk actions)
/dashboard/inventory/new           New item drawer
/dashboard/inventory/[id]          Item detail (tabs: Overview, Movements, Images, Notes)
/dashboard/inventory/[id]/edit     Edit drawer
/dashboard/inventory/import        CSV import wizard
/dashboard/locations               Location tree + table
/dashboard/locations/[id]          Location detail with on-hand items
/dashboard/categories              Category management
/dashboard/suppliers               Supplier list
/dashboard/suppliers/[id]          Supplier detail with linked items + PO history
/dashboard/purchase-orders         PO list, status filters
/dashboard/purchase-orders/new     PO builder
/dashboard/purchase-orders/[id]    PO detail with receive flow
/dashboard/movements               Stock movement ledger
/dashboard/reports                 Report hub
/dashboard/reports/inventory-value
/dashboard/reports/low-stock
/dashboard/reports/movement
/dashboard/reports/supplier
/dashboard/team                    Members + invites
/dashboard/notifications           Notification center
/dashboard/settings/organization
/dashboard/settings/billing
/dashboard/settings/preferences
/dashboard/settings/security
/dashboard/settings/api-keys       Phase 8+
```

App shell: collapsible left sidebar, topbar with global search (Cmd+K), notification bell, org switcher, user menu.

---

## 11. Mobile App Architecture

### Structure
- **Auth:** Supabase session in `expo-secure-store`; refreshed on resume
- **Routing:** `expo-router` v3 file-based; auth group + main tabs group
- **Tabs:** Home / Inventory / Scan (center, elevated FAB-style) / Activity / Settings
- **Shared logic:** consumed from `packages/core` (zod schemas, types) and `packages/api-client`
- **Networking:** typed REST client → `/api/v1/*` with auto-refresh JWT
- **Cache:** TanStack Query with persistence to AsyncStorage; offline read OK at MVP
- **Camera:** `expo-camera` `BarcodeScanner` view; throttled scans, haptic feedback
- **Image capture:** `expo-image-picker` → resize via `expo-image-manipulator` → upload signed URL
- **Push:** `expo-notifications` register token → POST `/push-tokens`; server fans out via Expo Push API

### Offline strategy (Phase 7+)
- WatermelonDB local store mirroring inventory_items for read
- Pending writes queue (stock_movements with `pending: true`) flushed on reconnect
- Conflict policy: server is source of truth; client retries with latest qty

---

## 12. Billing Plan (Stripe)

### Products
- **Free** ($0): 1 user, 100 items, 1 location
- **Pro** ($19/mo or $190/yr): 5 users, 5,000 items, 5 locations, scanning, alerts
- **Business** ($59/mo or $590/yr): 25 users, 50,000 items, unlimited locations, POs, reports, RBAC, activity logs, priority support
- **Enterprise** (contact sales): custom limits, SSO, API, dedicated support

### Implementation
- Stripe Products + Prices created via dashboard, IDs stored in env vars
- `POST /api/v1/billing/checkout` creates checkout session
- `POST /api/v1/billing/portal` creates customer portal session
- Webhook handler in Supabase Edge Function processes:
  - `checkout.session.completed` → set plan, mark trial_ends_at if applicable
  - `customer.subscription.updated` → sync plan
  - `customer.subscription.deleted` → downgrade to free
  - `invoice.payment_failed` → notification + grace period
- Plan limits enforced in service layer via `assertPlanLimit('items' | 'locations' | 'members')`
- Plan-gated features hidden from UI but ALSO blocked server-side

### Free trial
- 14-day Pro trial on signup, no card required → converts or downgrades
- Email reminders at day 7, day 12, day 14

---

## 13. Testing Plan

| Layer | Tool | What we test |
|---|---|---|
| Unit | Vitest | services, utils, Zod schemas, permission logic, plan-limit checks |
| Component | Testing Library + Vitest | Forms, drawers, inventory table |
| Integration | Vitest + Supabase local | Server actions hitting real Postgres + RLS |
| E2E (web) | Playwright | Auth, onboarding, add item, scan-by-barcode, PO receive, billing checkout |
| E2E (mobile) | Maestro or Detox | Login, scan flow, stock adjust |
| RLS | pgTAP or Vitest with PG client | Cross-org data leak attempts MUST fail |
| Webhooks | Vitest + Stripe CLI fixtures | Idempotency, signature failures |
| Visual | Chromatic or Playwright snapshots | Landing page panels |
| Load | k6 | Inventory list 50k items, search latency |

CI: PR runs lint + typecheck + unit + integration; merge-to-main runs full suite + E2E + deploys preview. Coverage target: 80% on `services/` and `lib/permissions`.

---

## 14. Deployment Plan

### Environments
- **Local:** `supabase start` for local DB; `pnpm dev` for web; Expo dev client for mobile
- **Preview:** Vercel preview per PR + dedicated Supabase preview branch (or separate dev project)
- **Staging:** branch `staging` → staging Supabase project + Vercel staging domain
- **Production:** main branch → Vercel prod + Supabase prod

### Pipelines
- Web: Vercel git integration, automatic PR previews
- DB: migrations gated through `supabase db push` from CI on staging/prod with manual approval
- Mobile: EAS Build → TestFlight + Internal App Sharing on every release tag; EAS Submit to stores manually

### Secrets management
- `vercel env` for web env vars (use `vercel env pull` in dev)
- Supabase secrets via Supabase CLI for edge functions
- Mobile: EAS Secrets for build-time, `expo-secure-store` for runtime

### Observability
- Sentry on web + mobile + edge functions
- PostHog event funnel: signup → org_created → first_item → first_scan → upgrade_to_paid
- Vercel Analytics for landing page perf
- Supabase logs for slow queries; query plan reviews monthly

### Domain & DNS
- Apex `stockpilot.app` → Vercel
- `app.stockpilot.app` → dashboard
- `api.stockpilot.app` → REST endpoints (rewrite to `/api/v1/*`)

---

## 15. Implementation Phases

### Phase 1 — Foundation (week 1-2)
- Monorepo + Turborepo + pnpm workspaces
- Next.js 16 app, Tailwind v4, shadcn/ui, Lucide
- Theme tokens (light + dark), typography scale
- Supabase project, initial migrations: orgs, members, profiles
- Auth flows: signup, signin, password reset, email verify
- Marketing layout shell + landing hero
- ESLint, Prettier, Husky, commitlint, GitHub Actions CI

### Phase 2 — Dashboard MVP (week 3-4)
- App shell (sidebar, topbar, cmd palette stub)
- Org creation + onboarding wizard
- Items CRUD (table, drawer form, detail page)
- Categories, locations, suppliers CRUD
- Stock movements ledger
- Low-stock dashboard card
- Skeleton loading + empty states

### Phase 3 — Premium Landing (week 5-6)
- Full scrollytelling sections 1–14
- Animated dashboard preview component
- Mobile mockup section with Lottie or video
- Pricing, FAQ, footer
- SEO metadata, OG images, sitemap, robots

### Phase 4 — Team & Permissions (week 7)
- Invites + email
- RBAC enforcement layer (`assertPermission`)
- Activity logs UI
- RLS policies covering 100% of tenant tables (test suite proves it)
- Role badges + member management UI

### Phase 5 — Advanced inventory (week 8-9)
- Purchase orders (create, edit, receive)
- Barcode + QR generation (`bwip-js` server-side)
- CSV import wizard with validation report + dry-run
- Bulk export
- Item images via Supabase Storage with signed URLs
- Reports (inventory value, low stock, movement, supplier)

### Phase 6 — Billing (week 10)
- Stripe products + checkout
- Customer portal
- Webhook handler in edge function
- Plan limits enforced
- 14-day trial flow + reminder emails
- Upgrade nudges in UI when hitting caps

### Phase 7 — Mobile app (week 11-13)
- Expo project, expo-router auth flow
- Inventory list + detail + adjust
- Camera scanner + lookup-by-barcode endpoint
- Image capture + upload
- Push notification registration + alerts
- TestFlight + Play Internal release

### Phase 8 — Polish & launch (week 14)
- Accessibility audit (axe + manual)
- Performance: Lighthouse 95+ landing, 90+ dashboard
- Security review (RLS coverage, dependency audit, OWASP checklist)
- Docs site: docs.stockpilot.app (Mintlify or Nextra)
- Status page (BetterStack)
- Public launch

### Phase 9 — AI features (post-launch)
- Embeddings backfill on items (pgvector)
- "Ask your inventory" chat (Vercel AI Gateway → Claude/GPT)
- Reorder suggestions via simple regression on `stock_movements`
- Anomaly detection on adjustment patterns
- Auto-categorize via image vision
- Receipt/invoice OCR (Nutrient or vision model)

### Phase 10 — Integrations (post-launch)
- Shopify, WooCommerce, Square (read items + sync stock)
- QuickBooks Online (sync POs + cost basis)
- Zapier + Make
- Slack/Teams notifications

---

## Tradeoffs & Open Decisions

1. **Single-org-per-user vs multi-org?** Recommend multi-org — common pattern in B2B (agencies, accountants). Adds an org switcher but minor cost.
2. **Item quantity = sum of location stock vs separate column?** I went with both: `inventory_items.quantity_on_hand` is denormalized, `item_stock_levels` is canonical per location. Trigger or txn keeps them in sync. Tradeoff: extra write cost vs much faster list queries.
3. **Server actions vs tRPC for web?** Server actions chosen for simplicity + RSC-native. tRPC is a fine alternative if we want runtime-validated calls everywhere.
4. **Supabase Auth vs Clerk?** Supabase Auth is integrated and free; Clerk has nicer UI primitives and SSO/MFA built in. Decision: ship on Supabase Auth, switch to Clerk if SSO becomes a paid-tier requirement (deal-driven).
5. **Inngest vs pg_cron + Vercel cron?** Start with native primitives; switch to Inngest if we need step functions for multi-step workflows (e.g., complex import or PO receive sagas).
6. **Offline mobile in MVP or v2?** v2. MVP ships online-only with optimistic UI; offline (WatermelonDB or PowerSync) added once core flows stabilize.
7. **Product name "StockPilot":** check trademark + .app domain availability before locking in.

---

## Ready to build

Next step: I'll scaffold the monorepo, set up Turborepo + Next.js + Tailwind + shadcn, drop in the Supabase migrations, and stub the auth + landing hero. Ask me to start Phase 1 and I'll begin executing.
