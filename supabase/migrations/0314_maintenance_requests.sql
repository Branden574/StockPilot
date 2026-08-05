-- 0314_maintenance_requests.sql
--
-- L4L Maintenance Requests module: tables + RLS + permissions + module rows +
-- MR numbering + notification-pref columns.
--
-- DELIBERATE DEVIATIONS FROM THE BRIEF SKETCH (§27), each adjudicated in the
-- plan: related_order_request_id (no `orders` table exists; every FK into
-- order_requests is *_order_request_id); no asset_tag column (no such data
-- exists anywhere); explicit `status` column backing the four §20 states.
--
-- L4L ENABLEMENT IS NOT HERE. This migration only grandfathers enabled=false
-- rows for every org. The one-off enable UPDATE runs at ship time against the
-- prod-verified L4L org id (plan Task 26) — never name-matching, never
-- hardcoded here.

-- ── 1) Permission default rows (TS mirror: packages/core permissions.ts) ────
-- submit: everyone incl. viewer (brief: any employee reports issues).
-- read_all + manage: admin + manager. configure: NO rows — owner-only via the
-- has_permission owner short-circuit. 0207 pgTAP count moves 111 -> 119.
insert into public.role_default_permissions (role, permission) values
  ('admin',   'maintenance_requests:submit'),
  ('manager', 'maintenance_requests:submit'),
  ('staff',   'maintenance_requests:submit'),
  ('viewer',  'maintenance_requests:submit'),
  ('admin',   'maintenance_requests:read_all'),
  ('manager', 'maintenance_requests:read_all'),
  ('admin',   'maintenance_requests:manage'),
  ('manager', 'maintenance_requests:manage')
on conflict (role, permission) do nothing;

-- ── 2) Grandfather every existing org: 'maintenance_requests' OFF ───────────
insert into public.organization_modules (organization_id, module_id, enabled, tier, enabled_at)
select o.id, 'maintenance_requests', false, 'optional', now()
from public.organizations o
on conflict (organization_id, module_id) do nothing;

-- ── 3) New-org seed: the 0297 body VERBATIM + the new row appended ──────────
-- Copied byte-for-byte from 0297_sports_module.sql (the latest wholesale
-- rewrite). Do not re-order, do not tidy, do not drop a module.
create or replace function public.seed_org_modules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.organization_modules (organization_id, module_id, tier, enabled)
  select new.id, m.module_id, m.tier, m.enabled
  from (values
    -- 12 core (enabled)
    ('overview','core', true),
    ('inventory','core', true),
    ('movements','core', true),
    ('categories','core', true),
    ('locations','core', true),
    ('reports','core', true),
    ('notifications','core', true),
    ('team','core', true),
    ('settings','core', true),
    ('admin_tools','core', true),
    ('charters','core', true),
    ('scan','core', true),
    -- 13 optional (enabled)
    ('books','optional', true),
    ('rentals','optional', true),
    ('bundles','optional', true),
    ('orders','optional', true),
    ('cycle_counts','optional', true),
    ('procedures','optional', true),
    ('purchase_orders','optional', true),
    ('receiving','optional', true),
    ('po_imports','optional', true),
    ('suppliers','optional', true),
    ('schedule','optional', true),
    ('ai','optional', true),
    ('public_requests','optional', true),
    -- returns: gate cleared + owner-enabled 2026-06-11 (0174)
    ('returns','optional', true),
    -- net-new opt-in optional (OFF)
    ('planning','optional', false),
    ('lot_serial','premium', false),
    ('price_tracking','optional', false),
    ('live_tracking','optional', false),
    -- net-new opt-in optional (OFF)
    ('zendesk','optional', false),
    -- sports: self-contained premium module, OFF by default (0297)
    ('sports','premium', false),
    -- maintenance requests: L4L-only for now, OFF by default (this migration)
    ('maintenance_requests','optional', false)
  ) as m(module_id, tier, enabled)
  on conflict (organization_id, module_id) do nothing;
  return new;
exception
  when others then
    raise warning 'seed_org_modules failed for org %: %', new.id, sqlerrm;
    return new;
end;
$$;

drop trigger if exists trg_seed_org_modules on public.organizations;
create trigger trg_seed_org_modules
  after insert on public.organizations
  for each row execute function public.seed_org_modules();

-- ── 4) maintenance_requests ─────────────────────────────────────────────────
create table if not exists public.maintenance_requests (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references public.organizations(id) on delete cascade,
  request_number            bigint,
  requester_user_id         uuid references auth.users(id) on delete set null,
  requester_name_snapshot   text not null check (length(requester_name_snapshot) between 1 and 200),
  requester_email_snapshot  text check (requester_email_snapshot is null or length(requester_email_snapshot) <= 320),
  requester_phone_snapshot  text check (requester_phone_snapshot is null or length(requester_phone_snapshot) <= 40),
  subject                   text not null check (length(subject) between 5 and 200),
  description               text not null check (length(description) between 1 and 5000),
  category                  text check (category is null or length(category) <= 80),
  priority                  text not null default 'normal'
                              check (priority in ('low','normal','high','urgent')),
  charter_id                uuid references public.charters(id) on delete set null,
  warehouse_id              uuid references public.warehouses(id) on delete set null,
  building                  text check (building is null or length(building) <= 200),
  room_or_area              text check (room_or_area is null or length(room_or_area) <= 200),
  department                text check (department is null or length(department) <= 200),
  access_instructions       text check (access_instructions is null or length(access_instructions) <= 2000),
  related_item_id           uuid references public.inventory_items(id) on delete set null,
  related_order_request_id  uuid references public.order_requests(id) on delete set null,
  related_rental_id         uuid references public.rentals(id) on delete set null,
  related_location_id       uuid references public.locations(id) on delete set null,
  local_owner_user_id       uuid references auth.users(id) on delete set null,
  status                    text not null default 'saved'
                              check (status in ('saved','draft_opened','archived','cancelled')),
  outlook_draft_opened_at   timestamptz,
  outlook_draft_open_count  integer not null default 0,
  draft_reminder_sent_at    timestamptz,
  archived_at               timestamptz,
  cancelled_at              timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

comment on table public.maintenance_requests is
  'L4L maintenance requests. StockPilot records Saved / Email draft opened / Archived / Cancelled ONLY — it can never observe whether the employee pressed Send or whether Zendesk created a ticket. No ticket-sync fields, ever.';

-- MR numbering: 0254 clone. Single per-org counter; the year in the display
-- handle (MR-2026-000123) is cosmetic, derived from created_at at format time.
create or replace function public.assign_maintenance_request_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.request_number is not null then
    return new; -- explicit numbers (restores) pass through
  end if;
  perform pg_advisory_xact_lock(hashtext('maintenance_request_number:' || new.organization_id::text));
  select coalesce(max(request_number), 0) + 1
    into new.request_number
    from public.maintenance_requests
   where organization_id = new.organization_id;
  return new;
end;
$$;

drop trigger if exists trg_assign_maintenance_request_number on public.maintenance_requests;
create trigger trg_assign_maintenance_request_number
  before insert on public.maintenance_requests
  for each row execute function public.assign_maintenance_request_number();

alter table public.maintenance_requests
  alter column request_number set not null;

create unique index if not exists maintenance_requests_org_number_uniq
  on public.maintenance_requests (organization_id, request_number);
create index if not exists maintenance_requests_org_created_idx
  on public.maintenance_requests (organization_id, created_at desc);
create index if not exists maintenance_requests_org_requester_idx
  on public.maintenance_requests (organization_id, requester_user_id, created_at desc);
create index if not exists maintenance_requests_org_status_idx
  on public.maintenance_requests (organization_id, status);

-- ── 5) maintenance_request_attachments ──────────────────────────────────────
create table if not exists public.maintenance_request_attachments (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations(id) on delete cascade,
  maintenance_request_id uuid not null references public.maintenance_requests(id) on delete cascade,
  storage_path           text not null check (length(storage_path) <= 500),
  thumbnail_path         text check (thumbnail_path is null or length(thumbnail_path) <= 500),
  original_filename      text not null check (length(original_filename) <= 300),
  safe_filename          text not null check (length(safe_filename) <= 300),
  mime_type              text not null check (mime_type in ('image/png','image/jpeg','image/webp')),
  byte_size              integer not null check (byte_size > 0 and byte_size <= 10485760),
  width                  integer,
  height                 integer,
  sort_order             integer not null default 0,
  verified_at            timestamptz,
  uploaded_by            uuid references auth.users(id) on delete set null,
  created_at             timestamptz not null default now()
);

create index if not exists maintenance_request_attachments_req_idx
  on public.maintenance_request_attachments (maintenance_request_id, sort_order, created_at);
create index if not exists maintenance_request_attachments_org_idx
  on public.maintenance_request_attachments (organization_id);

-- ── 6) maintenance_request_notes (internal StockPilot notes — NEVER Zendesk) ─
create table if not exists public.maintenance_request_notes (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations(id) on delete cascade,
  maintenance_request_id uuid not null references public.maintenance_requests(id) on delete cascade,
  author_user_id         uuid references auth.users(id) on delete set null,
  body                   text not null check (length(body) between 1 and 4000),
  created_at             timestamptz not null default now()
);

create index if not exists maintenance_request_notes_req_idx
  on public.maintenance_request_notes (maintenance_request_id, created_at);

-- ── 7) maintenance_request_share_links (0261 token pattern, request-scoped) ─
create table if not exists public.maintenance_request_share_links (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations(id) on delete cascade,
  maintenance_request_id uuid not null references public.maintenance_requests(id) on delete cascade,
  token                  text not null unique check (length(token) between 16 and 128),
  active                 boolean not null default true,
  expires_at             timestamptz not null,
  created_by             uuid references auth.users(id) on delete set null,
  revoked_at             timestamptz,
  created_at             timestamptz not null default now()
);

create index if not exists maintenance_request_share_links_req_idx
  on public.maintenance_request_share_links (maintenance_request_id);

-- ── 8) RLS ──────────────────────────────────────────────────────────────────
-- Every helper-function call inside a USING/WITH CHECK predicate below is
-- wrapped in `(select ...)`, matching the 0140 initplan-wrapping convention
-- (see 0140_rls_initplan_wrap.sql's item_tags_all example, which wraps
-- has_org_role even inside a correlated EXISTS) and the same convention 0297/
-- 0298/0301/0302/0304 already apply to every new policy since. This is a
-- deliberate departure from the brief's literal sketch, which left auth.uid(),
-- has_org_role(...) and has_permission(...) bare in several places.
alter table public.maintenance_requests enable row level security;
alter table public.maintenance_request_attachments enable row level security;
alter table public.maintenance_request_notes enable row level security;
alter table public.maintenance_request_share_links enable row level security;

grant select, insert, update on public.maintenance_requests to authenticated;
grant select, insert, delete on public.maintenance_request_attachments to authenticated;
grant select, insert on public.maintenance_request_notes to authenticated;
grant select on public.maintenance_request_share_links to authenticated;

-- SELECT: requester-own OR read_all OR manage. NOT module-gated (Q3): history
-- stays visible after a disable. has_permission (0310 rewrite) already fails
-- for disabled accounts and short-circuits owner to true.
create policy maintenance_requests_select on public.maintenance_requests
  for select to authenticated
  using (
    (requester_user_id = (select auth.uid()) and (select public.has_org_role(organization_id, 'viewer')))
    or (select public.has_permission(organization_id, 'maintenance_requests:read_all'))
    or (select public.has_permission(organization_id, 'maintenance_requests:manage'))
  );

-- INSERT: submitter creates OWN rows only; module must be enabled (Q3).
create policy maintenance_requests_insert on public.maintenance_requests
  for insert to authenticated
  with check (
    requester_user_id = (select auth.uid())
    and (
      (select public.has_org_role(organization_id, 'manager'))
      or (select public.has_permission(organization_id, 'maintenance_requests:submit'))
    )
    and (select public.module_enabled(organization_id, 'maintenance_requests'))
  );

-- UPDATE: requester edits own pre-archival rows; manage/manager edit any.
-- Allowed-FIELD narrowing (requester cannot flip local_owner_user_id etc.) is
-- enforced in the service layer; RLS enforces the row boundary.
create policy maintenance_requests_update on public.maintenance_requests
  for update to authenticated
  using (
    (requester_user_id = (select auth.uid()) and archived_at is null and cancelled_at is null
      and (select public.has_org_role(organization_id, 'viewer')))
    or (select public.has_org_role(organization_id, 'manager'))
    or (select public.has_permission(organization_id, 'maintenance_requests:manage'))
  )
  with check (
    (
      (requester_user_id = (select auth.uid()) and (select public.has_org_role(organization_id, 'viewer')))
      or (select public.has_org_role(organization_id, 'manager'))
      or (select public.has_permission(organization_id, 'maintenance_requests:manage'))
    )
    and (select public.module_enabled(organization_id, 'maintenance_requests'))
  );

-- Attachments: visibility follows the parent row.
create policy maintenance_request_attachments_select on public.maintenance_request_attachments
  for select to authenticated
  using (
    exists (
      select 1 from public.maintenance_requests r
       where r.id = maintenance_request_id
         and r.organization_id = organization_id
         and (
           (r.requester_user_id = (select auth.uid()) and (select public.has_org_role(r.organization_id, 'viewer')))
           or (select public.has_permission(r.organization_id, 'maintenance_requests:read_all'))
           or (select public.has_permission(r.organization_id, 'maintenance_requests:manage'))
         )
    )
  );

create policy maintenance_request_attachments_insert on public.maintenance_request_attachments
  for insert to authenticated
  with check (
    uploaded_by = (select auth.uid())
    and (select public.module_enabled(organization_id, 'maintenance_requests'))
    and exists (
      select 1 from public.maintenance_requests r
       where r.id = maintenance_request_id
         and r.organization_id = organization_id
         and r.archived_at is null and r.cancelled_at is null
         and (
           r.requester_user_id = (select auth.uid())
           or (select public.has_org_role(r.organization_id, 'manager'))
           or (select public.has_permission(r.organization_id, 'maintenance_requests:manage'))
         )
    )
  );

create policy maintenance_request_attachments_delete on public.maintenance_request_attachments
  for delete to authenticated
  using (
    exists (
      select 1 from public.maintenance_requests r
       where r.id = maintenance_request_id
         and r.organization_id = organization_id
         and r.archived_at is null and r.cancelled_at is null
         and (
           r.requester_user_id = (select auth.uid())
           or (select public.has_org_role(r.organization_id, 'manager'))
           or (select public.has_permission(r.organization_id, 'maintenance_requests:manage'))
         )
    )
  );

-- Notes: manage-only in BOTH directions (brief: requester must never read
-- internal notes; read_all explicitly excludes notes).
create policy maintenance_request_notes_select on public.maintenance_request_notes
  for select to authenticated
  using ((select public.has_permission(organization_id, 'maintenance_requests:manage')));

create policy maintenance_request_notes_insert on public.maintenance_request_notes
  for insert to authenticated
  with check (
    author_user_id = (select auth.uid())
    and (select public.has_permission(organization_id, 'maintenance_requests:manage'))
    and (select public.module_enabled(organization_id, 'maintenance_requests'))
  );

-- Share links: tokens are secrets. SELECT for manage only; ALL writes happen
-- through the service-role client (no authenticated write policies at all).
create policy maintenance_request_share_links_select on public.maintenance_request_share_links
  for select to authenticated
  using ((select public.has_permission(organization_id, 'maintenance_requests:manage')));

-- ── 9) Notification preference columns (0265 recipe) ────────────────────────
alter table public.notification_preferences
  add column if not exists push_maintenance_new_request    boolean not null default true,
  add column if not exists push_maintenance_urgent_request boolean not null default true,
  add column if not exists push_maintenance_assigned       boolean not null default true,
  add column if not exists push_maintenance_draft_reminder boolean not null default true;
