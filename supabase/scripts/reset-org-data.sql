-- ============================================================================
-- reset-org-data.sql
-- ============================================================================
-- Wipes transactional/test data for ONE organization so live testing can
-- start from a clean slate. Schema, users, org settings, warehouses,
-- charters, and (optionally) categories/suppliers/locations are kept.
--
-- HOW TO USE
--   1. Find your organization id:
--        select id, name, slug from public.organizations order by created_at;
--   2. Edit the line below to set your org id.
--   3. Paste this whole file into Supabase → SQL Editor → New query → Run.
--   4. Read the row counts that print at the start vs end. Anything that
--      shouldn't have been wiped, comment out before re-running.
--
-- SAFETY
--   - All deletes are scoped by organization_id (or by FK chain to it),
--     so other tenants are untouched.
--   - Wrapped in a transaction. If anything throws, nothing commits —
--     re-run after fixing whatever flagged.
--   - Idempotent: running it twice is a no-op the second time.
-- ============================================================================

\set org_id '''00000000-0000-0000-0000-000000000000'''  -- ← REPLACE THIS

begin;

-- ---------------------------------------------------------------------------
-- BEFORE: counts so you can sanity-check what's about to be wiped
-- ---------------------------------------------------------------------------
select 'BEFORE' as snapshot;
select 'inventory_items'         as t, count(*) from public.inventory_items         where organization_id = :org_id
union all
select 'stock_movements'         as t, count(*) from public.stock_movements         where organization_id = :org_id
union all
select 'purchase_orders'         as t, count(*) from public.purchase_orders         where organization_id = :org_id
union all
select 'cycle_counts'            as t, count(*) from public.cycle_counts            where organization_id = :org_id
union all
select 'po_imports'              as t, count(*) from public.po_imports              where organization_id = :org_id
union all
select 'notifications'           as t, count(*) from public.notifications           where organization_id = :org_id
union all
select 'audit_logs'              as t, count(*) from public.audit_logs              where organization_id = :org_id
union all
select 'ai_chat_sessions'        as t, count(*) from public.ai_chat_sessions        where organization_id = :org_id
union all
select 'categories'              as t, count(*) from public.categories              where organization_id = :org_id
union all
select 'suppliers'               as t, count(*) from public.suppliers               where organization_id = :org_id
union all
select 'locations'               as t, count(*) from public.locations               where organization_id = :org_id;

-- ---------------------------------------------------------------------------
-- TRANSACTIONAL DATA — always safe to wipe before going live
-- ---------------------------------------------------------------------------

-- AI assistant chat history (your test conversations)
delete from public.ai_chat_sessions where organization_id = :org_id;
-- ai_chat_messages cascades

-- Notifications + audit + outbox (test noise)
delete from public.notifications  where organization_id = :org_id;
delete from public.audit_logs     where organization_id = :org_id;
delete from public.outbox_events  where exists (
  select 1 from public.organizations o
   where o.id = :org_id
     and (outbox_events.payload ->> 'organization_id') = o.id::text
);
-- idempotency_keys is keyed by org_id when present
delete from public.idempotency_keys where organization_id = :org_id;

-- Cycle counts + their lines
delete from public.cycle_count_lines where exists (
  select 1 from public.cycle_counts cc
   where cc.id = cycle_count_lines.cycle_count_id
     and cc.organization_id = :org_id
);
delete from public.cycle_counts where organization_id = :org_id;

-- Receipts pipeline (children → parents)
delete from public.receipt_line_lots where exists (
  select 1 from public.receipt_lines rl
    join public.receipts r on r.id = rl.receipt_id
   where rl.id = receipt_line_lots.receipt_line_id
     and r.organization_id = :org_id
);
delete from public.receipt_lines where exists (
  select 1 from public.receipts r
   where r.id = receipt_lines.receipt_id
     and r.organization_id = :org_id
);
delete from public.receipts where organization_id = :org_id;

-- Approvals tied to org
delete from public.approvals where organization_id = :org_id;

-- Putaway moves
delete from public.putaway_moves where organization_id = :org_id;

-- Purchase orders + items
delete from public.purchase_order_items where exists (
  select 1 from public.purchase_orders po
   where po.id = purchase_order_items.purchase_order_id
     and po.organization_id = :org_id
);
delete from public.purchase_orders where organization_id = :org_id;

-- PO import staging
delete from public.po_import_lines where exists (
  select 1 from public.po_imports pi
   where pi.id = po_import_lines.po_import_id
     and pi.organization_id = :org_id
);
delete from public.po_imports where organization_id = :org_id;

-- Generic import jobs (CSV item imports etc.)
delete from public.import_job_errors where exists (
  select 1 from public.import_jobs ij
   where ij.id = import_job_errors.import_job_id
     and ij.organization_id = :org_id
);
delete from public.import_jobs where organization_id = :org_id;

-- Stock movements (must come BEFORE inventory_items if no FK cascade)
delete from public.stock_movements where organization_id = :org_id;

-- Item-level satellites
delete from public.item_attachments    where exists (select 1 from public.inventory_items i where i.id = item_attachments.item_id    and i.organization_id = :org_id);
delete from public.item_images         where exists (select 1 from public.inventory_items i where i.id = item_images.item_id         and i.organization_id = :org_id);
delete from public.item_tags           where exists (select 1 from public.inventory_items i where i.id = item_tags.item_id           and i.organization_id = :org_id);
delete from public.item_stock_levels   where exists (select 1 from public.inventory_items i where i.id = item_stock_levels.item_id   and i.organization_id = :org_id);
delete from public.serial_registry     where exists (select 1 from public.inventory_items i where i.id = serial_registry.item_id     and i.organization_id = :org_id);
delete from public.inventory_stock     where exists (select 1 from public.inventory_items i where i.id = inventory_stock.item_id     and i.organization_id = :org_id);

-- The big one
delete from public.inventory_items where organization_id = :org_id;

-- Vendor mappings (test PO mappings, harmless to wipe)
delete from public.vendor_item_mappings where organization_id = :org_id;

-- ---------------------------------------------------------------------------
-- OPTIONAL — comment OUT any of these you set up intentionally and want
-- to keep. Most teams will keep their warehouses/charters but wipe the
-- demo categories/suppliers/locations they made while clicking around.
-- ---------------------------------------------------------------------------

-- Demo categories you created while testing
delete from public.categories where organization_id = :org_id;

-- Demo suppliers
delete from public.suppliers where organization_id = :org_id;

-- Locations + bins. Both have organization_id directly — bins also
-- references warehouse_id but for a wipe we just nuke by org.
-- Skip these if you've set up real bin/location hierarchy to keep.
delete from public.bins      where organization_id = :org_id;
delete from public.locations where organization_id = :org_id;

-- ---------------------------------------------------------------------------
-- KEEP (do NOT wipe these):
--   organizations            ← your tenant row
--   organization_members     ← your team
--   organization_invites     ← pending invites
--   user_profiles            ← user names + avatars
--   warehouses               ← the warehouses you built
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
-- AFTER: counts to confirm everything is zero
-- ---------------------------------------------------------------------------
select 'AFTER' as snapshot;
select 'inventory_items'         as t, count(*) from public.inventory_items         where organization_id = :org_id
union all
select 'stock_movements'         as t, count(*) from public.stock_movements         where organization_id = :org_id
union all
select 'purchase_orders'         as t, count(*) from public.purchase_orders         where organization_id = :org_id
union all
select 'cycle_counts'            as t, count(*) from public.cycle_counts            where organization_id = :org_id
union all
select 'ai_chat_sessions'        as t, count(*) from public.ai_chat_sessions        where organization_id = :org_id
union all
select 'categories'              as t, count(*) from public.categories              where organization_id = :org_id
union all
select 'suppliers'               as t, count(*) from public.suppliers               where organization_id = :org_id;

commit;
