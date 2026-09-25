-- 0373_draw_provenance.sql
-- ============================================================================
-- Draw provenance: record which holdings every null-location stock change
-- took from (or landed in). DB-only. No data migration, no backfill, and no
-- change to which holdings are drawn.
--
-- ── THE PROBLEM ─────────────────────────────────────────────────────────────
-- A stock change with no location (phone quick +/-, a web manual removal in
-- 'any' mode, the AI adjust tool, restore reconcile, complete_picking,
-- reverse_receipt, the cancel restock, the bundle RPCs, return restock and
-- scrap) goes through public.apply_level_delta, which picks the holdings
-- itself by mode (racks / crates / areas / Sites by location age with
-- Unplaced last; Staging before them for staging_first, after them for
-- 'any'), in ANY warehouse of the org. The stock_movements row it pairs
-- with keeps from_location_id and to_location_id NULL, so nobody can
-- tell afterwards which holdings a draw consumed. The 0371 probe showed a
-- warehouse-one staff member draining a warehouse-two rack from 5 to 2 with
-- no trace. The owner's order (2026-09-25): record it first; decide the
-- warehouse scoping rule afterwards, with the data.
--
-- ── WHAT THIS MIGRATION DOES ────────────────────────────────────────────────
--   1. public.stock_movement_holdings: one row per holding a movement's draw
--      took from (quantity < 0) or its increment landed in (quantity > 0,
--      always a Staging location), in draw order (seq), with draw-time
--      snapshots: the location's kind and warehouse, the item's warehouse,
--      the mode as passed, and the drawer's scope (service / manager /
--      in_scope / out_of_scope, from caller_can_write_location). Warehouse
--      assignments change, so the scope cannot be rebuilt later.
--   2. ledger.apply_level_delta_for(movement_id, item, qty, mode): the ONE
--      draw engine. SECURITY DEFINER. Its body is the 0359 body of
--      public.apply_level_delta VERBATIM plus exactly eight added lines, each
--      ending in '-- 0373': three array declarations, one append per draw
--      loop, one record call in the increment branch and one after the final
--      insufficient_placed_stock check. Recording therefore happens only
--      after every draw succeeded, and a failed draw records nothing.
--   3. ledger._record_holdings: the only writer of the table. SECURITY
--      INVOKER and not executable by any API role: it runs only as the
--      engine's owner. A NULL movement id records nothing. It records each
--      share as its numeric(14,4) holding moved and skips a share that
--      rounds to zero, so a quantity with more than four decimals (which
--      adjust_stock and the API accept) records the truth and never trips
--      the table's CHECK (review, 2026-09-25). The drawer's scope is worked
--      out once per call: service or manager for the whole call, else one
--      caller_can_write_location per distinct (organization, warehouse) of
--      the holdings touched, never one per row (perf review, 2026-09-25).
--   4. public.apply_level_delta keeps its signature, default, SECURITY
--      DEFINER, search_path, ACL and comment. It keeps its own gate verbatim
--      and then calls the engine with a NULL movement id, so it moves
--      holdings exactly as before and records nothing. Its only remaining
--      caller is ledger.post_cycle_count (security_invariants INV-37).
--   5. ledger.adjust_stock, ledger.distribute_bundle, ledger.assemble_bundle
--      and ledger.process_return_disposition are restated from their LIVE
--      text (pg_get_functiondef at the pre-0373 head; distribute_bundle
--      carries 0367's 55000). Each generates the movement id itself
--      (v_mv_id := gen_random_uuid()), passes it to the engine, and inserts
--      its stock_movements row with that id. The only removed lines are the
--      `perform public.apply_level_delta(...)` calls, each replaced in place.
--
-- ── WHY THE ID IS PASSED EXPLICITLY ─────────────────────────────────────────
-- Three of the four callers draw BEFORE they insert their movement row, so
-- the engine cannot look the movement up. The alternative (a
-- transaction-local slot that a trigger on stock_movements pairs with the
-- next insert) can attach draws to the wrong movement with no error when two
-- ledger calls share a transaction: an insert-first writer leaves the slot
-- open and the next draw-first adjust writes onto it. An explicit id cannot
-- be paired wrongly by composition, and INV-38 checks the code shape in CI.
-- process_return_disposition mints one id per leg, so a restock landing can
-- never be attributed to the scrap row.
--
-- ── THE TAGGED-LINE RULE ────────────────────────────────────────────────────
-- Every line this migration adds to an existing body ends with '-- 0373'.
-- Removing those lines (regexp '\n[^\n]*-- 0373[^\n]*') gives back:
--   * for the engine: the 0359 apply_level_delta prosrc exactly (md5
--     4be0f94c4390e7cd9c15a73e629133bf);
--   * for each caller: its pre-0373 prosrc with only the
--     `perform public.apply_level_delta(` lines removed.
-- The post-check at the end of this file and pgTAP 0373 (P1-P6) both prove
-- it. Draw order, mode handling, locking, error codes and messages are
-- therefore byte-for-byte what 0359/0371 shipped.
--
-- ── THE DEFERRED FOREIGN KEY (a first in this repo) ─────────────────────────
-- stock_movement_holdings(movement_id, organization_id, item_id) references
-- stock_movements(id, organization_id, item_id), DEFERRABLE INITIALLY
-- DEFERRED, ON DELETE CASCADE. Deferred because the draw-first callers write
-- the holdings rows before the movement row exists; the check runs at
-- COMMIT. Composite so a row can never name another item's or another org's
-- movement (the 0201-0206 FK-org-consistency class); it needs the new unique
-- index stock_movements_id_org_item_key. A path that records for an id it
-- never inserts fails the whole stock operation at COMMIT with 23503.
-- RUNBOOK if that ever happens in production:
--   alter table public.stock_movement_holdings
--     drop constraint stock_movement_holdings_movement_fk;
-- restores availability at once (recording continues, unchecked); then find
-- the path with the coverage query in the PR and fix it.
--
-- ── WHO CAN SEE THE ROWS ────────────────────────────────────────────────────
-- SELECT for authenticated mirrors the parent: an org-member prefilter plus
-- EXISTS on stock_movements, which runs under stock_movements_select (0321).
-- A row is visible exactly when its movement is, for every persona. A
-- warehouse-scoped member can therefore see that a movement of an item in
-- their warehouse drew from a location in another warehouse; the location
-- itself is org-readable already, as 0371's item_holdings_elsewhere says.
-- No API role holds any write privilege (service_role included), there is
-- no write policy, and the table is not in the realtime publication.
--
-- ── NOT COVERED (deliberately) ──────────────────────────────────────────────
-- * ledger.post_cycle_count's residual draw (after the counted-rack share)
--   still calls public.apply_level_delta, which records nothing. It is
--   frozen for F1; pgTAP 0373 D29-D30 pin the gap so it flips on purpose.
-- * apply_cycle_count_location_delta, and every explicit-location path
--   (ledger.apply_holding_delta via adjust_stock / transfer_stock,
--   reopen_picking, rack write-off): their one holding is already exact in
--   from_location_id / to_location_id. Readers treat an empty provenance set
--   as "use from/to".
-- * Movements written outside the ledger (opening stock, imports,
--   duplicate_inventory_item, direct inserts).
-- * stock_movements.from_location_id stays NULL on the null-location paths.
-- * History starts at this push. Holdings keep no per-draw history, so a
--   backfill would be invented.
-- * Ties in the draw order (equal location created_at, equal Staging
--   quantities) stay undefined, exactly as before; the scoping migration
--   decides a tie-breaker.
--
-- ── ERROR CODES ─────────────────────────────────────────────────────────────
-- No new runtime SQLSTATE. The engine raises what apply_level_delta raised:
-- 42501 forbidden / ledger_only (user callers), P0001
-- insufficient_placed_stock. The recorder raises nothing by design; its
-- CHECK and FK constraints fail loudly (23514 / 23503) only on a bug. This
-- file raises 55000 at push time if a body it restates has drifted from the
-- text it was built from, if 0373 is already applied, if authenticated
-- cannot INSERT stock_movements.id, or if a post-check fails, and fails
-- with 55P03 when it cannot take its two table locks (PROD PUSH NOTE).
-- Never 40001/40P01 (0367).
--
-- ── PROD PUSH NOTE ──────────────────────────────────────────────────────────
-- The push holds SHARE ROW EXCLUSIVE on stock_movements and locations from
-- the lock prelude (after the preflight) to COMMIT, so movement inserts and
-- location writes wait for the index build and the rest of this file. The
-- prelude waits for stock_movements holding nothing, then takes locations
-- NOWAIT, so the push never waits while holding a lock a stock write needs:
-- no deadlock (40P01) either way round. Without it, a null-location +1 that
-- started during the index build deadlocked with the FK step (review,
-- 2026-09-25; scripts/db-concurrency/0373_push_lock_order.sh). The push
-- fails fast with 55P03 (lock_timeout on stock_movements, or NOWAIT on
-- locations while a write holds it); retry is the remedy (the 0370/0371
-- pattern). Push off-peak.
-- ============================================================================

-- PLAIN `set`, not `set local` (0303/0358/0370/0371): the CLI batch is atomic
-- but is not a transaction block. Reset at the end.
set lock_timeout = '5s';


-- ═══════════════════════════════════════════════════════════════════════════
-- 0) Preflight: refuse (55000) unless every body this file restates is the
--    exact text it was built from.
-- ═══════════════════════════════════════════════════════════════════════════
-- md5(prosrc) at the pre-0373 head (local, PG 17.6.1.166, 2026-09-25;
-- re-derived at 0372 after the rebase onto F1-2: unchanged, 0372 restates
-- none of these bodies):
--   public.apply_level_delta             4be0f94c4390e7cd9c15a73e629133bf (0359)
--   ledger.adjust_stock                  5ac1ac45313bb352e2ff5c015aa18cd3 (0371)
--   ledger.distribute_bundle             489959c7ad7fdc9cc153c6326e503dc5 (0365+0367)
--   ledger.assemble_bundle               8e9893d5666762e238bd354cc85bdbd1 (0365)
--   ledger.process_return_disposition    d16d045bafacef106377a2767c972704 (0197/0359)
do $pre$
declare
  r record;
  v_have text;
begin
  if to_regclass('public.stock_movement_holdings') is not null
     or to_regclass('public.stock_movements_id_org_item_key') is not null
     or to_regprocedure('ledger.apply_level_delta_for(uuid,uuid,numeric,text)') is not null
     or to_regprocedure('ledger._record_holdings(uuid,uuid,uuid,uuid,uuid[],numeric[],text[],text)') is not null then
    raise exception '0373 already applied (an object it creates exists)' using errcode = '55000';
  end if;

  for r in
    select * from (values
      ('public.apply_level_delta(uuid,numeric,text)',                            '4be0f94c4390e7cd9c15a73e629133bf'),
      ('ledger.adjust_stock(uuid,numeric,text,uuid,text,text,text)',             '5ac1ac45313bb352e2ff5c015aa18cd3'),
      ('ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)',     '489959c7ad7fdc9cc153c6326e503dc5'),
      ('ledger.assemble_bundle(uuid,numeric,uuid,text)',                         '8e9893d5666762e238bd354cc85bdbd1'),
      ('ledger.process_return_disposition(uuid)',                                'd16d045bafacef106377a2767c972704')
    ) v(fn, want)
  loop
    select md5(p.prosrc) into v_have
      from pg_proc p
     where p.oid = to_regprocedure(r.fn);
    if v_have is distinct from r.want then
      raise exception '0373: % drifted from the text this migration restates (md5 %, want %)',
        r.fn, coalesce(v_have, '<missing>'), r.want
        using errcode = '55000';
    end if;
  end loop;

  -- The INVOKER callers insert an explicit id into stock_movements as the
  -- user. That needs INSERT on the id column (today the default table-level
  -- grant; nothing narrows it).
  if not has_column_privilege('authenticated', 'public.stock_movements', 'id', 'INSERT') then
    raise exception '0373: authenticated cannot INSERT stock_movements.id' using errcode = '55000';
  end if;
end $pre$;

-- The lock prelude (see PROD PUSH NOTE). Sections 1 and 2 need SHARE ROW
-- EXCLUSIVE on stock_movements and locations until COMMIT. User paths take
-- ROW EXCLUSIVE on the two in BOTH orders (a null-location increment:
-- locations via ensure_*, then its movement; a return restock: its movement,
-- then locations), so any push that WAITS for one while holding the other can
-- deadlock (40P01). This waits (lock_timeout) for stock_movements while it
-- holds nothing a user transaction needs, then takes locations NOWAIT: 55P03
-- at once if a write holds it, and after that every lock this file needs is
-- already held. Inside DO because the CLI batch is not a transaction block
-- (a top-level LOCK TABLE refuses there); the locks last until the batch
-- commits. Proven by scripts/db-concurrency/0373_push_lock_order.sh.
do $lock$
begin
  lock table public.stock_movements in share row exclusive mode;
  lock table public.locations in share row exclusive mode nowait;
end $lock$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 1) The composite key the provenance FK references.
-- ═══════════════════════════════════════════════════════════════════════════
-- id alone is already unique; this index exists only so the child FK can pin
-- org and item consistency (the 0201-0206 class). One more index maintained
-- on every movement insert.
create unique index stock_movements_id_org_item_key
  on public.stock_movements (id, organization_id, item_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- 2) public.stock_movement_holdings
-- ═══════════════════════════════════════════════════════════════════════════
-- location_id is deliberately NOT in the primary key, so PostgREST does not
-- infer a stock_movements <-> locations many-to-many through this table. The
-- warehouse snapshots are plain uuids with no FK (no extra lock traffic;
-- they are facts at draw time, not live references).
create table public.stock_movement_holdings (
  movement_id           uuid          not null,
  seq                   integer       not null check (seq > 0),
  organization_id       uuid          not null,
  item_id               uuid          not null,
  location_id           uuid,
  quantity              numeric(14,4) not null check (quantity <> 0),
  step                  text          not null
                        check (step in ('increment', 'staging_first', 'placed', 'any_staging')),
  mode                  text,
  location_kind         text,
  location_warehouse_id uuid,
  item_warehouse_id     uuid,
  actor_scope           text          not null
                        check (actor_scope in ('service', 'manager', 'in_scope', 'out_of_scope')),
  created_at            timestamptz   not null default now(),
  constraint stock_movement_holdings_pkey primary key (movement_id, seq),
  constraint stock_movement_holdings_movement_fk
    foreign key (movement_id, organization_id, item_id)
    references public.stock_movements (id, organization_id, item_id)
    on delete cascade
    deferrable initially deferred,
  constraint stock_movement_holdings_location_fk
    foreign key (location_id)
    references public.locations (id)
    on delete set null
);

create index stock_movement_holdings_location_idx
  on public.stock_movement_holdings (location_id, created_at desc)
  where location_id is not null;

alter table public.stock_movement_holdings enable row level security;

-- Visibility mirrors the parent movement: the EXISTS runs under
-- stock_movements_select (0321), so it can never drift from it. The org
-- prefilter is cheap and keeps the planner narrow. Columns qualified
-- (pattern #25).
create policy stock_movement_holdings_select on public.stock_movement_holdings
  for select to authenticated
  using (
    stock_movement_holdings.organization_id in (select public.rls_member_org_ids())
    and exists (select 1 from public.stock_movements m
                 where m.id = stock_movement_holdings.movement_id)
  );

-- Undo Supabase's default table privileges: read-only for the API roles, and
-- nothing at all for anon.
revoke all on table public.stock_movement_holdings from public, anon, authenticated, service_role;
grant select on table public.stock_movement_holdings to authenticated, service_role;

comment on table public.stock_movement_holdings is
  '0373: which holdings a null-location stock change took from (quantity < 0) or landed in (quantity > 0: a Staging location), one row per holding in draw order (seq). The only writer is ledger._record_holdings, called from ledger.apply_level_delta_for with the movement id its caller generated; the composite FK (deferred to COMMIT, cascades) pins the row to its movement''s org and item. History starts at the 0373 push: no backfill. Not covered: post_cycle_count''s residual draw (public.apply_level_delta records nothing) and explicit-location paths, whose single holding is in stock_movements.from_location_id / to_location_id (an empty set means "use from/to"). location_kind, location_warehouse_id, item_warehouse_id and actor_scope are facts at draw time. A source "crosses warehouses" when location_warehouse_id and item_warehouse_id are both non-null and differ (NULL means org-level, never foreign; the 0343 rule). SELECT mirrors the parent movement''s visibility; no API role can write. A future location dedupe must repoint location_id, as 0270 did for from/to.';
comment on column public.stock_movement_holdings.quantity is
  '0373: < 0 taken from this holding, > 0 landed in it (increments land in Staging), exactly as the numeric(14,4) holding moved; a share that rounds to zero records no row. Rows of one movement sum to the holdings difference it made, which is its quantity_change on the recorded paths, except for a removal given with more than four decimals that ends in an exact half (e.g. -0.00005): the movement row rounds that away from zero, the holding (and so the rows) toward zero.';
comment on column public.stock_movement_holdings.step is
  '0373: which loop of the draw engine touched the holding: increment, staging_first (the Staging pre-pass), placed (racks/crates/areas/Sites by location age, Unplaced last), any_staging (0341 manual removal spilling into Staging).';
comment on column public.stock_movement_holdings.mode is
  '0373: p_mode exactly as the caller passed it (placed, staging_first, any, staging, or anything else, which draws as placed).';
comment on column public.stock_movement_holdings.location_kind is
  '0373: locations.kind at draw time. NULL is a Site (0292), never backfilled.';
comment on column public.stock_movement_holdings.location_warehouse_id is
  '0373: locations.warehouse_id at draw time. NULL = an org-level location.';
comment on column public.stock_movement_holdings.item_warehouse_id is
  '0373: inventory_items.warehouse_id at draw time.';
comment on column public.stock_movement_holdings.actor_scope is
  '0373: the drawer at draw time: service (no signed-in user), manager (manager or above in the org), in_scope / out_of_scope (below manager: caller_can_write_location of this holding''s location). The direct measure for a "draw only from writable warehouses" rule.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 3) ledger._record_holdings: the only writer of the table.
-- ═══════════════════════════════════════════════════════════════════════════
-- SECURITY INVOKER with no EXECUTE for any API role: it runs only as the
-- owner of the SECURITY DEFINER engine. seq continues from the movement's
-- current max, so a second engine call for the same movement appends instead
-- of colliding. Raises nothing by design; the table's CHECK and FK
-- constraints fail loudly on a bug.
--
-- The drawer's scope is worked out once per call, not once per row (perf
-- review, 2026-09-25: per row, a staff 50-line pick paid 150
-- caller_can_write_location calls). Service and manager are one answer for
-- the whole call, decided before the insert exactly as before. Below manager
-- the answer depends on the holding: caller_can_write_location reads its
-- location only for organization_id and warehouse_id (and auth.uid(), fixed
-- for the call), so it is asked once per distinct (organization, warehouse)
-- among the call's locations, on any one location of that pair, inside the
-- insert's own statement (same snapshot as the per-row call it replaces).
-- A missing location and a NULL id share the (NULL, NULL) pair, and both
-- answer false. pgTAP 0373 S1-S9 pin caller_can_write_location's text (a
-- change to what it reads fails there instead of silently skewing the
-- scope), prove the values equal the per-row formula for six personas, and
-- count the calls.
create function ledger._record_holdings(
  p_movement_id uuid,
  p_org         uuid,
  p_item_id     uuid,
  p_item_wh     uuid,
  p_locs        uuid[],
  p_qtys        numeric[],
  p_steps       text[],
  p_mode        text
)
returns void
language plpgsql
security invoker
set search_path = public
as $function$
declare
  v_uid   uuid := auth.uid();
  v_scope text;  -- the whole call's scope: service or manager; NULL below manager
begin
  if p_movement_id is null or coalesce(cardinality(p_locs), 0) = 0 then
    return;
  end if;
  if v_uid is null then
    v_scope := 'service';
  elsif public.has_org_role(p_org, 'manager') then
    v_scope := 'manager';
  end if;

  -- Each share is recorded as its holding actually moved. The engine's shares
  -- carry the caller's full precision (adjust_stock takes an unconstrained
  -- numeric; the API accepts any finite value), but item_stock_levels.quantity
  -- is numeric(14,4). An increment lands round(p_qty, 4) (the upsert's
  -- EXCLUDED row is already cast); a draw leaves round(q - take, 4) with
  -- q - take >= 0 and q already at four decimals. Both are the signed share
  -- rounded half UP: floor(x * 10000 + 0.5) / 10000. A share that rounds to
  -- zero moved nothing and records no row (only the last share of a draw can
  -- be fractional), so the CHECK (quantity <> 0) cannot fail and the rows
  -- equal the holdings difference exactly. seq numbers the kept rows.
  --
  -- s is read only below manager (COALESCE stops at a non-NULL v_scope, and a
  -- CTE that is never read is never run), and MATERIALIZED so each pair's
  -- caller_can_write_location runs once however many rows read it. It covers
  -- every location passed, kept or not: an extra pair only costs a call.
  insert into public.stock_movement_holdings (
    movement_id, seq, organization_id, item_id, location_id, quantity, step, mode,
    location_kind, location_warehouse_id, item_warehouse_id, actor_scope)
  with s as materialized (
    select g.organization_id, g.warehouse_id,
           case when public.caller_can_write_location(any_value(x.loc)) then 'in_scope'
                else 'out_of_scope' end as scope
      from unnest(p_locs) as x(loc)
      left join public.locations g on g.id = x.loc
     group by g.organization_id, g.warehouse_id
  )
  select p_movement_id,
         coalesce((select max(h.seq) from public.stock_movement_holdings h
                    where h.movement_id = p_movement_id), 0)
           + (row_number() over (order by u.ord))::int,
         p_org, p_item_id, u.loc, u.qty, u.step, p_mode,
         l.kind, l.warehouse_id, p_item_wh,
         coalesce(v_scope, (select s.scope from s
                             where s.organization_id is not distinct from l.organization_id
                               and s.warehouse_id is not distinct from l.warehouse_id))
    from (select x.loc, x.step, x.ord, floor(x.qty * 10000 + 0.5) / 10000 as qty
            from unnest(p_locs, p_qtys, p_steps) with ordinality as x(loc, qty, step, ord)) u
    left join public.locations l on l.id = u.loc
   where u.qty <> 0
   order by u.ord;
end;
$function$;

revoke all on function ledger._record_holdings(uuid, uuid, uuid, uuid, uuid[], numeric[], text[], text)
  from public, anon, authenticated, service_role;

comment on function ledger._record_holdings(uuid, uuid, uuid, uuid, uuid[], numeric[], text[], text) is
  '0373: the only writer of public.stock_movement_holdings. Called only by ledger.apply_level_delta_for (SECURITY DEFINER), so it runs as that function''s owner; no API role holds EXECUTE. A NULL movement id or an empty array records nothing. Each share is recorded as its numeric(14,4) holding moved (rounded half up to four decimals); a share that rounds to zero records no row. seq continues from the movement''s current max over the kept rows. actor_scope: service / manager / in_scope / out_of_scope (caller_can_write_location), worked out once per call: service or manager for the whole call, else caller_can_write_location once per distinct (organization, warehouse) of the call''s locations, in the insert''s own statement.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 4) ledger.apply_level_delta_for: the one draw engine.
-- ═══════════════════════════════════════════════════════════════════════════
-- The 0359 body of public.apply_level_delta VERBATIM plus eight lines tagged
-- '-- 0373'. Preserved exactly: the zero/NULL no-op first; the item read
-- without a lock (every caller holds the item FOR UPDATE); the gate only for
-- a signed-in caller, forbidden before ledger_only, both before the
-- not-found return; the increment into the warehouse's (or org's) Staging
-- with ensure_* side effects and `limit 1` with no ORDER BY; the
-- staging_first pre-pass (largest first), the placed loop for EVERY
-- decrement mode (kind IS DISTINCT FROM 'staging', Unplaced last, then
-- location created_at, no id tie-breaker), the 'any' tail (0341); no
-- warehouse, org or deleted_at filter; the unconditional UPDATE per step with
-- no FOR UPDATE on holdings; one P0001 insufficient_placed_stock at the end.
-- NO parameter defaults: a new name with no defaults has no overload or
-- default ambiguity (the 0306 trap). EXECUTE stays with authenticated: the
-- INVOKER ledger bodies call it as the user; the gate in the body is what
-- stops a direct call (ledger_only / forbidden; ledger is not exposed).
create function ledger.apply_level_delta_for(
  p_movement_id uuid,
  p_item_id     uuid,
  p_qty         numeric,
  p_mode        text
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_org    uuid;
  v_wh     uuid;
  v_loc    uuid;
  v_need   numeric;
  v_take   numeric;
  v_lvl    record;
  v_locs   uuid[]    := '{}';  -- 0373
  v_qtys   numeric[] := '{}';  -- 0373
  v_steps  text[]    := '{}';  -- 0373
begin
  if p_qty = 0 or p_qty is null then return; end if;
  select organization_id, warehouse_id into v_org, v_wh
    from public.inventory_items where id = p_item_id;

  -- *** 0331 authorization gate — see that migration's header. auth.uid() IS
  -- NULL means a service_role/postgres connection (anon and PUBLIC hold no
  -- EXECUTE; every authenticated request carries a sub claim). Everyone else
  -- must be an accepted, non-disabled, unexpired staff+ member of the org that
  -- OWNS the item (v_org comes from the item row above, never from the caller).
  -- The gate runs BEFORE the not-found early-return on purpose (existence
  -- probing). ***
  if auth.uid() is not null then
    if v_org is null or not public.has_org_role(v_org, 'staff') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    -- *** 0359: only from inside a ledger RPC. A direct call would move
    -- holdings with no movement row and no on-hand change. ***
    if not ledger.active() then
      raise exception 'ledger_only' using errcode = '42501';
    end if;
  end if;
  if v_org is null then return; end if;

  -- ---- INCREMENT: land in Staging ----------------------------------------
  if p_qty > 0 then
    if v_wh is not null then
      perform public.ensure_warehouse_placement_locations(v_wh);
      select id into v_loc from public.locations
        where warehouse_id = v_wh and kind = 'staging' and deleted_at is null limit 1;
    else
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
    perform ledger._record_holdings(p_movement_id, v_org, p_item_id, v_wh, array[v_loc], array[p_qty], array['increment'], p_mode);  -- 0373
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
      v_locs := v_locs || v_lvl.location_id; v_qtys := v_qtys || (-v_take); v_steps := v_steps || 'staging_first'::text;  -- 0373
    end loop;
  end if;

  -- placed draw-down (racks/areas/crates first, Unplaced last; never Staging).
  -- IS DISTINCT FROM, not <>: locations.kind is nullable (0292).
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
    v_locs := v_locs || v_lvl.location_id; v_qtys := v_qtys || (-v_take); v_steps := v_steps || 'placed'::text;  -- 0373
  end loop;

  -- *** 0341: 'any' — the placed holdings did not cover a MANUAL removal;
  -- continue into Staging (largest level first, like staging_first). Reached
  -- only in this mode and only when v_need is still positive, so 'placed'
  -- callers keep never touching Staging. ***
  if p_mode = 'any' and v_need > 0 then
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
      v_locs := v_locs || v_lvl.location_id; v_qtys := v_qtys || (-v_take); v_steps := v_steps || 'any_staging'::text;  -- 0373
    end loop;
  end if;

  if v_need > 0 then
    raise exception 'insufficient_placed_stock' using errcode = 'P0001';
  end if;
  perform ledger._record_holdings(p_movement_id, v_org, p_item_id, v_wh, v_locs, v_qtys, v_steps, p_mode);  -- 0373
end;
$function$;

revoke all on function ledger.apply_level_delta_for(uuid, uuid, numeric, text) from public, anon;
grant execute on function ledger.apply_level_delta_for(uuid, uuid, numeric, text)
  to authenticated, service_role;

comment on function ledger.apply_level_delta_for(uuid, uuid, numeric, text) is
  '0373: the null-location draw engine (the 0359 apply_level_delta body verbatim plus eight lines tagged -- 0373). + lands in the item''s warehouse Staging; - draws by mode: placed (default; racks/areas/crates/Sites by location age, Unplaced last, never Staging), staging_first (Staging largest first, then placed), any (0341: placed, then Staging); anything else draws as placed. After a successful draw it records the holdings touched for p_movement_id through ledger._record_holdings; a NULL p_movement_id records nothing. The caller must insert its stock_movements row with that id in the same transaction (the deferred FK checks it at COMMIT). SECURITY DEFINER; for a signed-in caller: staff+ of the item''s org (42501 forbidden), then ledger.active() (42501 ledger_only). P0001 insufficient_placed_stock when holdings cannot cover a draw.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 5) public.apply_level_delta: the non-recording wrapper.
-- ═══════════════════════════════════════════════════════════════════════════
-- Same signature, default, return type, SECURITY DEFINER, search_path and
-- comment. Its own gate stays verbatim (INV-25, 0331 tests 23/24, 0359 test
-- 34); the engine repeats it and gives the same answer in the same
-- statement. The draw logic now lives in ONE place (pattern #26), so the
-- scoping migration changes it once and post_cycle_count inherits it.
create or replace function public.apply_level_delta(p_item_id uuid, p_qty numeric, p_mode text default 'placed')
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_org uuid;
begin
  if p_qty = 0 or p_qty is null then return; end if;
  select organization_id into v_org
    from public.inventory_items where id = p_item_id;

  -- The 0331/0359 gate, verbatim in effect: a signed-in caller must be staff+
  -- of the org that OWNS the item, and inside a ledger RPC. It runs before the
  -- not-found return (no existence probing).
  if auth.uid() is not null then
    if v_org is null or not public.has_org_role(v_org, 'staff') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    if not ledger.active() then
      raise exception 'ledger_only' using errcode = '42501';
    end if;
  end if;
  if v_org is null then return; end if;

  -- Since 0373: a NULL movement id moves holdings exactly as before and
  -- records nothing. The only caller left is ledger.post_cycle_count (INV-37).
  perform ledger.apply_level_delta_for(null, p_item_id, p_qty, p_mode);
end;
$function$;

-- CREATE OR REPLACE keeps the ACL and comment; restate the grants (0359).
revoke all on function public.apply_level_delta(uuid, numeric, text) from public, anon;
grant execute on function public.apply_level_delta(uuid, numeric, text) to authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- 6) The four callers, restated from their LIVE text. Every added line ends
--    with '-- 0373'; the only removed lines are the public.apply_level_delta
--    calls. SECURITY mode, search_path, signature, defaults, return type,
--    owner, ACL and comment are unchanged (CREATE OR REPLACE keeps the ACL
--    and comment). Each movement id is generated before its draw and used
--    as the id of exactly one stock_movements row.
-- ═══════════════════════════════════════════════════════════════════════════

-- 6a) ledger.adjust_stock (SECURITY INVOKER; 0371 text). Draw, then insert.
-- Both branches insert with v_mv_id (equivalent to the column default); only
-- the null-location branch calls the engine. No RETURNING: in an INVOKER
-- body it would add the caller's SELECT-policy check.
CREATE OR REPLACE FUNCTION ledger.adjust_stock(p_item_id uuid, p_quantity_change numeric, p_movement_type text, p_location_id uuid DEFAULT NULL::uuid, p_reason text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_mode text DEFAULT 'placed'::text)
 RETURNS public.inventory_items
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_item public.inventory_items%rowtype;
  v_prev numeric;
  v_new  numeric;
  v_user uuid := auth.uid();
  v_mv_id uuid := gen_random_uuid();  -- 0373
begin
  select * into v_item from public.inventory_items where id = p_item_id for update;
  if not found then raise exception 'item_not_found' using errcode = 'P0002'; end if;
  if not public.has_org_role(v_item.organization_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- *** 0201: verify the caller-supplied location_id belongs to the item's org ***
  perform public.assert_location_in_org(p_location_id, v_item.organization_id);

  -- 0365: an explicit location must be one the caller may write, below
  -- manager. Without it, "-3 here, +3 at a rack in another warehouse" did
  -- what transfer_stock now refuses.
  if p_location_id is not null
     and not public.has_org_role(v_item.organization_id, 'manager')
     and not public.caller_can_write_location(p_location_id) then
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
    -- *** 0371: the explicit-location write runs in ledger.apply_holding_delta
    -- (SECURITY DEFINER), so it no longer depends on which holdings the caller
    -- can SELECT. It is the same two statements: for a delta >= 0 the upsert
    -- (e.g. receiving into Staging); for a delta < 0 the 0327 conditional
    -- draw, whose miss (row absent OR insufficient quantity) raises the SAME
    -- P0001 'insufficient_stock' as the total guard above. ***
    perform ledger.apply_holding_delta(p_item_id, p_location_id, p_quantity_change);
  else
    -- Null location: auto-allocate. + -> Staging, - -> draw-down by p_mode
    -- ('placed' for picks/ships; 'staging_first' for reversals/scrap write-offs).
    perform ledger.apply_level_delta_for(v_mv_id, p_item_id, p_quantity_change, p_mode);  -- 0373
  end if;

  insert into public.stock_movements (
    id,  -- 0373
    organization_id, item_id, movement_type,
    quantity_change, previous_quantity, new_quantity,
    from_location_id, to_location_id, reason, notes, user_id
  ) values (
    v_mv_id,  -- 0373
    v_item.organization_id, v_item.id, p_movement_type,
    p_quantity_change, v_prev, v_new,
    case when p_quantity_change < 0 then p_location_id else null end,
    case when p_quantity_change > 0 then p_location_id else null end,
    p_reason, p_notes, v_user
  );

  return v_item;
end;
$function$;

-- 6b) ledger.distribute_bundle (SECURITY INVOKER; 0365 text plus 0367's
-- 55000). One id per movement: the phantom drain and each component draw.
-- The zero-quantity bundle_shortage row keeps its default id; it draws
-- nothing.
CREATE OR REPLACE FUNCTION ledger.distribute_bundle(p_bundle_id uuid, p_quantity numeric, p_warehouse_id uuid, p_allow_shortage boolean, p_schedule_event_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_bundle    public.bundles%rowtype;
  v_org       uuid;
  v_distribution_id uuid;
  v_phantom_qty numeric(14,4) := 0;
  v_phantom_wh uuid;
  v_phantom_deleted timestamptz;
  v_use_phantom numeric(14,4) := 0;
  v_use_virtual numeric(14,4);
  v_shortage  boolean := false;
  v_user      uuid := auth.uid();
  v_component record;
  v_needed    numeric(14,4);
  v_have      numeric(14,4);
  v_draw      numeric(14,4);
  v_short     numeric(14,4);
  v_prev      numeric(14,4);
  v_new       numeric(14,4);
  v_existing  public.idempotency_keys%rowtype;
  v_request_hash text;
  v_mv_id     uuid;  -- 0373
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity_must_be_positive' using errcode = '22023';
  end if;

  select * into v_bundle
  from public.bundles where id = p_bundle_id for update;
  if not found then raise exception 'bundle_not_found' using errcode = 'P0002'; end if;
  if not v_bundle.is_active or v_bundle.archived_at is not null then
    raise exception 'bundle_not_active' using errcode = 'P0001';
  end if;
  v_org := v_bundle.organization_id;

  -- C9: tightened from 'staff' to 'manager' to match service gate
  -- `bundles:distribute`. The service layer's assertWarehouseAccess
  -- adds warehouse-scope; this assert is the org-role floor.
  if not public.has_org_role(v_org, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Verify warehouse belongs to org
  if not exists (
    select 1 from public.warehouses
    where id = p_warehouse_id and organization_id = v_org
  ) then
    raise exception 'warehouse_not_found' using errcode = 'P0002';
  end if;

  -- *** 0347 idempotency — see header. Runs after the role/warehouse checks so
  -- a refused caller cannot probe keys, and before any stock write so the
  -- replay short-circuits with nothing touched. ***
  if p_idempotency_key is not null then
    v_request_hash := md5(
      p_bundle_id::text || '|' || p_quantity::text || '|' || p_warehouse_id::text
      || '|' || coalesce(p_allow_shortage, false)::text
      || '|' || coalesce(p_schedule_event_id::text, '')
    );
    select * into v_existing
      from public.idempotency_keys
     where organization_id = v_org
       and scope = 'bundle_distribution'
       and key = p_idempotency_key
       for update;
    if found then
      if v_existing.request_hash = v_request_hash
         and v_existing.status = 'completed'
         and v_existing.resource_id is not null then
        return v_existing.resource_id;
      end if;
      raise exception 'idempotency_conflict' using errcode = '55000';
    end if;
    insert into public.idempotency_keys
      (organization_id, scope, key, request_hash, status, resource_type)
    values
      (v_org, 'bundle_distribution', p_idempotency_key, v_request_hash, 'in_progress', 'bundle_distribution');
  end if;

  -- Phantom allocation
  if v_bundle.phantom_item_id is not null then
    select quantity_on_hand, warehouse_id, deleted_at
      into v_phantom_qty, v_phantom_wh, v_phantom_deleted
    from public.inventory_items
    where id = v_bundle.phantom_item_id for update;
    v_phantom_qty := greatest(0, coalesce(v_phantom_qty, 0));
    -- 0365: pre-assembled kits in another warehouse (or on a deleted kit item)
    -- are not here. They are left alone and this distribution is built from
    -- this warehouse's components (assemble_bundle already refuses to build
    -- into another warehouse).
    if v_phantom_deleted is not null
       or (v_phantom_wh is not null and v_phantom_wh <> p_warehouse_id) then
      v_phantom_qty := 0;
    end if;
  end if;

  v_use_phantom := least(p_quantity, v_phantom_qty);
  v_use_virtual := p_quantity - v_use_phantom;

  -- Drain phantom
  if v_use_phantom > 0 then
    v_prev := v_phantom_qty;
    v_new  := v_prev - v_use_phantom;
    update public.inventory_items
      set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
      where id = v_bundle.phantom_item_id;
    -- Maintain levels: pre-assembled stock sat in Staging; drain it there first.
    v_mv_id := gen_random_uuid();  -- 0373
    perform ledger.apply_level_delta_for(v_mv_id, v_bundle.phantom_item_id, v_new - v_prev, 'staging_first');  -- 0373

    insert into public.stock_movements (
      id,  -- 0373
      organization_id, item_id, movement_type, quantity_change,
      previous_quantity, new_quantity, reason, reference_type,
      reference_id, user_id, notes
    ) values (
      v_mv_id,  -- 0373
      v_org, v_bundle.phantom_item_id, 'bundle_distribution', -v_use_phantom,
      v_prev, v_new, 'bundle_distribution', 'bundle',
      p_bundle_id, v_user, p_notes
    );
  end if;

  -- Component allocation for the virtual portion
  if v_use_virtual > 0 then
    -- 0365: every required component must be one the caller can see. The loop
    -- below reads components under the caller's RLS (these bodies are INVOKER);
    -- one it could not see (an item with no warehouse, or outside a category
    -- grant) was skipped silently and the kit went out without it.
    if exists (select 1 from public.bundle_components bc
                where bc.bundle_id = p_bundle_id and not bc.is_optional
                  and not exists (select 1 from public.inventory_items ii where ii.id = bc.item_id)) then
      raise exception 'component_not_visible' using errcode = 'P0001';
    end if;
    for v_component in
      select bc.item_id, bc.quantity, bc.is_optional, ii.quantity_on_hand,
             ii.warehouse_id as item_wh, ii.deleted_at
      from public.bundle_components bc
      join public.inventory_items ii on ii.id = bc.item_id
      where bc.bundle_id = p_bundle_id
      order by bc.item_id
      for update of ii
    loop
      v_needed := v_component.quantity * v_use_virtual;
      -- 0365: only this warehouse's stock (or a component with no warehouse)
      -- is drawn, and never a deleted item. 0101 dropped 0070's scope, so a
      -- distribution drained the component from whichever building held it
      -- while the preview reported a shortage.
      v_have   := case when v_component.deleted_at is null
                        and coalesce(v_component.item_wh, p_warehouse_id) = p_warehouse_id
                       then greatest(0, v_component.quantity_on_hand) else 0 end;
      v_draw   := least(v_needed, v_have);
      v_short  := v_needed - v_draw;

      if v_draw > 0 then
        v_prev := v_component.quantity_on_hand;
        v_new  := v_prev - v_draw;
        update public.inventory_items
          set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
          where id = v_component.item_id;
        -- Maintain levels: virtual-portion consumption draws from placed stock.
        v_mv_id := gen_random_uuid();  -- 0373
        perform ledger.apply_level_delta_for(v_mv_id, v_component.item_id, v_new - v_prev, 'placed');  -- 0373

        insert into public.stock_movements (
          id,  -- 0373
          organization_id, item_id, movement_type, quantity_change,
          previous_quantity, new_quantity, reason, reference_type,
          reference_id, user_id, notes
        ) values (
          v_mv_id,  -- 0373
          v_org, v_component.item_id, 'bundle_distribution', -v_draw,
          v_prev, v_new, 'bundle_distribution', 'bundle',
          p_bundle_id, v_user, p_notes
        );
      end if;

      if v_short > 0 then
        if not p_allow_shortage and not v_component.is_optional then
          raise exception 'insufficient_stock' using detail = v_component.item_id::text;
        end if;
        if not v_component.is_optional then
          v_shortage := true;
        end if;
        -- 0365: the zero-quantity shortage row goes on the item only when the
        -- item is stocked here; one kept in another warehouse (or deleted) was
        -- not short, it was not here, and its history should not say so. The
        -- distribution itself still records the shortage.
        if not v_component.is_optional
           and v_component.deleted_at is null
           and coalesce(v_component.item_wh, p_warehouse_id) = p_warehouse_id then
          insert into public.stock_movements (
            organization_id, item_id, movement_type, quantity_change,
            previous_quantity, new_quantity, reason, reference_type,
            reference_id, user_id, notes
          ) values (
            v_org, v_component.item_id, 'bundle_shortage', 0,
            v_component.quantity_on_hand, v_component.quantity_on_hand,
            'no_stock', 'bundle', p_bundle_id, v_user,
            'short ' || v_short::text || ' units during bundle distribution'
          );
        end if;
      end if;
    end loop;
  end if;

  insert into public.bundle_distributions (
    organization_id, bundle_id, warehouse_id, quantity,
    schedule_event_id, notes, shortage_recorded, distributed_by
  ) values (
    v_org, p_bundle_id, p_warehouse_id, p_quantity,
    p_schedule_event_id, p_notes, v_shortage, v_user
  )
  returning id into v_distribution_id;

  if p_idempotency_key is not null then
    update public.idempotency_keys
       set status = 'completed', resource_id = v_distribution_id, updated_at = now()
     where organization_id = v_org
       and scope = 'bundle_distribution'
       and key = p_idempotency_key;
  end if;

  return v_distribution_id;
end;
$function$;

-- 6c) ledger.assemble_bundle (SECURITY INVOKER; 0365 text). One id per
-- component draw and one for the phantom kit's Staging landing.
CREATE OR REPLACE FUNCTION ledger.assemble_bundle(p_bundle_id uuid, p_quantity numeric, p_warehouse_id uuid, p_notes text DEFAULT NULL::text)
 RETURNS TABLE(phantom_item_id uuid, phantom_qty numeric)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_bundle    public.bundles%rowtype;
  v_org       uuid;
  v_phantom   public.inventory_items%rowtype;
  v_user      uuid := auth.uid();
  v_phantom_sku text;
  v_component record;
  v_needed    numeric(14,4);
  v_prev      numeric(14,4);
  v_new       numeric(14,4);
  v_mv_id     uuid;  -- 0373
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity_must_be_positive' using errcode = '22023';
  end if;

  select * into v_bundle
  from public.bundles where id = p_bundle_id for update;
  if not found then raise exception 'bundle_not_found' using errcode = 'P0002'; end if;
  if not v_bundle.is_active or v_bundle.archived_at is not null then
    raise exception 'bundle_not_active' using errcode = 'P0001';
  end if;
  if not v_bundle.preassembly_enabled then
    raise exception 'preassembly_disabled' using errcode = 'P0001';
  end if;
  v_org := v_bundle.organization_id;

  -- C9: tightened from 'staff' to 'manager' to match service gate
  -- `bundles:manage`. The service layer's assertWarehouseAccess adds
  -- warehouse-scope; this assert is the org-role floor.
  if not public.has_org_role(v_org, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Verify warehouse belongs to org
  if not exists (
    select 1 from public.warehouses
    where id = p_warehouse_id and organization_id = v_org
  ) then
    raise exception 'warehouse_not_found' using errcode = 'P0002';
  end if;

  -- Lock or create phantom
  if v_bundle.phantom_item_id is not null then
    select * into v_phantom
    from public.inventory_items
    where id = v_bundle.phantom_item_id for update;
    if v_phantom.warehouse_id is not null and v_phantom.warehouse_id <> p_warehouse_id then
      raise exception 'phantom_warehouse_mismatch' using errcode = 'P0001';
    end if;
    -- 0365: never add kits to a deleted kit item.
    if v_phantom.deleted_at is not null then
      raise exception 'phantom_deleted' using errcode = 'P0001';
    end if;
  else
    -- SKU is internal, never user-facing. Truncated UUID guarantees
    -- uniqueness without colliding with any real SKU pattern.
    v_phantom_sku := '__BUNDLE__' || substr(p_bundle_id::text, 1, 8);
    insert into public.inventory_items (
      organization_id, sku, name, description, status,
      quantity_on_hand, warehouse_id, is_bundle,
      created_by, updated_by
    ) values (
      v_org, v_phantom_sku, v_bundle.name,
      'Pre-assembled bundle stock for ' || v_bundle.name,
      'active', 0, p_warehouse_id, true, v_user, v_user
    )
    returning * into v_phantom;

    update public.bundles
      set phantom_item_id = v_phantom.id, updated_at = now()
      where id = p_bundle_id;
  end if;

  -- Decrement components in deterministic order to avoid deadlocks
  -- between concurrent assemble/distribute calls.
  -- 0365: every required component must be one the caller can see. The loop
  -- below reads components under the caller's RLS (these bodies are INVOKER);
  -- one it could not see (an item with no warehouse, or outside a category
  -- grant) was skipped silently and the kit went out without it.
  if exists (select 1 from public.bundle_components bc
              where bc.bundle_id = p_bundle_id and not bc.is_optional
                and not exists (select 1 from public.inventory_items ii where ii.id = bc.item_id)) then
    raise exception 'component_not_visible' using errcode = 'P0001';
  end if;
  for v_component in
    select bc.item_id, bc.quantity, bc.is_optional, ii.quantity_on_hand, ii.id as ii_id,
           ii.warehouse_id as item_wh, ii.deleted_at
    from public.bundle_components bc
    join public.inventory_items ii on ii.id = bc.item_id
    where bc.bundle_id = p_bundle_id
    order by bc.item_id
    for update of ii
  loop
    v_needed := v_component.quantity * p_quantity;
    -- 0365: a kit built here uses this warehouse's components (or ones with
    -- no warehouse), never a deleted item's. Said as such, not as a stock
    -- shortage the bundle page would contradict.
    if v_component.deleted_at is not null
       or coalesce(v_component.item_wh, p_warehouse_id) <> p_warehouse_id then
      if not v_component.is_optional then
        raise exception 'component_not_in_warehouse'
          using errcode = 'P0001', detail = v_component.item_id::text;
      end if;
      continue;
    end if;
    if v_component.quantity_on_hand < v_needed then
      if not v_component.is_optional then
        raise exception 'insufficient_stock' using detail = v_component.item_id::text;
      else
        continue;
      end if;
    end if;

    v_prev := v_component.quantity_on_hand;
    v_new  := v_prev - v_needed;
    update public.inventory_items
      set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
      where id = v_component.item_id;
    -- Maintain levels: consume from placed locations (rack/area/crate).
    -- Raises insufficient_placed_stock if component stock is only in Staging.
    v_mv_id := gen_random_uuid();  -- 0373
    perform ledger.apply_level_delta_for(v_mv_id, v_component.item_id, v_new - v_prev, 'placed');  -- 0373

    insert into public.stock_movements (
      id,  -- 0373
      organization_id, item_id, movement_type, quantity_change,
      previous_quantity, new_quantity, reason, reference_type,
      reference_id, user_id, notes
    ) values (
      v_mv_id,  -- 0373
      v_org, v_component.item_id, 'bundle_assembly', -v_needed,
      v_prev, v_new, 'bundle_assembly', 'bundle',
      p_bundle_id, v_user, p_notes
    );
  end loop;

  -- Increment phantom
  v_prev := v_phantom.quantity_on_hand;
  v_new  := v_prev + p_quantity;
  update public.inventory_items
    set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
    where id = v_phantom.id;
  -- Maintain levels: assembled kit lands in Staging.
  v_mv_id := gen_random_uuid();  -- 0373
  perform ledger.apply_level_delta_for(v_mv_id, v_phantom.id, v_new - v_prev, 'staging');  -- 0373

  insert into public.stock_movements (
    id,  -- 0373
    organization_id, item_id, movement_type, quantity_change,
    previous_quantity, new_quantity, reason, reference_type,
    reference_id, user_id, notes
  ) values (
    v_mv_id,  -- 0373
    v_org, v_phantom.id, 'bundle_assembly', p_quantity,
    v_prev, v_new, 'bundle_assembly', 'bundle',
    p_bundle_id, v_user, p_notes
  );

  return query select v_phantom.id, v_new;
end;
$function$;

-- 6d) ledger.process_return_disposition (SECURITY DEFINER; the insert-first
-- writer). One id per leg: the restock 'return' row and its Staging landing,
-- then (scrap only) the 'loss' row and its staging_first draw.
CREATE OR REPLACE FUNCTION ledger.process_return_disposition(p_return_id uuid)
 RETURNS public.returns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_return  public.returns%rowtype;
  v_user    uuid := auth.uid();
  v_line    record;
  v_item    public.inventory_items%rowtype;
  v_prev    numeric;
  v_new     numeric;
  v_fulfilled numeric(14,4);
  v_returned  numeric(14,4);
  v_mv_id     uuid;  -- 0373
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  -- Lock the header so concurrent receive/close calls on the same return
  -- serialize; the applied latch on each line is the per-line guard.
  select * into v_return from public.returns where id = p_return_id for update;
  if not found then
    raise exception 'return_not_found' using errcode = 'P0002';
  end if;

  if not public.has_org_role(v_return.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Status gate: inventory only moves for a return that has actually been
  -- received. A return still in 'requested'/'approved' (never received) or in
  -- 'denied'/'cancelled' must never push stock — that would let a manager skip
  -- the approval/receipt workflow. 'closed' is already settled (this RPC moved
  -- it there); re-calling on a closed return is a no-op because every line's
  -- applied latch is true, but we still reject the transition explicitly so the
  -- received->closed move is the only path that mutates inventory. Mirrors
  -- cancel_order_request's invalid_status_transition guard (0137).
  if v_return.status <> 'received' then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_return.status;
  end if;

  -- order by item_id keeps the per-item row-lock order stable across concurrent
  -- calls touching the same item (matches complete_picking / cancel_order_request).
  for v_line in
    select rl.id as line_id, rl.item_id, rl.quantity, rl.disposition,
           rl.order_request_line_id
    from public.return_lines rl
    where rl.return_id = p_return_id
      and rl.applied = false
    order by rl.item_id
  loop
    -- ── Layer-2 backstop (0154): re-assert the DURABLE budget for this source
    -- line BEFORE moving any stock. Lock the source line FOR UPDATE so concurrent
    -- dispositions for the same line serialise, then refuse if consuming this
    -- line's quantity would push returned_quantity past quantity_fulfilled. If it
    -- would, a header status was forged past the transition trigger / INSERT cap
    -- (e.g. a cancel→revive). Reading the durable returned_quantity (not a SUM
    -- over mutable return rows) means a revive cannot trick this check. Applies to
    -- scrap lines too — over-claiming a line at all is inconsistent, reject
    -- regardless of disposition.
    select orl.quantity_fulfilled, orl.returned_quantity
      into v_fulfilled, v_returned
    from public.order_request_lines orl
    where orl.id = v_line.order_request_line_id
    for update;
    if not found then
      raise exception 'order_request_line_not_found'
        using errcode = 'P0002', detail = v_line.order_request_line_id::text;
    end if;

    if v_returned + v_line.quantity > v_fulfilled then
      raise exception 'return_exceeds_fulfilled'
        using errcode = 'P0001',
              detail = format(
                'order_request_line %s: returned %s + %s exceeds fulfilled %s',
                v_line.order_request_line_id, v_returned, v_line.quantity, v_fulfilled
              );
    end if;

    -- Lock the item once for the whole (possibly two-movement) disposition.
    select * into v_item
    from public.inventory_items
    where id = v_line.item_id
    for update;
    if not found then
      raise exception 'item_not_found' using errcode = 'P0002';
    end if;

    -- Defence in depth: the line's item must belong to the return's org.
    if v_item.organization_id <> v_return.organization_id then
      raise exception 'cross_org_item' using errcode = '42501';
    end if;

    -- INVENTORY MODEL: the returned unit already left on-hand at fulfilment.
    --   RESTOCK → +qty 'return' (re-enters sellable stock; net vs fulfilment = 0).
    --   SCRAP   → +qty 'return' THEN -qty 'loss' (NET-ZERO receive-then-write-off;
    --             a bare -qty would DOUBLE-DECREMENT a unit already gone).
    v_prev := v_item.quantity_on_hand;
    v_new  := v_prev + v_line.quantity;
    update public.inventory_items
      set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
    where id = v_line.item_id;
    v_mv_id := gen_random_uuid();  -- 0373
    insert into public.stock_movements (
      id,  -- 0373
      organization_id, item_id, movement_type,
      quantity_change, previous_quantity, new_quantity,
      reason, reference_type, reference_id, user_id
    ) values (
      v_mv_id,  -- 0373
      v_return.organization_id, v_line.item_id, 'return',
      v_line.quantity, v_prev, v_new,
      'Return ' || v_line.disposition || ' (return ' || p_return_id::text || ')',
      'return', p_return_id, v_user
    );
    -- 0197: returned unit lands in Staging (+delta mirrors the on_hand increment above).
    perform ledger.apply_level_delta_for(v_mv_id, v_line.item_id, v_line.quantity, 'staging');  -- 0373

    -- SCRAP: immediately write the received unit off as a 'loss' so the net
    -- effect on on-hand is zero (the unit is destroyed, it was never sellable).
    if v_line.disposition = 'scrap' then
      v_prev := v_new;
      v_new  := v_prev - v_line.quantity;
      if v_new < 0 then
        raise exception 'insufficient_stock' using errcode = 'P0001';
      end if;
      update public.inventory_items
        set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
      where id = v_line.item_id;
      v_mv_id := gen_random_uuid();  -- 0373
      insert into public.stock_movements (
        id,  -- 0373
        organization_id, item_id, movement_type,
        quantity_change, previous_quantity, new_quantity,
        reason, reference_type, reference_id, user_id
      ) values (
        v_mv_id,  -- 0373
        v_return.organization_id, v_line.item_id, 'loss',
        -v_line.quantity, v_prev, v_new,
        'Return scrap write-off (return ' || p_return_id::text || ')',
        'return', p_return_id, v_user
      );
      -- 0197: scrap loss drains Staging first (staging_first) so the unit that
      -- just landed in Staging is removed — net Staging change = 0 (no stranded unit).
      perform ledger.apply_level_delta_for(v_mv_id, v_line.item_id, -v_line.quantity, 'staging_first');  -- 0373
    end if;

    -- Consume the durable budget (idempotent via the applied latch below).
    update public.order_request_lines
      set returned_quantity = returned_quantity + v_line.quantity
    where id = v_line.order_request_line_id;

    -- One-way latch: never apply a disposition twice.
    update public.return_lines
      set applied = true
      where id = v_line.line_id;
  end loop;

  -- Make the received->closed transition atomic with the inventory write: once
  -- stock has moved the return is settled, so close it in the same transaction.
  -- (The status guard above ensures we only ever reach here from 'received'.)
  update public.returns
    set status    = 'closed',
        closed_by = v_user,
        closed_at = now()
  where id = p_return_id;

  select * into v_return from public.returns where id = p_return_id;
  return v_return;
end;
$function$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 7) Post-checks (fail closed, 55000). The tagged-line rule, proven on the
--    installed text.
-- ═══════════════════════════════════════════════════════════════════════════
do $post$
declare
  r record;
  v_src text;
begin
  -- The engine is the 0359 body plus tagged lines only.
  select p.prosrc into v_src from pg_proc p
   where p.oid = 'ledger.apply_level_delta_for(uuid,uuid,numeric,text)'::regprocedure;
  if md5(regexp_replace(v_src, '\n[^\n]*-- 0373[^\n]*', '', 'g')) <> '4be0f94c4390e7cd9c15a73e629133bf' then
    raise exception '0373 post-check: the engine is not the 0359 body plus tagged lines' using errcode = '55000';
  end if;

  -- The wrapper records nothing.
  select p.prosrc into v_src from pg_proc p
   where p.oid = 'public.apply_level_delta(uuid,numeric,text)'::regprocedure;
  if v_src !~ 'perform ledger\.apply_level_delta_for\(null, p_item_id, p_qty, p_mode\);' then
    raise exception '0373 post-check: public.apply_level_delta must call the engine with a NULL id' using errcode = '55000';
  end if;

  -- Each caller: the pre-0373 text minus its apply_level_delta lines, plus
  -- tagged lines only; every engine call passes v_mv_id; no old call left.
  for r in
    select * from (values
      ('ledger.adjust_stock(uuid,numeric,text,uuid,text,text,text)',         1, '2a3526c05ad8d2dfbd3deba457e7bf42'),
      ('ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)', 2, '04909b1f699a977aa95f9cd0cf6cc427'),
      ('ledger.assemble_bundle(uuid,numeric,uuid,text)',                     2, '19f334042018cd4667032da003b6e6ce'),
      ('ledger.process_return_disposition(uuid)',                            2, 'e13b1e104876286949d95c282008f84b')
    ) v(fn, calls, stripped_md5)
  loop
    select p.prosrc into v_src from pg_proc p where p.oid = r.fn::regprocedure;
    if (select count(*) from regexp_matches(v_src, 'apply_level_delta_for\(v_mv_id,', 'g')) <> r.calls
       or (select count(*) from regexp_matches(v_src, 'apply_level_delta_for\(', 'g')) <> r.calls
       or v_src ~ 'public\.apply_level_delta\('
       or md5(regexp_replace(v_src, '\n[^\n]*-- 0373[^\n]*', '', 'g')) <> r.stripped_md5 then
      raise exception '0373 post-check: % is not its pre-0373 text plus tagged lines', r.fn using errcode = '55000';
    end if;
  end loop;
end $post$;

reset lock_timeout;
