-- supabase/tests/0266_auto_archive_out_of_stock.test.sql
-- pgTAP for migration 0266 (auto-archive-on-zero-stock: zero_since +
-- auto_archived columns, trg_inventory_track_zero_since (BEFORE) and
-- trg_inventory_auto_restock_restore (AFTER)) plus migration 0268
-- (trg_inventory_clear_auto_archived (BEFORE UPDATE OF status), which
-- enforces auto_archived=true only while status='archived' on every
-- status-only write path, not just the quantity-change path above) plus
-- migration 0269 (same trigger function, extended: a manual restore of a
-- STILL-out-of-stock item also resets zero_since to grant a fresh dwell
-- window, so the next cron pass doesn't immediately re-archive it):
--   1. Crossing to zero stamps zero_since.
--   2. Staying at/below zero keeps the original zero_since (does not reset).
--   3. A system-archived item (auto_archived=true) at zero, when restocked,
--      is auto-restored: status -> active, auto_archived -> false,
--      zero_since -> null.
--   4. A MANUALLY archived item (auto_archived=false) is NOT restored on
--      restock — the self-UPDATE's `auto_archived = true` guard excludes it.
--   5. A MANUAL unarchive (status archived -> active, no quantity change)
--      clears auto_archived even though nothing touched quantity_on_hand —
--      this is the 0268 gap-closer, exercised on a path _auto_restock_restore
--      never runs.
--   6. The cron's own archive write (status -> archived, auto_archived ->
--      true) is left alone by 0268's trigger: new.status = 'archived' so the
--      condition is false and auto_archived stays true.
--   7. (0269) A MANUAL unarchive of a STILL-out-of-stock item (quantity_on_hand
--      unchanged, still <= 0) resets zero_since to ~now, discarding the old
--      stale (past-cutoff) value, so the item gets a fresh dwell window.
--   8. (0269) The RESTOCK path is unaffected: restocking (quantity_on_hand
--      0 -> positive) an archived+auto_archived item still ends with
--      zero_since IS NULL, nulled by _track_zero_since on the original
--      update's >0 crossing — not reset by 0269's new branch, because by the
--      time the self-UPDATE flips status, quantity_on_hand is already > 0
--      and the reset guard (`quantity_on_hand <= 0`) is false.
--   9. (0269 CRITICAL regression, post-review) A no-op status re-assert
--      (`status='active'` written on an already-ACTIVE item, exactly what
--      the Edit Item form submits on every ordinary save, e.g. a price
--      edit) must NOT reset zero_since. Before the old.status='archived'
--      guard was added, this column-level BEFORE UPDATE OF status trigger
--      fired on every such write (status is in the SET list even though the
--      value doesn't change) and `new.status is distinct from 'archived'`
--      was true, so it clobbered zero_since := now() on an out-of-stock
--      item that was never archived — permanently deferring the cron from
--      ever archiving an actively-edited item. Asserts the stale zero_since
--      is left untouched.
--
-- Fixture: one org + one active item at qty 10. organizations.slug (0001) and
-- inventory_items.sku (0002) are NOT NULL with no default, so both are
-- supplied here even though the feature brief's illustrative fixture omitted
-- them. Everything else (assertions, update sequence) matches the brief
-- verbatim. Wrapped in begin/rollback so nothing leaks.

begin;

select plan(14);

insert into public.organizations (id, name, slug)
  values ('00000000-0000-0000-0000-0000000000a1', 'pgtap-org', 'pgtap-auto-archive-org')
  on conflict do nothing;

insert into public.inventory_items (id, organization_id, sku, name, quantity_on_hand, status)
  values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000a1','PGTAP-AUTO-ARCHIVE','pgtap-item',10,'active');

-- 1. Crossing to zero stamps zero_since.
update public.inventory_items set quantity_on_hand = 0 where id='00000000-0000-0000-0000-0000000000b1';
select isnt((select zero_since from public.inventory_items where id='00000000-0000-0000-0000-0000000000b1'), null,
  'zero_since is set when qty crosses to 0');

-- 2. Staying at/below zero keeps the original zero_since (does not reset).
-- The second UPDATE below re-writes quantity_on_hand as 0 rather than -1. It
-- used to write -1, which migration 0322's
-- inventory_items_quantity_on_hand_nonneg CHECK now refuses (MED-11: a negative
-- on-hand was reachable only by a direct PostgREST PATCH or a cycle count
-- carrying a negative counted_quantity — never by any RPC, all of which raise
-- insufficient_stock first). The assertion is unchanged and still exercises the
-- SAME branch of _track_zero_since: `before update of quantity_on_hand` fires
-- on any UPDATE naming the column, and with old = 0 and new = 0 neither of the
-- function's two if-branches is taken, so zero_since must survive untouched.
-- 0322's own test file asserts the negative write is refused.
update public.inventory_items set zero_since = now() - interval '10 days' where id='00000000-0000-0000-0000-0000000000b1';
update public.inventory_items set quantity_on_hand = 0 where id='00000000-0000-0000-0000-0000000000b1';
select cmp_ok((select zero_since from public.inventory_items where id='00000000-0000-0000-0000-0000000000b1'), '<',
  now() - interval '1 day', 'zero_since is preserved while still <= 0');

-- 3. A system-archived item at zero, when restocked, is auto-restored.
update public.inventory_items set status='archived', auto_archived=true where id='00000000-0000-0000-0000-0000000000b1';
update public.inventory_items set quantity_on_hand = 5 where id='00000000-0000-0000-0000-0000000000b1';
select is((select status from public.inventory_items where id='00000000-0000-0000-0000-0000000000b1'), 'active',
  'restock auto-restores a system-archived item');
select is((select auto_archived from public.inventory_items where id='00000000-0000-0000-0000-0000000000b1'), false,
  'restore clears auto_archived');
select is((select zero_since from public.inventory_items where id='00000000-0000-0000-0000-0000000000b1'), null,
  'restock clears zero_since');
select is((select archived_at from public.inventory_items where id='00000000-0000-0000-0000-0000000000b1'), null,
  'restock auto-restore clears archived_at (0184 trigger)');

-- 4. A MANUALLY archived item (auto_archived=false) is NOT restored on restock.
update public.inventory_items set quantity_on_hand=0 where id='00000000-0000-0000-0000-0000000000b1';
update public.inventory_items set status='archived', auto_archived=false where id='00000000-0000-0000-0000-0000000000b1';
update public.inventory_items set quantity_on_hand=8 where id='00000000-0000-0000-0000-0000000000b1';
select is((select status from public.inventory_items where id='00000000-0000-0000-0000-0000000000b1'), 'archived',
  'restock does NOT revive a manually-archived item');

-- 5. (0268) A MANUAL unarchive (status-only write, no quantity change)
-- clears auto_archived. Set up a system-archived item first.
update public.inventory_items set status='archived', auto_archived=true where id='00000000-0000-0000-0000-0000000000b1';
update public.inventory_items set status='active' where id='00000000-0000-0000-0000-0000000000b1';
select is((select auto_archived from public.inventory_items where id='00000000-0000-0000-0000-0000000000b1'), false,
  'manual unarchive (status-only write) clears auto_archived (0268)');

-- 6. (0268) The cron's own archive write (status -> archived, auto_archived
-- -> true) is unaffected: auto_archived stays true.
update public.inventory_items set status='archived', auto_archived=true where id='00000000-0000-0000-0000-0000000000b1';
select is((select auto_archived from public.inventory_items where id='00000000-0000-0000-0000-0000000000b1'), true,
  'cron archive write leaves auto_archived true (0268 does not interfere)');

-- 7. (0269) A MANUAL unarchive of a STILL-out-of-stock item resets
-- zero_since to a fresh dwell window. Force the item into archived +
-- auto_archived + zero qty, stamp a stale (8-days-ago) zero_since, then do
-- a status-only manual unarchive and assert BOTH auto_archived clears AND
-- zero_since jumps forward to ~now (not the stale 8-day-old value).
update public.inventory_items
  set status='archived', auto_archived=true, quantity_on_hand=0
  where id='00000000-0000-0000-0000-0000000000b1';
update public.inventory_items set zero_since = now() - interval '8 days'
  where id='00000000-0000-0000-0000-0000000000b1';
update public.inventory_items set status='active'
  where id='00000000-0000-0000-0000-0000000000b1';
select is((select auto_archived from public.inventory_items where id='00000000-0000-0000-0000-0000000000b1'), false,
  'manual restore of a still-zero item clears auto_archived (0269)');
select cmp_ok((select zero_since from public.inventory_items where id='00000000-0000-0000-0000-0000000000b1'), '>',
  now() - interval '1 minute',
  'manual restore of a still-zero item resets zero_since to ~now, not the stale 8-day-old value (0269)');

-- 8. (0269) The RESTOCK path is unaffected: restocking (quantity_on_hand
-- 0 -> positive) an archived+auto_archived item still ends with zero_since
-- IS NULL — nulled by _track_zero_since on the original update's >0
-- crossing, not reset by 0269's new branch (by the time the self-UPDATE
-- flips status, quantity_on_hand is already > 0, so the reset guard is false).
update public.inventory_items
  set status='archived', auto_archived=true, quantity_on_hand=0
  where id='00000000-0000-0000-0000-0000000000b1';
update public.inventory_items set zero_since = now() - interval '10 days'
  where id='00000000-0000-0000-0000-0000000000b1';
update public.inventory_items set quantity_on_hand=5
  where id='00000000-0000-0000-0000-0000000000b1';
select is((select status from public.inventory_items where id='00000000-0000-0000-0000-0000000000b1'), 'active',
  'restock still auto-restores through 0269 (unaffected)');
select is((select zero_since from public.inventory_items where id='00000000-0000-0000-0000-0000000000b1'), null,
  'restock path still ends with zero_since NULL, not reset by 0269 (0269 does not interfere)');

-- 9. (0269 CRITICAL regression) A no-op status re-assert on an already-
-- ACTIVE, out-of-stock item (mimicking the Edit Item form, which always
-- submits status='active' unchanged on every ordinary save) must NOT reset
-- zero_since. Set the item active + zero qty with a stale (10-days-ago)
-- zero_since, then issue the same-value status write.
update public.inventory_items
  set status='active', auto_archived=false, quantity_on_hand=0
  where id='00000000-0000-0000-0000-0000000000b1';
update public.inventory_items set zero_since = now() - interval '10 days'
  where id='00000000-0000-0000-0000-0000000000b1';
update public.inventory_items set status='active'
  where id='00000000-0000-0000-0000-0000000000b1';
select cmp_ok((select zero_since from public.inventory_items where id='00000000-0000-0000-0000-0000000000b1'), '<',
  now() - interval '1 day',
  'no-op status re-assert on an already-active item does NOT reset zero_since (0269 CRITICAL fix)');

select * from finish();
rollback;
