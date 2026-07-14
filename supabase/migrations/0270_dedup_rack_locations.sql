-- 0270_dedup_rack_locations.sql
--
-- Fixes the duplicate-rack/crate bug: the interactive Transfer/Put-away
-- "new rack" path (transferStockAction / placeStockAction /
-- bulkPlaceStockAction in apps/web/src/server/actions/inventory.ts, and the
-- mobile REST twin POST /api/v1/items/[id]/transfer) called
-- LocationsService.create() with NO find-or-existing check — every put-away
-- onto a rack/crate name that already existed minted a brand-new
-- `locations` row instead of reusing it. (The bulk "Set rack" auto-place
-- path already deduped via a private findOrCreateRackLocation helper in
-- InventoryService — only the interactive path was missing it; the app-code
-- companion to this migration fixes that, see Unit A of the rack-set fix.)
--
-- Concretely: warehouse eab527b5 ended up with TWO non-deleted '2-C' rows
-- (077a55f3 from 2026-06-29, 3133f88f from 2026-07-10) with stock split
-- across both — this is org-agnostic and could affect ANY org, so this
-- migration sweeps every org, not just the one that surfaced the bug.
--
-- This migration does two things, ORG-AGNOSTIC (every org, not scoped to
-- one tenant):
--
--   1. MERGE existing duplicates via public._dedup_rack_locations() — for
--      every group of non-deleted `locations` rows sharing
--      (organization_id, warehouse_id, lower(name)) with kind in
--      ('rack','crate'), pick the OLDEST row (by created_at, tie-broken by
--      id) as the CANONICAL row, repoint every foreign key that references
--      the duplicate rows onto the canonical row, then soft-delete
--      (deleted_at = now()) the duplicates.
--
--   2. PREVENT future duplicates. A partial unique index on
--      (organization_id, warehouse_id, lower(name)) for active
--      rack/crate rows, so a future find-or-existing miss (or any other
--      write path) fails loudly with a constraint violation instead of
--      silently minting another duplicate.
--
-- The merge is a standalone function (rather than an inline DO block) so
-- the pgTAP test (0270_dedup_rack_locations.test.sql) can re-invoke the
-- EXACT same logic against freshly-seeded duplicate fixtures and prove it
-- both merges correctly AND is idempotent (second call is a no-op — see
-- the function's returned count). It is intentionally NOT exposed to the
-- app: no org scoping, no permission check, operates across every org — see
-- the revoke below.
--
-- ── Every FK that references locations.id (verified exhaustively via
--    `grep -rniE "references (public\.)?locations|location_id"
--    supabase/migrations` — repo-wide, not just this bug's tables) ────────
--
--   1. locations.parent_id                        (0002; self-ref, on delete set null)
--   2. inventory_items.primary_location_id         (0002; on delete set null)
--   3. item_stock_levels.location_id               (0002; NOT NULL, on delete cascade,
--                                                    UNIQUE(item_id, location_id) — needs
--                                                    quantity-merge, not a plain repoint,
--                                                    see step 1 in the function below)
--   4. stock_movements.from_location_id            (0002; on delete set null)
--   5. stock_movements.to_location_id              (0002; on delete set null)
--   6. purchase_orders.destination_location_id     (0002; on delete set null)
--   7. recurring_po_templates.destination_location_id (0180; on delete set null)
--
-- All 7 are repointed below. `bin_location` (inventory_items, 0002) is a
-- plain TEXT display label derived from the rack's name/number — NOT an FK
-- to locations.id — so it needs no repointing (a dedup group shares the
-- same name by construction, so the label text is unaffected either way).
--
-- Idempotent: the duplicate-detection query only considers rows where
-- deleted_at is null, so a second call finds no groups (the prior call's
-- soft-deletes already remove them from consideration) and returns 0 without
-- touching any row. The final unique index uses IF NOT EXISTS.
-- ────────────────────────────────────────────────────────────────────────

create or replace function public._dedup_rack_locations()
returns integer
language plpgsql
as $$
declare
  v_dup_count integer;
begin
  -- Defensive: lets this function be called more than once inside the SAME
  -- transaction (e.g. a pgTAP test proving idempotency) without hitting a
  -- "relation already exists" error on the temp table.
  drop table if exists _rack_crate_dup_map;

  -- One row per DUPLICATE location (never per-canonical), mapping it to the
  -- canonical id for its (org, warehouse, lower(name)) partition — oldest
  -- created_at wins, id breaks ties deterministically. Every row in a
  -- partition gets the SAME canonical_id from first_value() over the full
  -- window frame, so 3+-way duplicate groups collapse onto one row too.
  create temporary table _rack_crate_dup_map as
  select dup_id, canonical_id
  from (
    select
      loc.id as dup_id,
      first_value(loc.id) over (
        partition by loc.organization_id, loc.warehouse_id, lower(loc.name)
        order by loc.created_at asc, loc.id asc
        rows between unbounded preceding and unbounded following
      ) as canonical_id
    from public.locations loc
    where loc.kind in ('rack', 'crate')
      and loc.deleted_at is null
  ) ranked
  where dup_id <> canonical_id;

  select count(*) into v_dup_count from _rack_crate_dup_map;

  if v_dup_count = 0 then
    drop table if exists _rack_crate_dup_map;
    return 0;
  end if;

  -- ── FK #3 — item_stock_levels.location_id: needs a quantity MERGE, not a
  -- plain repoint, because of UNIQUE(item_id, location_id). For every
  -- (canonical_location, item) that has stock parked on ANY duplicate,
  -- compute total = existing canonical quantity (0 if none) + the SUM of
  -- every duplicate's quantity for that item (aggregated FIRST — a naive
  -- UPDATE ... FROM without this would silently drop all but one matching
  -- duplicate row when a 3+-way group shares the same item). Upsert the
  -- total onto the canonical row, then delete the now-redundant duplicates.
  with dup_sums as (
    select m.canonical_id, isl.item_id, sum(isl.quantity) as dup_qty
    from public.item_stock_levels isl
    join _rack_crate_dup_map m on m.dup_id = isl.location_id
    group by m.canonical_id, isl.item_id
  )
  insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  select
    ii.organization_id,
    ds.item_id,
    ds.canonical_id,
    ds.dup_qty + coalesce(canon.quantity, 0)
  from dup_sums ds
  join public.inventory_items ii on ii.id = ds.item_id
  left join public.item_stock_levels canon
    on canon.location_id = ds.canonical_id and canon.item_id = ds.item_id
  on conflict (item_id, location_id) do update
    set quantity = excluded.quantity, updated_at = now();

  delete from public.item_stock_levels isl
  using _rack_crate_dup_map m
  where isl.location_id = m.dup_id;

  -- ── FK #4/#5 — stock_movements (immutable ledger; plain repoint, no
  -- uniqueness constraint to worry about).
  update public.stock_movements sm
  set from_location_id = m.canonical_id
  from _rack_crate_dup_map m
  where sm.from_location_id = m.dup_id;

  update public.stock_movements sm
  set to_location_id = m.canonical_id
  from _rack_crate_dup_map m
  where sm.to_location_id = m.dup_id;

  -- ── FK #2 — inventory_items.primary_location_id.
  update public.inventory_items ii
  set primary_location_id = m.canonical_id
  from _rack_crate_dup_map m
  where ii.primary_location_id = m.dup_id;

  -- ── FK #6 — purchase_orders.destination_location_id.
  update public.purchase_orders po
  set destination_location_id = m.canonical_id
  from _rack_crate_dup_map m
  where po.destination_location_id = m.dup_id;

  -- ── FK #7 — recurring_po_templates.destination_location_id.
  update public.recurring_po_templates rpt
  set destination_location_id = m.canonical_id
  from _rack_crate_dup_map m
  where rpt.destination_location_id = m.dup_id;

  -- ── FK #1 — locations.parent_id (self-ref). Guard against a canonical
  -- row ending up parented to itself (only possible if a canonical's OWN
  -- parent_id pointed at a sibling duplicate in the same name/warehouse
  -- group — not expected, but cheap to exclude).
  update public.locations loc
  set parent_id = m.canonical_id
  from _rack_crate_dup_map m
  where loc.parent_id = m.dup_id
    and loc.id <> m.canonical_id;

  -- ── Soft-delete the duplicates now that every reference has been
  -- repointed onto the canonical row.
  update public.locations loc
  set deleted_at = now()
  from _rack_crate_dup_map m
  where loc.id = m.dup_id
    and loc.deleted_at is null;

  drop table if exists _rack_crate_dup_map;
  return v_dup_count;
end;
$$;

-- Deliberately NOT exposed to the app or any client role — including
-- service_role, which Supabase's default privileges grant EXECUTE to on
-- every new public-schema function unless revoked. This operates across
-- EVERY org with no org scoping and no permission check, so any
-- PostgREST-reachable grant would be an unnecessary standing capability
-- with no legitimate caller after this migration lands: only the migration
-- runner (postgres superuser, which bypasses grants entirely) and the
-- pgTAP test invoke it.
revoke all on function public._dedup_rack_locations() from public, anon, authenticated, service_role;

-- Run the merge once, now, against every org's existing data.
select public._dedup_rack_locations();

-- Prevent future duplicates. Only succeeds once the merge above has removed
-- every existing dup — a fresh `supabase db reset` proves this (see
-- rack-A-report.md for the run).
create unique index if not exists locations_unique_active_name
  on public.locations (organization_id, warehouse_id, lower(name))
  where deleted_at is null and kind in ('rack', 'crate');
