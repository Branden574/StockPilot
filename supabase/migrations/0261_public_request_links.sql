-- 0261_public_request_links.sql
-- Public catalog visibility P1 (plan:
-- docs/superpowers/plans/2026-07-12-public-catalog-visibility-plan.md).
--
-- Per-link curated public request catalogs, backend-enforced:
--   1. public_request_links        — one row per shareable /r/<token> link
--                                    (name, purpose, window, per-type toggles,
--                                    qty defaults). Replaces the single
--                                    org-wide organizations.public_request_token
--                                    as the unit of configuration.
--   2. public_link_catalog_entries — the explicit per-link item allowlist
--                                    (+ optional per-item qty cap).
--   3. inventory_items.public_visibility  — 'internal_only' (default; imports
--                                    and new items never leak) | 'public'
--                                    (eligible for links with
--                                    include_public_pool) | 'hidden' (never
--                                    public, even with an explicit entry).
--      + public_display_name / public_description (public-facing fields,
--        separate from internal name/description).
--   4. categories.public_visibility — category-level default for the public
--                                    pool ('public' default | 'internal_only').
--   5. public_link_eligible_items() — THE single eligibility predicate. Both
--                                    the catalog render and the submit
--                                    endpoint resolve eligibility through this
--                                    function so they can never drift.
--   6. RLS: org members read; admins+ (or public_links:manage grantees)
--      write — 0250-style additive posture. The anonymous public surfaces
--      keep using the service-role admin client exactly like today.
--
-- MIGRATION FREEZE (zero behavior change for existing links):
--   Every org with a non-null organizations.public_request_token gets one
--   "General request link" row carrying the SAME token — existing /r/<token>
--   URLs keep resolving — with availability_display='exact' (today's page
--   shows exact counts) and an explicit catalog entry for every book that is
--   publicly orderable today (active, not deleted, in an is_public_orderable
--   warehouse). organizations.public_request_token stays; the read path
--   resolves links-table-first with an org-token fallback that can be dropped
--   once verified.

-- ── 1. public_links:manage permission seed ──────────────────────────────────
-- Mirrors ROLE_PERMISSIONS in packages/core (admin only by default; owner is
-- short-circuited in has_permission). The 0207 parity pgTAP counts these rows.
insert into public.role_default_permissions (role, permission) values
  ('admin', 'public_links:manage')
on conflict do nothing;

-- ── 2. Tables ────────────────────────────────────────────────────────────────
create table if not exists public.public_request_links (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete cascade,
  name                 text not null check (length(name) between 1 and 160),
  purpose              text check (purpose is null or length(purpose) <= 500),
  instructions         text check (instructions is null or length(instructions) <= 4000),
  -- Same shape as organizations.public_request_token (64 hex chars from
  -- crypto.getRandomValues(32 bytes)); range check mirrors the submit
  -- endpoint's accepted token length.
  token                text not null unique check (length(token) between 16 and 128),
  active               boolean not null default true,
  expires_at           timestamptz,
  available_from       timestamptz,
  available_until      timestamptz,
  -- How the public page presents stock: exact counts | in-stock/low/out
  -- buckets | nothing. New links default to buckets (don't leak counts);
  -- the migrated General links get 'exact' to freeze today's rendering.
  availability_display text not null default 'bucket'
                         check (availability_display in ('exact', 'bucket', 'none')),
  books_enabled        boolean not null default true,
  items_enabled        boolean not null default false,
  -- When true, items marked public_visibility='public' (in public categories)
  -- are eligible WITHOUT an explicit catalog entry.
  include_public_pool  boolean not null default false,
  -- Link-wide per-line qty cap; an entry's max_qty_per_request overrides it.
  default_max_qty      integer check (default_max_qty is null or default_max_qty > 0),
  created_by           uuid references auth.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table if not exists public.public_link_catalog_entries (
  link_id             uuid not null references public.public_request_links(id) on delete cascade,
  item_id             uuid not null references public.inventory_items(id) on delete cascade,
  max_qty_per_request integer check (max_qty_per_request is null or max_qty_per_request > 0),
  created_at          timestamptz not null default now(),
  primary key (link_id, item_id)
);

-- ── 3. Item + category visibility columns ───────────────────────────────────
-- DEFAULT 'internal_only': every insert path (InventoryService.create, sized
-- bulk-create, CSV import, books import, PO-import sibling creation, the
-- duplicate_inventory_item RPC) uses an explicit column list, so the DB
-- default applies everywhere — nothing becomes public by accident.
alter table public.inventory_items
  add column if not exists public_visibility text not null default 'internal_only'
    check (public_visibility in ('internal_only', 'public', 'hidden'));
alter table public.inventory_items
  add column if not exists public_display_name text
    check (public_display_name is null or length(public_display_name) <= 300);
alter table public.inventory_items
  add column if not exists public_description text
    check (public_description is null or length(public_description) <= 2000);

-- Category default for the public pool. 'public' by default: the pool branch
-- already requires the ITEM to be explicitly 'public', so the category value
-- acts as a restriction ('internal_only' pulls a whole category out of the
-- pool), not an exposure.
alter table public.categories
  add column if not exists public_visibility text not null default 'public'
    check (public_visibility in ('public', 'internal_only'));

-- ── 4. Indexes + updated_at ──────────────────────────────────────────────────
create index if not exists public_request_links_org_idx
  on public.public_request_links (organization_id);
-- token lookups use the implicit unique index on token.
create index if not exists public_link_catalog_entries_item_idx
  on public.public_link_catalog_entries (item_id);

create trigger trg_public_request_links_updated_at
  before update on public.public_request_links
  for each row execute function public.tg_set_updated_at();

-- ── 5. Backfill freeze ───────────────────────────────────────────────────────
-- One "General request link" per org that has the public-requests token today,
-- carrying the SAME token so every already-shared /r/<token> URL keeps
-- working. availability_display='exact' freezes today's exact-count rendering
-- (the 'bucket' default is for NEW links only).
insert into public.public_request_links
  (organization_id, name, token, active, availability_display,
   books_enabled, items_enabled, include_public_pool)
select o.id, 'General request link', o.public_request_token, true, 'exact',
       true, false, false
from public.organizations o
where o.public_request_token is not null
on conflict (token) do nothing;

-- Explicit catalog entries for every book that is publicly orderable today:
-- active, not soft-deleted, sitting in an is_public_orderable warehouse.
-- This freezes each org's CURRENT public catalog as the link's explicit
-- config (items keep public_visibility='internal_only'; entry-based
-- eligibility doesn't require 'public').
insert into public.public_link_catalog_entries (link_id, item_id)
select l.id, i.id
from public.public_request_links l
join public.inventory_items i
  on i.organization_id = l.organization_id
join public.warehouses w
  on w.id = i.warehouse_id
 and w.organization_id = l.organization_id
where l.name = 'General request link'
  and w.is_public_orderable = true
  and i.item_type = 'book'
  and i.status = 'active'
  and i.deleted_at is null
on conflict do nothing;

-- ── 6. Eligibility predicate (single source of truth) ───────────────────────
-- Returns the (item_id, effective max qty) pairs eligible on link L for a
-- warehouse. Encodes the locked predicate:
--   item active AND not deleted AND warehouse orderable AND
--   item.public_visibility != 'hidden' AND
--   ( entry(L,item) EXISTS OR (L.include_public_pool AND
--     item.public_visibility='public' AND category.public_visibility='public') )
--   AND link active/not expired/inside date window AND per-type toggle
--   (books_enabled for item_type='book', items_enabled otherwise).
-- max_qty = entry.max_qty_per_request ?? link.default_max_qty ?? null
-- (null = unlimited). Uncategorized items count as 'public' category for the
-- pool branch (there is no category to restrict them).
--
-- Both the public catalog loader AND the public submit endpoint resolve
-- eligibility through this function (service-role RPC), so render and
-- enforcement can never drift.
create or replace function public.public_link_eligible_items(
  p_link_id uuid,
  p_warehouse_id uuid
)
returns table (item_id uuid, max_qty integer)
language sql
stable
security definer
set search_path = public
as $$
  select i.id as item_id,
         coalesce(e.max_qty_per_request, l.default_max_qty) as max_qty
  from public.public_request_links l
  join public.inventory_items i
    on i.organization_id = l.organization_id
  join public.warehouses w
    on w.id = i.warehouse_id
   and w.organization_id = l.organization_id
  left join public.categories c
    on c.id = i.category_id
  left join public.public_link_catalog_entries e
    on e.link_id = l.id
   and e.item_id = i.id
  where l.id = p_link_id
    and l.active
    and (l.expires_at is null or l.expires_at > now())
    and (l.available_from is null or l.available_from <= now())
    and (l.available_until is null or l.available_until >= now())
    and i.warehouse_id = p_warehouse_id
    and w.is_public_orderable
    and i.status = 'active'
    and i.deleted_at is null
    and i.public_visibility <> 'hidden'
    and (   (i.item_type =  'book' and l.books_enabled)
         or (i.item_type <> 'book' and l.items_enabled) )
    and (
      e.item_id is not null
      or (
        l.include_public_pool
        and i.public_visibility = 'public'
        and (i.category_id is null or c.public_visibility = 'public')
      )
    )
$$;

-- Service-role only: the anonymous public surfaces call it through the admin
-- client; nothing browser-side should be able to probe another org's links.
revoke all on function public.public_link_eligible_items(uuid, uuid) from public;
revoke all on function public.public_link_eligible_items(uuid, uuid) from anon;
revoke all on function public.public_link_eligible_items(uuid, uuid) from authenticated;
grant execute on function public.public_link_eligible_items(uuid, uuid) to service_role;

-- ── 7. RLS ───────────────────────────────────────────────────────────────────
-- FK-org-consistency helper (0203 pattern): an entry may only reference an
-- item in the SAME org as its parent link. SECURITY DEFINER so a
-- category-restricted viewer granted public_links:manage isn't blocked by the
-- inventory_items category RLS while the org check still holds.
create or replace function public.item_in_org(p_item_id uuid, p_org_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select p_item_id is null or exists (
    select 1 from public.inventory_items
    where id = p_item_id and organization_id = p_org_id
  );
$$;
grant execute on function public.item_in_org(uuid, uuid) to authenticated;

alter table public.public_request_links enable row level security;
alter table public.public_link_catalog_entries enable row level security;

-- Members read; admin-or-grantee writes (0250 additive posture — the admin
-- role floor is kept OR'd so a wrong override row can never lock admins out).
create policy public_request_links_select on public.public_request_links
  for select
  using (( select public.is_org_member(public_request_links.organization_id) ));
create policy public_request_links_write on public.public_request_links
  for all
  using (
    ( select public.has_org_role(public_request_links.organization_id, 'admin') )
    or ( select public.has_permission(public_request_links.organization_id, 'public_links:manage') )
  )
  with check (
    ( select public.has_org_role(public_request_links.organization_id, 'admin') )
    or ( select public.has_permission(public_request_links.organization_id, 'public_links:manage') )
  );

-- Entries resolve their org through the parent link (the parent's RLS already
-- proved org scope; same shape as 0250's child tables).
create policy public_link_catalog_entries_select on public.public_link_catalog_entries
  for select
  using (exists (
    select 1 from public.public_request_links l
    where l.id = public_link_catalog_entries.link_id
      and ( select public.is_org_member(l.organization_id) )
  ));
create policy public_link_catalog_entries_write on public.public_link_catalog_entries
  for all
  using (exists (
    select 1 from public.public_request_links l
    where l.id = public_link_catalog_entries.link_id
      and (
        ( select public.has_org_role(l.organization_id, 'admin') )
        or ( select public.has_permission(l.organization_id, 'public_links:manage') )
      )
  ))
  with check (exists (
    select 1 from public.public_request_links l
    where l.id = public_link_catalog_entries.link_id
      and (
        ( select public.has_org_role(l.organization_id, 'admin') )
        or ( select public.has_permission(l.organization_id, 'public_links:manage') )
      )
      and ( select public.item_in_org(public_link_catalog_entries.item_id, l.organization_id) )
  ));

grant select, insert, update, delete on public.public_request_links to authenticated;
grant select, insert, update, delete on public.public_link_catalog_entries to authenticated;
