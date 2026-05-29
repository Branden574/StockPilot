-- 0143_security_hardening_2026_05_28.sql
-- ============================================================================
-- Security hardening from the 2026-05-28 multi-agent review of that day's
-- changes. Three independent, RLS/storage-layer fixes (so they hold for ALL
-- clients — web service, mobile direct-write, and raw PostgREST alike):
--
--  1. cycle_count_lines UPDATE — restore the status + counted_by invariants
--     that 0049 enforced and 0080 inadvertently dropped when it loosened the
--     write role from manager+ to staff+. Without them, any staff member can,
--     via a direct PostgREST update (the mobile offline-sync path does exactly
--     this and never reaches the service-layer gate):
--       * overwrite counted_quantity on a completed/canceled count
--         (corrupting the historical / audit snapshot), and
--       * set counted_by to another user (audit-field impersonation).
--     We keep 0080's staff+ loosening; we only re-add the two integrity gates.
--
--  2. order_request_attachments INSERT — bind the row to the referenced
--     order's org + an attachable status + the org storage-path prefix, so the
--     mobile direct insert can't fabricate proof on non-attachable orders or
--     reference a cross-org order id. The web service enforced this; RLS did
--     not, and mobile inserts straight to the table.
--
--  3. order-attachments bucket — pin allowed_mime_types + file_size_limit, the
--     same hardening every other bucket got in 0046/0047/0124. Stops oversized
--     uploads (cost abuse) and stored HTML/SVG that would be served inline from
--     the storage origin.
-- ============================================================================

-- 1. cycle_count_lines UPDATE — restore in-progress + counted_by integrity ----
--    (0049 had both on a combined FOR ALL policy; 0080 split the policies and
--     dropped them. INSERT stays manager-gated as 0080/0140 left it.)
drop policy if exists cycle_count_lines_update on public.cycle_count_lines;
create policy cycle_count_lines_update on public.cycle_count_lines
  for update to authenticated
  using (
    exists (
      select 1 from public.cycle_counts cc
      where cc.id = cycle_count_lines.cycle_count_id
        and (select public.has_org_role(cc.organization_id, 'staff'))
        and cc.status = 'in_progress'
    )
  )
  with check (
    exists (
      select 1 from public.cycle_counts cc
      where cc.id = cycle_count_lines.cycle_count_id
        and (select public.has_org_role(cc.organization_id, 'staff'))
        and cc.status = 'in_progress'
    )
    -- Audit-field integrity: counted_by may only be the calling user or null.
    and (counted_by is null or counted_by = (select auth.uid()))
  );

-- 2. order_request_attachments INSERT — bind to the order's org + status ------
drop policy if exists "order_request_attachments manager insert"
  on public.order_request_attachments;
create policy "order_request_attachments manager insert"
  on public.order_request_attachments for insert to authenticated
  with check (
    public.has_org_role(organization_id, 'manager')
    -- The referenced order must belong to the SAME org and be in a status
    -- where proof-of-delivery attachments are allowed (mirrors the web
    -- service's ATTACHABLE_ORDER_STATUSES check).
    and exists (
      select 1 from public.order_requests o
      where o.id = order_request_attachments.order_request_id
        and o.organization_id = order_request_attachments.organization_id
        and o.status in (
          'staged_for_pickup', 'staged_for_delivery',
          'in_transit', 'signature_requested', 'completed'
        )
    )
    -- The stored object must live under this org's prefix (matches the
    -- {org}/{order}/{uuid} path convention + the bucket RLS).
    and split_part(storage_path, '/', 1) = organization_id::text
  );

-- 3. order-attachments bucket — pin type + size limits ------------------------
update storage.buckets
  set allowed_mime_types = array[
        'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif',
        'application/pdf'
      ],
      file_size_limit = 15 * 1024 * 1024
  where id = 'order-attachments';
