-- 0031_reset_l4l_fresno_test_data.sql
-- ============================================================================
-- One-time data wipe for the L4L Fresno organization (id 63c13e64-…85b4a)
-- to clear out test data before going live. Schema, users, warehouses,
-- charters, and warehouse-charter pairings are preserved.
--
-- This is a DATA migration, not a schema migration — running it on a
-- fresh DB with no rows for that org is a safe no-op (every delete
-- targets that one org id and matches zero rows). Idempotent on repeat.
--
-- HOW TO USE
--   Apply via your normal migration flow, OR paste into Supabase →
--   SQL Editor → New query → Run. The transaction wrap means a partial
--   failure rolls back cleanly with no data lost.
--
-- HOW IT WAS BUILT
--   Each delete is scoped by organization_id (directly or via an FK
--   chain to it) so it's impossible to nuke another tenant's rows.
--   The "OPTIONAL" block (categories, suppliers, locations, bins) is
--   on by default — comment those out and re-run if you want to keep
--   any of those rows.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- BEFORE counts — useful as a sanity check when reviewing the migration's
-- output. Runs harmlessly on a fresh DB (returns zeros).
-- ---------------------------------------------------------------------------
select 'BEFORE' as snapshot;
select 'inventory_items'  as t, count(*) from public.inventory_items  where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'
union all
select 'stock_movements'  as t, count(*) from public.stock_movements  where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'
union all
select 'purchase_orders'  as t, count(*) from public.purchase_orders  where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'
union all
select 'cycle_counts'     as t, count(*) from public.cycle_counts     where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'
union all
select 'po_imports'       as t, count(*) from public.po_imports       where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'
union all
select 'notifications'    as t, count(*) from public.notifications    where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'
union all
select 'audit_logs'       as t, count(*) from public.audit_logs       where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'
union all
select 'ai_chat_sessions' as t, count(*) from public.ai_chat_sessions where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'
union all
select 'categories'       as t, count(*) from public.categories       where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'
union all
select 'suppliers'        as t, count(*) from public.suppliers        where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'
union all
select 'locations'        as t, count(*) from public.locations        where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'
union all
select 'bins'             as t, count(*) from public.bins             where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a';

-- ---------------------------------------------------------------------------
-- TRANSACTIONAL DATA — always wiped
-- ---------------------------------------------------------------------------

delete from public.ai_chat_sessions where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a';
delete from public.notifications    where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a';
delete from public.audit_logs       where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a';
delete from public.idempotency_keys where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a';

delete from public.cycle_count_lines where exists (
  select 1 from public.cycle_counts cc
   where cc.id = cycle_count_lines.cycle_count_id
     and cc.organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'
);
delete from public.cycle_counts where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a';

delete from public.receipt_line_lots where exists (
  select 1 from public.receipt_lines rl
    join public.receipts r on r.id = rl.receipt_id
   where rl.id = receipt_line_lots.receipt_line_id
     and r.organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'
);
delete from public.receipt_lines where exists (
  select 1 from public.receipts r
   where r.id = receipt_lines.receipt_id
     and r.organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'
);
delete from public.receipts where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a';

delete from public.approvals    where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a';
delete from public.putaway_moves where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a';

delete from public.purchase_order_items where exists (
  select 1 from public.purchase_orders po
   where po.id = purchase_order_items.purchase_order_id
     and po.organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'
);
delete from public.purchase_orders where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a';

delete from public.po_import_lines where exists (
  select 1 from public.po_imports pi
   where pi.id = po_import_lines.po_import_id
     and pi.organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'
);
delete from public.po_imports where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a';

delete from public.import_job_errors where exists (
  select 1 from public.import_jobs ij
   where ij.id = import_job_errors.import_job_id
     and ij.organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'
);
delete from public.import_jobs where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a';

delete from public.stock_movements where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a';

delete from public.item_attachments    where exists (select 1 from public.inventory_items i where i.id = item_attachments.item_id    and i.organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a');
delete from public.item_images         where exists (select 1 from public.inventory_items i where i.id = item_images.item_id         and i.organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a');
delete from public.item_tags           where exists (select 1 from public.inventory_items i where i.id = item_tags.item_id           and i.organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a');
delete from public.item_stock_levels   where exists (select 1 from public.inventory_items i where i.id = item_stock_levels.item_id   and i.organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a');
delete from public.serial_registry     where exists (select 1 from public.inventory_items i where i.id = serial_registry.item_id     and i.organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a');
delete from public.inventory_stock     where exists (select 1 from public.inventory_items i where i.id = inventory_stock.item_id     and i.organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a');

delete from public.inventory_items where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a';

delete from public.vendor_item_mappings where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a';

-- ---------------------------------------------------------------------------
-- OPTIONAL — comment OUT any block you set up intentionally and want to keep.
-- (Suppliers like "Amazon Capital Services" / "Staples Advantage", the
-- "Novel" category, DC4's bin/location hierarchy.)
-- ---------------------------------------------------------------------------

delete from public.categories where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a';
delete from public.suppliers  where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a';

delete from public.bins      where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a';
delete from public.locations where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a';

-- ---------------------------------------------------------------------------
-- KEEP (do NOT wipe these):
--   organizations            ← your tenant row
--   organization_members     ← your team
--   organization_invites     ← pending invites
--   user_profiles            ← user names + avatars
--   warehouses               ← the warehouses you built (DC4)
--   charters                 ← charters
--   warehouse_charters       ← warehouse↔charter pairings
--   user_warehouse_assignments
--   tolerance_profiles       ← receipt tolerance rules
--   tags                     ← tag definitions
--   uom_conversions          ← unit-of-measure conversions
--   mfa_recovery_codes       ← MFA backup codes
--   push_tokens              ← mobile push registrations
--   notification_preferences ← per-user notif settings
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- AFTER counts (should all be 0 after a successful run)
-- ---------------------------------------------------------------------------
select 'AFTER' as snapshot;
select 'inventory_items'  as t, count(*) from public.inventory_items  where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'
union all
select 'stock_movements'  as t, count(*) from public.stock_movements  where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'
union all
select 'purchase_orders'  as t, count(*) from public.purchase_orders  where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'
union all
select 'cycle_counts'     as t, count(*) from public.cycle_counts     where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'
union all
select 'ai_chat_sessions' as t, count(*) from public.ai_chat_sessions where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'
union all
select 'categories'       as t, count(*) from public.categories       where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'
union all
select 'suppliers'        as t, count(*) from public.suppliers        where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'
union all
select 'locations'        as t, count(*) from public.locations        where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'
union all
select 'bins'             as t, count(*) from public.bins             where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a';

commit;
