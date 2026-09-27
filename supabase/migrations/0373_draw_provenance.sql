-- 0373_draw_provenance.sql
-- ============================================================================
-- Draw provenance: record which holdings every null-location stock change
-- took from (or landed in), on the movement row itself. DB-only. No data
-- migration, no backfill, and no change to which holdings are drawn.
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
-- warehouse scoping rule afterwards, with the data. Second order (2026-09-26):
-- the first build (a separate table, +14-22% on 50-line picks) was too slow;
-- find a design with no speed regression.
--
-- ── WHAT THIS MIGRATION DOES ────────────────────────────────────────────────
--   1. Two composite types and one nullable column, stock_movements.draw
--      (public.stock_draw): the mode as passed, the item's warehouse, the
--      drawer's scope when it is one answer for the whole draw (service /
--      manager), and the holdings in draw order (public.stock_draw_holding:
--      location, quantity as the numeric(14,4) holding moved, step, the
--      location's kind and warehouse at draw time, and the drawer's scope
--      for that holding below manager: in_scope / out_of_scope).
--   2. ledger.apply_level_delta_for(item, qty, mode, record, uid, OUT draw):
--      the ONE draw engine. SECURITY DEFINER. Its body is the 0359 body of
--      public.apply_level_delta VERBATIM plus eleven added lines, each ending
--      in '-- 0373'. It returns the draw through its OUT parameter; it writes
--      nothing of its own. A failed draw raises before it returns, so it
--      records nothing.
--   3. The four recording callers (ledger.adjust_stock, distribute_bundle,
--      assemble_bundle, process_return_disposition) assign the engine's
--      result to v_prov and write it into the draw column of the ONE
--      stock_movements row they insert next. No second table, no index, no
--      foreign key, no deferred check, no work at COMMIT: the buffer is the
--      engine's own arrays and the flush is the INSERT the caller already
--      makes. Pairing is plain data flow, so a draw cannot land on another
--      movement or be orphaned. process_return_disposition becomes
--      draw-first for both legs, like the other three.
--   4. ledger._seal: works out the drawer's scope and builds the draw. The
--      scope is cached in a transaction-local setting (see THE SCOPE CACHE).
--   5. The 0369 stamp trigger on stock_movements is extended: a draw can be
--      INSERTed only inside a ledger transaction (ledger.active()), by any
--      role, and no role can UPDATE it afterwards.
--   6. public.stock_movement_holdings: a security_invoker VIEW with the
--      first build's 13 columns (one row per holding, seq = draw order), so
--      readers ask "which holdings did movement X draw from, and was each in
--      the drawer's scope" by movement_id. It sees exactly the movements the
--      reader can see (stock_movements_select, 0321).
--   7. public.apply_level_delta keeps its signature, default, SECURITY
--      DEFINER, search_path, ACL and comment. It keeps its own gate verbatim
--      and calls the engine with record = false, so it moves holdings exactly
--      as before and records nothing. Its only remaining caller is
--      ledger.post_cycle_count (security_invariants INV-37).
--
-- ── THE TAGGED-LINE RULE ────────────────────────────────────────────────────
-- Every line this migration adds to an existing body ends with '-- 0373' (or
-- is a '-- 0373:' comment). Removing those lines (regexp
-- '\n[^\n]*-- 0373[^\n]*') gives back:
--   * for the engine: the 0359 apply_level_delta prosrc exactly (md5
--     4be0f94c4390e7cd9c15a73e629133bf);
--   * for each caller: its pre-0373 prosrc with only the
--     `perform public.apply_level_delta(` lines removed.
-- The post-check at the end of this file and pgTAP 0373 (P1-P6) prove it.
-- Draw order, mode handling, locking, error codes and messages are therefore
-- byte-for-byte what 0359/0371 shipped. The location facts come from three
-- extra columns in each draw loop's SELECT list, read from the locations row
-- the loop already joins, in the statement that chose the holding; pgTAP
-- 0373 P9 proves the three loop queries plan identically with and without
-- them (custom and generic plans).
--
-- ── THE SCOPE CACHE ─────────────────────────────────────────────────────────
-- Below manager the scope of a holding is caller_can_write_location of its
-- location. Its answer depends only on the location's (organization,
-- warehouse), and the manager answer only on the organization, so ledger._seal
-- asks each once per transaction and keeps the answers in the
-- transaction-local setting stockpilot.draw_scope, keyed by
-- pg_current_xact_id() / the drawer / the item's organization (the trust
-- basis of 0359's ledger.active(): only set_config inside the same
-- transaction can plant a value, 0359's census forbids a caller-chosen name,
-- and a leftover never matches a later transaction). A cache miss runs ONE
-- statement over the base tables that restates has_org_role(org, 'manager')
-- or caller_can_write_location (is_org_member + user_can_access_warehouse
-- 'write') for that drawer. The section 0 preflight pins the four restated
-- predicates (text and volatility) and the (organization_id, user_id)
-- uniqueness of organization_members; pgTAP 0373 S2-S4 prove the restatement
-- equals the live predicates for twelve signed-in personas and service over
-- nine locations.
--
-- Statement-level AFTER triggers clear the cache whenever the transaction
-- itself changes an input: organization_members and user_warehouse_assignments
-- (any change), user_profiles (insert, delete, truncate, or disabled_at / id),
-- warehouses (insert, delete, truncate, or organization_id / id), locations
-- (delete, truncate, or organization_id / warehouse_id / id; an increment's
-- Staging answer is keyed by the location). No other input exists: now() is
-- fixed for the transaction, and the drawer is part of the key.
--
-- WHAT THE CACHE CHANGES (owner sign-off): under READ COMMITTED each statement
-- sees the commits made before it started. The first build asked per engine
-- call; this asks once per transaction. The two differ only when ANOTHER
-- transaction commits a change to the drawer's membership, role, acceptance,
-- impersonation expiry, disabled flag or warehouse assignment, to a
-- warehouse's organization, or to a Staging location's organization or
-- warehouse, BETWEEN two draws of one transaction (a 50-line pick is one
-- transaction of about 20 ms). Then the later draws record the scope as of
-- the transaction's first draw that needed it. A single adjust is one draw,
-- so it is unchanged; under REPEATABLE READ or SERIALIZABLE the two are
-- identical. Authorization itself is untouched: every gate still runs live.
--
-- ── WHO CAN SEE A DRAW ──────────────────────────────────────────────────────
-- The draw is a column of its movement, so it is visible exactly when the
-- movement is (stock_movements_select, 0321), through PostgREST, the view
-- and Realtime alike. The first build's table had the same reach (org
-- prefilter plus EXISTS on the parent movement), so no reader gains a row.
-- stock_movements is in the supabase_realtime publication (0024): each
-- INSERT event now carries the draw, delivered only to subscribers whose RLS
-- check passes for that row (realtime.apply_rls runs the subscriber's role
-- and claims), the same audience. The web subscriber reads only
-- commit_timestamp. Every app and mobile read of stock_movements names its
-- columns, so no existing read starts returning it.
--
-- ── NOT COVERED (deliberately) ──────────────────────────────────────────────
-- * ledger.post_cycle_count's residual draw (after the counted-rack share)
--   still calls public.apply_level_delta, which records nothing. It is
--   frozen for F1; pgTAP 0373 D29-D30 pin the gap so it flips on purpose.
-- * apply_cycle_count_location_delta, and every explicit-location path
--   (ledger.apply_holding_delta via adjust_stock / transfer_stock,
--   reopen_picking, rack write-off): their one holding is already exact in
--   from_location_id / to_location_id. Readers treat a NULL draw as "use
--   from/to".
-- * Movements written outside the ledger (opening stock, imports,
--   duplicate_inventory_item, direct inserts): they cannot carry a draw.
-- * location_id inside a draw is a fact, not a reference: no foreign key, so
--   a hard-deleted location leaves its id (the first build set it NULL). A
--   future location dedupe must rewrite draws in a migration (the trigger
--   refuses every UPDATE of draw).
-- * History starts at this push. Holdings keep no per-draw history, so a
--   backfill would be invented.
-- * Ties in the draw order (equal location created_at, equal Staging
--   quantities) stay undefined, exactly as before.
--
-- ── ERROR CODES ─────────────────────────────────────────────────────────────
-- The engine raises what apply_level_delta raised: 42501 forbidden /
-- ledger_only (user callers), P0001 insufficient_placed_stock. The stamp
-- trigger raises 42501 ledger_only for a draw inserted outside a ledger
-- transaction and 42501 draw_immutable for any UPDATE that changes a draw;
-- neither is reachable from a ledger RPC. This file raises 55000 at push
-- time if a body it restates or mirrors has drifted from the text it was
-- built from, if 0373 is already applied, if stock_movements carries a
-- trigger other than the 0369 stamp, if authenticated lacks table-level
-- INSERT or SELECT on stock_movements, or if a post-check fails; and 55P03
-- when it cannot take its locks (PROD PUSH NOTE). Never 40001/40P01 (0367).
--
-- ── PROD PUSH NOTE ──────────────────────────────────────────────────────────
-- ADD COLUMN needs ACCESS EXCLUSIVE on stock_movements (metadata only: the
-- column is nullable with no default, so no rewrite), and the forget triggers
-- need SHARE ROW EXCLUSIVE on locations, organization_members,
-- user_warehouse_assignments, user_profiles and warehouses, all held until
-- COMMIT. The lock prelude waits (lock_timeout 5s) for stock_movements while
-- holding nothing, then takes the other five NOWAIT, so the push never waits
-- while holding a lock a user transaction needs: no deadlock (40P01) either
-- way round (scripts/db-concurrency/0373_push_lock_order.sh). The push fails
-- fast with 55P03 instead; retry is the remedy (the 0370/0371 pattern). Reads
-- of stock_movements wait for the push while it runs. Push off-peak.
-- ============================================================================

-- PLAIN `set`, not `set local` (0303/0358/0370/0371): the CLI batch is atomic
-- but is not a transaction block. Reset at the end.
set lock_timeout = '5s';


-- ═══════════════════════════════════════════════════════════════════════════
-- 0) Preflight: refuse (55000) unless every body this file restates or
--    mirrors is the exact text it was built from.
-- ═══════════════════════════════════════════════════════════════════════════
-- md5(prosrc) at the pre-0373 head (local, PG 17.6.1.166; unchanged at 0372):
--   public.apply_level_delta             4be0f94c4390e7cd9c15a73e629133bf (0359)
--   ledger.adjust_stock                  5ac1ac45313bb352e2ff5c015aa18cd3 (0371)
--   ledger.distribute_bundle             489959c7ad7fdc9cc153c6326e503dc5 (0365+0367)
--   ledger.assemble_bundle               8e9893d5666762e238bd354cc85bdbd1 (0365)
--   ledger.process_return_disposition    d16d045bafacef106377a2767c972704 (0197/0359)
--   public.tg_stock_movements_via_ledger 31fb4a57e3748a412211947559111cff (0369)
-- and the four predicates ledger._seal restates (all STABLE):
--   public.has_org_role                  10422b29a6e15acd003d4f11ed28e90c
--   public.caller_can_write_location     188634bf8552a0064bfbf1ebfecf814f (0365)
--   public.is_org_member                 76492a6556e9f6a7c33d942aa9726f9f
--   public.user_can_access_warehouse     76b4170f3d393e8a1f293ca3d4895955
-- A drifted predicate means the restatement may no longer equal it: re-prove
-- ledger._seal (pgTAP 0373 S2-S4) before updating a pin.
do $pre$
declare
  r record;
  v_have text;
  v_vol  text;
begin
  if to_regtype('public.stock_draw') is not null
     or to_regtype('public.stock_draw_holding') is not null
     or to_regclass('public.stock_movement_holdings') is not null
     or exists (select 1 from pg_attribute a
                 where a.attrelid = 'public.stock_movements'::regclass and a.attname = 'draw' and not a.attisdropped)
     or exists (select 1 from pg_proc p
                 where p.pronamespace = 'ledger'::regnamespace
                   and p.proname in ('apply_level_delta_for', '_seal', '_record_holdings', 'tg_forget_draw_scope')) then
    raise exception '0373 already applied (an object it creates exists)' using errcode = '55000';
  end if;

  for r in
    select * from (values
      ('public.apply_level_delta(uuid,numeric,text)',                            '4be0f94c4390e7cd9c15a73e629133bf', null),
      ('ledger.adjust_stock(uuid,numeric,text,uuid,text,text,text)',             '5ac1ac45313bb352e2ff5c015aa18cd3', null),
      ('ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)',     '489959c7ad7fdc9cc153c6326e503dc5', null),
      ('ledger.assemble_bundle(uuid,numeric,uuid,text)',                         '8e9893d5666762e238bd354cc85bdbd1', null),
      ('ledger.process_return_disposition(uuid)',                                'd16d045bafacef106377a2767c972704', null),
      ('public.tg_stock_movements_via_ledger()',                                 '31fb4a57e3748a412211947559111cff', null),
      ('public.has_org_role(uuid,text)',                                         '10422b29a6e15acd003d4f11ed28e90c', 's'),
      ('public.caller_can_write_location(uuid)',                                 '188634bf8552a0064bfbf1ebfecf814f', 's'),
      ('public.is_org_member(uuid)',                                             '76492a6556e9f6a7c33d942aa9726f9f', 's'),
      ('public.user_can_access_warehouse(uuid,uuid,text)',                       '76b4170f3d393e8a1f293ca3d4895955', 's')
    ) v(fn, want, vol)
  loop
    select md5(p.prosrc), p.provolatile::text into v_have, v_vol
      from pg_proc p
     where p.oid = to_regprocedure(r.fn);
    if v_have is distinct from r.want or (r.vol is not null and v_vol is distinct from r.vol) then
      raise exception '0373: % drifted from the text this migration restates or mirrors (md5 %, volatility %; want %, %)',
        r.fn, coalesce(v_have, '<missing>'), coalesce(v_vol, '<missing>'), r.want, coalesce(r.vol, 'any')
        using errcode = '55000';
    end if;
  end loop;

  -- has_org_role and user_can_access_warehouse pick one membership row with
  -- `limit 1`; the restatement asks EXISTS. They agree only while
  -- (organization_id, user_id) is unique.
  if not exists (select 1 from pg_constraint c
                  where c.conrelid = 'public.organization_members'::regclass and c.contype in ('u', 'p')
                    and (select array_agg(a.attname::text order by a.attname)
                           from unnest(c.conkey) k(attnum)
                           join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum)
                        = array['organization_id', 'user_id']) then
    raise exception '0373: organization_members is no longer unique on (organization_id, user_id)' using errcode = '55000';
  end if;

  -- The stamp trigger must be the only trigger that sees a movement row, so
  -- nothing else can write or rewrite a draw on its way in.
  if (select array_agg(t.tgname::text order by t.tgname) from pg_trigger t
       where t.tgrelid = 'public.stock_movements'::regclass and not t.tgisinternal)
     is distinct from array['trg_zz_stock_movements_via_ledger'] then
    raise exception '0373: stock_movements carries a trigger other than the 0369 stamp' using errcode = '55000';
  end if;

  -- The INVOKER callers insert the new column as the user, and the
  -- security_invoker view reads it as the user: both ride on the table-level
  -- grants (a column-level grant would not cover a new column).
  if not has_table_privilege('authenticated', 'public.stock_movements', 'INSERT')
     or not has_table_privilege('authenticated', 'public.stock_movements', 'SELECT') then
    raise exception '0373: authenticated lacks table-level INSERT or SELECT on stock_movements' using errcode = '55000';
  end if;
end $pre$;

-- The lock prelude (see PROD PUSH NOTE). Inside DO because the CLI batch is
-- not a transaction block (a top-level LOCK TABLE refuses there); the locks
-- last until the batch commits. Proven by
-- scripts/db-concurrency/0373_push_lock_order.sh.
do $lock$
begin
  lock table public.stock_movements in access exclusive mode;
  lock table public.locations, public.organization_members, public.user_warehouse_assignments,
             public.user_profiles, public.warehouses
    in share row exclusive mode nowait;
end $lock$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 1) The draw types and the column.
-- ═══════════════════════════════════════════════════════════════════════════
create type public.stock_draw_holding as (
  location_id           uuid,
  quantity              numeric(14,4),
  step                  text,
  location_kind         text,
  location_warehouse_id uuid,
  actor_scope           text
);

create type public.stock_draw as (
  mode              text,
  item_warehouse_id uuid,
  actor_scope       text,
  holdings          public.stock_draw_holding[]
);

comment on type public.stock_draw_holding is
  '0373: one holding a null-location draw took from (quantity < 0) or its increment landed in (quantity > 0, a Staging location). quantity is exactly what the numeric(14,4) holding moved (a share that rounds to zero is not recorded). step: increment, staging_first (the Staging pre-pass), placed (racks/crates/areas/Sites by location age, Unplaced last), any_staging (0341 manual removal spilling into Staging). location_kind and location_warehouse_id are the location''s at draw time (kind NULL = a Site, 0292; warehouse NULL = org-level). actor_scope is set below manager only: in_scope / out_of_scope = caller_can_write_location of this location at the transaction''s first draw that asked (see stock_movements.draw).';
comment on type public.stock_draw is
  '0373: what a null-location stock change drew, carried by its own stock_movements row. mode is p_mode exactly as passed; item_warehouse_id is inventory_items.warehouse_id at draw time; actor_scope is service (no signed-in user) or manager (manager or above in the org) when one answer covers the whole draw, else NULL and each holding carries in_scope / out_of_scope. holdings are in draw order. Read it through public.stock_movement_holdings.';

-- Nullable, no default: metadata only, no table rewrite.
alter table public.stock_movements add column draw public.stock_draw;

comment on column public.stock_movements.draw is
  '0373: which holdings this movement''s null-location draw touched, in draw order, with draw-time facts and the drawer''s scope. Written only by the ledger (the caller passes the engine''s result into its own INSERT); the stamp trigger refuses a draw outside a ledger transaction and any later change. NULL on every other movement (explicit-location paths have from/to; post_cycle_count''s residual draw is not recorded; history starts at the 0373 push). The scope is worked out once per transaction per drawer and organization (and per location organization and warehouse below manager); a change another transaction commits between two draws of one transaction is not seen by the later draws. Read it through public.stock_movement_holdings (same visibility as the movement).';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2) The 0369 stamp trigger, extended: only the ledger writes a draw, and
--    nobody changes it afterwards.
-- ═══════════════════════════════════════════════════════════════════════════
-- num_nonnulls(new.draw) = 1, never `new.draw is not null`: on a composite,
-- IS NOT NULL is true only when EVERY field is non-null, so a forged draw
-- with one NULL field would pass it. ledger.active() is asked once per insert,
-- as before. The UPDATE rule covers every role (service_role and the owner
-- included); the trigger fires on UPDATE OF via_ledger, draw, and no other
-- trigger can set NEW.draw (section 0 refuses any other trigger).
create or replace function public.tg_stock_movements_via_ledger()
returns trigger
language plpgsql
set search_path = public
as $function$
declare
  v_active boolean;
begin
  -- SECURITY INVOKER on purpose: current_user is the role doing the write.
  -- Inside a SECURITY DEFINER body it is the owner; through PostgREST it is
  -- authenticated/anon; a cron is service_role.
  if tg_op = 'INSERT' then
    v_active := ledger.active();
    new.via_ledger := v_active or current_user not in ('authenticated', 'anon');
    -- 0373: a draw exists only on a row the ledger wrote.
    if not v_active and num_nonnulls(new.draw) = 1 then
      raise exception 'ledger_only' using errcode = '42501',
        detail = 'stock_movements.draw is written only inside a ledger transaction (0373).';
    end if;
  else
    if current_user in ('authenticated', 'anon') then
      -- stock_movements has no UPDATE policy today, so this is defence in
      -- depth: an API role can never flip the flag.
      new.via_ledger := old.via_ledger;
    end if;
    -- 0373: a draw never changes after its insert, for any role.
    if new.draw is distinct from old.draw then
      raise exception 'draw_immutable' using errcode = '42501',
        detail = 'stock_movements.draw cannot change after the movement is written (0373).';
    end if;
  end if;
  return new;
end;
$function$;

-- CREATE OR REPLACE keeps the ACL (0369: postgres, service_role) and owner.
drop trigger trg_zz_stock_movements_via_ledger on public.stock_movements;
create trigger trg_zz_stock_movements_via_ledger
  before insert or update of via_ledger, draw on public.stock_movements
  for each row execute function public.tg_stock_movements_via_ledger();


-- ═══════════════════════════════════════════════════════════════════════════
-- 3) ledger._seal: the drawer's scope, once per transaction, and the draw.
-- ═══════════════════════════════════════════════════════════════════════════
-- SECURITY INVOKER with no EXECUTE for any API role: it runs only as the
-- owner of the SECURITY DEFINER engine. No SET clause (a SET costs a GUC save
-- and restore on every call, and this runs once per recorded draw): every
-- name is schema-qualified, and it runs under the engine's
-- search_path = public.
--
-- p_uid is the caller's own v_user (auth.uid() at the caller's start, and the
-- movement's user_id), so the scope belongs to the recorded actor and costs
-- no second JWT parse. NULL = service. p_o carries each holding's location
-- organization from the draw loop; NULL marks an increment, whose Staging
-- location is keyed by its id and read on a cache miss.
--
-- The cache value is '<xid>/<uid>/<org>|<M or S>|' followed by one
-- '<key>=<I or O>|' per answer, key 'p:<location org>/<warehouse or ->' or
-- 'l:<location id>'. A value for another transaction, drawer or organization
-- is replaced, never read.
--
-- The two statements restate, for p_uid:
--   'M'  = has_org_role(p_org, 'manager'): an accepted, unexpired
--          (impersonation), not-disabled membership with role owner, admin or
--          manager (organization_members is unique on (organization_id,
--          user_id), so has_org_role's `limit 1` row is the only row);
--   'I'  = caller_can_write_location(location): the location has an
--          organization; the drawer is_org_member of it (accepted, unexpired,
--          not disabled); and either the location has no warehouse, or
--          user_can_access_warehouse(drawer, warehouse, 'write'): a membership
--          of the WAREHOUSE's organization (accepted, not disabled, no
--          impersonation filter) as owner, admin or manager, or as staff with
--          an assignment to that warehouse.
create function ledger._seal(
  p_uid  uuid,
  p_org  uuid,
  p_wh   uuid,
  p_mode text,
  p_h    public.stock_draw_holding[],
  p_o    uuid[]
)
returns public.stock_draw
language plpgsql
security invoker
as $function$
declare
  v_head pg_catalog.text;
  v_c    pg_catalog.text;
  v_key  pg_catalog.text;
  v_p    pg_catalog.int4;
  v_a    pg_catalog.text;
  v_lorg pg_catalog.uuid;
  v_lwh  pg_catalog.uuid;
  i      pg_catalog.int4;
begin
  if p_uid is null then
    return row(p_mode, p_wh, 'service', p_h)::public.stock_draw;
  end if;
  v_head := pg_catalog.pg_current_xact_id()::pg_catalog.text || '/' || p_uid::pg_catalog.text || '/'
            || coalesce(p_org::pg_catalog.text, '-') || '|';
  v_c := pg_catalog.current_setting('stockpilot.draw_scope', true);
  if v_c is null or not pg_catalog.starts_with(v_c, v_head) then
    select v_head
           || case when exists (
                select 1 from public.organization_members m
                 where m.organization_id = p_org and m.user_id = p_uid
                   and m.accepted_at is not null
                   and (m.impersonation_expires_at is null or m.impersonation_expires_at > pg_catalog.now())
                   and m.role in ('owner', 'admin', 'manager')
                   and not exists (select 1 from public.user_profiles up
                                    where up.id = m.user_id and up.disabled_at is not null))
              then 'M' else 'S' end
           || '|'
      into v_c;
    perform pg_catalog.set_config('stockpilot.draw_scope', v_c, true);
  end if;
  if pg_catalog.substr(v_c, pg_catalog.length(v_head) + 1, 1) = 'M' then
    return row(p_mode, p_wh, 'manager', p_h)::public.stock_draw;
  end if;

  for i in 1 .. pg_catalog.cardinality(p_h) loop
    if p_o[i] is null then
      v_key := '|l:' || coalesce(p_h[i].location_id::pg_catalog.text, '-') || '=';
    else
      v_key := '|p:' || p_o[i]::pg_catalog.text || '/'
               || coalesce(p_h[i].location_warehouse_id::pg_catalog.text, '-') || '=';
    end if;
    v_p := pg_catalog.strpos(v_c, v_key);
    if v_p = 0 then
      if p_o[i] is null then
        select l.organization_id, l.warehouse_id into v_lorg, v_lwh
          from public.locations l where l.id = p_h[i].location_id;
      else
        v_lorg := p_o[i];
        v_lwh  := p_h[i].location_warehouse_id;
      end if;
      select case
               when v_lorg is null then 'O'
               when not exists (
                 select 1 from public.organization_members m
                  where m.organization_id = v_lorg and m.user_id = p_uid
                    and m.accepted_at is not null
                    and (m.impersonation_expires_at is null or m.impersonation_expires_at > pg_catalog.now())
                    and not exists (select 1 from public.user_profiles up
                                     where up.id = m.user_id and up.disabled_at is not null)) then 'O'
               when v_lwh is null then 'I'
               when exists (
                 select 1 from public.warehouses w
                   join public.organization_members m on m.organization_id = w.organization_id
                  where w.id = v_lwh and m.user_id = p_uid
                    and m.accepted_at is not null
                    and not exists (select 1 from public.user_profiles up
                                     where up.id = p_uid and up.disabled_at is not null)
                    and (m.role in ('owner', 'admin', 'manager')
                         or (m.role = 'staff'
                             and exists (select 1 from public.user_warehouse_assignments a
                                          where a.user_id = p_uid and a.warehouse_id = v_lwh)))) then 'I'
               else 'O'
             end
        into v_a;
      v_c := v_c || pg_catalog.substr(v_key, 2) || v_a || '|';
      perform pg_catalog.set_config('stockpilot.draw_scope', v_c, true);
    else
      v_a := pg_catalog.substr(v_c, v_p + pg_catalog.length(v_key), 1);
    end if;
    p_h[i].actor_scope := case v_a when 'I' then 'in_scope' else 'out_of_scope' end;
  end loop;
  return row(p_mode, p_wh, null, p_h)::public.stock_draw;
end;
$function$;

revoke all on function ledger._seal(uuid, uuid, uuid, text, public.stock_draw_holding[], uuid[])
  from public, anon, authenticated, service_role;

comment on function ledger._seal(uuid, uuid, uuid, text, public.stock_draw_holding[], uuid[]) is
  '0373: builds the draw a null-location stock change returns, with the drawer''s scope: service (p_uid NULL), manager (has_org_role(org, manager)) for the whole draw, else in_scope / out_of_scope per holding (caller_can_write_location of its location). Each answer is asked once per transaction per drawer and organization (and per location organization and warehouse, or per Staging location for an increment) and kept in the transaction-local setting stockpilot.draw_scope, keyed by pg_current_xact_id(); the forget triggers clear it when the transaction changes an input. A miss runs one statement restating the pinned predicates (0373 preflight; pgTAP 0373 S2-S4). Called only by ledger.apply_level_delta_for (SECURITY DEFINER); no API role can execute it.';

-- The forget triggers: the transaction's own change to any input of the two
-- answers clears the cache, so its next draw asks again. Statement-level, so
-- a write costs one set_config however many rows it touched. Not on
-- locations INSERT: ensure_*_placement_locations inserts on every increment,
-- and no cached answer depends on a location that did not exist (a Staging
-- answer is keyed by an existing location; re-creating its id needs a DELETE,
-- which clears).
create function ledger.tg_forget_draw_scope()
returns trigger
language plpgsql
set search_path = public
as $function$
begin
  perform pg_catalog.set_config('stockpilot.draw_scope', '', true);
  return null;
end;
$function$;

revoke all on function ledger.tg_forget_draw_scope() from public, anon, authenticated, service_role;

comment on function ledger.tg_forget_draw_scope() is
  '0373: clears the transaction-local draw scope cache (stockpilot.draw_scope) after a statement changes an input of ledger._seal''s answers: organization_members, user_warehouse_assignments, user_profiles (disabled_at, id), warehouses (organization_id, id), locations (organization_id, warehouse_id, id).';

create trigger trg_zz_forget_draw_scope
  after insert or update or delete or truncate on public.organization_members
  for each statement execute function ledger.tg_forget_draw_scope();
create trigger trg_zz_forget_draw_scope
  after insert or update or delete or truncate on public.user_warehouse_assignments
  for each statement execute function ledger.tg_forget_draw_scope();
create trigger trg_zz_forget_draw_scope
  after insert or delete or truncate or update of id, disabled_at on public.user_profiles
  for each statement execute function ledger.tg_forget_draw_scope();
create trigger trg_zz_forget_draw_scope
  after insert or delete or truncate or update of id, organization_id on public.warehouses
  for each statement execute function ledger.tg_forget_draw_scope();
create trigger trg_zz_forget_draw_scope
  after delete or truncate or update of id, organization_id, warehouse_id on public.locations
  for each statement execute function ledger.tg_forget_draw_scope();


-- ═══════════════════════════════════════════════════════════════════════════
-- 4) ledger.apply_level_delta_for: the one draw engine.
-- ═══════════════════════════════════════════════════════════════════════════
-- The 0359 body of public.apply_level_delta VERBATIM plus eleven lines tagged
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
-- The bare `return;` lines are legal with an OUT parameter (they return
-- o_draw, NULL unless set). Each share is recorded as its numeric(14,4)
-- holding moved: floor(x * 10000 + 0.5) / 10000 (the increment's upsert
-- casts, a draw leaves q - take with q at four decimals; both round half up),
-- and a share that rounds to zero is not recorded.
-- NO parameter defaults (the 0306 trap). EXECUTE stays with authenticated:
-- the INVOKER ledger bodies call it as the user; the gate in the body is what
-- stops a direct call (ledger_only / forbidden; ledger is not exposed).
create function ledger.apply_level_delta_for(
  p_item_id uuid,
  p_qty     numeric,
  p_mode    text,
  p_record  boolean,
  p_uid     uuid,
  out o_draw public.stock_draw
)
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
  v_h      public.stock_draw_holding[];  -- 0373
  v_o      uuid[];  -- 0373
  v_q      numeric;  -- 0373
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
    if p_record then v_q := floor(p_qty * 10000 + 0.5) / 10000; if v_q <> 0 then o_draw := ledger._seal(p_uid, v_org, v_wh, p_mode, array[row(v_loc, v_q, 'increment', 'staging', v_wh, null)::public.stock_draw_holding], array[null::uuid]); end if; end if;  -- 0373
    return;
  end if;

  -- ---- DECREMENT: draw down by mode --------------------------------------
  v_need := -p_qty;  -- positive amount to remove

  -- staging_first: drain the Staging level(s) before placed.
  if p_mode = 'staging_first' then
    for v_lvl in
      select s.location_id, s.quantity
           , l.kind, l.warehouse_id, l.organization_id  -- 0373
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
      v_q := floor(-v_take * 10000 + 0.5) / 10000; if v_q <> 0 then v_h := v_h || row(v_lvl.location_id, v_q, 'staging_first', v_lvl.kind, v_lvl.warehouse_id, null)::public.stock_draw_holding; v_o := v_o || v_lvl.organization_id; end if;  -- 0373
    end loop;
  end if;

  -- placed draw-down (racks/areas/crates first, Unplaced last; never Staging).
  -- IS DISTINCT FROM, not <>: locations.kind is nullable (0292).
  for v_lvl in
    select s.location_id, s.quantity
         , l.kind, l.warehouse_id, l.organization_id  -- 0373
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
    v_q := floor(-v_take * 10000 + 0.5) / 10000; if v_q <> 0 then v_h := v_h || row(v_lvl.location_id, v_q, 'placed', v_lvl.kind, v_lvl.warehouse_id, null)::public.stock_draw_holding; v_o := v_o || v_lvl.organization_id; end if;  -- 0373
  end loop;

  -- *** 0341: 'any' — the placed holdings did not cover a MANUAL removal;
  -- continue into Staging (largest level first, like staging_first). Reached
  -- only in this mode and only when v_need is still positive, so 'placed'
  -- callers keep never touching Staging. ***
  if p_mode = 'any' and v_need > 0 then
    for v_lvl in
      select s.location_id, s.quantity
           , l.kind, l.warehouse_id, l.organization_id  -- 0373
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
      v_q := floor(-v_take * 10000 + 0.5) / 10000; if v_q <> 0 then v_h := v_h || row(v_lvl.location_id, v_q, 'any_staging', v_lvl.kind, v_lvl.warehouse_id, null)::public.stock_draw_holding; v_o := v_o || v_lvl.organization_id; end if;  -- 0373
    end loop;
  end if;

  if v_need > 0 then
    raise exception 'insufficient_placed_stock' using errcode = 'P0001';
  end if;
  if p_record and v_h is not null then o_draw := ledger._seal(p_uid, v_org, v_wh, p_mode, v_h, v_o); end if;  -- 0373
end;
$function$;
revoke all on function ledger.apply_level_delta_for(uuid, numeric, text, boolean, uuid) from public, anon;
grant execute on function ledger.apply_level_delta_for(uuid, numeric, text, boolean, uuid)
  to authenticated, service_role;

comment on function ledger.apply_level_delta_for(uuid, numeric, text, boolean, uuid) is
  '0373: the null-location draw engine (the 0359 apply_level_delta body verbatim plus eleven lines tagged -- 0373). + lands in the item''s warehouse Staging; - draws by mode: placed (default; racks/areas/crates/Sites by location age, Unplaced last, never Staging), staging_first (Staging largest first, then placed), any (0341: placed, then Staging); anything else draws as placed. With p_record it returns the draw (holdings touched, draw-time facts, the scope of p_uid through ledger._seal) for the caller to write into the stock_movements row it inserts next; without, it returns NULL. SECURITY DEFINER; for a signed-in caller: staff+ of the item''s org (42501 forbidden), then ledger.active() (42501 ledger_only). P0001 insufficient_placed_stock when holdings cannot cover a draw.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 5) public.apply_level_delta: the non-recording wrapper.
-- ═══════════════════════════════════════════════════════════════════════════
-- Same signature, default, return type, SECURITY DEFINER, search_path and
-- comment. Its own gate stays verbatim (INV-25, 0331 tests 23/24, 0359 test
-- 34); the engine repeats it and gives the same answer in the same
-- statement. The draw logic lives in ONE place (pattern #26).
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

  -- Since 0373: record = false moves holdings exactly as before and returns
  -- no draw. The only caller left is ledger.post_cycle_count (INV-37).
  perform ledger.apply_level_delta_for(p_item_id, p_qty, p_mode, false, null);
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
--    and comment). Each engine call is assigned to v_prov and passes
--    (true, v_user); the stock_movements INSERT right after it writes v_prov
--    into draw. v_prov is assigned only on the paths that draw, and every
--    INSERT that writes it follows its own assignment (INV-38).
-- ═══════════════════════════════════════════════════════════════════════════

-- 6a) ledger.adjust_stock (SECURITY INVOKER; 0371 text). Draw, then insert.
-- The explicit-location branch never assigns v_prov, so its row's draw is
-- NULL.
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
  v_prov public.stock_draw;  -- 0373
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
    v_prov := ledger.apply_level_delta_for(p_item_id, p_quantity_change, p_mode, true, v_user);  -- 0373
  end if;

  insert into public.stock_movements (
    draw,  -- 0373
    organization_id, item_id, movement_type,
    quantity_change, previous_quantity, new_quantity,
    from_location_id, to_location_id, reason, notes, user_id
  ) values (
    v_prov,  -- 0373
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
-- 55000). The phantom drain and each component draw; the zero-quantity
-- bundle_shortage row writes no draw.
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
  v_prov      public.stock_draw;  -- 0373
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
    v_prov := ledger.apply_level_delta_for(v_bundle.phantom_item_id, v_new - v_prev, 'staging_first', true, v_user);  -- 0373

    insert into public.stock_movements (
      draw,  -- 0373
      organization_id, item_id, movement_type, quantity_change,
      previous_quantity, new_quantity, reason, reference_type,
      reference_id, user_id, notes
    ) values (
      v_prov,  -- 0373
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
        v_prov := ledger.apply_level_delta_for(v_component.item_id, v_new - v_prev, 'placed', true, v_user);  -- 0373

        insert into public.stock_movements (
          draw,  -- 0373
          organization_id, item_id, movement_type, quantity_change,
          previous_quantity, new_quantity, reason, reference_type,
          reference_id, user_id, notes
        ) values (
          v_prov,  -- 0373
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
-- 6c) ledger.assemble_bundle (SECURITY INVOKER; 0365 text). Each component
-- draw and the kit's Staging landing.
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
  v_prov      public.stock_draw;  -- 0373
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
    v_prov := ledger.apply_level_delta_for(v_component.item_id, v_new - v_prev, 'placed', true, v_user);  -- 0373

    insert into public.stock_movements (
      draw,  -- 0373
      organization_id, item_id, movement_type, quantity_change,
      previous_quantity, new_quantity, reason, reference_type,
      reference_id, user_id, notes
    ) values (
      v_prov,  -- 0373
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
  v_prov := ledger.apply_level_delta_for(v_phantom.id, v_new - v_prev, 'staging', true, v_user);  -- 0373

  insert into public.stock_movements (
    draw,  -- 0373
    organization_id, item_id, movement_type, quantity_change,
    previous_quantity, new_quantity, reason, reference_type,
    reference_id, user_id, notes
  ) values (
    v_prov,  -- 0373
    v_org, v_phantom.id, 'bundle_assembly', p_quantity,
    v_prev, v_new, 'bundle_assembly', 'bundle',
    p_bundle_id, v_user, p_notes
  );

  return query select v_phantom.id, v_new;
end;
$function$;
-- 6d) ledger.process_return_disposition (SECURITY DEFINER). Both legs are
-- now draw-first like the other callers: the restock's Staging landing, then
-- the 'return' row; (scrap only) the staging_first draw, then the 'loss' row.
-- Nothing on stock_movements reads holdings (the stamp is its only trigger)
-- and nothing on item_stock_levels or locations reads stock_movements, so
-- the order changes nothing observable except lock order, which becomes
-- adjust_stock's (locations, then the movement).
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
  v_prov      public.stock_draw;  -- 0373
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
    -- 0373: drawn before the insert (0197 drew after it), so this row carries its own draw.
    v_prov := ledger.apply_level_delta_for(v_line.item_id, v_line.quantity, 'staging', true, v_user);  -- 0373
    insert into public.stock_movements (
      draw,  -- 0373
      organization_id, item_id, movement_type,
      quantity_change, previous_quantity, new_quantity,
      reason, reference_type, reference_id, user_id
    ) values (
      v_prov,  -- 0373
      v_return.organization_id, v_line.item_id, 'return',
      v_line.quantity, v_prev, v_new,
      'Return ' || v_line.disposition || ' (return ' || p_return_id::text || ')',
      'return', p_return_id, v_user
    );
    -- 0197: returned unit lands in Staging (+delta mirrors the on_hand increment above).

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
      -- 0373: drawn before the insert (0197 drew after it), so this row carries its own draw.
      v_prov := ledger.apply_level_delta_for(v_line.item_id, -v_line.quantity, 'staging_first', true, v_user);  -- 0373
      insert into public.stock_movements (
        draw,  -- 0373
        organization_id, item_id, movement_type,
        quantity_change, previous_quantity, new_quantity,
        reason, reference_type, reference_id, user_id
      ) values (
        v_prov,  -- 0373
        v_return.organization_id, v_line.item_id, 'loss',
        -v_line.quantity, v_prev, v_new,
        'Return scrap write-off (return ' || p_return_id::text || ')',
        'return', p_return_id, v_user
      );
      -- 0197: scrap loss drains Staging first (staging_first) so the unit that
      -- just landed in Staging is removed — net Staging change = 0 (no stranded unit).
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
-- 7) public.stock_movement_holdings: the read helper.
-- ═══════════════════════════════════════════════════════════════════════════
-- security_invoker: the reader's own SELECT on stock_movements and its RLS
-- (stock_movements_select, 0321) decide what is visible, so it can never
-- drift from the movement's visibility. One row per recorded holding; a
-- movement with no draw has no rows (unnest of NULL). `where movement_id =`
-- uses the stock_movements primary key; a lookup by location scans the
-- organization's movements (no location index, by design: add one only when
-- a screen needs it).
create view public.stock_movement_holdings
  with (security_invoker = true)
as
select m.id                                          as movement_id,
       h.seq::integer                                as seq,
       m.organization_id                             as organization_id,
       m.item_id                                     as item_id,
       h.location_id                                 as location_id,
       h.quantity                                    as quantity,
       h.step                                        as step,
       (m.draw).mode                                 as mode,
       h.location_kind                               as location_kind,
       h.location_warehouse_id                       as location_warehouse_id,
       (m.draw).item_warehouse_id                    as item_warehouse_id,
       coalesce(h.actor_scope, (m.draw).actor_scope) as actor_scope,
       m.created_at                                  as created_at
  from public.stock_movements m
 cross join lateral unnest((m.draw).holdings) with ordinality
       as h(location_id, quantity, step, location_kind, location_warehouse_id, actor_scope, seq);

-- Undo Supabase's default privileges: read-only for the API roles, nothing
-- for anon.
revoke all on table public.stock_movement_holdings from public, anon, authenticated, service_role;
grant select on table public.stock_movement_holdings to authenticated, service_role;

comment on view public.stock_movement_holdings is
  '0373: one row per holding a null-location stock change took from (quantity < 0) or landed in (quantity > 0: a Staging location), in draw order (seq), read from stock_movements.draw. security_invoker: visible exactly when the movement is (stock_movements_select). No rows for a movement without a draw: explicit-location paths (use from_location_id / to_location_id), post_cycle_count''s residual draw, and movements before the 0373 push. location_kind, location_warehouse_id, item_warehouse_id and actor_scope are facts at draw time. A source "crosses warehouses" when location_warehouse_id and item_warehouse_id are both non-null and differ (NULL means org-level, never foreign; the 0343 rule). actor_scope: service / manager / in_scope / out_of_scope, worked out once per transaction (see stock_movements.draw).';
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
  '0373: the drawer: service (no signed-in user), manager (manager or above in the org), in_scope / out_of_scope (below manager: caller_can_write_location of this holding''s location). Asked once per transaction; the direct measure for a "draw only from writable warehouses" rule.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 8) Post-checks (fail closed, 55000). The tagged-line rule and the pairing,
--    proven on the installed text.
-- ═══════════════════════════════════════════════════════════════════════════
do $post$
declare
  r record;
  v_src text;
  v_seg text;
  v_ord bigint;
begin
  -- The engine is the 0359 body plus tagged lines only.
  select p.prosrc into v_src from pg_proc p
   where p.oid = 'ledger.apply_level_delta_for(uuid,numeric,text,boolean,uuid)'::regprocedure;
  if md5(regexp_replace(v_src, '\n[^\n]*-- 0373[^\n]*', '', 'g')) <> '4be0f94c4390e7cd9c15a73e629133bf' then
    raise exception '0373 post-check: the engine is not the 0359 body plus tagged lines' using errcode = '55000';
  end if;

  -- The wrapper records nothing.
  select p.prosrc into v_src from pg_proc p
   where p.oid = 'public.apply_level_delta(uuid,numeric,text)'::regprocedure;
  if v_src !~ 'perform ledger\.apply_level_delta_for\(p_item_id, p_qty, p_mode, false, null\);' then
    raise exception '0373 post-check: public.apply_level_delta must call the engine with record = false' using errcode = '55000';
  end if;

  -- Each caller: the pre-0373 text minus its apply_level_delta lines, plus
  -- tagged lines only; every engine call is `v_prov := ...(…, true, v_user)`;
  -- every assignment is followed, before the next one, by exactly one INSERT
  -- that writes v_prov into draw, and no such INSERT precedes the first.
  for r in
    select * from (values
      ('ledger.adjust_stock(uuid,numeric,text,uuid,text,text,text)',         1, '2a3526c05ad8d2dfbd3deba457e7bf42'),
      ('ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)', 2, '04909b1f699a977aa95f9cd0cf6cc427'),
      ('ledger.assemble_bundle(uuid,numeric,uuid,text)',                     2, '19f334042018cd4667032da003b6e6ce'),
      ('ledger.process_return_disposition(uuid)',                            2, 'e13b1e104876286949d95c282008f84b')
    ) v(fn, calls, stripped_md5)
  loop
    select p.prosrc into v_src from pg_proc p where p.oid = r.fn::regprocedure;
    if (select count(*) from regexp_matches(v_src, 'v_prov := ledger\.apply_level_delta_for\([^;]*, true, v_user\);  -- 0373', 'g')) <> r.calls
       or (select count(*) from regexp_matches(v_src, 'apply_level_delta_for\(', 'g')) <> r.calls
       or (select count(*) from regexp_matches(v_src, 'insert into public\.stock_movements \(\s*draw,  -- 0373[^;]*\) values \(\s*v_prov,  -- 0373', 'g')) <> r.calls
       or v_src ~ 'public\.apply_level_delta\('
       or md5(regexp_replace(v_src, '\n[^\n]*-- 0373[^\n]*', '', 'g')) <> r.stripped_md5 then
      raise exception '0373 post-check: % is not its pre-0373 text plus the allowed tagged lines', r.fn using errcode = '55000';
    end if;
    for v_seg, v_ord in
      select g.seg, g.ord
        from regexp_split_to_table(v_src, 'v_prov := ledger\.apply_level_delta_for\(') with ordinality as g(seg, ord)
    loop
      if (select count(*) from regexp_matches(v_seg, 'insert into public\.stock_movements \(\s*draw,', 'g'))
         <> (case when v_ord = 1 then 0 else 1 end) then
        raise exception '0373 post-check: % does not pair each draw with exactly one following INSERT', r.fn using errcode = '55000';
      end if;
    end loop;
  end loop;

  -- The new column rides on the table-level grants.
  if not has_column_privilege('authenticated', 'public.stock_movements', 'draw', 'INSERT')
     or not has_column_privilege('authenticated', 'public.stock_movements', 'draw', 'SELECT') then
    raise exception '0373 post-check: authenticated cannot INSERT and SELECT stock_movements.draw' using errcode = '55000';
  end if;
end $post$;

reset lock_timeout;
