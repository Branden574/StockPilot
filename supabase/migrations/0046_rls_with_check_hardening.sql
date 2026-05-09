-- ============================================================================
-- 0046_rls_with_check_hardening.sql
-- ============================================================================
-- Closes the "WITH CHECK clause missing on FOR UPDATE / FOR ALL policies"
-- pattern across the schema. Without WITH CHECK, Postgres validates the
-- USING predicate against the row BEFORE the update — meaning an
-- authenticated user can mutate a row they own into a state they
-- shouldn't (e.g. reassign user_id, pivot organization_id, change a
-- foreign key into another org, or set a status they aren't supposed
-- to set). Adding WITH CHECK forces post-update validation too.
--
-- Also tightens schedule_events update/delete to the row creator OR
-- manager+, replacing the old "any org member" policy. Storage bucket
-- MIME-type enforcement on org-logos and user-avatars closes the
-- client-only-MIME-check finding so a renamed binary can't end up in
-- a public CDN URL.
-- ============================================================================

-- ── saved_views ──────────────────────────────────────────────────────
-- The owner could UPDATE their own row to set user_id = <victim> or
-- organization_id = <other_org>, reassigning ownership.
drop policy if exists "saved_views_owner_update" on public.saved_views;
create policy "saved_views_owner_update" on public.saved_views
  for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ── warehouse_charters ────────────────────────────────────────────────
drop policy if exists wc_admin_write on public.warehouse_charters;
create policy wc_admin_write on public.warehouse_charters
  for all to authenticated
  using (
    exists (
      select 1 from public.charters c
      where c.id = warehouse_charters.charter_id
        and public.has_org_role(c.organization_id, 'admin')
    )
  )
  with check (
    exists (
      select 1 from public.charters c
      where c.id = warehouse_charters.charter_id
        and public.has_org_role(c.organization_id, 'admin')
    )
  );

-- ── bins ─────────────────────────────────────────────────────────────
drop policy if exists bins_write on public.bins;
create policy bins_write on public.bins
  for all to authenticated
  using (public.has_org_role(organization_id, 'manager'))
  with check (public.has_org_role(organization_id, 'manager'));

-- ── inventory_stock (per-bin item counts) ────────────────────────────
drop policy if exists inventory_stock_write on public.inventory_stock;
create policy inventory_stock_write on public.inventory_stock
  for all to authenticated
  using (public.has_org_role(organization_id, 'staff'))
  with check (public.has_org_role(organization_id, 'staff'));

-- ── putaway_moves ────────────────────────────────────────────────────
drop policy if exists putaway_moves_write on public.putaway_moves;
create policy putaway_moves_write on public.putaway_moves
  for all to authenticated
  using (public.has_org_role(organization_id, 'staff'))
  with check (public.has_org_role(organization_id, 'staff'));

-- ── receipts + receipt_lines + receipt_line_lots ─────────────────────
drop policy if exists receipts_write on public.receipts;
create policy receipts_write on public.receipts
  for all to authenticated
  using (public.has_org_role(organization_id, 'staff'))
  with check (public.has_org_role(organization_id, 'staff'));

drop policy if exists receipt_lines_write on public.receipt_lines;
create policy receipt_lines_write on public.receipt_lines
  for all to authenticated
  using (
    exists (
      select 1 from public.receipts r
      where r.id = receipt_lines.receipt_id
        and public.has_org_role(r.organization_id, 'staff')
    )
  )
  with check (
    exists (
      select 1 from public.receipts r
      where r.id = receipt_lines.receipt_id
        and public.has_org_role(r.organization_id, 'staff')
    )
  );

drop policy if exists receipt_line_lots_write on public.receipt_line_lots;
create policy receipt_line_lots_write on public.receipt_line_lots
  for all to authenticated
  using (
    exists (
      select 1 from public.receipt_lines rl
      join public.receipts r on r.id = rl.receipt_id
      where rl.id = receipt_line_lots.receipt_line_id
        and public.has_org_role(r.organization_id, 'staff')
    )
  )
  with check (
    exists (
      select 1 from public.receipt_lines rl
      join public.receipts r on r.id = rl.receipt_id
      where rl.id = receipt_line_lots.receipt_line_id
        and public.has_org_role(r.organization_id, 'staff')
    )
  );

-- ── vendor_item_mappings ─────────────────────────────────────────────
drop policy if exists vim_admin_write on public.vendor_item_mappings;
create policy vim_admin_write on public.vendor_item_mappings
  for all to authenticated
  using (public.has_org_role(organization_id, 'admin'))
  with check (public.has_org_role(organization_id, 'admin'));

-- ── outbox_events ────────────────────────────────────────────────────
drop policy if exists outbox_events_write on public.outbox_events;
create policy outbox_events_write on public.outbox_events
  for all to authenticated
  using (public.has_org_role(organization_id, 'admin'))
  with check (public.has_org_role(organization_id, 'admin'));

-- ── serial_registry ──────────────────────────────────────────────────
drop policy if exists serial_registry_write on public.serial_registry;
create policy serial_registry_write on public.serial_registry
  for all to authenticated
  using (public.has_org_role(organization_id, 'staff'))
  with check (public.has_org_role(organization_id, 'staff'));

-- ── po_import_lines ──────────────────────────────────────────────────
drop policy if exists po_import_lines_write on public.po_import_lines;
create policy po_import_lines_write on public.po_import_lines
  for all to authenticated
  using (
    exists (
      select 1 from public.po_imports pi
      where pi.id = po_import_lines.po_import_id
        and public.has_org_role(pi.organization_id, 'manager')
    )
  )
  with check (
    exists (
      select 1 from public.po_imports pi
      where pi.id = po_import_lines.po_import_id
        and public.has_org_role(pi.organization_id, 'manager')
    )
  );

-- ── schedule_events ──────────────────────────────────────────────────
-- Old policy: any org member could update or delete any event.
-- New: only the creator OR a manager+ can mutate. Reads stay open to
-- every org member (the listInRange path needs that).
drop policy if exists schedule_events_update on public.schedule_events;
create policy schedule_events_update on public.schedule_events
  for update to authenticated
  using (
    public.is_org_member(organization_id)
    and (created_by = auth.uid() or public.has_org_role(organization_id, 'manager'))
  )
  with check (
    public.is_org_member(organization_id)
    and (created_by = auth.uid() or public.has_org_role(organization_id, 'manager'))
  );

drop policy if exists schedule_events_delete on public.schedule_events;
create policy schedule_events_delete on public.schedule_events
  for delete to authenticated
  using (
    public.is_org_member(organization_id)
    and (created_by = auth.uid() or public.has_org_role(organization_id, 'manager'))
  );

-- ── order_requests UPDATE policy ─────────────────────────────────────
-- Already locked to manager+ in 0045 — reaffirm WITH CHECK here in case
-- a future migration drops it. Idempotent.
drop policy if exists order_requests_update on public.order_requests;
create policy order_requests_update on public.order_requests
  for update to authenticated
  using (public.has_org_role(organization_id, 'manager'))
  with check (public.has_org_role(organization_id, 'manager'));

-- ============================================================================
-- Storage bucket MIME-type enforcement
-- ============================================================================
-- Avatar + org-logo uploaders validate file.type in the browser only.
-- The MIME header is user-controlled (a renamed binary can claim any
-- type). Pin the buckets' allowed_mime_types so Supabase Storage
-- rejects anything outside the list before it lands in the public CDN.
-- ============================================================================

update storage.buckets
  set allowed_mime_types = array['image/png','image/jpeg','image/webp','image/avif']
  where id = 'org-logos';

update storage.buckets
  set allowed_mime_types = array['image/png','image/jpeg','image/webp','image/avif']
  where id = 'user-avatars';

-- item-images allows the same set + adds heic for mobile capture.
update storage.buckets
  set allowed_mime_types = array['image/png','image/jpeg','image/webp','image/avif','image/heic']
  where id = 'item-images';
