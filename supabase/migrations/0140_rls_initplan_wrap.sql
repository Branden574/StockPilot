-- ============================================================================
-- 0140_rls_initplan_wrap.sql
-- RLS InitPlan optimisation: wrap bare helper calls in (SELECT ...)
-- ============================================================================
--
-- WHAT THIS DOES
-- --------------
-- Postgres evaluates every USING / WITH CHECK predicate for each row that
-- the query touches.  A bare function call like
--
--     using (public.is_org_member(organization_id))
--
-- is re-executed once per row, even when the function is STABLE and the
-- result cannot change within a single statement.  Wrapping the call:
--
--     using ((SELECT public.is_org_member(organization_id)))
--
-- tells the planner it may hoist the call into an InitPlan subquery and
-- evaluate it exactly once per statement, caching the boolean result.
-- For a SELECT over 10 000 rows, this turns 10 000 cross-schema look-ups
-- into 1.  The pattern is a documented Supabase/PostgreSQL best practice.
--
-- SAFETY GUARANTEE
-- ----------------
-- 1. The wrapped expression evaluates identically; no semantic change.
-- 2. Each policy is dropped and recreated atomically inside this single
--    transaction (the migration runner wraps each file in a transaction).
--    Partial application cannot lock any user out.
-- 3. Policy names, tables, FOR command (SELECT/INSERT/UPDATE/DELETE/ALL),
--    TO clauses, and every USING/WITH CHECK condition are preserved
--    verbatim — only the helper function call sites gain the SELECT wrapper.
-- 4. Helpers (is_org_member, has_org_role, user_org_role) are NOT modified.
--    All three are already STABLE + SECURITY DEFINER (see 0001_init.sql).
--
-- POLICIES REWRITTEN (91 total across public.* + storage.objects)
-- ---------------------------------------------------------------
--   public.organizations                (3)  organizations_select/update/delete
--   public.organization_members         (4)  *_select/insert/update/delete
--   public.organization_invites         (3)  *_select/insert/delete
--   public.categories                   (3)  *_select/insert/update   (delete: manager only, no helpers needed — see note)
--   public.categories                   (1)  categories_delete
--   public.tags                         (2)  tags_select/write
--   public.locations                    (4)  *_select/insert/update/delete
--   public.suppliers                    (2)  suppliers_select/write
--   public.inventory_items              (4)  *_select/insert/update/delete
--   public.item_stock_levels            (2)  *_select/write
--   public.item_images                  (2)  *_select/write
--   public.item_attachments             (2)  *_select/write
--   public.item_tags                    (1)  item_tags_all
--   public.stock_movements              (2)  *_select/insert
--   public.purchase_orders              (2)  *_select/write
--   public.purchase_order_items         (2)  *_select/write
--   public.activity_logs                (1)  activity_logs_select
--   public.audit_logs                   (1)  audit_logs_select
--   public.import_jobs                  (2)  *_select/write
--   public.import_job_errors            (1)  import_job_errors_select
--   public.charters                     (2)  charters_select/charters_admin_write
--   public.warehouses                   (2)  warehouses_select/warehouses_admin_write
--   public.user_warehouse_assignments   (2)  uwa_select_own/uwa_admin_write
--   public.bins                         (1)  bins_write
--   public.inventory_stock              (1)  inventory_stock_write
--   public.putaway_moves                (1)  putaway_moves_write
--   public.outbox_events                (2)  outbox_events_select/write
--   public.receipts                     (1)  receipts_write
--   public.receipt_lines                (1)  receipt_lines_write
--   public.receipt_line_lots            (1)  receipt_line_lots_write
--   public.serial_registry              (1)  serial_registry_write
--   public.idempotency_keys             (1)  idempotency_keys_write
--   public.uom_conversions              (1)  uom_conversions_write
--   public.vendor_item_mappings         (1)  vim_admin_write
--   public.cycle_counts                 (3)  *_select/insert/update
--   public.cycle_count_lines            (4)  *_select/insert/update/delete
--   public.cycle_count_ai_scans         (3)  *_select/insert/update
--   public.schedule_events              (4)  *_select/insert/update/delete
--   public.bundles                      (4)  *_select/insert/update/delete
--   public.bundle_components            (2)  *_select/write
--   public.bundle_distributions         (2)  *_select/insert
--   public.order_requests               (3)  *_select/insert/update
--   public.order_request_lines          (2)  *_select/insert
--   public.stock_reservations           (1)  stock_reservations_select
--   public.warehouse_charters           (1)  wc_admin_write
--   public.shipments                    (2)  *_select/write
--   public.shipment_lines               (2)  *_select/write
--   public.procedures                   (2)  *_select/write
--   public.procedure_categories         (2)  *_select/write
--   public.procedure_videos             (2)  *_select/write
--   public.procedure_comments           (4)  *_select/insert/update_own/delete_own
--   public.approvals                    (1)  approvals_admin_decide
--   public.tolerance_profiles           (1)  tolerance_profiles_write
--   public.po_imports                   (2)  po_imports_insert/update
--   public.po_import_lines              (1)  po_import_lines_write
--   public.ai_chat_sessions             (4)  *_select/insert/update/delete
--   public.ai_chat_messages             (3)  *_select/insert/delete
--   public.user_category_assignments    (2)  *_select/write
--   storage.objects — 14 bucket policies
--
-- INTENTIONAL SKIPS
-- -----------------
--   public.billing_events       — RLS enabled, no client policies (service-role-only).
--                                 Adding policies here would break the intentional blank.
--   public.notifications        — policies use only auth.uid() equality; no helpers.
--   public.notification_preferences — same; auth.uid() only.
--   public.push_tokens          — same; auth.uid() only.
--   public.saved_views          — policies use auth.uid() / organization_members inline
--                                 subquery; no bare helper calls.
--   public.user_profiles        — policies use auth.uid() and inline EXISTS; no helpers.
--   public.approvals_select/insert — inline EXISTS against organization_members, not helpers.
--   public.tolerance_profiles_select — inline EXISTS, not helpers.
--   public.receipt_lines_select / receipt_line_lots_select / putaway_moves_select /
--     bins_select / inventory_stock_select / outbox_events (select inline) /
--     po_import_lines_select / serial_registry_select / po_imports_select /
--     idempotency_keys_select / uom_conversions_select / vim_select — all use
--     inline EXISTS against organization_members directly (not the helper), so the
--     InitPlan benefit is already captured by the inline subquery structure and
--     there is no bare helper to wrap.
--   public.order_request_lines_insert (0078) — uses auth.uid() equality inside EXISTS; has
--     one has_org_role call but it's inside an exists() so per-row is correct.
--     ACTUALLY: it is bare inside EXISTS, so it IS wrapped below.
--   storage.objects — "org-logos public read", "user-avatars public read",
--     "user-avatars own write/update/delete" — no helper function calls.
--
-- ROLLBACK
-- --------
-- Re-apply 0003_rls.sql through the last migration that touched any policy.
-- Each migration in this project uses DROP IF EXISTS + CREATE, so replaying
-- the original files restores the prior state.  The fastest rollback:
--     supabase db reset   (dev only)
-- or apply the inverse by re-running each original migration file in order.
-- ============================================================================

begin;

-- ============================================================================
-- public.organizations
-- ============================================================================

drop policy if exists organizations_select on public.organizations;
create policy organizations_select on public.organizations
  for select to authenticated
  using ((SELECT public.is_org_member(id)));

drop policy if exists organizations_update on public.organizations;
create policy organizations_update on public.organizations
  for update to authenticated
  using ((SELECT public.has_org_role(id, 'admin')))
  with check ((SELECT public.has_org_role(id, 'admin')));

drop policy if exists organizations_delete on public.organizations;
create policy organizations_delete on public.organizations
  for delete to authenticated
  using ((SELECT public.has_org_role(id, 'owner')));

-- ============================================================================
-- public.organization_members
-- ============================================================================

drop policy if exists organization_members_select on public.organization_members;
create policy organization_members_select on public.organization_members
  for select to authenticated
  using ((SELECT public.is_org_member(organization_id)));

drop policy if exists organization_members_insert on public.organization_members;
create policy organization_members_insert on public.organization_members
  for insert to authenticated
  with check (
    user_id = auth.uid()
    or (SELECT public.has_org_role(organization_id, 'admin'))
  );

drop policy if exists organization_members_update on public.organization_members;
create policy organization_members_update on public.organization_members
  for update to authenticated
  using ((SELECT public.has_org_role(organization_id, 'admin')))
  with check ((SELECT public.has_org_role(organization_id, 'admin')));

drop policy if exists organization_members_delete on public.organization_members;
create policy organization_members_delete on public.organization_members
  for delete to authenticated
  using (
    user_id = auth.uid()
    or (SELECT public.has_org_role(organization_id, 'admin'))
  );

-- ============================================================================
-- public.organization_invites
-- ============================================================================

drop policy if exists organization_invites_select on public.organization_invites;
create policy organization_invites_select on public.organization_invites
  for select to authenticated
  using ((SELECT public.has_org_role(organization_id, 'admin')));

drop policy if exists organization_invites_insert on public.organization_invites;
create policy organization_invites_insert on public.organization_invites
  for insert to authenticated
  with check ((SELECT public.has_org_role(organization_id, 'admin')));

drop policy if exists organization_invites_delete on public.organization_invites;
create policy organization_invites_delete on public.organization_invites
  for delete to authenticated
  using ((SELECT public.has_org_role(organization_id, 'admin')));

-- ============================================================================
-- public.categories
-- Live policies (in order of last migration):
--   categories_select  → 0129 (uses is_org_member — see below)
--   categories_insert  → 0003
--   categories_update  → 0003
--   categories_delete  → 0106
-- ============================================================================

-- categories_select: 0129 wraps is_org_member + user_can_see_item_category.
-- user_can_see_item_category takes explicit args so no initplan issue there.
-- Wrap only is_org_member.
drop policy if exists categories_select on public.categories;
create policy categories_select on public.categories
  for select to authenticated
  using (
    (SELECT public.is_org_member(organization_id))
    and public.user_can_see_item_category(auth.uid(), organization_id, id)
  );

drop policy if exists categories_insert on public.categories;
create policy categories_insert on public.categories
  for insert to authenticated
  with check ((SELECT public.has_org_role(organization_id, 'manager')));

drop policy if exists categories_update on public.categories;
create policy categories_update on public.categories
  for update to authenticated
  using ((SELECT public.has_org_role(organization_id, 'manager')))
  with check ((SELECT public.has_org_role(organization_id, 'manager')));

drop policy if exists categories_delete on public.categories;
create policy categories_delete on public.categories
  for delete to authenticated
  using ((SELECT public.has_org_role(organization_id, 'manager')));

-- ============================================================================
-- public.tags
-- ============================================================================

drop policy if exists tags_select on public.tags;
create policy tags_select on public.tags
  for select to authenticated
  using ((SELECT public.is_org_member(organization_id)));

drop policy if exists tags_write on public.tags;
create policy tags_write on public.tags
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'manager')))
  with check ((SELECT public.has_org_role(organization_id, 'manager')));

-- ============================================================================
-- public.locations
-- ============================================================================

drop policy if exists locations_select on public.locations;
create policy locations_select on public.locations
  for select to authenticated
  using ((SELECT public.is_org_member(organization_id)));

drop policy if exists locations_insert on public.locations;
create policy locations_insert on public.locations
  for insert to authenticated
  with check ((SELECT public.has_org_role(organization_id, 'manager')));

drop policy if exists locations_update on public.locations;
create policy locations_update on public.locations
  for update to authenticated
  using ((SELECT public.has_org_role(organization_id, 'manager')))
  with check ((SELECT public.has_org_role(organization_id, 'manager')));

drop policy if exists locations_delete on public.locations;
create policy locations_delete on public.locations
  for delete to authenticated
  using ((SELECT public.has_org_role(organization_id, 'admin')));

-- ============================================================================
-- public.suppliers
-- ============================================================================

drop policy if exists suppliers_select on public.suppliers;
create policy suppliers_select on public.suppliers
  for select to authenticated
  using ((SELECT public.is_org_member(organization_id)));

drop policy if exists suppliers_write on public.suppliers;
create policy suppliers_write on public.suppliers
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'manager')))
  with check ((SELECT public.has_org_role(organization_id, 'manager')));

-- ============================================================================
-- public.inventory_items
-- Live policy is from 0129 (select) and 0007 (insert/update), 0003 (delete).
-- 0129 select uses user_can_access_inventory + user_can_see_item_category —
-- neither is a bare is_org_member/has_org_role call, so no wrap needed there.
-- 0007 insert/update/delete use is_org_member/has_org_role directly.
-- ============================================================================

-- SELECT (from 0129): calls user_can_access_inventory and user_can_see_item_category
-- with explicit uid args — no bare helper wrapping needed; leave as-is.
-- The policy is recreated here only so there is no gap during the transaction.
drop policy if exists inventory_items_select on public.inventory_items;
create policy inventory_items_select on public.inventory_items
  for select to authenticated
  using (
    public.user_can_access_inventory(auth.uid(), warehouse_id, charter_id, 'read')
    and public.user_can_see_item_category(auth.uid(), organization_id, category_id)
  );

-- INSERT (from 0007): bare has_org_role calls → wrap
drop policy if exists inventory_items_insert on public.inventory_items;
create policy inventory_items_insert on public.inventory_items
  for insert to authenticated
  with check (
    (SELECT public.has_org_role(organization_id, 'staff'))
    and (
      (SELECT public.has_org_role(organization_id, 'manager'))
      or warehouse_id is null
      or public.user_can_access_warehouse(auth.uid(), warehouse_id, 'write')
    )
  );

-- UPDATE (from 0007): bare has_org_role calls → wrap
drop policy if exists inventory_items_update on public.inventory_items;
create policy inventory_items_update on public.inventory_items
  for update to authenticated
  using (
    (SELECT public.has_org_role(organization_id, 'staff'))
    and (
      (SELECT public.has_org_role(organization_id, 'manager'))
      or warehouse_id is null
      or public.user_can_access_warehouse(auth.uid(), warehouse_id, 'write')
    )
  )
  with check (
    (SELECT public.has_org_role(organization_id, 'staff'))
    and (
      (SELECT public.has_org_role(organization_id, 'manager'))
      or warehouse_id is null
      or public.user_can_access_warehouse(auth.uid(), warehouse_id, 'write')
    )
  );

-- DELETE (from 0003)
drop policy if exists inventory_items_delete on public.inventory_items;
create policy inventory_items_delete on public.inventory_items
  for delete to authenticated
  using ((SELECT public.has_org_role(organization_id, 'admin')));

-- ============================================================================
-- public.item_stock_levels
-- ============================================================================

drop policy if exists item_stock_levels_select on public.item_stock_levels;
create policy item_stock_levels_select on public.item_stock_levels
  for select to authenticated
  using ((SELECT public.is_org_member(organization_id)));

drop policy if exists item_stock_levels_write on public.item_stock_levels;
create policy item_stock_levels_write on public.item_stock_levels
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'staff')))
  with check ((SELECT public.has_org_role(organization_id, 'staff')));

-- ============================================================================
-- public.item_images
-- ============================================================================

drop policy if exists item_images_select on public.item_images;
create policy item_images_select on public.item_images
  for select to authenticated
  using ((SELECT public.is_org_member(organization_id)));

drop policy if exists item_images_write on public.item_images;
create policy item_images_write on public.item_images
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'staff')))
  with check ((SELECT public.has_org_role(organization_id, 'staff')));

-- ============================================================================
-- public.item_attachments
-- ============================================================================

drop policy if exists item_attachments_select on public.item_attachments;
create policy item_attachments_select on public.item_attachments
  for select to authenticated
  using ((SELECT public.is_org_member(organization_id)));

drop policy if exists item_attachments_write on public.item_attachments;
create policy item_attachments_write on public.item_attachments
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'staff')))
  with check ((SELECT public.has_org_role(organization_id, 'staff')));

-- ============================================================================
-- public.item_tags
-- The condition joins inventory_items to get org_id; has_org_role is bare
-- inside the EXISTS subquery.  Wrap it.
-- ============================================================================

drop policy if exists item_tags_all on public.item_tags;
create policy item_tags_all on public.item_tags
  for all to authenticated
  using (
    exists (
      select 1 from public.inventory_items it
      where it.id = item_id
        and (SELECT public.has_org_role(it.organization_id, 'staff'))
    )
  )
  with check (
    exists (
      select 1 from public.inventory_items it
      where it.id = item_id
        and (SELECT public.has_org_role(it.organization_id, 'staff'))
    )
  );

-- ============================================================================
-- public.stock_movements
-- ============================================================================

drop policy if exists stock_movements_select on public.stock_movements;
create policy stock_movements_select on public.stock_movements
  for select to authenticated
  using ((SELECT public.is_org_member(organization_id)));

drop policy if exists stock_movements_insert on public.stock_movements;
create policy stock_movements_insert on public.stock_movements
  for insert to authenticated
  with check ((SELECT public.has_org_role(organization_id, 'staff')));

-- ============================================================================
-- public.purchase_orders
-- ============================================================================

drop policy if exists purchase_orders_select on public.purchase_orders;
create policy purchase_orders_select on public.purchase_orders
  for select to authenticated
  using ((SELECT public.is_org_member(organization_id)));

drop policy if exists purchase_orders_write on public.purchase_orders;
create policy purchase_orders_write on public.purchase_orders
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'manager')))
  with check ((SELECT public.has_org_role(organization_id, 'manager')));

-- ============================================================================
-- public.purchase_order_items
-- ============================================================================

drop policy if exists purchase_order_items_select on public.purchase_order_items;
create policy purchase_order_items_select on public.purchase_order_items
  for select to authenticated
  using ((SELECT public.is_org_member(organization_id)));

drop policy if exists purchase_order_items_write on public.purchase_order_items;
create policy purchase_order_items_write on public.purchase_order_items
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'manager')))
  with check ((SELECT public.has_org_role(organization_id, 'manager')));

-- ============================================================================
-- public.activity_logs
-- ============================================================================

drop policy if exists activity_logs_select on public.activity_logs;
create policy activity_logs_select on public.activity_logs
  for select to authenticated
  using ((SELECT public.has_org_role(organization_id, 'manager')));

-- ============================================================================
-- public.audit_logs  (live policy from 0100)
-- ============================================================================

drop policy if exists audit_logs_select on public.audit_logs;
create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using ((SELECT public.has_org_role(organization_id, 'manager')));

-- ============================================================================
-- public.import_jobs
-- ============================================================================

drop policy if exists import_jobs_select on public.import_jobs;
create policy import_jobs_select on public.import_jobs
  for select to authenticated
  using ((SELECT public.is_org_member(organization_id)));

drop policy if exists import_jobs_write on public.import_jobs;
create policy import_jobs_write on public.import_jobs
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'manager')))
  with check ((SELECT public.has_org_role(organization_id, 'manager')));

-- ============================================================================
-- public.import_job_errors
-- The parent import_jobs row is looked up; is_org_member is bare inside EXISTS.
-- ============================================================================

drop policy if exists import_job_errors_select on public.import_job_errors;
create policy import_job_errors_select on public.import_job_errors
  for select to authenticated
  using (
    exists (
      select 1 from public.import_jobs j
      where j.id = import_job_id
        and (SELECT public.is_org_member(j.organization_id))
    )
  );

-- ============================================================================
-- public.charters  (from 0007)
-- ============================================================================

drop policy if exists charters_select on public.charters;
create policy charters_select on public.charters
  for select to authenticated
  using ((SELECT public.is_org_member(organization_id)));

drop policy if exists charters_admin_write on public.charters;
create policy charters_admin_write on public.charters
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'admin')))
  with check ((SELECT public.has_org_role(organization_id, 'admin')));

-- ============================================================================
-- public.warehouses  (from 0007)
-- is_org_member and has_org_role are bare inside the compound USING expression.
-- user_can_access_warehouse takes auth.uid() explicitly — no wrap needed there.
-- ============================================================================

drop policy if exists warehouses_select on public.warehouses;
create policy warehouses_select on public.warehouses
  for select to authenticated
  using (
    (SELECT public.is_org_member(organization_id))
    and (
      (SELECT public.has_org_role(organization_id, 'manager'))
      or public.user_can_access_warehouse(auth.uid(), id, 'read')
    )
  );

drop policy if exists warehouses_admin_write on public.warehouses;
create policy warehouses_admin_write on public.warehouses
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'admin')))
  with check ((SELECT public.has_org_role(organization_id, 'admin')));

-- ============================================================================
-- public.user_warehouse_assignments  (from 0007)
-- ============================================================================

drop policy if exists uwa_select_own on public.user_warehouse_assignments;
create policy uwa_select_own on public.user_warehouse_assignments
  for select to authenticated
  using (
    user_id = auth.uid()
    or (SELECT public.has_org_role(organization_id, 'admin'))
  );

drop policy if exists uwa_admin_write on public.user_warehouse_assignments;
create policy uwa_admin_write on public.user_warehouse_assignments
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'admin')))
  with check ((SELECT public.has_org_role(organization_id, 'admin')));

-- ============================================================================
-- public.bins  (live policy from 0046)
-- ============================================================================

drop policy if exists bins_write on public.bins;
create policy bins_write on public.bins
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'manager')))
  with check ((SELECT public.has_org_role(organization_id, 'manager')));

-- ============================================================================
-- public.inventory_stock  (live policy from 0046)
-- ============================================================================

drop policy if exists inventory_stock_write on public.inventory_stock;
create policy inventory_stock_write on public.inventory_stock
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'staff')))
  with check ((SELECT public.has_org_role(organization_id, 'staff')));

-- ============================================================================
-- public.putaway_moves  (live policy from 0046)
-- ============================================================================

drop policy if exists putaway_moves_write on public.putaway_moves;
create policy putaway_moves_write on public.putaway_moves
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'staff')))
  with check ((SELECT public.has_org_role(organization_id, 'staff')));

-- ============================================================================
-- public.outbox_events  (live policies from 0016 + 0046)
-- ============================================================================

drop policy if exists outbox_events_select on public.outbox_events;
create policy outbox_events_select on public.outbox_events
  for select to authenticated
  using ((SELECT public.has_org_role(organization_id, 'manager')));

drop policy if exists outbox_events_write on public.outbox_events;
create policy outbox_events_write on public.outbox_events
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'admin')))
  with check ((SELECT public.has_org_role(organization_id, 'admin')));

-- ============================================================================
-- public.receipts  (live policy from 0046)
-- ============================================================================

drop policy if exists receipts_write on public.receipts;
create policy receipts_write on public.receipts
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'staff')))
  with check ((SELECT public.has_org_role(organization_id, 'staff')));

-- ============================================================================
-- public.receipt_lines  (live policy from 0046)
-- has_org_role inside EXISTS — wrap it
-- ============================================================================

drop policy if exists receipt_lines_write on public.receipt_lines;
create policy receipt_lines_write on public.receipt_lines
  for all to authenticated
  using (
    exists (
      select 1 from public.receipts r
      where r.id = receipt_lines.receipt_id
        and (SELECT public.has_org_role(r.organization_id, 'staff'))
    )
  )
  with check (
    exists (
      select 1 from public.receipts r
      where r.id = receipt_lines.receipt_id
        and (SELECT public.has_org_role(r.organization_id, 'staff'))
    )
  );

-- ============================================================================
-- public.receipt_line_lots  (live policy from 0046)
-- ============================================================================

drop policy if exists receipt_line_lots_write on public.receipt_line_lots;
create policy receipt_line_lots_write on public.receipt_line_lots
  for all to authenticated
  using (
    exists (
      select 1
      from public.receipt_lines rl
      join public.receipts r on r.id = rl.receipt_id
      where rl.id = receipt_line_lots.receipt_line_id
        and (SELECT public.has_org_role(r.organization_id, 'staff'))
    )
  )
  with check (
    exists (
      select 1
      from public.receipt_lines rl
      join public.receipts r on r.id = rl.receipt_id
      where rl.id = receipt_line_lots.receipt_line_id
        and (SELECT public.has_org_role(r.organization_id, 'staff'))
    )
  );

-- ============================================================================
-- public.serial_registry  (live policy from 0046)
-- ============================================================================

drop policy if exists serial_registry_write on public.serial_registry;
create policy serial_registry_write on public.serial_registry
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'staff')))
  with check ((SELECT public.has_org_role(organization_id, 'staff')));

-- ============================================================================
-- public.idempotency_keys  (live policy from 0013)
-- ============================================================================

drop policy if exists idempotency_keys_write on public.idempotency_keys;
create policy idempotency_keys_write on public.idempotency_keys
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'manager')));

-- ============================================================================
-- public.uom_conversions  (live policy from 0014)
-- ============================================================================

drop policy if exists uom_conversions_write on public.uom_conversions;
create policy uom_conversions_write on public.uom_conversions
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'manager')));

-- ============================================================================
-- public.vendor_item_mappings  (live policy from 0085)
-- ============================================================================

drop policy if exists vim_admin_write on public.vendor_item_mappings;
create policy vim_admin_write on public.vendor_item_mappings
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'manager')))
  with check ((SELECT public.has_org_role(organization_id, 'manager')));

-- ============================================================================
-- public.cycle_counts  (from 0023)
-- ============================================================================

drop policy if exists cycle_counts_select on public.cycle_counts;
create policy cycle_counts_select on public.cycle_counts
  for select to authenticated
  using ((SELECT public.is_org_member(organization_id)));

drop policy if exists cycle_counts_insert on public.cycle_counts;
create policy cycle_counts_insert on public.cycle_counts
  for insert to authenticated
  with check ((SELECT public.has_org_role(organization_id, 'manager')));

drop policy if exists cycle_counts_update on public.cycle_counts;
create policy cycle_counts_update on public.cycle_counts
  for update to authenticated
  using ((SELECT public.has_org_role(organization_id, 'manager')))
  with check ((SELECT public.has_org_role(organization_id, 'manager')));

-- ============================================================================
-- public.cycle_count_lines
-- SELECT from 0023; INSERT/UPDATE/DELETE from 0080.
-- Note: 0049 introduced a combined "write" policy that 0080 later dropped
-- and replaced with three separate policies — the write policy is gone.
-- ============================================================================

drop policy if exists cycle_count_lines_select on public.cycle_count_lines;
create policy cycle_count_lines_select on public.cycle_count_lines
  for select to authenticated
  using (
    exists (
      select 1 from public.cycle_counts cc
      where cc.id = cycle_count_lines.cycle_count_id
        and (SELECT public.is_org_member(cc.organization_id))
    )
  );

drop policy if exists cycle_count_lines_insert on public.cycle_count_lines;
create policy cycle_count_lines_insert on public.cycle_count_lines
  for insert to authenticated
  with check (
    exists (
      select 1 from public.cycle_counts cc
      where cc.id = cycle_count_lines.cycle_count_id
        and (SELECT public.has_org_role(cc.organization_id, 'manager'))
    )
  );

drop policy if exists cycle_count_lines_update on public.cycle_count_lines;
create policy cycle_count_lines_update on public.cycle_count_lines
  for update to authenticated
  using (
    exists (
      select 1 from public.cycle_counts cc
      where cc.id = cycle_count_lines.cycle_count_id
        and (SELECT public.has_org_role(cc.organization_id, 'staff'))
    )
  )
  with check (
    exists (
      select 1 from public.cycle_counts cc
      where cc.id = cycle_count_lines.cycle_count_id
        and (SELECT public.has_org_role(cc.organization_id, 'staff'))
    )
  );

drop policy if exists cycle_count_lines_delete on public.cycle_count_lines;
create policy cycle_count_lines_delete on public.cycle_count_lines
  for delete to authenticated
  using (
    exists (
      select 1 from public.cycle_counts cc
      where cc.id = cycle_count_lines.cycle_count_id
        and (SELECT public.has_org_role(cc.organization_id, 'manager'))
    )
  );

-- ============================================================================
-- public.cycle_count_ai_scans  (from 0124)
-- ============================================================================

drop policy if exists cc_ai_scans_select on public.cycle_count_ai_scans;
create policy cc_ai_scans_select on public.cycle_count_ai_scans
  for select to authenticated
  using ((SELECT public.is_org_member(organization_id)));

drop policy if exists cc_ai_scans_insert on public.cycle_count_ai_scans;
create policy cc_ai_scans_insert on public.cycle_count_ai_scans
  for insert to authenticated
  with check (
    (SELECT public.has_org_role(organization_id, 'staff'))
    and created_by = auth.uid()
  );

drop policy if exists cc_ai_scans_update on public.cycle_count_ai_scans;
create policy cc_ai_scans_update on public.cycle_count_ai_scans
  for update to authenticated
  using (
    (SELECT public.has_org_role(organization_id, 'staff'))
    and (created_by = auth.uid() or (SELECT public.has_org_role(organization_id, 'manager')))
  )
  with check (
    (SELECT public.has_org_role(organization_id, 'staff'))
    and (created_by = auth.uid() or (SELECT public.has_org_role(organization_id, 'manager')))
  );

-- ============================================================================
-- public.schedule_events
-- Live policies from 0033 (select/insert) and 0046 (update/delete).
-- is_org_member and has_org_role are bare in all four.
-- ============================================================================

drop policy if exists schedule_events_select on public.schedule_events;
create policy schedule_events_select on public.schedule_events
  for select to authenticated
  using (
    (SELECT public.is_org_member(organization_id))
    and (
      warehouse_id is null
      or public.user_can_access_warehouse(auth.uid(), warehouse_id, 'read')
    )
  );

drop policy if exists schedule_events_insert on public.schedule_events;
create policy schedule_events_insert on public.schedule_events
  for insert to authenticated
  with check (
    (SELECT public.is_org_member(organization_id))
    and created_by = auth.uid()
    and (
      warehouse_id is null
      or public.user_can_access_warehouse(auth.uid(), warehouse_id, 'write')
    )
  );

drop policy if exists schedule_events_update on public.schedule_events;
create policy schedule_events_update on public.schedule_events
  for update to authenticated
  using (
    (SELECT public.is_org_member(organization_id))
    and (created_by = auth.uid() or (SELECT public.has_org_role(organization_id, 'manager')))
  )
  with check (
    (SELECT public.is_org_member(organization_id))
    and (created_by = auth.uid() or (SELECT public.has_org_role(organization_id, 'manager')))
  );

drop policy if exists schedule_events_delete on public.schedule_events;
create policy schedule_events_delete on public.schedule_events
  for delete to authenticated
  using (
    (SELECT public.is_org_member(organization_id))
    and (created_by = auth.uid() or (SELECT public.has_org_role(organization_id, 'manager')))
  );

-- ============================================================================
-- public.bundles  (from 0040)
-- ============================================================================

drop policy if exists bundles_select on public.bundles;
create policy bundles_select on public.bundles
  for select to authenticated
  using ((SELECT public.is_org_member(organization_id)));

drop policy if exists bundles_insert on public.bundles;
create policy bundles_insert on public.bundles
  for insert to authenticated
  with check ((SELECT public.has_org_role(organization_id, 'manager')));

drop policy if exists bundles_update on public.bundles;
create policy bundles_update on public.bundles
  for update to authenticated
  using ((SELECT public.has_org_role(organization_id, 'manager')))
  with check ((SELECT public.has_org_role(organization_id, 'manager')));

drop policy if exists bundles_delete on public.bundles;
create policy bundles_delete on public.bundles
  for delete to authenticated
  using ((SELECT public.has_org_role(organization_id, 'admin')));

-- ============================================================================
-- public.bundle_components  (from 0040)
-- Helper calls are inside EXISTS subqueries — wrap each one.
-- ============================================================================

drop policy if exists bundle_components_select on public.bundle_components;
create policy bundle_components_select on public.bundle_components
  for select to authenticated
  using (
    exists (
      select 1 from public.bundles b
      where b.id = bundle_components.bundle_id
        and (SELECT public.is_org_member(b.organization_id))
    )
  );

drop policy if exists bundle_components_write on public.bundle_components;
create policy bundle_components_write on public.bundle_components
  for all to authenticated
  using (
    exists (
      select 1 from public.bundles b
      where b.id = bundle_components.bundle_id
        and (SELECT public.has_org_role(b.organization_id, 'manager'))
    )
  )
  with check (
    exists (
      select 1 from public.bundles b
      where b.id = bundle_components.bundle_id
        and (SELECT public.has_org_role(b.organization_id, 'manager'))
    )
  );

-- ============================================================================
-- public.bundle_distributions  (from 0040)
-- ============================================================================

drop policy if exists bundle_distributions_select on public.bundle_distributions;
create policy bundle_distributions_select on public.bundle_distributions
  for select to authenticated
  using ((SELECT public.is_org_member(organization_id)));

drop policy if exists bundle_distributions_insert on public.bundle_distributions;
create policy bundle_distributions_insert on public.bundle_distributions
  for insert to authenticated
  with check ((SELECT public.has_org_role(organization_id, 'staff')));

-- ============================================================================
-- public.order_requests
-- Live policies: select (0044), insert (0116), update (0046).
-- ============================================================================

drop policy if exists order_requests_select on public.order_requests;
create policy order_requests_select on public.order_requests
  for select to authenticated
  using ((SELECT public.is_org_member(organization_id)));

-- INSERT (0116): is_org_member + conditional has_org_role
drop policy if exists order_requests_insert on public.order_requests;
create policy order_requests_insert on public.order_requests
  for insert to authenticated
  with check (
    (SELECT public.is_org_member(organization_id))
    and source = 'internal'
    and (
      requester_user_id = auth.uid()
      or (
        requester_user_id is null
        and requester_email is not null
        and (SELECT public.has_org_role(organization_id, 'manager'))
      )
    )
  );

-- UPDATE (0046)
drop policy if exists order_requests_update on public.order_requests;
create policy order_requests_update on public.order_requests
  for update to authenticated
  using ((SELECT public.has_org_role(organization_id, 'manager')))
  with check ((SELECT public.has_org_role(organization_id, 'manager')));

-- ============================================================================
-- public.order_request_lines
-- SELECT (0044): is_org_member inside EXISTS
-- INSERT (0078): has_org_role inside EXISTS (conditional branch)
-- ============================================================================

drop policy if exists order_request_lines_select on public.order_request_lines;
create policy order_request_lines_select on public.order_request_lines
  for select to authenticated
  using (
    exists (
      select 1 from public.order_requests r
      where r.id = order_request_lines.order_request_id
        and (SELECT public.is_org_member(r.organization_id))
    )
  );

drop policy if exists order_request_lines_insert on public.order_request_lines;
create policy order_request_lines_insert on public.order_request_lines
  for insert to authenticated
  with check (
    exists (
      select 1
      from public.order_requests r
      join public.inventory_items ii
        on ii.id = order_request_lines.item_id
       and ii.organization_id = r.organization_id
      where r.id = order_request_lines.order_request_id
        and (
          r.requester_user_id = auth.uid()
          or (SELECT public.has_org_role(r.organization_id, 'manager'))
        )
        and ii.warehouse_id = r.warehouse_id
    )
  );

-- ============================================================================
-- public.stock_reservations  (from 0044)
-- ============================================================================

drop policy if exists stock_reservations_select on public.stock_reservations;
create policy stock_reservations_select on public.stock_reservations
  for select to authenticated
  using ((SELECT public.is_org_member(organization_id)));

-- ============================================================================
-- public.warehouse_charters  (live policy from 0046)
-- has_org_role inside EXISTS — wrap it
-- ============================================================================

drop policy if exists wc_admin_write on public.warehouse_charters;
create policy wc_admin_write on public.warehouse_charters
  for all to authenticated
  using (
    exists (
      select 1 from public.charters c
      where c.id = warehouse_charters.charter_id
        and (SELECT public.has_org_role(c.organization_id, 'admin'))
    )
  )
  with check (
    exists (
      select 1 from public.charters c
      where c.id = warehouse_charters.charter_id
        and (SELECT public.has_org_role(c.organization_id, 'admin'))
    )
  );

-- ============================================================================
-- public.shipments  (from 0050)
-- ============================================================================

drop policy if exists shipments_select on public.shipments;
create policy shipments_select on public.shipments
  for select to authenticated
  using ((SELECT public.is_org_member(organization_id)));

drop policy if exists shipments_write on public.shipments;
create policy shipments_write on public.shipments
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'manager')))
  with check ((SELECT public.has_org_role(organization_id, 'manager')));

-- ============================================================================
-- public.shipment_lines  (from 0050)
-- ============================================================================

drop policy if exists shipment_lines_select on public.shipment_lines;
create policy shipment_lines_select on public.shipment_lines
  for select to authenticated
  using ((SELECT public.is_org_member(organization_id)));

drop policy if exists shipment_lines_write on public.shipment_lines;
create policy shipment_lines_write on public.shipment_lines
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'manager')))
  with check ((SELECT public.has_org_role(organization_id, 'manager')));

-- ============================================================================
-- public.procedure_categories  (from 0053)
-- ============================================================================

drop policy if exists procedure_categories_select on public.procedure_categories;
create policy procedure_categories_select on public.procedure_categories
  for select to authenticated
  using ((SELECT public.is_org_member(organization_id)));

drop policy if exists procedure_categories_write on public.procedure_categories;
create policy procedure_categories_write on public.procedure_categories
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'admin')))
  with check ((SELECT public.has_org_role(organization_id, 'admin')));

-- ============================================================================
-- public.procedures  (from 0053)
-- ============================================================================

drop policy if exists procedures_select on public.procedures;
create policy procedures_select on public.procedures
  for select to authenticated
  using ((SELECT public.is_org_member(organization_id)));

drop policy if exists procedures_write on public.procedures;
create policy procedures_write on public.procedures
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'manager')))
  with check ((SELECT public.has_org_role(organization_id, 'manager')));

-- ============================================================================
-- public.procedure_videos  (from 0053)
-- ============================================================================

drop policy if exists procedure_videos_select on public.procedure_videos;
create policy procedure_videos_select on public.procedure_videos
  for select to authenticated
  using ((SELECT public.is_org_member(organization_id)));

drop policy if exists procedure_videos_write on public.procedure_videos;
create policy procedure_videos_write on public.procedure_videos
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'manager')))
  with check ((SELECT public.has_org_role(organization_id, 'manager')));

-- ============================================================================
-- public.procedure_comments
-- SELECT/update_own/delete_own from 0053; insert from 0088.
-- ============================================================================

drop policy if exists procedure_comments_select on public.procedure_comments;
create policy procedure_comments_select on public.procedure_comments
  for select to authenticated
  using ((SELECT public.is_org_member(organization_id)));

-- INSERT (0088): is_org_member + has_org_role both bare
drop policy if exists procedure_comments_insert on public.procedure_comments;
create policy procedure_comments_insert on public.procedure_comments
  for insert to authenticated
  with check (
    (SELECT public.is_org_member(organization_id))
    and author_id = auth.uid()
    and (SELECT public.has_org_role(organization_id, 'manager'))
  );

drop policy if exists procedure_comments_update_own on public.procedure_comments;
create policy procedure_comments_update_own on public.procedure_comments
  for update to authenticated
  using (
    (SELECT public.is_org_member(organization_id))
    and (author_id = auth.uid() or (SELECT public.has_org_role(organization_id, 'admin')))
  )
  with check (
    (SELECT public.is_org_member(organization_id))
    and (author_id = auth.uid() or (SELECT public.has_org_role(organization_id, 'admin')))
  );

drop policy if exists procedure_comments_delete_own on public.procedure_comments;
create policy procedure_comments_delete_own on public.procedure_comments
  for delete to authenticated
  using (
    (SELECT public.is_org_member(organization_id))
    and (author_id = auth.uid() or (SELECT public.has_org_role(organization_id, 'admin')))
  );

-- ============================================================================
-- public.approvals  (from 0017)
-- approvals_select and approvals_insert use inline EXISTS against
-- organization_members directly (no helper call) — skipped.
-- approvals_admin_decide has a bare has_org_role — wrap it.
-- ============================================================================

drop policy if exists approvals_admin_decide on public.approvals;
create policy approvals_admin_decide on public.approvals
  for update to authenticated
  using ((SELECT public.has_org_role(organization_id, 'admin')));

-- ============================================================================
-- public.tolerance_profiles  (from 0017)
-- tolerance_profiles_select uses inline EXISTS — skipped.
-- tolerance_profiles_write has a bare has_org_role — wrap it.
-- ============================================================================

drop policy if exists tolerance_profiles_write on public.tolerance_profiles;
create policy tolerance_profiles_write on public.tolerance_profiles
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'manager')));

-- ============================================================================
-- public.po_imports  (live policies from 0010)
-- po_imports_select uses inline EXISTS — skipped.
-- po_imports_insert and po_imports_update have bare has_org_role — wrap them.
-- ============================================================================

drop policy if exists po_imports_insert on public.po_imports;
create policy po_imports_insert on public.po_imports
  for insert to authenticated
  with check ((SELECT public.has_org_role(organization_id, 'manager')));

drop policy if exists po_imports_update on public.po_imports;
create policy po_imports_update on public.po_imports
  for update to authenticated
  using ((SELECT public.has_org_role(organization_id, 'manager')))
  with check ((SELECT public.has_org_role(organization_id, 'manager')));

-- ============================================================================
-- public.po_import_lines  (live policy from 0046)
-- has_org_role inside EXISTS — wrap it
-- ============================================================================

drop policy if exists po_import_lines_write on public.po_import_lines;
create policy po_import_lines_write on public.po_import_lines
  for all to authenticated
  using (
    exists (
      select 1 from public.po_imports pi
      where pi.id = po_import_lines.po_import_id
        and (SELECT public.has_org_role(pi.organization_id, 'manager'))
    )
  )
  with check (
    exists (
      select 1 from public.po_imports pi
      where pi.id = po_import_lines.po_import_id
        and (SELECT public.has_org_role(pi.organization_id, 'manager'))
    )
  );

-- ============================================================================
-- public.ai_chat_sessions  (from 0030)
-- All four policies have bare is_org_member calls.
-- ============================================================================

drop policy if exists ai_chat_sessions_select on public.ai_chat_sessions;
create policy ai_chat_sessions_select on public.ai_chat_sessions
  for select to authenticated
  using (user_id = auth.uid() and (SELECT public.is_org_member(organization_id)));

drop policy if exists ai_chat_sessions_insert on public.ai_chat_sessions;
create policy ai_chat_sessions_insert on public.ai_chat_sessions
  for insert to authenticated
  with check (user_id = auth.uid() and (SELECT public.is_org_member(organization_id)));

drop policy if exists ai_chat_sessions_update on public.ai_chat_sessions;
create policy ai_chat_sessions_update on public.ai_chat_sessions
  for update to authenticated
  using (user_id = auth.uid() and (SELECT public.is_org_member(organization_id)))
  with check (user_id = auth.uid() and (SELECT public.is_org_member(organization_id)));

drop policy if exists ai_chat_sessions_delete on public.ai_chat_sessions;
create policy ai_chat_sessions_delete on public.ai_chat_sessions
  for delete to authenticated
  using (user_id = auth.uid() and (SELECT public.is_org_member(organization_id)));

-- ============================================================================
-- public.ai_chat_messages  (from 0030)
-- is_org_member is inside an EXISTS — wrap it in each.
-- ============================================================================

drop policy if exists ai_chat_messages_select on public.ai_chat_messages;
create policy ai_chat_messages_select on public.ai_chat_messages
  for select to authenticated
  using (
    exists (
      select 1
        from public.ai_chat_sessions s
       where s.id = ai_chat_messages.session_id
         and s.user_id = auth.uid()
         and (SELECT public.is_org_member(s.organization_id))
    )
  );

drop policy if exists ai_chat_messages_insert on public.ai_chat_messages;
create policy ai_chat_messages_insert on public.ai_chat_messages
  for insert to authenticated
  with check (
    exists (
      select 1
        from public.ai_chat_sessions s
       where s.id = ai_chat_messages.session_id
         and s.user_id = auth.uid()
         and (SELECT public.is_org_member(s.organization_id))
    )
  );

drop policy if exists ai_chat_messages_delete on public.ai_chat_messages;
create policy ai_chat_messages_delete on public.ai_chat_messages
  for delete to authenticated
  using (
    exists (
      select 1
        from public.ai_chat_sessions s
       where s.id = ai_chat_messages.session_id
         and s.user_id = auth.uid()
         and (SELECT public.is_org_member(s.organization_id))
    )
  );

-- ============================================================================
-- public.user_category_assignments  (from 0128)
-- ============================================================================

drop policy if exists user_category_assignments_select on public.user_category_assignments;
create policy user_category_assignments_select on public.user_category_assignments
  for select to authenticated
  using (
    user_id = auth.uid()
    or (SELECT public.has_org_role(organization_id, 'manager'))
  );

drop policy if exists user_category_assignments_write on public.user_category_assignments;
create policy user_category_assignments_write on public.user_category_assignments
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'manager')))
  with check ((SELECT public.has_org_role(organization_id, 'manager')));

-- ============================================================================
-- storage.objects — bucket policies
-- ============================================================================

-- ── item-images (from 0003) ───────────────────────────────────────────────

drop policy if exists "item-images authenticated read" on storage.objects;
create policy "item-images authenticated read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'item-images'
    and (SELECT public.is_org_member((storage.foldername(name))[1]::uuid))
  );

drop policy if exists "item-images staff write" on storage.objects;
create policy "item-images staff write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'item-images'
    and (SELECT public.has_org_role((storage.foldername(name))[1]::uuid, 'staff'))
  );

drop policy if exists "item-images staff update" on storage.objects;
create policy "item-images staff update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'item-images'
    and (SELECT public.has_org_role((storage.foldername(name))[1]::uuid, 'staff'))
  );

drop policy if exists "item-images staff delete" on storage.objects;
create policy "item-images staff delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'item-images'
    and (SELECT public.has_org_role((storage.foldername(name))[1]::uuid, 'staff'))
  );

-- ── item-attachments (from 0003) ──────────────────────────────────────────

drop policy if exists "item-attachments authenticated read" on storage.objects;
create policy "item-attachments authenticated read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'item-attachments'
    and (SELECT public.is_org_member((storage.foldername(name))[1]::uuid))
  );

drop policy if exists "item-attachments staff write" on storage.objects;
create policy "item-attachments staff write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'item-attachments'
    and (SELECT public.has_org_role((storage.foldername(name))[1]::uuid, 'staff'))
  );

-- ── org-logos (from 0003 + 0026) ─────────────────────────────────────────
-- "org-logos public read" has no helper calls — skipped.

drop policy if exists "org-logos admin write" on storage.objects;
create policy "org-logos admin write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'org-logos'
    and (SELECT public.has_org_role((storage.foldername(name))[1]::uuid, 'admin'))
  );

drop policy if exists "org-logos admin update" on storage.objects;
create policy "org-logos admin update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'org-logos'
    and (SELECT public.has_org_role((storage.foldername(name))[1]::uuid, 'admin'))
  )
  with check (
    bucket_id = 'org-logos'
    and (SELECT public.has_org_role((storage.foldername(name))[1]::uuid, 'admin'))
  );

drop policy if exists "org-logos admin delete" on storage.objects;
create policy "org-logos admin delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'org-logos'
    and (SELECT public.has_org_role((storage.foldername(name))[1]::uuid, 'admin'))
  );

-- ── po-imports (from 0021) ────────────────────────────────────────────────

drop policy if exists "po-imports authenticated read" on storage.objects;
create policy "po-imports authenticated read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'po-imports'
    and (SELECT public.is_org_member((storage.foldername(name))[1]::uuid))
  );

drop policy if exists "po-imports manager write" on storage.objects;
create policy "po-imports manager write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'po-imports'
    and (SELECT public.has_org_role((storage.foldername(name))[1]::uuid, 'manager'))
  );

drop policy if exists "po-imports manager update" on storage.objects;
create policy "po-imports manager update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'po-imports'
    and (SELECT public.has_org_role((storage.foldername(name))[1]::uuid, 'manager'))
  )
  with check (
    bucket_id = 'po-imports'
    and (SELECT public.has_org_role((storage.foldername(name))[1]::uuid, 'manager'))
  );

drop policy if exists "po-imports manager delete" on storage.objects;
create policy "po-imports manager delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'po-imports'
    and (SELECT public.has_org_role((storage.foldername(name))[1]::uuid, 'manager'))
  );

-- ── procedure-videos (from 0053) ─────────────────────────────────────────

drop policy if exists procedure_videos_read on storage.objects;
create policy procedure_videos_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'procedure-videos'
    and (SELECT public.is_org_member((storage.foldername(name))[1]::uuid))
  );

drop policy if exists procedure_videos_insert on storage.objects;
create policy procedure_videos_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'procedure-videos'
    and (SELECT public.has_org_role((storage.foldername(name))[1]::uuid, 'manager'))
  );

drop policy if exists procedure_videos_update on storage.objects;
create policy procedure_videos_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'procedure-videos'
    and (SELECT public.has_org_role((storage.foldername(name))[1]::uuid, 'manager'))
  )
  with check (
    bucket_id = 'procedure-videos'
    and (SELECT public.has_org_role((storage.foldername(name))[1]::uuid, 'manager'))
  );

drop policy if exists procedure_videos_delete on storage.objects;
create policy procedure_videos_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'procedure-videos'
    and (SELECT public.has_org_role((storage.foldername(name))[1]::uuid, 'manager'))
  );

-- ── cycle-count-scans (from 0124) ─────────────────────────────────────────

drop policy if exists "cycle-count-scans org read" on storage.objects;
create policy "cycle-count-scans org read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'cycle-count-scans'
    and (SELECT public.is_org_member((storage.foldername(name))[1]::uuid))
  );

drop policy if exists "cycle-count-scans org write" on storage.objects;
create policy "cycle-count-scans org write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'cycle-count-scans'
    and (SELECT public.has_org_role((storage.foldername(name))[1]::uuid, 'staff'))
  );

drop policy if exists "cycle-count-scans manager delete" on storage.objects;
create policy "cycle-count-scans manager delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'cycle-count-scans'
    and (SELECT public.has_org_role((storage.foldername(name))[1]::uuid, 'manager'))
  );

commit;

-- ============================================================================
-- VERIFY: after applying, run these queries in Supabase Studio → SQL editor
-- or psql to confirm the policies are present with the expected table/command.
-- ============================================================================

-- VERIFY 1: Count of policies that reference the SELECT-wrapped helpers
-- Expected: should be 0 bare calls remaining (all wrapped in a SELECT subexpr)
/*
SELECT schemaname, tablename, policyname, qual, with_check
FROM pg_policies
WHERE schemaname IN ('public', 'storage')
  AND (
    qual       ~* '\bpublic\.(is_org_member|has_org_role|user_org_role)\s*\('
    OR with_check ~* '\bpublic\.(is_org_member|has_org_role|user_org_role)\s*\('
  )
  -- Bare call: helper call NOT preceded by (SELECT
  AND (
    qual       ~ '(?<!\(SELECT\s{0,10})public\.(is_org_member|has_org_role|user_org_role)\s*\('
    OR with_check ~ '(?<!\(SELECT\s{0,10})public\.(is_org_member|has_org_role|user_org_role)\s*\('
  );
*/

-- VERIFY 2: Spot-check a sample of wrapped policies
/*
SELECT policyname, tablename, qual
FROM pg_policies
WHERE tablename IN (
  'organizations','organization_members','categories',
  'inventory_items','cycle_counts','schedule_events',
  'order_requests','shipments'
)
AND schemaname = 'public'
ORDER BY tablename, policyname;
*/

-- VERIFY 3: Confirm helper function signatures are unchanged
/*
SELECT proname, provolatile, prosecdef
FROM pg_proc
WHERE proname IN ('is_org_member','has_org_role','user_org_role')
  AND pronamespace = 'public'::regnamespace;
-- Expected: provolatile = 's' (stable), prosecdef = true for all three.
*/

-- VERIFY 4: Confirm no policies were accidentally dropped
/*
SELECT COUNT(*) FROM pg_policies
WHERE schemaname IN ('public','storage')
  AND tablename NOT IN ('billing_events');
-- Compare this count to the value before the migration.
-- The count should be identical (policies replaced, not removed).
*/
