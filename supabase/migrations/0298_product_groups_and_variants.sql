-- 0298_product_groups_and_variants.sql
--
-- ============================================================================
-- PROD PUSH NOTE — PUSH THIS FILE IN A SCHEDULED LOW-TRAFFIC WINDOW.
-- Same hazard, same window, same remedy as 0295 and 0303 (whose header carries
-- the long-form explanation and the retry procedure). Read all three as one
-- push.
--
-- Section 2 is the expensive part: ten `add column`s, two CHECK swaps and two
-- NON-CONCURRENT index builds on inventory_items, plus two `alter policy`
-- statements, all in ONE transaction. The first ADD COLUMN takes ACCESS
-- EXCLUSIVE on inventory_items and a migration file does not COMMIT until its
-- last statement, so that lock is held through both index builds. For that whole
-- window inventory_items answers nobody — READS INCLUDED. Do not read the
-- statement-level notes below as a promise of concurrency: individually a
-- nullable ADD COLUMN is rewrite-free and a VALIDATE takes only SHARE UPDATE
-- EXCLUSIVE, but every one of them runs while that first lock is still held.
--
-- COST: dominated by the two index builds over 1.2 M rows (inventory_items_
-- group_idx is non-partial and therefore indexes every row). Budget tens of
-- seconds of full table unavailability, not milliseconds. `create index
-- concurrently` is NOT an option — it cannot run inside a transaction block, and
-- a migration file is one.
--
-- Without `set lock_timeout` the first ADD COLUMN's lock REQUEST queues AHEAD of
-- every new reader, so one slow analytics query holding a read lock takes the
-- whole table offline for as long as it runs and this migration waits behind it.
-- Prod statement_timeout is 120s, which bounds that to roughly a two-minute full
-- inventory_items outage per attempt. 5s converts it into "the push failed,
-- retry it".
--
-- ON lock_timeout FAILURE ("canceling statement due to lock timeout", SQLSTATE
-- 55P03): nothing was applied — the transaction rolled back whole — so RETRY,
-- ideally once whatever holds inventory_items has finished (`select pid, state,
-- xact_start, query from pg_stat_activity where state <> 'idle' order by
-- xact_start`). The section-2 statements are idempotent (`if not exists`,
-- `drop constraint if exists`); section 1's `create table` / `create index` are
-- not, but they are also inside the same all-or-nothing transaction, so a
-- rolled-back attempt leaves nothing behind to collide with.
--
-- DEPLOY-ORDER COUPLING — MIGRATIONS FIRST, WEB DEPLOY SECOND.
-- Two web paths select the columns this file adds UNCONDITIONALLY, with no
-- feature flag and no fallback, so shipping the web deploy first 500s them:
--   * apps/web/src/app/api/v1/items/lookup/route.ts — its select list names
--     group_id, variant_size and jersey_number (route.ts:100).
--   * apps/web/src/server/services/size-counts.ts (SizeCountsService) — reads
--     and writes size_count_sessions.product_group_id, added by 0302.
-- 0302 depends on product_groups existing here, so the whole 0294-0303 run must
-- land BEFORE the deploy that ships those two paths.
-- ============================================================================
--
-- Phase 3 of the Sports program: the GROUP overlay and first-class VARIANT
-- attributes.
--
-- ARCHITECTURE (forced by the Phase 1 audit): inventory_items stays the ONLY
-- stock-bearing entity. Every operational flow FKs item_id and the ledger
-- invariant SUM(stock_movements) = quantity_on_hand makes inventory_items the
-- mandatory quantity owner. So: GROUP = this new table (identity only),
-- VARIANT = an inventory_items SKU family, UNIT = serial_registry. That is the
-- only shape that leaves adjust_stock / apply_level_delta untouched.
--
-- product_groups OWNS NO QUANTITY, EVER. There is deliberately no
-- quantity_on_hand, no total, no cached count. Roll-ups are derived at read
-- time from the variants (see the view at the end).
--
-- group_id IS NULLABLE WITH NO BACKFILL. null = every item in every existing
-- org, whose behaviour is completely unchanged. There is NO name-heuristic
-- backfill anywhere in this migration (owner decision 2026-07-27: existing
-- families link opt-in via a review tool; a heuristic backfill would bake
-- wrong groupings into persistent identity). This file contains ZERO DML: no
-- insert, no update, no delete, on any table. The only statements are
-- `create table`, `alter table`, `create index`, `create/alter policy`,
-- `create function`, `create view`, `grant` and `comment`.
--
-- jersey_number IS DELIBERATELY NON-UNIQUE. The same number legitimately
-- repeats across sizes, groups, teams, seasons and warehouses. The Model B
-- uniqueness key (organization_id, sku, charter_id, bin_location) from 0234 is
-- NOT touched by this migration — no index here shares its column list and
-- none of the new columns join it.

-- Bound the lock wait for EVERY statement in this transaction. See the PROD
-- PUSH NOTE above. Set here, before section 1, rather than immediately above
-- section 2 — a GUC set mid-file only covers what follows it, and the two
-- `alter policy` statements in section 3 take ACCESS EXCLUSIVE on
-- inventory_items too.
--
-- PLAIN `set`, NOT `set local` — deliberately, for the reason 0303:72-81
-- documents at length: the Supabase CLI applies a migration file as one
-- pipelined pgx batch that is atomic but is not a transaction BLOCK, so `set
-- local` emits "WARNING (25P01): SET LOCAL can only be used in transaction
-- blocks" and is DISCARDED — the timeout would silently not exist. A plain
-- `set` takes effect for the rest of the batch and is `reset` at the end of
-- this file so it cannot leak into a LATER migration in the same push.
set lock_timeout = '5s';

-- ── 1) product_groups ───────────────────────────────────────────────────────
create table public.product_groups (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  category_id      uuid references public.categories(id) on delete set null,
  /* Denormalized subcategory key for fast filtering; mirrors the category. */
  subcategory_key  text,
  name             text not null,
  brand            text,
  manufacturer     text,
  model            text,
  style_number     text,
  /* Colorway lives at GROUP level by default. A group whose variants differ by
     colorway sets this NULL and carries the colorway on
     inventory_items.variant_color instead. */
  colorway         text,
  /* Jersey identity attributes. */
  team             text,
  league           text,
  season           text,
  home_away        text check (home_away is null or home_away in ('home','away','alternate')),
  color            text,
  size_scale_id    uuid references public.size_scales(id) on delete set null,
  default_counting_unit text not null default 'each'
                     check (default_counting_unit in ('unit','each','pair','set','case')),
  tracking_mode    text
                     check (tracking_mode is null or tracking_mode in (
                       'QUANTITY','QUANTITY_BY_VARIANT','NUMBERED_VARIANT',
                       'SERIALIZED','OPTIONAL_SERIALIZED','INDIVIDUALLY_TAGGED','LOT_TRACKED'
                     )),
  /* Deterministic identity key. Built by packages/core/src/sports/variant-keys.ts
     and written by the service — never derived in SQL, so the TS normalizers
     stay the single source of truth. */
  group_key        text not null,
  status           text not null default 'active'
                     check (status in ('active','archived','discontinued')),
  created_by       uuid references public.user_profiles(id) on delete set null,
  updated_by       uuid references public.user_profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

-- One group per identity per org. This is what makes "shoe sizes 9/10/11 are
-- ONE group" enforceable rather than aspirational.
create unique index product_groups_org_key_uniq
  on public.product_groups (organization_id, group_key)
  where deleted_at is null;

create index product_groups_org_status_idx
  on public.product_groups (organization_id, status) where deleted_at is null;
create index product_groups_category_idx
  on public.product_groups (organization_id, category_id) where deleted_at is null;
-- Supports the group-first import matcher (Task 14).
create index product_groups_brand_style_idx
  on public.product_groups (organization_id, lower(brand), lower(style_number))
  where deleted_at is null;
create index product_groups_team_season_idx
  on public.product_groups (organization_id, lower(team), lower(season))
  where deleted_at is null;

create trigger product_groups_set_updated_at
  before update on public.product_groups
  for each row execute function public.tg_set_updated_at();

comment on table public.product_groups is
  'Shared product identity (Nike Pegasus 41; Falcons Home Jersey). OWNS NO '
  'QUANTITY, EVER - quantity lives only on inventory_items. Variants are the '
  'inventory_items rows whose group_id points here.';

comment on column public.product_groups.group_key is
  'Deterministic identity key built by packages/core/src/sports/variant-keys.ts. '
  'Never a name string alone (requirements: matching is deterministic, never '
  'name-string-only).';

-- ── 2) inventory_items variant columns ──────────────────────────────────────
alter table public.inventory_items
  /* NULL = not part of a group. Every existing row, in every existing org. */
  add column if not exists group_id uuid references public.product_groups(id) on delete set null,
  /* Normalized size for matching and ordering ('10.5', 'XL'). */
  add column if not exists variant_size text,
  /* The size EXACTLY as imported/typed. Never overwritten by normalization. */
  add column if not exists variant_size_original text,
  add column if not exists variant_size_system text,
  add column if not exists variant_width text,
  add column if not exists variant_fit text,
  add column if not exists variant_color text,
  /* Normalized TEXT preserving meaningful leading zeroes. NON-UNIQUE BY
     DESIGN - see the migration header. */
  add column if not exists jersey_number text,
  add column if not exists player_name text,
  /* Deterministic variant identity within the group. Written by the service. */
  add column if not exists variant_key text;

-- Length guards. These are the constraints custom_fields could never give us.
--
-- NOT VALID + VALIDATE, the split 0303:85-92 establishes. A validated CHECK
-- added inline makes Postgres verify it against all 1.2 M existing rows before
-- the ALTER can return, and that scan runs under the ACCESS EXCLUSIVE lock the
-- ADD COLUMNs above already hold. Added NOT VALID the constraint is catalog-only
-- and instant, and it still enforces every subsequent insert/update; VALIDATE's
-- one scan takes only SHARE UPDATE EXCLUSIVE. Both predicates are trivially true
-- of every existing row — the columns were created NULL two statements ago and
-- nothing in this file writes them — so neither VALIDATE can fail on legacy
-- data.
--
-- The end state is identical to a validated add (convalidated = true), which is
-- why the pgTAP file needs no change: an out-of-range value is still rejected
-- with 23514.
alter table public.inventory_items
  drop constraint if exists inventory_items_jersey_number_check;
alter table public.inventory_items
  add constraint inventory_items_jersey_number_check
  check (
    jersey_number is null
    or (length(jersey_number) between 1 and 4 and jersey_number ~ '^[0-9]+$')
  ) not valid;
alter table public.inventory_items
  validate constraint inventory_items_jersey_number_check;

alter table public.inventory_items
  drop constraint if exists inventory_items_variant_size_check;
alter table public.inventory_items
  add constraint inventory_items_variant_size_check
  check (variant_size is null or length(variant_size) between 1 and 24) not valid;
alter table public.inventory_items
  validate constraint inventory_items_variant_size_check;

comment on column public.inventory_items.jersey_number is
  'Uniform number as normalized TEXT, preserving meaningful leading zeroes '
  '(0, 00, 07, 12, 99). NOT UNIQUE and never part of any uniqueness key - the '
  'same number legitimately repeats across sizes, groups, teams, seasons and '
  'warehouses. NEVER a serial number, and never labelled as one in any UI.';

comment on column public.inventory_items.variant_size_original is
  'The size string exactly as imported or typed. Kept alongside the normalized '
  'form so an approved cross-system mapping is always auditable against the '
  'source (requirements: "Keep original imported text + normalized form").';

comment on column public.inventory_items.group_id is
  'The product group this item is a variant of. NULL = ungrouped, which is '
  'every item in every org until an opt-in link is made. No heuristic backfill '
  'ever writes this column.';

-- Variant lookup: the group detail page and the import matcher both start here.
--
-- DELIBERATELY NON-PARTIAL, and it must stay that way. This index is also the
-- only thing standing between `delete from product_groups` and a sequential
-- scan of 1.2 M inventory_items rows. The referential-integrity probe that
-- Postgres runs for inventory_items_group_id_fkey (on delete set null) is a
-- bare `... where group_id = $1`, executed by the RI SECURITY DEFINER snapshot
-- with NO knowledge of the deleted_at predicate — the planner cannot prove a
-- partial index's WHERE clause is implied, so a partial index is unusable
-- there and every group delete would seq-scan AND row-lock the whole items
-- table. (Reviewed 2026-07-27: the original `where group_id is not null and
-- deleted_at is null` form did exactly that.)
--
-- Nothing is lost by widening it: a btree simply stores the NULL group_ids too,
-- and the group-detail / import-matcher queries still get the same index scan
-- with `deleted_at is null` applied as a cheap filter over the handful of rows
-- one group owns.
--
-- The former inventory_items_group_variant_idx on (group_id, variant_key) is
-- deliberately NOT recreated. A group holds a handful of variant rows, so
-- (group_id) alone answers `where group_id = ? and variant_key = ?` with a
-- trivial filter, and a second index on the most-written table in the app is
-- pure write cost. One non-partial index serves the reads and the RI probe.
create index inventory_items_group_idx
  on public.inventory_items (group_id);

-- Jersey-number search, per org. Non-unique on purpose.
create index inventory_items_jersey_number_idx
  on public.inventory_items (organization_id, jersey_number)
  where jersey_number is not null and deleted_at is null;

-- ── 3) FK org-consistency helpers ───────────────────────────────────────────
-- Same shape and lineage as charter_in_org / supplier_in_org / location_in_org
-- (migrations 0201-0206). A plain FK cannot express "and it must belong to the
-- SAME org", so without these a member of org B could attach their item to org
-- A's group and pollute org A's identity graph.
create or replace function public.product_group_in_org(p_group_id uuid, p_org_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select p_group_id is null or exists (
    select 1 from public.product_groups
    where id = p_group_id and organization_id = p_org_id
  );
$$;
revoke all on function public.product_group_in_org(uuid, uuid) from public;
revoke all on function public.product_group_in_org(uuid, uuid) from anon;
grant execute on function public.product_group_in_org(uuid, uuid) to authenticated;

create or replace function public.category_in_org(p_category_id uuid, p_org_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select p_category_id is null or exists (
    select 1 from public.categories
    where id = p_category_id and organization_id = p_org_id
  );
$$;
revoke all on function public.category_in_org(uuid, uuid) from public;
revoke all on function public.category_in_org(uuid, uuid) from anon;
grant execute on function public.category_in_org(uuid, uuid) to authenticated;

-- inventory_items.group_id must live in the item's own org.
--
-- `alter policy ... with check` REPLACES the whole expression, so the CURRENT
-- predicate is reproduced verbatim below (captured from pg_policy at 0297) and
-- the new arm is appended. USING is left untouched by this form.
alter policy inventory_items_insert on public.inventory_items
  with check (
    (
      ((select public.has_org_role(inventory_items.organization_id, 'staff'::text))
        or (select public.has_permission(inventory_items.organization_id, 'items:create'::text)))
      and ((select public.has_org_role(inventory_items.organization_id, 'manager'::text))
        or (warehouse_id is null)
        or public.user_can_access_warehouse(auth.uid(), warehouse_id, 'write'::text))
      and (select public.location_in_org(inventory_items.primary_location_id, inventory_items.organization_id))
      and (select public.charter_in_org(inventory_items.charter_id, inventory_items.organization_id))
      and (select public.supplier_in_org(inventory_items.supplier_id, inventory_items.organization_id))
    )
    and (select public.product_group_in_org(inventory_items.group_id, inventory_items.organization_id))
  );

alter policy inventory_items_update on public.inventory_items
  with check (
    (
      ((select public.has_org_role(inventory_items.organization_id, 'staff'::text))
        or (select public.has_permission(inventory_items.organization_id, 'items:update'::text)))
      and ((select public.has_org_role(inventory_items.organization_id, 'manager'::text))
        or (warehouse_id is null)
        or public.user_can_access_warehouse(auth.uid(), warehouse_id, 'write'::text))
      and (select public.location_in_org(inventory_items.primary_location_id, inventory_items.organization_id))
      and (select public.charter_in_org(inventory_items.charter_id, inventory_items.organization_id))
      and (select public.supplier_in_org(inventory_items.supplier_id, inventory_items.organization_id))
    )
    and (select public.product_group_in_org(inventory_items.group_id, inventory_items.organization_id))
  );

-- ── 4) RLS on product_groups ────────────────────────────────────────────────
alter table public.product_groups enable row level security;

-- SELECT is org membership AND category visibility. Both arms are required.
--
-- Reviewed 2026-07-27: the first cut used is_org_member alone, which made this
-- table the one read surface in the whole app that ignored the viewer
-- category-visibility boundary. A viewer restricted to a category set reads
-- ZERO categories (categories_select, 0129 -> 0140) and ZERO items
-- (inventory_items_select, 0129 -> 0229) outside that set, but could still read
-- the group row for a category invisible to them: name, brand, team, style
-- number, season. Quantities were already masked (product_group_rollups is
-- security_invoker and its numbers come from inventory_items), so the leak was
-- identity metadata — still a leak, and still the wrong boundary.
--
-- The second arm is the 0229 hashed-set spelling of
-- user_can_see_item_category(auth.uid(), organization_id, category_id), which
-- is what inventory_items_select uses today. Identical row set, including the
-- NULL case: a group whose category_id IS NULL is visible to every
-- unrestricted member and hidden from a restricted viewer, exactly as a
-- NULL-category item is. The set form is used rather than the plpgsql function
-- (categories_select's 0129 spelling) for the reason 0229 documents: the two
-- helpers reference no outer column, so they are hashed once per statement
-- instead of re-executed per row.
create policy product_groups_select on public.product_groups
  for select to authenticated
  using (
    (select public.is_org_member(organization_id))
    and (
      organization_id in (select public.rls_cat_unrestricted_org_ids())
      or (organization_id, category_id) in
           (select * from public.rls_cat_allowed_category_ids())
    )
  );

create policy product_groups_insert on public.product_groups
  for insert to authenticated
  with check (
    (
      (select public.has_org_role(organization_id, 'manager'))
      or (select public.has_permission(organization_id, 'sports:manage'))
      or (select public.has_permission(organization_id, 'items:create'))
    )
    and (select public.category_in_org(category_id, organization_id))
  );

create policy product_groups_update on public.product_groups
  for update to authenticated
  using (
    (select public.has_org_role(organization_id, 'manager'))
    or (select public.has_permission(organization_id, 'sports:manage'))
  )
  with check (
    (
      (select public.has_org_role(organization_id, 'manager'))
      or (select public.has_permission(organization_id, 'sports:manage'))
    )
    and (select public.category_in_org(category_id, organization_id))
  );

create policy product_groups_delete on public.product_groups
  for delete to authenticated
  using ((select public.has_org_role(organization_id, 'manager')));

-- KNOWN GAP, Minor, DEFERRED (review 2026-07-27) — no behaviour change here.
-- product_groups.organization_id is MUTABLE: nothing above pins it across an
-- UPDATE. This is NOT a cross-tenant escalation — USING is evaluated on the OLD
-- row and WITH CHECK on the NEW one, so re-homing a group requires manager (or
-- sports:manage) in BOTH orgs. What it does allow is someone holding manager in
-- two orgs moving a group out from under its variants: product_group_in_org is
-- only enforced on inventory_items writes, so the already-attached items would
-- keep pointing at a group that now lives in another org. A guard belongs with
-- the group service (Task 6+) as an organization_id-immutability trigger; it is
-- deliberately not added in 0298, which stays a pure schema migration.

-- EXPLICIT GRANT (0067). Missing grants cause real 403s on hardened projects
-- even when RLS would allow the row. Migration 0283 omitted this; do not.
grant select, insert, update, delete on public.product_groups to authenticated;

-- ── 5) Derived roll-up view ─────────────────────────────────────────────────
-- The ONLY place a group total exists. Recomputed on every read, never stored.
-- "6 variants, 52 pairs total" comes from here.
--
-- security_invoker = true IS LOAD-BEARING (0059). A Postgres view defaults to
-- security_invoker = FALSE, which evaluates the underlying tables with the
-- VIEW OWNER's rights - and the owner here is the migration superuser, who
-- bypasses RLS entirely. Without this option every authenticated user would
-- read every org's group totals through this view.
create or replace view public.product_group_rollups
with (security_invoker = true) as
select
  g.id                                                as group_id,
  g.organization_id,
  count(distinct i.variant_key)
    filter (where i.variant_key is not null)          as variant_count,
  count(i.id)                                         as placement_count,
  coalesce(sum(i.quantity_on_hand), 0)                as total_quantity,
  g.default_counting_unit                             as counting_unit
from public.product_groups g
left join public.inventory_items i
  on i.group_id = g.id
 and i.deleted_at is null
 and i.status <> 'archived'
where g.deleted_at is null
group by g.id, g.organization_id, g.default_counting_unit;

comment on view public.product_group_rollups is
  'Derived group totals. product_groups stores NO quantity - this view is the '
  'only source of a group-level total, and it is recomputed on every read. '
  'security_invoker = true so RLS on product_groups and inventory_items is the '
  'caller''s, not the view owner''s.';

grant select on public.product_group_rollups to authenticated;

-- Hand the lock timeout back — the `set` at the top is plain, not LOCAL (see the
-- note there), so it would otherwise outlive this migration on the apply
-- connection and quietly impose 5s on every LATER migration in the same push. On
-- a failed push the abort unwinds it instead, so this line only matters on the
-- success path.
reset lock_timeout;
