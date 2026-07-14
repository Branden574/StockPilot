-- supabase/tests/0266_auto_archive_out_of_stock.test.sql
-- pgTAP for migration 0266 (auto-archive-on-zero-stock: zero_since +
-- auto_archived columns, trg_inventory_track_zero_since (BEFORE) and
-- trg_inventory_auto_restock_restore (AFTER)) plus migration 0268
-- (trg_inventory_clear_auto_archived (BEFORE UPDATE OF status), which
-- enforces auto_archived=true only while status='archived' on every
-- status-only write path, not just the quantity-change path above):
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
--
-- Fixture: one org + one active item at qty 10. organizations.slug (0001) and
-- inventory_items.sku (0002) are NOT NULL with no default, so both are
-- supplied here even though the feature brief's illustrative fixture omitted
-- them. Everything else (assertions, update sequence) matches the brief
-- verbatim. Wrapped in begin/rollback so nothing leaks.

begin;

select plan(9);

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
update public.inventory_items set zero_since = now() - interval '10 days' where id='00000000-0000-0000-0000-0000000000b1';
update public.inventory_items set quantity_on_hand = -1 where id='00000000-0000-0000-0000-0000000000b1';
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

select * from finish();
rollback;
