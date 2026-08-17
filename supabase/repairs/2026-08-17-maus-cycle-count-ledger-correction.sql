-- supabase/repairs/2026-08-17-maus-cycle-count-ledger-correction.sql
-- ============================================================================
-- ONE-OFF LEDGER CORRECTION — "Maus I, My Father Bleeds History" (L4L)
-- Owner-authorised 2026-08-17. NOT a migration: run by hand, once, with psql.
--
-- WHAT IT CORRECTS
--   stock_movements row b1ee9bac-cf69-4b42-a79d-8c44b1b9044c (2026-07-23
--   17:30 UTC, post_cycle_count v3, cycle count dd5f2630-...) wrote
--   adjust -35 / previous 124 / new 89 where -20 / previous 109 / new 89 was
--   true: the 15-unit order pick at 16:26 (row 2d9b07ba, 124 -> 109) had
--   already left the shelf when the counter entered 89, and v3 measured the
--   variance against the START snapshot (124), so the pick was subtracted a
--   second time on the ledger and the count row's previous_quantity (124)
--   does not chain from the pick row's new_quantity (109). Full diagnosis:
--   the header of supabase/migrations/0339_cycle_count_rebase_expected_at_count_time.sql
--   (post_cycle_count v4 prevents the recurrence; this script repairs the
--   one row it already wrote).
--
-- WHAT IT WRITES (owner-authorised shape, exactly)
--   * ONE corrective stock_movements row for the item:
--       movement_type   'adjust'
--       quantity_change +15
--       previous_quantity = the item's on-hand at run time
--       new_quantity      = on-hand + 15
--       reason  'Corrects cycle-count double-count of 2026-07-23 (row b1ee9bac:
--                -35 written where -20 was true; see diagnosis)'
--       reference_type 'cycle_count', reference_id dd5f2630-9e62-438b-b1b6-49ef44c4e40c
--       user_id NULL (system correction, no acting user)
--   * inventory_items.quantity_on_hand + 15 (updated_by NULL).
--   * item_stock_levels reconciled through the EXISTING helper
--     public.apply_level_delta(item, +15, 'placed') — the same call
--     post_cycle_count itself makes for a positive variance. Its contract for
--     a positive delta is to land the units in the warehouse's Staging
--     location; the coordinator may then place them onto the rack with a
--     normal transfer. No level arithmetic is hand-written here.
--     adjust_stock() is NOT used: it gates on has_org_role(staff), which is
--     false for a service/postgres connection (auth.uid() is null) and would
--     stamp user_id with whichever user was impersonated; the owner asked for
--     user_id NULL. apply_level_delta explicitly allows the null-subject
--     connection (0331 header).
--
-- PETER'S RECOUNT — READ BEFORE RUNNING
--   Peter is recounting Maus. If his recount posts BEFORE this runs, this
--   correction is STILL valid — it fixes the ledger's chain (Σ quantity_change
--   is 15 short of the on-hand progression because of the -35 row), not the
--   shelf — but the ON-HAND delta must then be re-evaluated by the
--   coordinator: a recount is an authoritative statement of what the shelf
--   holds, and adding 15 to on-hand on top of it would over-state the shelf
--   by 15 unless the coordinator has established otherwise. The ledger row
--   as authorised (+15 with previous/new = on-hand/on-hand+15) is only
--   internally consistent if on-hand also moves +15, so "ledger only" is
--   not a mode this script offers; if the on-hand delta is judged wrong the
--   script must not be run as-is.
--   OBSERVED AT WRITE TIME (prod, SELECT only, 2026-08-17 ~19:20 UTC):
--     325f8e05  2026-08-17 18:06 UTC  adjust  +40  39 -> 79  "Recounted for
--               accuracy. Added 40 to current on hand, for a total of 79."
--     i.e. a recount-style adjustment has ALREADY posted; on-hand is 79,
--     Σ item_stock_levels is 79 (38-B rack 79, 100-A 0, Staging 0).
--   Because of that, the script REFUSES to apply while any movement for the
--   item is dated after 2026-08-17 18:00 UTC unless the coordinator passes
--   -v ACK_POST_RECOUNT=1, which records that the on-hand delta was
--   re-evaluated and is still wanted.
--
-- HOW TO RUN (psql only — the \if flow does not exist in the MCP/SQL editor)
--   Dry run (previews + applies inside a transaction, then ROLLS BACK):
--     psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 \
--       -f supabase/repairs/2026-08-17-maus-cycle-count-ledger-correction.sql
--   Apply (COMMITS):
--     psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 -v APPLY=1 [-v ACK_POST_RECOUNT=1] \
--       -f supabase/repairs/2026-08-17-maus-cycle-count-ledger-correction.sql
--   Connect as postgres (bypassrls; auth.uid() is null). Never as an
--   application user.
--
-- SAFETY
--   * Idempotent: guarded on reference_id + the exact reason text; a second
--     run is a NOTICE + no-op.
--   * Transactional: everything is inside one BEGIN; the post-write
--     invariant (Σ item_stock_levels = quantity_on_hand, exactly one
--     correction row) is asserted and RAISES on failure, which aborts the
--     transaction under ON_ERROR_STOP.
--   * SELECT preview first: the item, its levels and its last movements are
--     printed before anything is written, and again after.
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET off
\pset pager off

\if :{?APPLY}
\else
  \set APPLY 0
\endif
\if :{?ACK_POST_RECOUNT}
\else
  \set ACK_POST_RECOUNT 0
\endif

\set item_id   '9c481921-db94-42fe-8189-24a7c47a3937'
\set org_id    '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'
\set cc_id     'dd5f2630-9e62-438b-b1b6-49ef44c4e40c'
\set bad_row   'b1ee9bac-cf69-4b42-a79d-8c44b1b9044c'

begin;

set local repair.apply            = :'APPLY';
set local repair.ack_post_recount = :'ACK_POST_RECOUNT';

\echo
\echo '=== PREVIEW (before) ==================================================='
select current_user, auth.uid() as acting_user, now() as at;

select ii.id, ii.name, ii.sku, ii.organization_id, ii.warehouse_id,
       ii.quantity_on_hand,
       (select coalesce(sum(s.quantity), 0) from public.item_stock_levels s where s.item_id = ii.id) as levels_sum,
       ii.deleted_at
  from public.inventory_items ii
 where ii.id = :'item_id';

select l.name as location, l.kind, s.quantity
  from public.item_stock_levels s
  join public.locations l on l.id = s.location_id
 where s.item_id = :'item_id'
 order by s.quantity desc, l.name;

select id, created_at, movement_type, quantity_change, previous_quantity, new_quantity,
       reason, reference_type, reference_id, user_id
  from public.stock_movements
 where item_id = :'item_id'
 order by created_at desc
 limit 12;

select id, created_at, quantity_change, previous_quantity, new_quantity, notes
  from public.stock_movements
 where id = :'bad_row';

\echo
\echo '=== APPLY ==============================================================='
do $repair$
declare
  -- Literals are repeated here on purpose: psql does not interpolate :vars
  -- inside a dollar-quoted DO body. Keep them identical to the \set block.
  v_item_id  constant uuid    := '9c481921-db94-42fe-8189-24a7c47a3937';
  v_org_id   constant uuid    := '63c13e64-92a6-4ea4-9936-6a2c26a85b4a';
  v_cc_id    constant uuid    := 'dd5f2630-9e62-438b-b1b6-49ef44c4e40c';
  v_bad_row  constant uuid    := 'b1ee9bac-cf69-4b42-a79d-8c44b1b9044c';
  v_delta    constant numeric := 15;
  v_reason   constant text    := 'Corrects cycle-count double-count of 2026-07-23 (row b1ee9bac: -35 written where -20 was true; see diagnosis)';
  v_item     public.inventory_items%rowtype;
  v_prev     numeric(14,4);
  v_new      numeric(14,4);
  v_sum      numeric;
  v_rows     bigint;
  v_later    bigint;
begin
  -- Idempotency guard: reference_id + exact reason text.
  if exists (
      select 1 from public.stock_movements
       where item_id = v_item_id
         and reference_type = 'cycle_count'
         and reference_id = v_cc_id
         and reason = v_reason
  ) then
    raise notice 'ALREADY APPLIED: a correction row with this reference_id + reason exists — no-op.';
    return;
  end if;

  -- The row being corrected must be what the diagnosis says it is.
  if not exists (
      select 1 from public.stock_movements
       where id = v_bad_row
         and item_id = v_item_id
         and reference_type = 'cycle_count'
         and reference_id = v_cc_id
         and quantity_change = -35
         and previous_quantity = 124
         and new_quantity = 89
  ) then
    raise exception 'REFUSED: row % is not the -35 / 124 -> 89 cycle-count row this script corrects; re-check the diagnosis.', v_bad_row;
  end if;

  -- Peter's recount guard (see header): any movement after 2026-08-17 18:00 UTC
  -- means a recount-era adjustment may already have posted; the coordinator
  -- must re-evaluate the on-hand delta and pass -v ACK_POST_RECOUNT=1.
  select count(*) into v_later
    from public.stock_movements
   where item_id = v_item_id
     and created_at > timestamptz '2026-08-17 18:00:00+00';
  if v_later > 0 and current_setting('repair.ack_post_recount', true) is distinct from '1' then
    raise exception 'REFUSED: % movement(s) for this item are dated after 2026-08-17 18:00 UTC (a recount may already have posted). Re-evaluate the on-hand delta (+%) and re-run with -v ACK_POST_RECOUNT=1 if it is still wanted.', v_later, v_delta;
  end if;

  -- Lock the item and read the live on-hand: previous_quantity = live, so
  -- the correction row chains from whatever the ledger's last row left.
  select * into v_item
    from public.inventory_items
   where id = v_item_id
     and organization_id = v_org_id
     and deleted_at is null
   for update;
  if not found then
    raise exception 'REFUSED: item % not found in org % (or soft-deleted).', v_item_id, v_org_id;
  end if;

  v_prev := v_item.quantity_on_hand;
  v_new  := v_prev + v_delta;

  insert into public.stock_movements(
    organization_id, item_id, movement_type,
    quantity_change, previous_quantity, new_quantity,
    reason, notes, user_id,
    reference_type, reference_id
  ) values (
    v_org_id, v_item_id, 'adjust',
    v_delta, v_prev, v_new,
    v_reason,
    '[repair 2026-08-17] Ledger correction for cycle count ' || v_cc_id::text
      || ': row ' || v_bad_row::text
      || ' recorded adjust -35 (previous 124, new 89) at post time, but the -15 order pick of 16:26 UTC (row 2d9b07ba, 124 -> 109) had already left the shelf when 89 was counted, so the true count adjustment was -20 (previous 109, new 89). This row restores the 15 units subtracted twice. Levels reconciled via apply_level_delta(+15, placed): the units land in Staging. Diagnosis: migration 0339 header.',
    null,
    'cycle_count', v_cc_id
  );

  update public.inventory_items
     set quantity_on_hand = v_new,
         updated_by = null
   where id = v_item_id
     and deleted_at is null;

  -- Level reconciliation THROUGH THE EXISTING HELPER (post_cycle_count's own
  -- tail): +delta lands in the warehouse's Staging location.
  perform public.apply_level_delta(v_item_id, v_delta, 'placed');

  -- Post-write invariants.
  select coalesce(sum(quantity), 0) into v_sum
    from public.item_stock_levels where item_id = v_item_id;
  if v_sum <> v_new then
    raise exception 'INVARIANT FAILED: sum(item_stock_levels) = % but quantity_on_hand = % after the repair — rolled back.', v_sum, v_new;
  end if;
  select count(*) into v_rows
    from public.stock_movements
   where item_id = v_item_id and reference_id = v_cc_id and reason = v_reason;
  if v_rows <> 1 then
    raise exception 'INVARIANT FAILED: % correction rows found, expected exactly 1 — rolled back.', v_rows;
  end if;

  raise notice 'APPLIED: adjust +% (previous %, new %) for item %; levels sum = %.', v_delta, v_prev, v_new, v_item_id, v_sum;
end
$repair$;

\echo
\echo '=== PREVIEW (after) ===================================================='
select ii.id, ii.quantity_on_hand,
       (select coalesce(sum(s.quantity), 0) from public.item_stock_levels s where s.item_id = ii.id) as levels_sum
  from public.inventory_items ii
 where ii.id = :'item_id';

select l.name as location, l.kind, s.quantity
  from public.item_stock_levels s
  join public.locations l on l.id = s.location_id
 where s.item_id = :'item_id'
 order by s.quantity desc, l.name;

select id, created_at, movement_type, quantity_change, previous_quantity, new_quantity,
       reason, reference_type, reference_id, user_id
  from public.stock_movements
 where item_id = :'item_id'
 order by created_at desc
 limit 5;

\if :APPLY
  \echo
  \echo '=== APPLY=1: COMMITTING ================================================='
  commit;
\else
  \echo
  \echo '=== DRY RUN (no -v APPLY=1): ROLLING BACK ==============================='
  rollback;
\endif
