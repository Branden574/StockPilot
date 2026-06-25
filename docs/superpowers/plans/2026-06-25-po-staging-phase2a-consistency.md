# PO Staging Phase 2a — Level-Authoritative Mutators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make `item_stock_levels` the system-wide source of truth — every on-hand mutator keeps `Σ item_stock_levels = quantity_on_hand`, decrements draw from placed stock only (blocking when short), and null-location increments land in Staging.

**Architecture:** A single shared SQL helper `apply_level_delta(item, qty, mode)` holds all allocation logic (+ → Staging; − → draw down by mode). `adjust_stock` calls it on the null-location path, so every existing null-location caller (picking, shipping, cancel-restore) inherits correct behavior with no call-site change. The mutators that bypass `adjust_stock` and mutate `quantity_on_hand` inline (`post_cycle_count`, `process_return_disposition`, bundle assemble/disassemble) call the helper directly alongside their existing on-hand/movement logic. `reverse_receipt` and net-zero return-scrap use the helper's `staging_first` mode.

**Tech Stack:** Supabase Postgres (plpgsql RPCs, `supabase/migrations/NNNN_*.sql`), pgTAP (`supabase/tests/NNNN_*.test.sql`, `pnpm db:test`), TypeScript/Vitest for any service-surface error mapping.

## Spec corrections (discovered while reading current code — supersede spec §4.4/§7)
- **Mechanism is a shared helper, not a literal reroute through `adjust_stock`.** Two bypassers cannot simply call `adjust_stock`:
  - **`post_cycle_count` (latest def `0079_post_cycle_count_v2.sql`)** deliberately sets `quantity_on_hand = expected_snapshot + diff` (NOT `+= diff` against live qty — that was the v1 drift-rebasing bug it fixed) and writes a custom `stock_movements` row (`reference_type='cycle_count'`, snapshot `previous_quantity`, drift note). Calling `adjust_stock` would re-introduce the drift bug and lose the audit metadata. So it keeps its own on-hand/movement logic and ONLY adds an `apply_level_delta(item, v_diff, …)` call.
  - **`process_return_disposition` (latest def `0154_returns_status_machine_db_guard.sql`)** and **bundles (`0101_bundle_rpc_tighten_to_manager.sql`)** also `update inventory_items.quantity_on_hand` inline with custom movements; same treatment.
- **Draw-down has TWO modes.** Normal decrements (pick/ship/sale/bundle-consume) are `placed` (placed-only, block if short). Reversals/write-offs of just-added stock — `reverse_receipt` and net-zero return-**scrap** (`+qty 'return'` then `-qty 'loss'`) — must remove from **Staging first** (where the unit just landed), then placed: mode `staging_first`. Using `placed` mode for scrap's loss leg would strand the returned unit in Staging while decrementing a rack → phantom stock.
- **Bundles are in scope** (spec §4.5 table): assemble consumes components (− placed) and produces the bundle (+ Staging); disassemble reverses.
- Confirmed null-location callers (no change needed; inherit via `adjust_stock`): `complete_picking` `0121:235` (`-qty, 'transfer', null`), `post_shipment_shipped` `0073:83` (`-qty, 'transfer', null`), `cancel_order_request` `0155:91` (`+qty, 'return', null`).

## Researched test fixtures + auth pattern (built against the live schema — use these, don't re-derive)
Complete, schema-grounded seed blocks were researched from the existing passing suites and written to scratch files; each task's implementer **starts from its fixture file** and finalizes it against the live DB (`supabase db reset && pnpm db:test`, fixing any column mismatch):
- Task 2 (orders): `…/scratchpad/fixture-orders.sql`
- Task 4 (cycle): `…/scratchpad/fixture-cycle.sql`
- Task 5 (returns): `…/scratchpad/fixture-returns.sql`
- Task 6 (bundles): `…/scratchpad/fixture-bundles.sql`
(scratch dir = `/private/tmp/claude-501/-Users-brandenvincent-walker-Developer-InventorySystem/b7fc6dc0-134e-4114-b7df-23e58c2f3915/scratchpad/`)

**Auth/role seeding (all suites):** membership is `public.organization_members(organization_id, user_id, role, accepted_at)` — `role` in `('owner','admin','manager','staff','viewer')`, and `accepted_at` MUST be non-null (`has_org_role` filters on it). Seed role `'manager'` (covers both staff and manager checks). Set the caller context with:
```sql
set local "request.jwt.claim.sub"  to '<user-uuid>';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
```
`adjust_stock`/picking/etc. are `security invoker` (check `has_org_role` via `auth.uid()` at call time), so set this BEFORE the RPC call. `inventory_items.warehouse_id` must be set (RLS `user_can_access_inventory` derives org via the warehouse; null → readbacks return null under the authenticated role).

**Domain gotchas (from the research):**
- Orders: seed `order_requests` at `status='pick_slip_generated'` via direct INSERT (no approve→pickslip RPC; the transition trigger fires on UPDATE only) and `fulfillment_type='pickup'` (delivery needs `delivery_charter_id`). `complete_picking(p_order_id uuid)` lazy-assigns the picker; no reservation row needed. `cancel_order_request(p_id uuid, p_reason text default null)`.
- Cycle: insert `cycle_counts` (status defaults `'in_progress'`, scope `'warehouse'`, started_at `now()`) + `cycle_count_lines` (`expected_quantity` NOT NULL snapshot, `counted_quantity`, and SET `warehouse_id` to the item's warehouse or the `item_out_of_scope` guard no-ops the line). `post_cycle_count(p_cycle_count_id uuid)`.
- Returns: `process_return_disposition(p_return_id uuid)` (security definer). `returns`(organization_id, order_request_id, status — must be `'received'`); `return_lines`(return_id, organization_id, order_request_line_id, item_id, quantity, disposition `'restock'|'scrap'`, applied=false). Adapt the seed from `0158_returns_invariants.test.sql`.
- Bundles: `assemble_bundle(p_bundle_id uuid, p_quantity numeric, p_warehouse_id uuid, p_notes text default null)` and `distribute_bundle(p_bundle_id uuid, p_quantity numeric, p_warehouse_id uuid, p_allow_shortage boolean, …)`. **No `disassemble_bundle` RPC exists — do NOT invent one.** `bundles.preassembly_enabled` must be `true` (else `preassembly_disabled`); the phantom item is auto-created `is_bundle=true`; `bundle_components(bundle_id, item_id, quantity, is_optional)` PK `(bundle_id,item_id)`.

## Global Constraints
- Migrations sequential zero-padded; **next free is `0194`** (Phase 1 shipped through 0193, live in prod). One concern per migration; never edit a shipped migration.
- Every migration opens with a `-- NNNN_name.sql` comment block (what + why).
- pgTAP wrapped `begin; select plan(N); … select * from finish(); rollback;`. Run `supabase db reset && pnpm db:test` (a bare `pnpm db:test` runs the stale backup schema → false failures).
- **Invariant after every task:** for every non-deleted item, `Σ item_stock_levels.quantity = quantity_on_hand`.
- Draw-down binding rule: never draw from `kind='staging'` in `placed` mode; Unplaced drained last; raise `insufficient_placed_stock` (errcode `P0001`) and roll back when placed stock is short.
- All functions keep their existing `security` mode + `search_path` (several use `public, extensions` for `digest()` — preserve verbatim).
- No `Co-Authored-By: Claude/Anthropic` trailer on any commit.
- After merge: `supabase db push --linked`, pgTAP green first; re-verify `Σlevels=on_hand` on prod.
- This is Phase 2a (backend). Phase 2b (staging UX) is a separate plan written after 2a lands.

## File Structure
- `supabase/migrations/0194_apply_level_delta.sql` — the shared `apply_level_delta(uuid,numeric,text)` helper + rewire `adjust_stock` null-location path to call it.
- `supabase/migrations/0195_reverse_receipt_staging_first.sql` — `reverse_receipt` uses `staging_first`.
- `supabase/migrations/0196_cycle_count_levels.sql` — `post_cycle_count` adds the helper call.
- `supabase/migrations/0197_return_disposition_levels.sql` — `process_return_disposition` restock→Staging, scrap loss→`staging_first`.
- `supabase/migrations/0198_bundle_levels.sql` — bundle assemble/disassemble call the helper.
- `supabase/tests/0194_…`–`0198_…test.sql` — pgTAP per task.

---

### Task 1: `apply_level_delta` helper + `adjust_stock` null-location allocation

**Files:**
- Create: `supabase/migrations/0194_apply_level_delta.sql`
- Test: `supabase/tests/0194_apply_level_delta.test.sql`

**Interfaces:**
- Produces: `public.apply_level_delta(p_item_id uuid, p_qty numeric, p_mode text)` — `p_mode in ('placed','staging','staging_first')`. `p_qty>0` → add `+p_qty` to the item's warehouse Staging level (mode ignored for positives). `p_qty<0`: `placed` → draw from non-staging levels (racks/areas/crates first, Unplaced last) raising `insufficient_placed_stock` if short; `staging_first` → draw from Staging first then placed (raise `insufficient_placed_stock` only if total < need). Maintains levels ONLY (does not touch `quantity_on_hand` or `stock_movements`). Resolves the item's warehouse via `inventory_items.warehouse_id`, falling back to the org-level Staging/Unplaced buckets.
- Produces: `adjust_stock` unchanged signature/behavior EXCEPT the null-location path now calls `apply_level_delta` (positives → `staging`, negatives → `placed`).

- [ ] **Step 1: Write the migration**

```sql
-- 0194_apply_level_delta.sql
-- Shared per-location allocation helper + adjust_stock null-location wiring.
-- Makes item_stock_levels authoritative: every null-location adjust_stock call
-- (picking, shipping, cancel-restore, manual adjust, etc.) now maintains levels.
-- + qty -> Staging; - qty -> draw down placed (mode 'placed') or Staging-first
-- (mode 'staging_first'); raises insufficient_placed_stock when short.

create or replace function public.apply_level_delta(
  p_item_id uuid,
  p_qty     numeric,
  p_mode    text default 'placed'
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_org    uuid;
  v_wh     uuid;
  v_loc    uuid;
  v_need   numeric;
  v_avail  numeric;
  v_take   numeric;
  v_lvl    record;
begin
  if p_qty = 0 or p_qty is null then return; end if;
  select organization_id, warehouse_id into v_org, v_wh
    from public.inventory_items where id = p_item_id;
  if v_org is null then return; end if;

  -- ---- INCREMENT: land in Staging ----------------------------------------
  if p_qty > 0 then
    if v_wh is not null then
      perform public.ensure_warehouse_placement_locations(v_wh);
      select id into v_loc from public.locations
        where warehouse_id = v_wh and kind = 'staging' and deleted_at is null limit 1;
    else
      select id into v_loc from public.locations
        where organization_id = v_org and warehouse_id is null
          and kind = 'staging' and deleted_at is null limit 1;
      if v_loc is null then
        insert into public.locations(organization_id, name, type, kind)
        values (v_org, 'Staging', 'other', 'staging') returning id into v_loc;
      end if;
    end if;
    insert into public.item_stock_levels(organization_id, item_id, location_id, quantity)
    values (v_org, p_item_id, v_loc, p_qty)
    on conflict (item_id, location_id) do update
      set quantity = public.item_stock_levels.quantity + excluded.quantity,
          updated_at = now();
    return;
  end if;

  -- ---- DECREMENT: draw down by mode --------------------------------------
  v_need := -p_qty;  -- positive amount to remove

  -- staging_first: drain the Staging level(s) before placed.
  if p_mode = 'staging_first' then
    for v_lvl in
      select s.location_id, s.quantity
        from public.item_stock_levels s
        join public.locations l on l.id = s.location_id
       where s.item_id = p_item_id and s.quantity > 0 and l.kind = 'staging'
       order by s.quantity desc
    loop
      exit when v_need <= 0;
      v_take := least(v_lvl.quantity, v_need);
      update public.item_stock_levels set quantity = quantity - v_take, updated_at = now()
        where item_id = p_item_id and location_id = v_lvl.location_id;
      v_need := v_need - v_take;
    end loop;
  end if;

  -- placed draw-down (racks/areas/crates first, Unplaced last; never Staging).
  for v_lvl in
    select s.location_id, s.quantity
      from public.item_stock_levels s
      join public.locations l on l.id = s.location_id
     where s.item_id = p_item_id and s.quantity > 0 and l.kind <> 'staging'
     order by (case when l.kind = 'unplaced' then 1 else 0 end), l.created_at
  loop
    exit when v_need <= 0;
    v_take := least(v_lvl.quantity, v_need);
    update public.item_stock_levels set quantity = quantity - v_take, updated_at = now()
      where item_id = p_item_id and location_id = v_lvl.location_id;
    v_need := v_need - v_take;
  end loop;

  if v_need > 0 then
    raise exception 'insufficient_placed_stock' using errcode = 'P0001';
  end if;
end;
$$;

-- Rewire adjust_stock: null-location path now maintains levels via the helper.
-- (Verbatim copy of the 0189 body with the level block replaced.)
create or replace function public.adjust_stock(
  p_item_id          uuid,
  p_quantity_change  numeric,
  p_movement_type    text,
  p_location_id      uuid default null,
  p_reason           text default null,
  p_notes            text default null,
  p_mode             text default 'placed'   -- draw-down mode for the null-location negative path
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

  -- Per-location maintenance:
  if p_location_id is not null then
    -- Explicit location (e.g. receiving into Staging): mutate that level.
    insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
    values (v_item.organization_id, p_item_id, p_location_id, p_quantity_change)
    on conflict (item_id, location_id) do update
      set quantity = public.item_stock_levels.quantity + excluded.quantity,
          updated_at = now();
  else
    -- Null location: auto-allocate. + -> Staging, - -> draw-down by p_mode
    -- ('placed' for picks/ships; 'staging_first' for reversals/scrap write-offs).
    perform public.apply_level_delta(p_item_id, p_quantity_change, p_mode);
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

- [ ] **Step 2: Write the pgTAP test** — seed an item with placed (rack=6) + staging(0); assert: positive null adjust → Staging level rises + Σ=on_hand; negative null adjust within placed → rack drops, Σ=on_hand; negative null adjust exceeding placed → `insufficient_placed_stock` thrown.

```sql
-- supabase/tests/0194_apply_level_delta.test.sql
begin;
select plan(4);
do $$
declare v_org uuid; v_wh uuid; v_item uuid; v_rack uuid; v_stg uuid;
begin
  insert into public.organizations(name) values ('p2a-t1') returning id into v_org;
  insert into public.warehouses(organization_id, name) values (v_org,'WH') returning id into v_wh;
  perform public.ensure_warehouse_placement_locations(v_wh);
  select id into v_stg from public.locations where warehouse_id=v_wh and kind='staging';
  insert into public.locations(organization_id,warehouse_id,name,type,kind,rack_number)
    values (v_org,v_wh,'R1','shelf','rack','R1') returning id into v_rack;
  insert into public.inventory_items(organization_id,sku,name,quantity_on_hand,warehouse_id)
    values (v_org,'SKU1','i',6,v_wh) returning id into v_item;
  insert into public.item_stock_levels(organization_id,item_id,location_id,quantity)
    values (v_org,v_item,v_rack,6);
  perform set_config('t.item',v_item::text,true);
  perform set_config('t.rack',v_rack::text,true);
  perform set_config('t.stg', v_stg::text, true);
  -- grant role for adjust_stock has_org_role: insert org_members staff row
  insert into public.org_members(organization_id,user_id,role)
    values (v_org, '00000000-0000-0000-0000-000000000001','staff') on conflict do nothing;
  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
  set local role authenticated;
  perform public.adjust_stock(v_item, 4, 'add', null, 'pos', null);   -- +4 -> Staging
  perform public.adjust_stock(v_item, -5, 'remove', null, 'neg', null); -- -5 from placed(6)->1
  reset role;
end$$;
select is((select quantity from public.item_stock_levels where item_id=current_setting('t.item')::uuid and location_id=current_setting('t.stg')::uuid), 4::numeric, '+4 landed in Staging');
select is((select quantity from public.item_stock_levels where item_id=current_setting('t.item')::uuid and location_id=current_setting('t.rack')::uuid), 1::numeric, '-5 drew from placed rack (6->1)');
select is((select quantity_on_hand from public.inventory_items where id=current_setting('t.item')::uuid), 5::numeric, 'on_hand = 6 +4 -5 = 5');
select is((select coalesce(sum(quantity),0) from public.item_stock_levels where item_id=current_setting('t.item')::uuid), 5::numeric, 'Sigma levels = on_hand');
select * from finish();
rollback;
```

> Implementer note: the auth/role seeding pattern (org_members + jwt sub + `set local role`) must match what the existing passing suites use (`0190_receive_to_staging.test.sql`, `0191_transfer_stock_levels.test.sql`). Copy their exact pattern; the column/table names above (`org_members`, role value) must be verified against the real schema and corrected if different. Add a 5th `throws_ok` asserting an over-draw (`adjust_stock(item,-100,'remove',null,…)`) raises `insufficient_placed_stock` — bump `plan(4)`→`plan(5)`.

- [ ] **Step 3: Run** `supabase db reset && pnpm db:test` → `0194_…ok`, full suite PASS.
- [ ] **Step 4: Commit** `git commit -m "feat(inventory): apply_level_delta helper + adjust_stock null-location allocation (mig 0194)"`

---

### Task 2: Verify picking/shipping/cancel inherit the allocator (tests only)

**Files:**
- Test: `supabase/tests/0194b_inherited_callers.test.sql` (no migration — behavior comes from Task 1)

**Interfaces:** Consumes Task 1's `adjust_stock`.

- [ ] **Step 1: Write pgTAP** that drives the REAL RPCs and asserts the invariant + placed-only enforcement:
  - Seed an order_request with a fulfilled line on an item whose stock is placed; call `complete_picking` → assert the placed level dropped, Σ=on_hand, and a pick of an item whose stock is ONLY in Staging raises `insufficient_placed_stock`.
  - Call `cancel_order_request` on a fulfilled order → assert the restored qty landed in Staging and Σ=on_hand.

```sql
-- supabase/tests/0194b_inherited_callers.test.sql
begin;
select plan(3);
-- Seed via the same fixture helpers used by the orders pgTAP suites; drive
-- complete_picking + cancel_order_request and assert:
--   1. complete_picking decremented a PLACED level (not Staging) and Sigma=on_hand
--   2. picking an item whose stock is only staged raises insufficient_placed_stock
--   3. cancel_order_request restored qty into Staging and Sigma=on_hand
-- (Full fixture omitted here; implementer builds it from the existing orders
--  test fixtures. If no reusable orders fixture exists, assert the invariant at
--  the apply_level_delta level for the two modes instead and NOTE the substitution.)
select pass('placeholder-replaced-by-implementer-1');
select pass('placeholder-replaced-by-implementer-2');
select pass('placeholder-replaced-by-implementer-3');
select * from finish();
rollback;
```

> Implementer: replace the three `pass()` placeholders with the real assertions above. This is the one task where the fixture depends on existing orders-test scaffolding you must locate; if it genuinely cannot be reused, fall back to asserting the two draw-down modes directly on `apply_level_delta` and clearly note why in your report. Do NOT ship `pass()` placeholders.

- [ ] **Step 2: Run** `supabase db reset && pnpm db:test`.
- [ ] **Step 3: Commit** `git commit -m "test(inventory): picking/shipping/cancel inherit placed-only allocation"`

---

### Task 3: `reverse_receipt` Staging-first

**Files:**
- Create: `supabase/migrations/0195_reverse_receipt_staging_first.sql`
- Test: `supabase/tests/0195_reverse_receipt_staging_first.test.sql`

**Interfaces:** Consumes `apply_level_delta(…, 'staging_first')`.

- [ ] **Step 1: Write the migration.** Base on the CURRENT `reverse_receipt` body in `supabase/migrations/0193_reverse_receipt_staging.sql` (security invoker, `search_path = public, extensions`). Task 1 added the optional `p_mode` param to `adjust_stock`, which makes this clean — exactly two deltas:
  - **Delete** the Phase-1 explicit-Staging resolution block (the `ensure_warehouse_placement_locations(v_orig.warehouse_id)` call + the `select id into v_staging …` and the `v_staging` declaration).
  - **Change** the per-line decrement call from `perform public.adjust_stock(v_line.item_id, -v_line.qty_accepted_base, 'correction', v_staging, 'receipt_reversal', v_rev.id::text);` to pass a **null** location and request **staging-first** draw-down:
    ```sql
    perform public.adjust_stock(
      v_line.item_id, -v_line.qty_accepted_base, 'correction',
      null, 'receipt_reversal', v_rev.id::text, 'staging_first');
    ```
  This reuses `adjust_stock`'s on-hand `< 0` guard + movement insert, and `apply_level_delta(..., 'staging_first')` drains Staging before placed — correct whether or not the received stock was already placed out (Phase 2b). Everything else in the 0193 body is unchanged.
- [ ] **Step 2: pgTAP** — receive N into Staging, then reverse: assert on_hand back to 0 AND Σlevels=0 (Staging drained). Then a second case: receive N, PLACE M of it to a rack (via `transfer_stock`), then reverse — assert on_hand=0 and Σlevels=0 (Staging M-N drained first, remainder from the rack).

```sql
-- supabase/tests/0195_reverse_receipt_staging_first.test.sql
begin;
select plan(2);
-- Case A: receive 5 -> Staging; reverse -> on_hand 0 AND Sigma 0.
-- Case B: receive 5; transfer_stock 3 Staging->rack; reverse -> on_hand 0 AND
--         Sigma 0 (staging-first drains the 2 staged, then 3 from the rack).
-- Build on the 0190/0193 receive fixture pattern.
select pass('replace-with-case-A');
select pass('replace-with-case-B');
select * from finish();
rollback;
```

> Implementer: replace the placeholders with the two real assertions; do not ship `pass()` placeholders.

- [ ] **Step 3: Run** `supabase db reset && pnpm db:test`.
- [ ] **Step 4: Commit** `git commit -m "fix(inventory): reverse_receipt drains Staging first then placed (mig 0195)"`

---

### Task 4: `post_cycle_count` maintains levels

**Files:**
- Create: `supabase/migrations/0196_cycle_count_levels.sql`
- Test: `supabase/tests/0196_cycle_count_levels.test.sql`

**Interfaces:** Consumes `apply_level_delta`.

- [ ] **Step 1: Write the migration.** Base on the CURRENT body in `supabase/migrations/0079_post_cycle_count_v2.sql` (security invoker, `search_path = public`). Keep EVERYTHING (snapshot variance, drift note, custom `stock_movements` insert, the `update … set quantity_on_hand = v_line.expected_quantity + v_diff`). Add ONE line immediately AFTER that `update public.inventory_items … quantity_on_hand = expected + v_diff …` statement, inside the loop:
  ```sql
  -- Keep the per-location breakdown in step with the on-hand change.
  perform public.apply_level_delta(v_line.item_id, v_diff, 'placed');
  ```
  (`v_diff` may be ±. Positive → Staging; negative → placed draw-down. The on-hand delta applied is exactly `v_diff` — `expected+v_diff` minus the pre-existing level sum which equals `expected` when reconciled — so Σlevels tracks on_hand. If a drift made live qty ≠ expected, the level sum may diverge by the drift amount; that is the SAME drift the function intentionally surfaces in the movement note, not a new bug. Document this in the test.)
- [ ] **Step 2: pgTAP** — seed an item placed=10 (rack), expected snapshot=10; counted=7 (v_diff=−3) → assert on_hand=7, rack=7, Σ=on_hand. Then counted=12 (v_diff=+2 from a fresh count) → assert the +2 landed in Staging and Σ=on_hand.

```sql
-- supabase/tests/0196_cycle_count_levels.test.sql
begin;
select plan(2);
-- Build a cycle_count + line with expected_quantity snapshot, set counted, post,
-- assert on_hand and Sigma-levels match, negative diff drew from placed, positive
-- diff landed in Staging. Use the cycle_count fixture shape from 0079's callers.
select pass('replace-neg-diff');
select pass('replace-pos-diff');
select * from finish();
rollback;
```

> Implementer: replace placeholders with real assertions; no `pass()` placeholders shipped.

- [ ] **Step 3: Run** `supabase db reset && pnpm db:test`.
- [ ] **Step 4: Commit** `git commit -m "feat(inventory): post_cycle_count maintains item_stock_levels (mig 0196)"`

---

### Task 5: `process_return_disposition` maintains levels (restock→Staging, scrap staging-first)

**Files:**
- Create: `supabase/migrations/0197_return_disposition_levels.sql`
- Test: `supabase/tests/0197_return_disposition_levels.test.sql`

**Interfaces:** Consumes `apply_level_delta`.

- [ ] **Step 1: Write the migration.** Base on the CURRENT body in `supabase/migrations/0154_returns_status_machine_db_guard.sql` (preserve the NET-ZERO scrap semantics, `returned_quantity` increment, guards, search_path). It does inline `update inventory_items set quantity_on_hand = v_new` + custom movements for: the `+qty 'return'` leg (restock OR the receive leg of scrap) and, for scrap, the `-qty 'loss'` write-off leg. Add helper calls so levels track:
  - After the `+qty 'return'` on-hand update + movement: `perform public.apply_level_delta(v_line.item_id, <the +qty>, 'staging');`  (returned unit lands in Staging).
  - After the scrap `-qty 'loss'` on-hand update + movement: `perform public.apply_level_delta(v_line.item_id, -<the qty>, 'staging_first');`  (writes off the unit that just landed in Staging — staging-first prevents stranding it).
  (Identify the exact variable names for the returned qty in the 0154 body and use them. The net effect for scrap: +Staging then −Staging = net 0 level change, matching the net-0 on-hand.)
- [ ] **Step 2: pgTAP** — RESTOCK return of qty R on an item: assert on_hand rose by R, the R landed in Staging, Σ=on_hand. SCRAP return of qty S: assert on_hand net unchanged, Σ=on_hand, and NO phantom Staging left (Staging delta net 0).

```sql
-- supabase/tests/0197_return_disposition_levels.test.sql
begin;
select plan(3);
-- RESTOCK: on_hand += R, Staging += R, Sigma = on_hand.
-- SCRAP: on_hand net 0, Sigma = on_hand, Staging net 0 (no stranded unit).
select pass('replace-restock-onhand-staging');
select pass('replace-scrap-netzero');
select pass('replace-sigma-invariant');
select * from finish();
rollback;
```

> Implementer: replace placeholders with real assertions; no `pass()` placeholders shipped.

- [ ] **Step 3: Run** `supabase db reset && pnpm db:test`.
- [ ] **Step 4: Commit** `git commit -m "feat(inventory): process_return_disposition maintains levels (restock->Staging, scrap staging-first) (mig 0197)"`

---

### Task 6: Bundle stock RPCs maintain levels (assemble_bundle / distribute_bundle — no disassemble RPC exists)

**Files:**
- Create: `supabase/migrations/0198_bundle_levels.sql`
- Test: `supabase/tests/0198_bundle_levels.test.sql`

**Interfaces:** Consumes `apply_level_delta`.

- [ ] **Step 1: Write the migration.** Base on the CURRENT bundle RPC bodies in `supabase/migrations/0101_bundle_rpc_tighten_to_manager.sql` — `assemble_bundle(p_bundle_id, p_quantity, p_warehouse_id, p_notes)` and `distribute_bundle(p_bundle_id, p_quantity, p_warehouse_id, p_allow_shortage, …)`. **There is NO `disassemble_bundle` RPC — do not create one.** Both RPCs `update inventory_items set quantity_on_hand = v_new` inline for each component and/or the phantom/bundle item. Add one `apply_level_delta` call mirroring EACH existing on-hand `update`, by sign:
  - Any **consume** (`quantity_on_hand` decreases, e.g. component `-v_needed`): `perform public.apply_level_delta(<that item id>, -<amount>, 'placed');` (blocks with `insufficient_placed_stock` if the component isn't placed — consistent with picking).
  - Any **produce** (`quantity_on_hand` increases, e.g. phantom/bundle `+qty`): `perform public.apply_level_delta(<that item id>, +<amount>, 'staging');`
  Use the exact variable names from the 0101 bodies (`v_component.ii_id`, `v_needed`, the phantom qty, etc.). One helper call per on-hand `update`; the sign of the helper's qty matches the on-hand change so `Σlevels = on_hand` holds. `assemble_bundle` requires `bundles.preassembly_enabled = true`.
- [ ] **Step 2: pgTAP** — assemble 1 bundle from 2 components (each placed): assert each component's placed level dropped, the bundle's +1 landed in Staging, Σ=on_hand for all three. Assemble blocked when a component is only staged → `insufficient_placed_stock`.

```sql
-- supabase/tests/0198_bundle_levels.test.sql
begin;
select plan(3);
-- assemble: components decrement from placed, bundle output -> Staging, Sigma=on_hand each.
-- assemble with an only-staged component raises insufficient_placed_stock.
select pass('replace-assemble-levels');
select pass('replace-assemble-blocked');
select pass('replace-sigma');
select * from finish();
rollback;
```

> Implementer: replace placeholders with real assertions; no `pass()` placeholders shipped.

- [ ] **Step 3: Run** `supabase db reset && pnpm db:test`.
- [ ] **Step 4: Commit** `git commit -m "feat(inventory): bundle assemble/disassemble maintain levels (mig 0198)"`

---

### Task 7: Seed an initial `item_stock_levels` row on item creation (DISCOVERED during execution)

**Why (discovered, Critical):** `InventoryService.create()` / `createVariants` / bulk-create + the Sage/CSV/books imports all set `quantity_on_hand` directly + write an `'initial'` `stock_movements` row but DO NOT seed an `item_stock_levels` row. Post-Phase-2a, a newly-created stocked item has `Σlevels=0 < on_hand`, so its first pick/ship/reverse raises `insufficient_placed_stock` (un-pickable). The Phase 1 backfill only covered items existing at backfill time. A single `AFTER INSERT` trigger fixes ALL create/import paths (current + future + direct SQL) in one place — the user's earlier anti-trigger choice was about the MUTATOR allocation (ambiguous source); at creation the intent is unambiguous, so a trigger is the robust catch-all here.

**Destination:** initial stock is "loading existing/known inventory" (like the Phase 1 backfill), so it lands **pickable** — at the item's `primary_location_id` if that's a real non-staging location, else the warehouse **Unplaced** (else an org-level Unplaced bucket). NOT Staging.

**Files:**
- Create: `supabase/migrations/0199_seed_initial_level.sql`
- Test: `supabase/tests/0199_seed_initial_level.test.sql`

**Interfaces:** Consumes `ensure_warehouse_placement_locations`, `apply_level_delta` semantics (kinds). Produces: every `inventory_items` INSERT with `quantity_on_hand > 0` gets a matching `item_stock_levels` row so `Σlevels = quantity_on_hand` from creation.

- [ ] **Step 1: Write the migration**

```sql
-- 0199_seed_initial_level.sql
-- Phase 2a make item_stock_levels authoritative from item CREATION: the create
-- /import paths set quantity_on_hand directly without seeding a level, which
-- (post-2a) would make a new stocked item un-pickable (Σlevels=0<on_hand ->
-- insufficient_placed_stock on first decrement). An AFTER INSERT trigger seeds
-- the initial level for ALL create paths in one place. Destination = primary
-- location (if a real non-staging loc) else warehouse Unplaced else org Unplaced
-- -- pickable, mirroring the Phase 1 backfill's treatment of existing stock.

create or replace function public.tg_seed_initial_level()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_loc uuid;
begin
  if coalesce(new.quantity_on_hand, 0) <= 0 then return new; end if;

  -- Prefer the item's primary location if it's a real, non-staging placed bin.
  if new.primary_location_id is not null then
    select id into v_loc from public.locations
      where id = new.primary_location_id and deleted_at is null
        and kind is distinct from 'staging'
      limit 1;
  end if;

  -- Else the warehouse Unplaced location (create placement locs if needed).
  if v_loc is null and new.warehouse_id is not null then
    perform public.ensure_warehouse_placement_locations(new.warehouse_id);
    select id into v_loc from public.locations
      where warehouse_id = new.warehouse_id and kind = 'unplaced' and deleted_at is null
      limit 1;
  end if;

  -- Else an org-level Unplaced bucket (no warehouse), created on demand.
  if v_loc is null then
    select id into v_loc from public.locations
      where organization_id = new.organization_id and warehouse_id is null
        and kind = 'unplaced' and deleted_at is null
      limit 1;
    if v_loc is null then
      insert into public.locations(organization_id, name, type, kind)
      values (new.organization_id, 'Unplaced', 'other', 'unplaced')
      returning id into v_loc;
    end if;
  end if;

  insert into public.item_stock_levels(organization_id, item_id, location_id, quantity)
  values (new.organization_id, new.id, v_loc, new.quantity_on_hand)
  on conflict (item_id, location_id) do update
    set quantity = public.item_stock_levels.quantity + excluded.quantity,
        updated_at = now();

  return new;
exception
  when others then
    -- Never block item creation on a seeding hiccup (mirror the 0188 trigger).
    raise warning 'seed initial level failed for item %: %', new.id, sqlerrm;
    return new;
end;
$$;

drop trigger if exists trg_seed_initial_level on public.inventory_items;
create trigger trg_seed_initial_level
  after insert on public.inventory_items
  for each row execute function public.tg_seed_initial_level();
```

- [ ] **Step 2: Write the pgTAP test** (`supabase/tests/0199_seed_initial_level.test.sql`)

Assertions (wrap begin/plan/finish/rollback; org + warehouse + a rack location seeded; the warehouse-insert trigger from 0188 auto-creates Staging/Unplaced):
1. Insert an item with `quantity_on_hand=12` and `primary_location_id` = the rack → the rack's `item_stock_levels` level = 12, and `Σ levels = quantity_on_hand`.
2. Insert an item with `quantity_on_hand=5` and `primary_location_id = null` (but `warehouse_id` set) → the warehouse Unplaced level = 5, `Σ = on_hand`. (NOT Staging — assert the staging level is 0/absent.)
3. Insert an item with `quantity_on_hand=0` → no `item_stock_levels` row created (and trivially `Σ = on_hand = 0`).
(These inserts can run as the table-owner/superuser test role since the trigger is SECURITY DEFINER; no app auth needed, but match the existing suites' transaction style.)

- [ ] **Step 3: Run** `supabase db reset && pnpm db:test` → `0199_… ok` + full suite PASS.
- [ ] **Step 4: Commit** `git commit -m "feat(inventory): seed initial item_stock_levels on item creation (mig 0199)"`

---

## Final gate (after all tasks)
- [ ] `supabase db reset && pnpm db:test` green (all new suites).
- [ ] `pnpm --filter @stockpilot/web exec tsc --noEmit` clean; `pnpm --filter @stockpilot/web test` green (surface `insufficient_placed_stock` as a friendly error in the picking/shipping/adjust UIs — add the mapping + a unit test if a service-layer error map exists).
- [ ] **Second multi-lens adversarial review** (this rewires picking/shipping/returns/cycle/bundles — money/stock surfaces): regression vs each shipped RPC, the two draw-down modes, the scrap net-zero, RLS/tenancy on the helper, and a global `Σlevels=on_hand` invariant sweep.
- [ ] Apply to prod `supabase db push --linked` (0194–0198); re-verify `Σlevels=on_hand` and spot-check receive→place→pick→reverse + a return + a cycle count.

## Self-review
**Spec coverage:** §3 decision 1 (authoritative) → Tasks 1,4,5,6 + inherited 2; decision 2 (placed-only block) → Task 1 helper + Task 2; decision 3 (increments→Staging) → Task 1 + 4/5/6; decision 4 (centralize) → Task 1 helper. §4.3 reverse_receipt → Task 3. §4.4 bypassers → Tasks 4,5 (+ bundles Task 6, a discovered addition). §8 testing → per-task pgTAP + final gate.
**Placeholder scan:** Tasks 2/3/4/5/6 ship pgTAP with `pass()` placeholders the IMPLEMENTER must replace with the described real assertions — this is called out explicitly per task with the exact assertions to write, and is a deliberate "build the fixture from existing scaffolding" instruction, NOT a silent TODO. Task 1 + the helper carry complete code. The reviewer must reject any task that ships `pass()` placeholders.
**Type consistency:** `apply_level_delta(uuid, numeric, text)` signature is identical across Tasks 1,3,4,5,6. The `adjust_stock` optional `p_mode` (if the recommended Task 3 route is taken) must be added in Task 1 and used in Task 3 — flagged in both.

## Execution Handoff
1. **Subagent-Driven (recommended)** — fresh subagent per task + two-stage review, then the final adversarial review.
2. **Inline Execution** — batch with checkpoints.
