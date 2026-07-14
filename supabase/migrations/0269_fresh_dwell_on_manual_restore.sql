-- 0269_fresh_dwell_on_manual_restore.sql
--
-- Follow-up to 0268: a MANUAL restore (unarchive) of an item that is still
-- out of stock (quantity_on_hand <= 0) must grant a fresh dwell window, or
-- the next daily auto-archive cron pass re-archives it immediately.
--
-- Why the gap exists: a manual "Unarchive" write only flips `status`
-- ('archived' -> 'active'); it does not touch `quantity_on_hand`. So
-- trg_inventory_track_zero_since (0266, a BEFORE UPDATE OF quantity_on_hand
-- trigger) never fires, and `zero_since` keeps whatever old, already-past-
-- cutoff timestamp it had when the item was archived. The cron's candidate
-- query (organization_id, status='active', auto_archived=false,
-- quantity_on_hand<=0, zero_since not null and <= now()-dwellDays) matches
-- that stale zero_since on its very next run, undoing the manual restore the
-- same day.
--
-- Fix: extend 0268's trigger function (same BEFORE UPDATE OF status trigger,
-- trg_inventory_clear_auto_archived — unchanged, only the function body is
-- replaced). When a row leaves 'archived' while still at/below zero AND
-- already has a zero_since stamped, reset zero_since := now(). That starts
-- the dwell clock over, exactly as if the item had just crossed to zero
-- today. Pure NEW mutation, no self-UPDATE, so it composes with the other
-- BEFORE triggers on this table exactly like 0268 already did.
--
-- CRITICAL guard added post-review: the whole block is gated on
-- `old.status = 'archived'`, not just `new.status is distinct from
-- 'archived'`. A column-level `BEFORE UPDATE OF status` trigger fires
-- whenever `status` appears in the UPDATE's SET list, even when the value
-- is unchanged (e.g. the Edit Item form always submits `status: 'active'`
-- on every save, including plain field edits like price). Without the
-- old.status='archived' guard, that no-op re-assert on an already-active,
-- out-of-stock item would satisfy `new.status is distinct from 'archived'`
-- (true, since 'active' is distinct from 'archived') and silently reset
-- zero_since := now() on every ordinary edit — permanently deferring the
-- cron from ever archiving an actively-edited item. Requiring
-- old.status='archived' restricts both the auto_archived clear and the
-- zero_since reset to a genuine archived -> non-archived transition.
--
-- VERIFY no interference with 3 other paths, all satisfied by requiring
-- old.status = 'archived':
--
-- 1. Cron's own archive write (old.status likely 'active' -> new.status
--    'archived'): old.status = 'archived' is false, so the whole block is
--    skipped — correct, nothing to clear or reset on the way IN to archived.
--
-- 2. RESTOCK path (_auto_restock_restore, 0266's AFTER UPDATE OF
--    quantity_on_hand trigger): its guarded self-UPDATE only fires
--    `old.quantity_on_hand <= 0 and new.quantity_on_hand > 0`, and that
--    self-UPDATE sets `status = 'active'` while old.status is 'archived'
--    (satisfying the new guard) and quantity_on_hand is ALREADY > 0 (it
--    changed quantity_on_hand in the same original UPDATE that triggered the
--    restore, before this trigger runs on the self-UPDATE). So auto_archived
--    still clears correctly, but the zero_since reset guard
--    (`new.quantity_on_hand <= 0`) is FALSE — zero_since is left alone. It
--    doesn't need to be touched here anyway: `trg_inventory_track_zero_since`
--    already nulled zero_since on the ORIGINAL quantity_on_hand update (the
--    >0 crossing), before either of these status-side triggers ran. So the
--    restock path is untouched by this change.
--
-- 3. Genuine MANUAL unarchive (old.status 'archived' -> new.status
--    'active', quantity_on_hand unchanged and still <= 0, zero_since still
--    set from the original archive): old.status='archived' is true, so the
--    block runs — auto_archived clears and zero_since resets to now(),
--    granting the fresh dwell window this migration exists to provide.
--
-- Idempotent CREATE OR REPLACE; the trigger definition itself (BEFORE UPDATE
-- OF status, same function) is unchanged from 0268.

create or replace function public._clear_auto_archived_on_unarchive()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'archived' and new.status is distinct from 'archived' then
    if new.auto_archived then
      new.auto_archived := false;
    end if;
    -- Manual restore of a still-out-of-stock item: grant a fresh dwell
    -- window so the next cron run doesn't immediately re-archive it.
    if new.quantity_on_hand <= 0 and new.zero_since is not null then
      new.zero_since := now();
    end if;
  end if;
  return new;
end;
$$;
