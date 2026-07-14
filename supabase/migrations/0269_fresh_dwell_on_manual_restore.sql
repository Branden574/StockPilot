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
-- VERIFY no interference with the RESTOCK path (_auto_restock_restore,
-- 0266's AFTER UPDATE OF quantity_on_hand trigger): that trigger's guarded
-- self-UPDATE only fires `old.quantity_on_hand <= 0 and new.quantity_on_hand
-- > 0`, and its self-UPDATE sets `status = 'active'` while quantity_on_hand
-- is ALREADY > 0 (it changed quantity_on_hand in the same original UPDATE
-- that triggered the restore, before this trigger even runs on the
-- self-UPDATE). So when this trigger fires on that self-UPDATE, `new.status
-- is distinct from 'archived'` is true, but `new.quantity_on_hand <= 0` is
-- FALSE — the reset condition below does not apply, and zero_since is left
-- alone. It doesn't need to be touched here anyway: `trg_inventory_track_
-- zero_since` already nulled zero_since on the ORIGINAL quantity_on_hand
-- update (the >0 crossing), before either of these status-side triggers
-- ran. So the restock path is untouched by this change; only a genuine
-- manual restore of a STILL-zero item (quantity_on_hand unchanged, zero_since
-- still set from the original archive) hits the new branch.
--
-- Idempotent CREATE OR REPLACE; the trigger definition itself (BEFORE UPDATE
-- OF status, same function) is unchanged from 0268.

create or replace function public._clear_auto_archived_on_unarchive()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from 'archived' then
    if new.auto_archived then
      new.auto_archived := false;
    end if;
    -- Manual restore of a still-out-of-stock item: grant a fresh dwell
    -- window so the next cron run doesn't immediately re-archive it.
    if new.quantity_on_hand <= 0 and new.zero_since is not null then
      new.zero_since := now();
    end if;
    return new;
  end if;
  return new;
end;
$$;
