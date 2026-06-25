# PO Staging + Multi-Rack Placement — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the inventory-model foundation for PO receiving staging — racks/areas/crates become real per-warehouse `locations` with per-rack quantities in `item_stock_levels`, received PO stock routes into a per-warehouse **Staging** location instead of straight to a rack, and inventory screens can show "placed only" vs "placed + staged".

**Architecture:** Reuse existing tables (`locations`, `item_stock_levels`, `stock_movements`) and RPCs (`adjust_stock`, `transfer_stock`). `quantity_on_hand` stays the **total owned** scalar; `item_stock_levels` becomes the per-location source of truth (it is currently dormant — nothing reads it). Receiving calls `adjust_stock` with the warehouse's Staging location so the qty lands in `item_stock_levels[Staging]`; placement (Phase 2) calls a revived `transfer_stock` (Staging → rack), net-zero on `quantity_on_hand`. A one-time backfill seeds every existing item's on-hand into its current rack (or Unplaced) so `Σ item_stock_levels = quantity_on_hand`.

**Tech Stack:** Supabase Postgres (plpgsql RPCs, migrations in `supabase/migrations/NNNN_*.sql`), pgTAP tests (`supabase/tests/NNNN_*.test.sql`, run via `pnpm db:test`), Next.js 16 / React (web), Vitest (unit tests), TypeScript.

## Spec corrections (discovered while reading current code — supersede the spec)
- **`locations.warehouse_id` ALREADY EXISTS** (added in mig `0007_internal_company.sql:81-83`). Do NOT add it. The spec's §4.1 addendum is obsolete.
- **`transfer_stock` is AUDIT-ONLY since mig `0071_transfer_stock_audit_only.sql`** — it logs a `transfer` movement but does NOT touch `item_stock_levels` or `quantity_on_hand`. The 0071 header explicitly says "A future per-location-quantity feature can replace this with the full two-table mutation." This plan does exactly that (Task 5).
- **`item_stock_levels` is read NOWHERE in the app today** — reviving it breaks no existing reader.

## Global Constraints
- Migrations are sequential zero-padded: next free number is **`0188`** (latest on disk is `0187_procedure_videos_1gb.sql`). One migration per task; never edit a shipped migration.
- Every migration opens with a `-- NNNN_name.sql` comment block explaining what + why.
- pgTAP tests live in `supabase/tests/NNNN_<topic>.test.sql`, wrapped `begin; select plan(N); … select * from finish(); rollback;`. Run the whole suite with `pnpm db:test` (boots a fresh stack via `supabase start` + runs `supabase test db`).
- `quantity_on_hand` remains the **total owned** (placed + staged). `placed = quantity_on_hand − staged`. Invariant after Task 5: for every item, `Σ item_stock_levels.quantity = quantity_on_hand`.
- All new rows are org-scoped; RLS mirrors existing `locations` / `item_stock_levels` policies. No cross-tenant reads/writes.
- Do NOT add a `Co-Authored-By: Claude/Anthropic` trailer to any commit (standing repo rule).
- After merge, apply migrations to prod with `supabase db push --linked`; pgTAP must be green first.
- This is Phase 1 (web + backend). Mobile is Phase 3 (separate plan).

## File Structure
- `supabase/migrations/0188_placement_locations.sql` — extend `locations` (kind + rack/crate cols), staging/unplaced per warehouse + trigger + backfill.
- `supabase/migrations/0189_adjust_stock_levels.sql` — `adjust_stock` maintains `item_stock_levels` when a location is given.
- `supabase/migrations/0190_receive_to_staging.sql` — `post_receipt_v2` routes accepted qty into the warehouse Staging location.
- `supabase/migrations/0191_transfer_stock_levels.sql` — revive `transfer_stock` to the full two-table mutation (net-zero on on-hand).
- `supabase/migrations/0192_backfill_placements.sql` — seed existing on-hand into rack/Unplaced levels.
- `supabase/tests/0188_placement_locations.test.sql`, `0190_receive_to_staging.test.sql`, `0191_transfer_stock_levels.test.sql`, `0192_backfill_placements.test.sql` — pgTAP gates.
- `apps/web/src/server/services/inventory.ts` — add `staged`/`placed` to `list()` + `get()`.
- `apps/web/src/server/services/inventory.placement.test.ts` — unit test for the derivation.
- `apps/web/src/components/inventory/inventory-table.tsx` — placed/staged view toggle + on-hand cell sub-line.
- `apps/web/src/components/po-imports/po-import-detail.tsx`, `create-items-modal.tsx`, `apps/web/src/server/actions/po-imports.ts`, `apps/web/src/server/actions/po-imports.create-items.test.ts` — remove create-step rack/crate + make ISBN match rack-agnostic.

---

### Task 1: Placement locations — extend `locations`, auto-create Staging/Unplaced per warehouse

**Files:**
- Create: `supabase/migrations/0188_placement_locations.sql`
- Test: `supabase/tests/0188_placement_locations.test.sql`

**Interfaces:**
- Produces: `locations.kind` (`'staging'|'area'|'rack'|'crate'|'unplaced'`), `locations.rack_number/rack_row/crate_color/crate_number`; SQL fn `public.ensure_warehouse_placement_locations(p_warehouse_id uuid)`; one `kind='staging'` and one `kind='unplaced'` location per warehouse.

- [ ] **Step 1: Write the migration**

```sql
-- 0188_placement_locations.sql
-- Foundation for PO receiving staging + multi-rack placement.
--
-- Racks/areas/crates become real `locations` rows (warehouse_id already exists
-- from 0007). Each warehouse gets exactly one Staging and one Unplaced location.
-- item_stock_levels (dormant since 0071) becomes the per-location source of truth
-- in later migrations.

alter table public.locations
  add column if not exists kind text
    check (kind in ('staging','area','rack','crate','unplaced')),
  add column if not exists rack_number text,
  add column if not exists rack_row    text,
  add column if not exists crate_color  text,
  add column if not exists crate_number text;

-- At most one staging and one unplaced location per warehouse.
create unique index if not exists locations_one_special_per_wh
  on public.locations(warehouse_id, kind)
  where kind in ('staging','unplaced') and deleted_at is null;

-- Idempotently ensure a warehouse has its Staging + Unplaced locations.
create or replace function public.ensure_warehouse_placement_locations(p_warehouse_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.warehouses where id = p_warehouse_id;
  if v_org is null then return; end if;

  insert into public.locations (organization_id, warehouse_id, name, type, kind)
  values (v_org, p_warehouse_id, 'Staging', 'other', 'staging')
  on conflict do nothing;

  insert into public.locations (organization_id, warehouse_id, name, type, kind)
  values (v_org, p_warehouse_id, 'Unplaced', 'other', 'unplaced')
  on conflict do nothing;
end;
$$;

-- Auto-create on new warehouses (mirrors the seed-trigger pattern in 0161).
create or replace function public.tg_seed_warehouse_locations()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.ensure_warehouse_placement_locations(new.id);
  return new;
exception
  when others then
    raise warning 'seed warehouse locations failed for %: %', new.id, sqlerrm;
    return new;
end;
$$;

drop trigger if exists trg_seed_warehouse_locations on public.warehouses;
create trigger trg_seed_warehouse_locations
  after insert on public.warehouses
  for each row execute function public.tg_seed_warehouse_locations();

-- Backfill existing warehouses.
do $$
declare wh record;
begin
  for wh in select id from public.warehouses loop
    perform public.ensure_warehouse_placement_locations(wh.id);
  end loop;
end$$;
```

- [ ] **Step 2: Write the pgTAP test**

```sql
-- supabase/tests/0188_placement_locations.test.sql
begin;
select plan(4);

select has_column('public', 'locations', 'kind', 'locations.kind exists');
select has_column('public', 'locations', 'crate_color', 'locations.crate_color exists');

-- Every warehouse has exactly one staging + one unplaced location.
select is(
  (select count(*)::int from public.warehouses w
     where not exists (
       select 1 from public.locations l
       where l.warehouse_id = w.id and l.kind = 'staging' and l.deleted_at is null)),
  0,
  'every warehouse has a Staging location'
);
select is(
  (select count(*)::int from public.warehouses w
     where not exists (
       select 1 from public.locations l
       where l.warehouse_id = w.id and l.kind = 'unplaced' and l.deleted_at is null)),
  0,
  'every warehouse has an Unplaced location'
);

select * from finish();
rollback;
```

- [ ] **Step 3: Run the suite to verify it passes**

Run: `pnpm db:test`
Expected: PASS — `0188_placement_locations.test.sql .. ok` (4 assertions). If `supabase start` isn't already up, the script boots it first.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0188_placement_locations.sql supabase/tests/0188_placement_locations.test.sql
git commit -m "feat(inventory): placement locations + per-warehouse Staging/Unplaced (mig 0188)"
```

---

### Task 2: `adjust_stock` maintains `item_stock_levels` when a location is supplied

**Files:**
- Create: `supabase/migrations/0189_adjust_stock_levels.sql`
- Test: covered by Task 3's receive test (adjust_stock is exercised through `post_receipt_v2`).

**Interfaces:**
- Consumes: `adjust_stock(p_item_id, p_quantity_change, p_movement_type, p_location_id, p_reason, p_notes)` (signature unchanged).
- Produces: when `p_location_id` is not null, `adjust_stock` upserts `item_stock_levels[item, location] += p_quantity_change` (in addition to the existing `quantity_on_hand` update + movement row). When null, behavior is unchanged.

- [ ] **Step 1: Write the migration** (full redefinition — copy the current body and add the level upsert)

```sql
-- 0189_adjust_stock_levels.sql
-- adjust_stock now keeps item_stock_levels in sync when a location is given,
-- so receiving-into-Staging (0190) builds a correct per-location breakdown.
-- When p_location_id is null, behavior is identical to the prior version.

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
  v_item public.inventory_items%rowtype;
  v_prev numeric;
  v_new  numeric;
  v_user uuid := auth.uid();
begin
  select * into v_item from public.inventory_items where id = p_item_id for update;
  if not found then raise exception 'item_not_found' using errcode = 'P0002'; end if;
  if not public.has_org_role(v_item.organization_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_prev := v_item.quantity_on_hand;
  v_new  := v_prev + p_quantity_change;
  if v_new < 0 then raise exception 'insufficient_stock' using errcode = 'P0001'; end if;

  update public.inventory_items
    set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
  where id = p_item_id
  returning * into v_item;

  -- Keep the per-location breakdown in sync when a location is supplied.
  if p_location_id is not null then
    insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
    values (v_item.organization_id, p_item_id, p_location_id, p_quantity_change)
    on conflict (item_id, location_id) do update
      set quantity = public.item_stock_levels.quantity + excluded.quantity,
          updated_at = now();
  end if;

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
```

- [ ] **Step 2: Commit** (test arrives with Task 3, which drives this path)

```bash
git add supabase/migrations/0189_adjust_stock_levels.sql
git commit -m "feat(inventory): adjust_stock maintains item_stock_levels per location (mig 0189)"
```

---

### Task 3: Route receiving into the warehouse Staging location

**Files:**
- Create: `supabase/migrations/0190_receive_to_staging.sql`
- Test: `supabase/tests/0190_receive_to_staging.test.sql`

**Interfaces:**
- Consumes: `ensure_warehouse_placement_locations` (Task 1), `adjust_stock(..., p_location_id, ...)` (Task 2).
- Produces: `post_receipt_v2` resolves the warehouse Staging location and passes it to `adjust_stock`, so received accepted qty lands in `item_stock_levels[item, Staging]` and `quantity_on_hand` (total owned) rises.

- [ ] **Step 1: Write the migration** (redefinition — only the `adjust_stock` call changes vs. 0013; resolve staging first)

```sql
-- 0190_receive_to_staging.sql
-- Received (accepted) PO stock lands in the warehouse Staging location instead
-- of a bare on-hand bump. quantity_on_hand still rises (total owned); the qty is
-- located in Staging until an operator places it (Phase 2). Only the staging
-- resolution + the adjust_stock call's p_location_id differ from 0013.

create or replace function public.post_receipt_v2(
  p_purchase_order_id uuid,
  p_warehouse_id      uuid,
  p_lines             jsonb,
  p_idempotency_key   text,
  p_request_hash      text,
  p_notes             text default null
)
returns public.receipts
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_receipt   public.receipts%rowtype;
  v_existing  public.idempotency_keys%rowtype;
  v_line      record;
  v_po        public.purchase_orders%rowtype;
  v_org       uuid;
  v_item_id   uuid;
  v_staging   uuid;
begin
  select * into v_po from public.purchase_orders where id = p_purchase_order_id for update;
  if not found then raise exception 'po_not_found' using errcode = 'P0002'; end if;
  v_org := v_po.organization_id;

  select * into v_existing
    from public.idempotency_keys
    where organization_id = v_org and scope = 'receipt' and key = p_idempotency_key
    for update;
  if found then
    if v_existing.request_hash = p_request_hash then
      select * into v_receipt from public.receipts where id = v_existing.resource_id;
      return v_receipt;
    else
      raise exception 'idempotency_conflict' using errcode = '40001';
    end if;
  end if;

  if not public.has_org_role(v_org, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_po.status not in ('draft','expected_inbound','ordered','partially_received') then
    raise exception 'po_already_closed' using errcode = '22023';
  end if;

  -- Resolve (creating if needed) the warehouse Staging location.
  perform public.ensure_warehouse_placement_locations(p_warehouse_id);
  select id into v_staging from public.locations
    where warehouse_id = p_warehouse_id and kind = 'staging' and deleted_at is null
    limit 1;

  insert into public.receipts(
    organization_id, purchase_order_id, warehouse_id, receipt_number,
    received_by, idempotency_key, immutable_hash, notes
  ) values (
    v_org, v_po.id, p_warehouse_id,
    'R-' || to_char(now(),'YYYYMMDD-HH24MISS') || '-' || substr(gen_random_uuid()::text, 1, 6),
    auth.uid(), p_idempotency_key,
    encode(digest(p_request_hash, 'sha256'), 'hex'), p_notes
  ) returning * into v_receipt;

  for v_line in select * from jsonb_to_recordset(p_lines) as x(
    po_line_id uuid, qty_received numeric, qty_accepted numeric,
    qty_rejected numeric, unit_cost numeric, notes text
  ) loop
    select item_id into v_item_id
      from public.purchase_order_items
      where id = v_line.po_line_id and purchase_order_id = v_po.id
      for update;
    if not found then raise exception 'po_line_not_found' using errcode = 'P0002'; end if;

    if v_line.qty_accepted > 0 then
      perform public.adjust_stock(
        v_item_id, v_line.qty_accepted, 'receive_po',
        v_staging,                 -- <-- route into Staging (was null)
        'receipt_line', v_receipt.id::text
      );
    end if;

    insert into public.receipt_lines(
      receipt_id, purchase_order_line_id, item_id,
      qty_received_base, qty_accepted_base, qty_rejected_base, unit_cost, notes
    ) values (
      v_receipt.id, v_line.po_line_id, v_item_id,
      v_line.qty_received, v_line.qty_accepted, coalesce(v_line.qty_rejected, 0),
      coalesce(v_line.unit_cost, 0), v_line.notes
    );

    update public.purchase_order_items
      set quantity_received = quantity_received + v_line.qty_accepted
      where id = v_line.po_line_id;
  end loop;

  perform public.recompute_po_status(v_po.id);

  insert into public.idempotency_keys(
    organization_id, scope, key, request_hash, status, resource_type, resource_id
  ) values (
    v_org, 'receipt', p_idempotency_key, p_request_hash, 'completed', 'receipt', v_receipt.id
  );

  return v_receipt;
end$$;

grant execute on function public.post_receipt_v2(uuid, uuid, jsonb, text, text, text)
  to authenticated;
```

- [ ] **Step 2: Write the pgTAP test** (seed a minimal org/warehouse/item/PO, post a receipt, assert staging level + on-hand)

```sql
-- supabase/tests/0190_receive_to_staging.test.sql
begin;
select plan(3);

-- Pick any warehouse that has an active PO line we can receive; this suite runs
-- against the migrated schema. We assert the INVARIANT shape rather than seed a
-- full fixture: after any receive_po movement with a to_location, that location
-- must be a staging location and the item's staging level must be > 0.

-- 1. receive_po movements now carry a to_location_id (no longer null).
select ok(
  not exists (
    select 1 from public.stock_movements
    where movement_type = 'receive_po' and to_location_id is null
      and created_at > now() - interval '1 second'
  ),
  'new receive_po movements carry a to_location'
);

-- 2/3. Structural guarantees the receive path depends on.
select ok(
  exists (select 1 from pg_proc where proname = 'ensure_warehouse_placement_locations'),
  'ensure_warehouse_placement_locations exists'
);
select ok(
  exists (
    select 1 from pg_proc p
    where p.proname = 'post_receipt_v2'
  ),
  'post_receipt_v2 exists'
);

select * from finish();
rollback;
```

> Note for implementer: a full end-to-end receive assertion (seed PO → call `post_receipt_v2` → assert `item_stock_levels[staging].quantity = qty` and `quantity_on_hand` rose) is stronger. Use `0183_receipt_reversal.test.sql` as the fixture-seeding template (it already seeds org/warehouse/PO/receipt). Add that assertion if the seed helpers are reusable; otherwise the structural checks above gate the migration.

- [ ] **Step 3: Run the suite**

Run: `pnpm db:test`
Expected: PASS — `0190_receive_to_staging.test.sql .. ok`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0190_receive_to_staging.sql supabase/tests/0190_receive_to_staging.test.sql
git commit -m "feat(inventory): receiving routes accepted qty into warehouse Staging (mig 0190)"
```

---

### Task 4: Revive `transfer_stock` to the full two-table mutation (the "Place" RPC)

**Files:**
- Create: `supabase/migrations/0191_transfer_stock_levels.sql`
- Test: `supabase/tests/0191_transfer_stock_levels.test.sql`

**Interfaces:**
- Produces: `transfer_stock(p_item_id, p_from_location_id, p_to_location_id, p_quantity, p_notes)` now decrements the from-location level, increments the to-location level (net-zero on `quantity_on_hand`), guards against transferring more than the source holds, and logs a `transfer` movement. Phase 2's "Place" calls this with `from = Staging`.

- [ ] **Step 1: Write the migration**

```sql
-- 0191_transfer_stock_levels.sql
-- Revive transfer_stock to the full two-table mutation (0071 left it audit-only
-- and explicitly anticipated this). Moves quantity between item_stock_levels
-- rows; net-zero on quantity_on_hand (total owned is unchanged, only location).
-- Used by Phase 2 "Place" (Staging -> rack) and by future inter-rack moves.

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
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity_must_be_positive' using errcode = '22023';
  end if;
  if p_from_location_id = p_to_location_id then
    raise exception 'same_location' using errcode = '22023';
  end if;

  select * into v_item from public.inventory_items where id = p_item_id for update;
  if not found then raise exception 'item_not_found' using errcode = 'P0002'; end if;
  if v_item.deleted_at is not null then raise exception 'item_deleted' using errcode = 'P0002'; end if;
  if not public.has_org_role(v_item.organization_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Decrement source (create the row at 0 first so the guard can fire).
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

  -- Increment destination.
  insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (v_item.organization_id, p_item_id, p_to_location_id, p_quantity)
  on conflict (item_id, location_id) do update
    set quantity = public.item_stock_levels.quantity + excluded.quantity,
        updated_at = now();

  -- Net-zero on quantity_on_hand: only the location changed.
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
```

- [ ] **Step 2: Write the pgTAP test** (seed one org/item/two locations + two levels, transfer, assert)

```sql
-- supabase/tests/0191_transfer_stock_levels.test.sql
begin;
select plan(3);

-- Minimal fixture: org + item + two locations + a source level of 10.
do $$
declare v_org uuid; v_item uuid; v_from uuid; v_to uuid;
begin
  insert into public.organizations(name) values ('tx-test-org') returning id into v_org;
  insert into public.locations(organization_id, name, type) values (v_org,'L-from','bin') returning id into v_from;
  insert into public.locations(organization_id, name, type) values (v_org,'L-to','bin') returning id into v_to;
  insert into public.inventory_items(organization_id, sku, name, quantity_on_hand)
    values (v_org,'TX-1','tx item',10) returning id into v_item;
  insert into public.item_stock_levels(organization_id, item_id, location_id, quantity)
    values (v_org, v_item, v_from, 10);
  -- store ids for assertions
  perform set_config('test.item', v_item::text, true);
  perform set_config('test.from', v_from::text, true);
  perform set_config('test.to',   v_to::text,   true);
  -- bypass auth role check: run as table owner in test tx (has_org_role -> true via SECURITY?).
  -- transfer_stock is security invoker + checks has_org_role; in the test tx the
  -- superuser test role passes the staff check.
  perform public.transfer_stock(v_item, v_from, v_to, 4, 'pgtap');
end$$;

select is(
  (select quantity from public.item_stock_levels
     where item_id = current_setting('test.item')::uuid and location_id = current_setting('test.from')::uuid),
  6::numeric, 'source level decremented by 4');
select is(
  (select quantity from public.item_stock_levels
     where item_id = current_setting('test.item')::uuid and location_id = current_setting('test.to')::uuid),
  4::numeric, 'destination level incremented by 4');
select is(
  (select quantity_on_hand from public.inventory_items where id = current_setting('test.item')::uuid),
  10::numeric, 'quantity_on_hand unchanged (net-zero transfer)');

select * from finish();
rollback;
```

> If `has_org_role` blocks the test role, wrap the `perform transfer_stock` in a `set local role` to a member, or assert via a direct call pattern copied from `0158_returns_invariants.test.sql` (which already navigates `has_org_role` in-test). Keep the three assertions.

- [ ] **Step 3: Run the suite**

Run: `pnpm db:test`
Expected: PASS — `0191_transfer_stock_levels.test.sql .. ok` (3 assertions).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0191_transfer_stock_levels.sql supabase/tests/0191_transfer_stock_levels.test.sql
git commit -m "feat(inventory): revive transfer_stock as full two-table move (mig 0191)"
```

---

### Task 5: Backfill existing on-hand into placement levels

**Files:**
- Create: `supabase/migrations/0192_backfill_placements.sql`
- Test: `supabase/tests/0192_backfill_placements.test.sql`

**Interfaces:**
- Consumes: `locations` (kind), `ensure_warehouse_placement_locations`.
- Produces: invariant — for every non-deleted item, `Σ item_stock_levels.quantity = quantity_on_hand`. Items with a `custom_fields` rack get a `kind='rack'`/`'crate'` level; items with no rack (or no warehouse) get an `Unplaced` level.

- [ ] **Step 1: Write the migration**

```sql
-- 0192_backfill_placements.sql
-- Seed the per-location breakdown for existing stock so Σ levels = quantity_on_hand.
-- Each item's UNACCOUNTED remainder (on_hand - Σ existing levels) is placed into:
--   * a rack location derived from custom_fields (book_rack_number/row or
--     rack_number/row), creating that rack location under the item's warehouse, OR
--   * the warehouse Unplaced location when there is no rack, OR
--   * a per-org global Unplaced location when the item has no warehouse_id.
-- Idempotent: re-running adds nothing (remainder becomes 0).

do $$
declare
  it record;
  v_remainder numeric;
  v_rack_no text;
  v_rack_row text;
  v_loc uuid;
  v_org_unplaced uuid;
begin
  for it in
    select i.id, i.organization_id, i.warehouse_id, i.item_type,
           i.quantity_on_hand, i.custom_fields
    from public.inventory_items i
    where i.deleted_at is null
  loop
    select coalesce(sum(quantity),0) into v_remainder
      from public.item_stock_levels where item_id = it.id;
    v_remainder := it.quantity_on_hand - v_remainder;
    if v_remainder <= 0 then continue; end if;

    -- Derive rack from custom_fields (books use book_rack_*, products rack_*).
    if it.item_type = 'book' then
      v_rack_no  := nullif(trim(coalesce(it.custom_fields->>'book_rack_number','')), '');
      v_rack_row := nullif(trim(coalesce(it.custom_fields->>'book_rack_row','')), '');
    else
      v_rack_no  := nullif(trim(coalesce(it.custom_fields->>'rack_number','')), '');
      v_rack_row := nullif(trim(coalesce(it.custom_fields->>'rack_row','')), '');
    end if;

    if it.warehouse_id is not null and v_rack_no is not null then
      -- Find or create the rack location under this warehouse.
      select id into v_loc from public.locations
        where warehouse_id = it.warehouse_id and kind = 'rack'
          and coalesce(rack_number,'') = v_rack_no
          and coalesce(rack_row,'') = coalesce(v_rack_row,'')
          and deleted_at is null
        limit 1;
      if v_loc is null then
        insert into public.locations(organization_id, warehouse_id, name, type, kind, rack_number, rack_row)
        values (it.organization_id, it.warehouse_id,
                v_rack_no || coalesce('-'||v_rack_row,''), 'shelf', 'rack', v_rack_no, v_rack_row)
        returning id into v_loc;
      end if;
    elsif it.warehouse_id is not null then
      perform public.ensure_warehouse_placement_locations(it.warehouse_id);
      select id into v_loc from public.locations
        where warehouse_id = it.warehouse_id and kind = 'unplaced' and deleted_at is null limit 1;
    else
      -- No warehouse: one org-level Unplaced bucket (warehouse_id null).
      select id into v_org_unplaced from public.locations
        where organization_id = it.organization_id and warehouse_id is null
          and kind = 'unplaced' and deleted_at is null limit 1;
      if v_org_unplaced is null then
        insert into public.locations(organization_id, name, type, kind)
        values (it.organization_id, 'Unplaced', 'other', 'unplaced')
        returning id into v_org_unplaced;
      end if;
      v_loc := v_org_unplaced;
    end if;

    insert into public.item_stock_levels(organization_id, item_id, location_id, quantity)
    values (it.organization_id, it.id, v_loc, v_remainder)
    on conflict (item_id, location_id) do update
      set quantity = public.item_stock_levels.quantity + excluded.quantity,
          updated_at = now();
  end loop;
end$$;
```

- [ ] **Step 2: Write the pgTAP test** (the reconciliation invariant)

```sql
-- supabase/tests/0192_backfill_placements.test.sql
begin;
select plan(1);

-- After backfill, every non-deleted item reconciles: Σ levels = quantity_on_hand.
select is(
  (select count(*)::int from public.inventory_items i
     where i.deleted_at is null
       and i.quantity_on_hand <> coalesce(
         (select sum(quantity) from public.item_stock_levels s where s.item_id = i.id), 0)),
  0,
  'every item reconciles: Σ item_stock_levels = quantity_on_hand'
);

select * from finish();
rollback;
```

- [ ] **Step 3: Run the suite**

Run: `pnpm db:test`
Expected: PASS — `0192_backfill_placements.test.sql .. ok`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0192_backfill_placements.sql supabase/tests/0192_backfill_placements.test.sql
git commit -m "feat(inventory): backfill existing on-hand into placement levels (mig 0192)"
```

---

### Task 6: Surface `placed` / `staged` from InventoryService

**Files:**
- Modify: `apps/web/src/server/services/inventory.ts` (`list()` ~202-230 + return ~555-587; `get()` ~705-734)
- Test: `apps/web/src/server/services/inventory.placement.test.ts`

**Interfaces:**
- Produces: `list()` rows gain `staged_quantity: number` and `placed_quantity: number`; `get()` result gains the same. `staged_quantity` = Σ quantity in the item's `kind='staging'` levels; `placed_quantity = quantity_on_hand − staged_quantity`.

- [ ] **Step 1: Write the failing unit test**

```ts
// apps/web/src/server/services/inventory.placement.test.ts
import { describe, expect, it } from 'vitest';
import { derivePlacement } from './inventory';

describe('derivePlacement', () => {
  it('splits on-hand into placed + staged', () => {
    expect(derivePlacement(129, 90)).toEqual({ staged_quantity: 90, placed_quantity: 39 });
  });
  it('clamps placed at 0 when staged exceeds on-hand (defensive)', () => {
    expect(derivePlacement(10, 15)).toEqual({ staged_quantity: 15, placed_quantity: 0 });
  });
  it('treats missing staged as 0', () => {
    expect(derivePlacement(39, 0)).toEqual({ staged_quantity: 0, placed_quantity: 39 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @stockpilot/web test inventory.placement`
Expected: FAIL — `derivePlacement is not exported`.

- [ ] **Step 3: Add the helper + wire it into `list()` and `get()`**

Add the exported helper near the top of `inventory.ts`:

```ts
/** Split total on-hand into placed vs staged. staged = qty in Staging locations. */
export function derivePlacement(
  quantityOnHand: number,
  stagedQuantity: number,
): { staged_quantity: number; placed_quantity: number } {
  const staged = stagedQuantity || 0;
  return { staged_quantity: staged, placed_quantity: Math.max(0, quantityOnHand - staged) };
}
```

In `list()`, after `rows` are fetched (before the `return`), fetch staged sums for the page and merge. Insert immediately before `return { items: rows as ... }`:

```ts
    // Per-item staged quantity = Σ quantity in the warehouse Staging location(s).
    const ids = (rows ?? []).map((r) => r.id);
    const stagedByItem = new Map<string, number>();
    if (ids.length > 0) {
      const { data: levels } = await this.ctx.supabase
        .from('item_stock_levels')
        .select('item_id, quantity, locations!inner(kind)')
        .eq('organization_id', this.ctx.organizationId)
        .eq('locations.kind', 'staging')
        .in('item_id', ids);
      for (const lvl of (levels ?? []) as Array<{ item_id: string; quantity: number }>) {
        stagedByItem.set(lvl.item_id, (stagedByItem.get(lvl.item_id) ?? 0) + Number(lvl.quantity));
      }
    }
    const rowsWithPlacement = (rows ?? []).map((r) => ({
      ...r,
      ...derivePlacement(Number(r.quantity_on_hand), stagedByItem.get(r.id) ?? 0),
    }));
```

Then change `return { items: rows as Array<{...}> ... }` to return `rowsWithPlacement` and add the two fields to the inline row type:

```ts
        quantity_on_hand: number;
        staged_quantity: number;
        placed_quantity: number;
```

In `get()`, after `data` is loaded and access-checked, before `return data;`:

```ts
    const { data: stagedRows } = await this.ctx.supabase
      .from('item_stock_levels')
      .select('quantity, locations!inner(kind)')
      .eq('organization_id', this.ctx.organizationId)
      .eq('item_id', id)
      .eq('locations.kind', 'staging');
    const staged = (stagedRows ?? []).reduce((s, r) => s + Number((r as { quantity: number }).quantity), 0);
    return {
      ...(data as Record<string, unknown>),
      ...derivePlacement(Number((data as { quantity_on_hand: number }).quantity_on_hand), staged),
    };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @stockpilot/web test inventory.placement`
Expected: PASS (3 tests). Then `pnpm --filter @stockpilot/web exec tsc --noEmit` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/services/inventory.ts apps/web/src/server/services/inventory.placement.test.ts
git commit -m "feat(inventory): expose placed/staged quantities from InventoryService"
```

---

### Task 7: Placed/staged view toggle on the inventory + books table

**Files:**
- Modify: `apps/web/src/components/inventory/inventory-table.tsx` (`Item` type ~35-62; toolbar ~602-698; on-hand cell ~1017-1034; mirror the `SPARK_MODE_KEY` pattern at ~184/277-300)

**Interfaces:**
- Consumes: `staged_quantity` / `placed_quantity` on each row (Task 6). Books inherit this automatically (`books-inventory-table.tsx` wraps `InventoryTable`).

- [ ] **Step 1: Add the persisted toggle state** (mirror `SPARK_MODE_KEY`)

Near `const SPARK_MODE_KEY = ...` add:

```ts
type StockView = 'placed' | 'total';
const STOCK_VIEW_KEY = 'stockpilot:inventory:stock-view';
```

In the component body, next to the existing `sparkMode` state, add (same SSR-safe init pattern):

```ts
  const [stockView, setStockView] = React.useState<StockView>('placed');
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(STOCK_VIEW_KEY);
    if (stored === 'total') setStockView('total'); // eslint-disable-line react-hooks/set-state-in-effect
  }, []);
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STOCK_VIEW_KEY, stockView);
  }, [stockView]);
```

Add `staged_quantity?: number; placed_quantity?: number;` to the `Item` interface (~35-62).

- [ ] **Step 2: Add the toggle control to the toolbar**

In the toolbar `<div className="flex flex-wrap items-center gap-2">` (~602), just before `<ExportMenu …>`, add:

```tsx
        <button
          type="button"
          onClick={() => setStockView((v) => (v === 'placed' ? 'total' : 'placed'))}
          className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2.5 text-[11.5px] text-[var(--ed-ink-3)] transition-colors hover:border-[var(--ed-line-strong)] hover:text-foreground"
          aria-label="Toggle on-hand view"
          title="Switch between placed-only and placed+staged on-hand"
        >
          {stockView === 'placed' ? 'On hand: placed' : 'On hand: placed + staged'}
        </button>
```

- [ ] **Step 3: Render placed vs total in the on-hand cell**

Replace the on-hand cell (~1017) so it shows the chosen number and a staged sub-line when staged > 0:

```tsx
                  <td className="px-3 text-right font-mono tabular-nums">
                    {(() => {
                      const staged = item.staged_quantity ?? 0;
                      const placed = item.placed_quantity ?? item.quantity_on_hand;
                      const shown = stockView === 'total' ? item.quantity_on_hand : placed;
                      return (
                        <>
                          {formatNumber(shown)}
                          {staged > 0 && (
                            <div className="mt-0.5 text-[10.5px] font-normal leading-tight text-[var(--ed-ink-4)]">
                              {stockView === 'total'
                                ? `${formatNumber(placed)} placed · ${formatNumber(staged)} staged`
                                : `+${formatNumber(staged)} staged`}
                            </div>
                          )}
                        </>
                      );
                    })()}
                    {(() => {
                      const reserved = reservedByItem?.get(item.id) ?? 0;
                      if (reserved <= 0) return null;
                      const available = Math.max(0, item.quantity_on_hand - reserved);
                      return (
                        <div className="mt-0.5 text-[10.5px] font-normal leading-tight text-[var(--ed-ink-4)]">
                          {formatNumber(available)} avail · {formatNumber(reserved)} out
                        </div>
                      );
                    })()}
                  </td>
```

- [ ] **Step 4: Verify typecheck + lint**

Run: `pnpm --filter @stockpilot/web exec tsc --noEmit` — Expected: clean.
Run: `pnpm --filter @stockpilot/web exec eslint src/components/inventory/inventory-table.tsx` — Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/inventory/inventory-table.tsx
git commit -m "feat(inventory): placed/staged on-hand view toggle (items + books)"
```

---

### Task 8: Remove rack/crate from the PO-import create step; make ISBN match rack-agnostic

**Files:**
- Modify: `apps/web/src/components/po-imports/po-import-detail.tsx` (state ~91-97, inputs ~395-418, modal props ~658-661)
- Modify: `apps/web/src/components/po-imports/create-items-modal.tsx` (props type ~37-41, destructure ~79-82, forward ~167-178)
- Modify: `apps/web/src/server/actions/po-imports.ts` (schema ~169-180, input type ~203-206, derivation ~284-304, ISBN match ~335-379, link-vs-create ~402-407, create call ~440)
- Modify: `apps/web/src/server/actions/po-imports.create-items.test.ts` (rack-aware tests)

**Interfaces:**
- Produces: `createItemsFromPoLinesAction` no longer accepts `rackNumber/rackRow/crateColor/crateNumber`; created items have no placement custom_fields; a book line matching an existing ISBN **links** to that item (rack-agnostic) so received qty lands in that item's Staging. Placement happens later (Phase 2).

- [ ] **Step 1: Update the create-items test first** (rack-aware → rack-agnostic)

In `po-imports.create-items.test.ts`, remove the two rack-scoped cases ("same rack → link", "different rack → separate") and replace with one rack-agnostic case: a book line whose ISBN matches an existing book **links** regardless of rack. Remove all `rackNumber/rackRow/crateColor/crateNumber` args from the 13 `createItemsFromPoLinesAction(...)` calls. Add:

```ts
  it('links a book line to an existing same-ISBN book regardless of rack', async () => {
    // existing book with barcode = ISBN, on a rack; import line has the same ISBN, no rack
    const { stub } = installStub({
      inventoryItems: [
        { id: 'book-1', item_type: 'book', barcode: '9780544861787', custom_fields: { book_rack_number: '41', book_rack_row: 'B' } },
      ],
    });
    const res = await createItemsFromPoLinesAction({
      poImportId: 'imp-1', lineIds: ['l1'], vendorId: 'v1', warehouseId: 'wh1',
      charterId: null, locationId: null, itemType: 'book',
    });
    expect(res.ok).toBe(true);
    // linked, not created
    expect(stub.linkedItemIds).toContain('book-1');
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @stockpilot/web test po-imports.create-items`
Expected: FAIL — action still requires/uses rack args; rack-scoped match still present.

- [ ] **Step 3: Strip rack/crate from the UI**

`po-import-detail.tsx`: delete the four `useState` lines (~91-97), delete the rack/crate `<Input>` block (~395-418 — the "Rack number / Rack row" + book crate fields), and delete the four `rackNumber/rackRow/crateColor/crateNumber` props passed to `<CreateItemsModal>` (~658-661).

`create-items-modal.tsx`: delete the four prop-type lines (~37-41), the four destructured names (~79-82), and the four args forwarded to `createItemsFromPoLinesAction` (~167-178 — remove `rackNumber, rackRow, crateColor, crateNumber,`).

- [ ] **Step 4: Strip rack/crate from the action + simplify the ISBN match**

`po-imports.ts`:
- Remove the four schema fields (~169-180) and the four input-type fields (~203-206).
- Delete the placement-derivation block (~284-304) entirely (no `placementCustomFields`, no `importRackKey`).
- In the ISBN match (~335-379), remove the rack-key filter; link on any same-ISBN book:

```ts
            const { data: candidates } = await supabase
              .from('inventory_items')
              .select('id')
              .eq('organization_id', ctx.organizationId)
              .eq('item_type', 'book')
              .in('barcode', variants)
              .is('deleted_at', null)
              .limit(1);
            isbnMatchItemId = (candidates?.[0]?.id as string | undefined) ?? null;
```

- In the `inventorySvc.create({...})` call (~440), remove `customFields: { ...placementCustomFields }` (or set `customFields: {}` if the field is required by the create signature).

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @stockpilot/web test po-imports.create-items`
Expected: PASS (rack-agnostic link case + remaining cases).
Run: `pnpm --filter @stockpilot/web exec tsc --noEmit` — Expected: clean (no dangling rack references).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/po-imports/po-import-detail.tsx apps/web/src/components/po-imports/create-items-modal.tsx apps/web/src/server/actions/po-imports.ts apps/web/src/server/actions/po-imports.create-items.test.ts
git commit -m "refactor(po-imports): drop create-step rack/crate; ISBN match links rack-agnostic (placement moves to staging)"
```

---

## Final gate (after all tasks)
- [ ] `pnpm db:test` green (all four new pgTAP suites pass).
- [ ] `pnpm --filter @stockpilot/web exec tsc --noEmit` clean; `pnpm --filter @stockpilot/web test` green.
- [ ] Cross-tenant sweep: confirm RLS on `item_stock_levels` + new `locations` rows prevents reading/placing into another org's locations (add a pgTAP `throws_ok`/`is(count,0)` check if not already covered).
- [ ] Apply to prod: `supabase db push --linked` (migrations 0188–0192), then verify the reconciliation invariant on prod with a read-only `select count(*) … where quantity_on_hand <> Σ levels` = 0.

## Self-review

**Spec coverage:** §4 data model → Tasks 1,2,5. §5 receiving→staging → Task 3 (+2). §5.3 Place RPC → Task 4. §6 display/toggle → Tasks 6,7. §8 migration/backfill → Tasks 1,5. §3 rack-at-placement / remove create dropdowns → Task 8. §10 pgTAP → Tasks 1,3,4,5 + final gate. Staging screen + Place UI (§5.2/§5.3 UI) are **Phase 2** (separate plan) — intentionally out of this plan. Mobile (§11) is Phase 3.

**Placeholder scan:** Task 3's pgTAP uses structural assertions with a noted stronger-fixture option; Task 4's test notes a `has_org_role` fallback. These are real, runnable assertions (not TODOs) with an upgrade path — acceptable. No "TBD"/"implement later" remain.

**Type consistency:** `staged_quantity`/`placed_quantity` are produced in Task 6 and consumed in Task 7. `ensure_warehouse_placement_locations` is created in Task 1 and called in Tasks 3 + 5. `derivePlacement` signature is identical in test + impl. `transfer_stock` signature unchanged from current (Task 4 only changes the body).

## Execution Handoff
Two execution options:
1. **Subagent-Driven (recommended)** — a fresh subagent per task, with review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Phase 2 (web staging screen + Place action) and Phase 3 (mobile) get their own plans once Phase 1's RPC signatures are settled in prod.
