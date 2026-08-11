-- 0331_ar2_warehouse_scope_item_stock_levels.sql
-- ============================================================================
-- AR-2 closure: item_stock_levels gets the warehouse-scoped SELECT its sibling
-- tables received in wave C (0322's purchase_orders_select shape), and the one
-- remaining caller-scoped reader of the table — apply_level_delta — becomes
-- SECURITY DEFINER first, in the same change, so every stock RPC behaves
-- byte-identically for every caller before and after the narrowing. DB-only:
-- zero app-code edits.
--
-- 0322 s.4 refused this narrowing and recorded the prerequisite: "make the Σ
-- and the draw-down selection independent of the caller's read scope". 0327
-- met half of it (post_cycle_count's Σ now flows through the SECURITY DEFINER
-- _cycle_count_org_stock_sum) and deliberately left apply_level_delta
-- caller-scoped. This migration completes the prerequisite and performs the
-- narrowing, in dependency order inside one transaction.
--
-- PRODUCTION FACTS (queried 2026-08-11): item_stock_levels holds 573 rows,
-- location_id is NOT NULL with zero null-location rows, and 20 rows sit in
-- locations whose warehouse_id IS NULL — those must stay org-visible via the
-- null-warehouse disjunct (the "DC4 shape": locations.kind IS NULL Sites are
-- never given a kind, and apply_level_delta's own warehouseless branch
-- allocates into org-level, warehouse-less locations on purpose). ZERO
-- staff-role members exist in any org; the warehouse-scoped population is
-- L4L's viewers, who hold exactly 1 of 2 warehouses.
--
-- ── CALLER-SCOPED READER SWEEP (why apply_level_delta is the only function
--    that must be privileged) ────────────────────────────────────────────────
-- Every persistent function whose body touches item_stock_levels, latest
-- definition wins (grep of all migrations, 0331 audit):
--
--   * apply_level_delta (0292)        — SECURITY INVOKER, two SELECT loops
--     over the table (staging_first pre-pass + placed draw-down). A hidden
--     row makes the draw skip real stock and raise insufficient_placed_stock
--     on a legitimate pick. PRIVILEGED BELOW.
--   * _cycle_count_org_stock_sum (0327) — already SECURITY DEFINER with its
--     own manager gate; the Σ is complete regardless of caller. Untouched.
--   * post_cycle_count (0327)         — SECURITY INVOKER, but its only read
--     of the table flows through _cycle_count_org_stock_sum (wiring pinned by
--     0327's test). Untouched.
--   * adjust_stock (0327)             — SECURITY INVOKER; touches the table
--     only via a guarded INSERT ... ON CONFLICT DO UPDATE and the 0327
--     conditional draw ("update public.item_stock_levels ... where item_id =
--     p_item_id and location_id = p_location_id and quantity +
--     p_quantity_change >= 0"). No SELECT of the table. Row visibility for
--     those writes is governed by item_stock_levels_write (FOR ALL, staff
--     floor — 0202), which this migration does NOT touch. Untouched.
--   * transfer_stock (0327)           — SECURITY INVOKER; same class: a
--     source-seed INSERT ... ON CONFLICT DO NOTHING, the conditional draw
--     ("update public.item_stock_levels ... where item_id = p_item_id and
--     location_id = p_from_location_id and quantity >= p_quantity") and the
--     destination upsert. No SELECT of the table. Untouched.
--   * process_return_disposition (0197) — already SECURITY DEFINER; writes
--     the table only via apply_level_delta. Untouched.
--   * post_receipt_v2 (0190), reverse_receipt (0195), assemble_bundle /
--     distribute_bundle (0198) — SECURITY INVOKER, manager-gated; touch the
--     table only via apply_level_delta. Untouched.
--   * 0031 / 0192 / 0200 / 0270       — one-time migration DML, ran as the
--     migration superuser; not persistent functions.
--
-- NOTE on the conditional-write paths (adjust_stock / transfer_stock): a
-- PostgreSQL UPDATE that reads existing column values (both draws read
-- `quantity` in SET and WHERE) requires the row to pass a SELECT-applicable
-- policy IN ADDITION to an UPDATE-applicable one. item_stock_levels_write is
-- FOR ALL with USING (has_org_role staff), FOR ALL policies apply to SELECT
-- too, and permissive policies OR together — so every staff+ caller keeps
-- org-wide row visibility for those writes (and, inescapably, for plain
-- SELECT) through the write policy, exactly as today. The narrowing below
-- therefore bites precisely the population it is aimed at: read-only members
-- (viewers) below the write floor. This is inherent to the table's write
-- floor being staff; the sibling tables' write floors are manager, which is
-- why their staff CAN be read-narrowed. Documented, deliberate, and pinned in
-- this migration's test.
--
-- ── CHARTER-BLIND BY DESIGN ─────────────────────────────────────────────────
-- my_warehouse_ids() ignores user_warehouse_assignments.charter_id, so a
-- charter-scoped viewer sees ALL holdings quantities at their warehouse even
-- where the item rows themselves are charter-narrowed. That matches 0322's
-- prescription for this table and leaks only anonymous quantities (a
-- location id and a number — the item row it hangs off may itself be
-- invisible to them).
-- ============================================================================


-- ═══════════════════════════════════════════════════════════════════════════
-- 1) apply_level_delta becomes SECURITY DEFINER with an internal org gate.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Body is a byte-for-byte copy of 0292 (the latest definition — 0194 is
-- superseded; 0327 deliberately left this function alone) with exactly TWO
-- deltas: `security invoker` -> `security definer`, and the authorization
-- gate inserted immediately after the org derivation. Everything else —
-- the increment branch, the staging_first pre-pass, the placed draw-down,
-- every predicate 0292 documents — is unchanged.
--
-- WHY DEFINER: the draw-down loops SELECT the holdings they will consume.
-- Under SECURITY INVOKER that read runs inside the caller's RLS, so a holding
-- hidden from the caller is skipped and a legitimate pick dies with
-- insufficient_placed_stock — the exact 0292 failure class, reintroduced by
-- policy instead of by predicate. DEFINER makes the selection complete
-- regardless of who is asking, which is the 0322 s.4 prerequisite for the
-- policy change in section 3.
--
-- THE GATE (house style: _cycle_count_org_stock_sum, 0327 — secdef + pinned
-- search_path + internal self-authorization + revoke anon):
--   * privileged callers — when auth.uid() IS NULL the connection has no JWT
--     subject. After section 2, PUBLIC and anon hold no EXECUTE, and every
--     authenticated PostgREST request carries a sub claim, so a null subject
--     here means service_role / postgres / supabase_admin (the 0309
--     allowlist). current_user itself cannot be consulted: inside a SECURITY
--     DEFINER body it reports the function OWNER, not the session. The null
--     subject, backed by the grant surface, IS the service detection.
--   * user callers — must pass has_org_role(v_org, 'staff'), where v_org is
--     derived from the TARGET ITEM's row (the signature carries no org id to
--     trust or distrust). has_org_role (0310) already folds in every
--     membership guard: accepted_at not null, unexpired impersonation, and
--     not disabled (user_profiles.disabled_at). The STAFF floor is chosen to
--     make definer status grant nothing new: it equals the write floor the
--     invoker version hit at its INSERT/UPDATE sites
--     (item_stock_levels_write, 0202), and every SQL caller already gates at
--     staff (adjust_stock) or manager (post_receipt_v2, reverse_receipt,
--     post_cycle_count, assemble_bundle, distribute_bundle,
--     process_return_disposition) — so no legitimate path changes behavior.
--     The outer RPCs own the fine-grained permission checks; this gate exists
--     so definer status cannot be reached cross-org or from below the write
--     floor.
--
-- WHY NO WRITE CAN TOUCH ANOTHER ORG'S ROWS FOR AN IN-ORG CALLER: the
-- signature is (p_item_id, p_qty, p_mode) — no org id, no location id. Every
-- statement in the body is keyed to the target item: the level upsert and
-- both draw-down UPDATEs filter on `item_id = p_item_id`, and the location
-- lookups derive from v_org / v_wh, which are read off the item's own row.
-- An authorized caller can therefore only ever move quantities between
-- holdings OF THAT ITEM, inside the org the gate just verified them against.
--
-- Direct-call behavior change (no app path does this — apply_level_delta is
-- called only from SQL RPC bodies): a below-staff org member invoking it via
-- PostgREST used to fail downstream on write RLS (increment) or raise
-- insufficient_placed_stock after a zero-row draw (decrement) — no write ever
-- committed. They now get a crisp 42501 'forbidden' up front. Outsiders and
-- anon: anon loses EXECUTE outright (section 2); an authenticated outsider
-- gets 42501 where they previously got the same downstream failures.

create or replace function public.apply_level_delta(
  p_item_id uuid,
  p_qty     numeric,
  p_mode    text default 'placed'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org    uuid;
  v_wh     uuid;
  v_loc    uuid;
  v_need   numeric;
  v_take   numeric;
  v_lvl    record;
begin
  if p_qty = 0 or p_qty is null then return; end if;
  select organization_id, warehouse_id into v_org, v_wh
    from public.inventory_items where id = p_item_id;
  if v_org is null then return; end if;

  -- *** 0331 authorization gate — see header. auth.uid() IS NULL means a
  -- service_role/postgres connection (anon and PUBLIC hold no EXECUTE; every
  -- authenticated request carries a sub claim). Everyone else must be an
  -- accepted, non-disabled, unexpired staff+ member of the org that OWNS the
  -- item (v_org comes from the item row above, never from the caller). ***
  if auth.uid() is not null then
    if not public.has_org_role(v_org, 'staff') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  -- ---- INCREMENT: land in Staging ----------------------------------------
  if p_qty > 0 then
    if v_wh is not null then
      perform public.ensure_warehouse_placement_locations(v_wh);
      -- `kind = 'staging'` is a positive match on THE staging bucket; NULL-kind
      -- rows are correctly not selected (they are placed bins, not Staging).
      select id into v_loc from public.locations
        where warehouse_id = v_wh and kind = 'staging' and deleted_at is null limit 1;
    else
      -- Use SECURITY DEFINER helper to bypass locations_insert RLS (requires manager)
      -- so staff-role positive adjustments on warehouseless items also succeed.
      perform public.ensure_org_placement_locations(v_org);
      select id into v_loc from public.locations
        where organization_id = v_org and warehouse_id is null
          and kind = 'staging' and deleted_at is null limit 1;
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
  -- `l.kind = 'staging'` again matches Staging ONLY. NULL-kind stock is placed
  -- stock and is intentionally left to the placed loop below.
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
  -- IS DISTINCT FROM, not <>: locations.kind is nullable and `NULL <> 'staging'`
  -- is NULL, which silently excluded every NULL-kind location and made the stock
  -- sitting in it unpickable (see 0292's header).
  -- The ORDER BY leaves NULL-kind rows in the `else 0` group, so real bins
  -- (including NULL-kind ones) are still visited before Unplaced.
  for v_lvl in
    select s.location_id, s.quantity
      from public.item_stock_levels s
      join public.locations l on l.id = s.location_id
     where s.item_id = p_item_id and s.quantity > 0 and l.kind is distinct from 'staging'
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

comment on function public.apply_level_delta(uuid, numeric, text) is
  'Shared item_stock_levels maintenance tail of adjust_stock, post_receipt_v2, reverse_receipt, post_cycle_count, assemble/distribute_bundle and process_return_disposition. SECURITY DEFINER since 0331 so its draw-down selection is complete regardless of the caller''s read scope (the 0322 s.4 prerequisite for warehouse-narrowing item_stock_levels_select); self-authorizes at the item''s org with the staff floor the write policy already enforced, and allows null-subject (service_role/postgres) connections — anon holds no EXECUTE. All writes are keyed to the target item, so an authorized caller can only touch that item''s holdings in that org.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2) Grant hygiene — close the anon over-grant on apply_level_delta.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0318/0322 posture: Postgres default-grants EXECUTE TO PUBLIC on every new
-- function, and this project's default privileges add a direct anon grant, so
-- BOTH must be named to close them (verified live 2026-08-11: anon held
-- EXECUTE). authenticated keeps EXECUTE because every calling RPC
-- (adjust_stock, post_cycle_count, the bundle pair, reverse_receipt,
-- post_receipt_v2) is SECURITY INVOKER and reaches this function as the
-- querying user; the function now self-authorizes, so the grant is safe.

revoke execute on function public.apply_level_delta(uuid, numeric, text) from public, anon;
grant  execute on function public.apply_level_delta(uuid, numeric, text) to authenticated;
grant  execute on function public.apply_level_delta(uuid, numeric, text) to service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3) item_stock_levels_select — the 0322 purchase_orders_select shape,
--    adapted via the holding's location.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Differences from purchase_orders_select, and why:
--   * no permission conjunct — there is no items:read-style configurable
--     permission gating this table's surfaces; org membership is the floor
--     the app enforces, exactly as 0140 had it.
--   * no `location_id is null` disjunct — the column is NOT NULL (0002), and
--     production holds zero null-location rows (verified 2026-08-11).
--   * the null-WAREHOUSE disjunct is load-bearing: 20 production rows sit in
--     locations with warehouse_id IS NULL (org-level Sites — the DC4 shape —
--     and apply_level_delta's own warehouseless Staging/Unplaced buckets).
--     They are not warehouse-scopable, so they stay visible to every member,
--     which is exactly their behavior today for an all-access caller.
--
-- COST (0322's initplan discipline, followed exactly): both helper calls are
-- wrapped in scalar subselects so they run as initplans, the privileged
-- disjunct short-circuits the OR for manager+, and my_warehouse_ids() takes
-- no argument so its IN-subquery is uncorrelated and hash-materialized ONCE
-- per statement (the 0229 posture). Warehouse-scoped members pay one PK probe
-- on locations per row. The heaviest reader of this table
-- (server/loaders/inventory-list.ts) uses createAdminClient() and never
-- meets this policy; 0310's 500k-row initplan measurements were taken against
-- policies of this same wrapped shape.
--
-- Conjunct count: 1 -> 2. The WRITE policy (item_stock_levels_write, 0202) is
-- NOT touched — and because it is FOR ALL with a staff USING clause, staff+
-- keep org-wide visibility for both their conditional RPC writes and plain
-- SELECT (permissive policies OR; see header). The narrowing bites read-only
-- members: a viewer sees only holdings whose location sits in one of their
-- assigned warehouses, plus the unscopable null-warehouse holdings.
--
-- Charter-blind by design: my_warehouse_ids() ignores charter scoping, so a
-- charter-scoped viewer sees all holdings quantities at their warehouse even
-- where item rows are charter-narrowed (0322's prescription; anonymous
-- quantities only).

drop policy if exists item_stock_levels_select on public.item_stock_levels;
create policy item_stock_levels_select on public.item_stock_levels
  for select to authenticated
  using (
    -- CONJUNCT 1 of 2 — RESTATED VERBATIM from 0140. The entire previous
    -- policy. Carries the accepted-membership, unexpired-impersonation (0177)
    -- and not-disabled (0310) guards, so nothing below repeats them.
    ( select public.is_org_member(item_stock_levels.organization_id) )

    -- CONJUNCT 2 of 2 — NEW (AR-2). Warehouse scope for warehouse-scoped
    -- members only.
    and (
      -- (a) All-access roles: owner + admin + manager (has_org_role is a rank
      --     floor) — getWarehouseAccess()'s hasAllAccess set. Unnarrowed.
      ( select public.has_org_role(item_stock_levels.organization_id, 'manager') )

      -- (b) The holding's location must live in one of the caller's
      --     warehouses — or be an org-level location with no warehouse, which
      --     is unscopable and stays visible (the DC4 shape; 20 prod rows).
      --     `l.id` and `item_stock_levels.location_id` are both qualified
      --     (pattern #25). my_warehouse_ids() (0310) is the DB twin of
      --     getWarehouseAccess(): manager+ resolve to every warehouse in the
      --     org, staff/viewer to their user_warehouse_assignments rows (0280
      --     materializes "all warehouses" as one row per warehouse).
      or exists (
        select 1
        from public.locations l
        where l.id = item_stock_levels.location_id
          and (
            l.warehouse_id is null
            or l.warehouse_id in (select mw.warehouse_id from public.my_warehouse_ids() mw)
          )
      )
    )
  );

comment on table public.item_stock_levels is
  'SELECT (0331) requires org membership AND either manager+ or the holding''s location living in one of the caller''s warehouses; holdings in warehouse-less locations are unscopable and stay member-visible. The FOR ALL write policy (0202, staff floor) is untouched and ORs into SELECT visibility for staff+, so the narrowing bites read-only members. Holdings are charter-blind by design (my_warehouse_ids ignores charter scoping). Safe to narrow since 0327 (+0331): post_cycle_count''s Σ and apply_level_delta''s draw-down are both SECURITY DEFINER and immune to the caller''s read scope.';
