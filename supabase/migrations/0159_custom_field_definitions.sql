-- ============================================================================
-- 0159_custom_field_definitions.sql — Per-org CUSTOM FIELD definitions.
--
-- A per-org registry of typed extra fields for items. Each definition names a
-- snake_case `field_key` that becomes a key inside inventory_items.custom_fields
-- (the jsonb column from 0002, which already holds hardcoded keys such as
-- book_rack_number/rack_number/size/author). Definitions describe HOW to render
-- + validate one custom_fields key; they NEVER touch the reserved hardcoded
-- keys — the item form writes those alongside, never through this registry.
--
-- Config table: ADMIN-managed. RLS = member SELECT, admin write — mirrors the
-- org-config posture (the nav/dashboard editors are likewise owner/admin only).
-- The write path is an admin-gated server action; this table is the trust
-- boundary's storage, RLS is the backstop.
--
-- Conventions re-used (verbatim from 0149/0146):
--   • RLS helpers from 0001_init.sql: is_org_member(org_id uuid),
--     has_org_role(org_id uuid, min_role text) — wrapped in (SELECT ...) per
--     the InitPlan convention (0140).
--   • tg_set_updated_at() updated_at trigger (0001) with the `drop trigger if
--     exists` idempotency guard.
--   • `drop policy if exists` policy guards; grants to authenticated.
-- ============================================================================

create table if not exists public.custom_field_definitions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Which entity the field decorates. Only 'item' today; the check keeps the
  -- door open for future entities without widening it accidentally.
  entity          text not null default 'item' check (entity in ('item')),
  -- The snake_case key written into inventory_items.custom_fields. Unique per
  -- (org, entity) so two definitions can't fight over the same jsonb key.
  field_key       text not null,
  label           text not null,
  field_type      text not null check (field_type in ('text','number','date','select','checkbox')),
  -- For 'select': a jsonb array of { value, label }. NULL for every other type.
  options         jsonb,
  required        boolean not null default false,
  sort_order      int not null default 0,
  archived        boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, entity, field_key)
);

create index if not exists custom_field_definitions_org_idx
  on public.custom_field_definitions (organization_id);

-- updated_at maintenance (tg_set_updated_at convention, 0001). ---------------
drop trigger if exists custom_field_definitions_set_updated_at on public.custom_field_definitions;
create trigger custom_field_definitions_set_updated_at
  before update on public.custom_field_definitions
  for each row execute function public.tg_set_updated_at();

-- RLS: member read, admin write (config table). ------------------------------
alter table public.custom_field_definitions enable row level security;

drop policy if exists custom_field_definitions_select on public.custom_field_definitions;
create policy custom_field_definitions_select on public.custom_field_definitions
  for select to authenticated using ((select public.is_org_member(organization_id)));

drop policy if exists custom_field_definitions_write on public.custom_field_definitions;
create policy custom_field_definitions_write on public.custom_field_definitions
  for all to authenticated
  using ((select public.has_org_role(organization_id,'admin')))
  with check ((select public.has_org_role(organization_id,'admin')));

grant select, insert, update, delete on public.custom_field_definitions to authenticated;

comment on table public.custom_field_definitions is
  'Per-org registry of typed extra fields for items. Each row describes one snake_case key stored inside inventory_items.custom_fields. Admin-managed (RLS = member select / admin write). Reserved hardcoded keys (book_rack_number/rack_number/size/author/...) are written by the item form directly and are never represented here.';
