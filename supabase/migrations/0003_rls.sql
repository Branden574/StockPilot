-- ============================================================================
-- 0003_rls.sql — Row-Level Security policies
-- All tenant tables are scoped via organization_id + organization_members.
-- ============================================================================

-- ============================================================================
-- ORGANIZATIONS
-- ============================================================================
create policy organizations_select on public.organizations
  for select to authenticated
  using (public.is_org_member(id));

create policy organizations_insert on public.organizations
  for insert to authenticated
  with check (auth.uid() is not null);

create policy organizations_update on public.organizations
  for update to authenticated
  using (public.has_org_role(id, 'admin'))
  with check (public.has_org_role(id, 'admin'));

create policy organizations_delete on public.organizations
  for delete to authenticated
  using (public.has_org_role(id, 'owner'));

-- ============================================================================
-- USER PROFILES — readable by org-mates, writable only by self
-- ============================================================================
create policy user_profiles_select_self on public.user_profiles
  for select to authenticated
  using (id = auth.uid());

create policy user_profiles_select_orgmates on public.user_profiles
  for select to authenticated
  using (
    exists (
      select 1
      from public.organization_members me
      join public.organization_members them
        on them.organization_id = me.organization_id
      where me.user_id = auth.uid()
        and me.accepted_at is not null
        and them.user_id = public.user_profiles.id
    )
  );

create policy user_profiles_update_self on public.user_profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- ============================================================================
-- ORGANIZATION MEMBERS
-- ============================================================================
create policy organization_members_select on public.organization_members
  for select to authenticated
  using (public.is_org_member(organization_id));

create policy organization_members_insert on public.organization_members
  for insert to authenticated
  with check (
    -- Either the user is creating their own membership upon org creation/invite acceptance,
    -- or they are an admin/owner adding someone else.
    user_id = auth.uid()
    or public.has_org_role(organization_id, 'admin')
  );

create policy organization_members_update on public.organization_members
  for update to authenticated
  using (public.has_org_role(organization_id, 'admin'))
  with check (public.has_org_role(organization_id, 'admin'));

create policy organization_members_delete on public.organization_members
  for delete to authenticated
  using (
    user_id = auth.uid()
    or public.has_org_role(organization_id, 'admin')
  );

-- ============================================================================
-- ORGANIZATION INVITES
-- ============================================================================
create policy organization_invites_select on public.organization_invites
  for select to authenticated
  using (public.has_org_role(organization_id, 'admin'));

create policy organization_invites_insert on public.organization_invites
  for insert to authenticated
  with check (public.has_org_role(organization_id, 'admin'));

create policy organization_invites_delete on public.organization_invites
  for delete to authenticated
  using (public.has_org_role(organization_id, 'admin'));

-- Token lookups happen server-side via the service role; no anon select policy.

-- ============================================================================
-- TAXONOMY (categories, tags)
-- ============================================================================
create policy categories_select on public.categories
  for select to authenticated using (public.is_org_member(organization_id));
create policy categories_insert on public.categories
  for insert to authenticated with check (public.has_org_role(organization_id, 'manager'));
create policy categories_update on public.categories
  for update to authenticated
  using (public.has_org_role(organization_id, 'manager'))
  with check (public.has_org_role(organization_id, 'manager'));
create policy categories_delete on public.categories
  for delete to authenticated using (public.has_org_role(organization_id, 'admin'));

create policy tags_select on public.tags
  for select to authenticated using (public.is_org_member(organization_id));
create policy tags_write on public.tags
  for all to authenticated
  using (public.has_org_role(organization_id, 'manager'))
  with check (public.has_org_role(organization_id, 'manager'));

-- ============================================================================
-- LOCATIONS
-- ============================================================================
create policy locations_select on public.locations
  for select to authenticated using (public.is_org_member(organization_id));
create policy locations_insert on public.locations
  for insert to authenticated with check (public.has_org_role(organization_id, 'manager'));
create policy locations_update on public.locations
  for update to authenticated
  using (public.has_org_role(organization_id, 'manager'))
  with check (public.has_org_role(organization_id, 'manager'));
create policy locations_delete on public.locations
  for delete to authenticated using (public.has_org_role(organization_id, 'admin'));

-- ============================================================================
-- SUPPLIERS
-- ============================================================================
create policy suppliers_select on public.suppliers
  for select to authenticated using (public.is_org_member(organization_id));
create policy suppliers_write on public.suppliers
  for all to authenticated
  using (public.has_org_role(organization_id, 'manager'))
  with check (public.has_org_role(organization_id, 'manager'));

-- ============================================================================
-- INVENTORY ITEMS + RELATED
-- ============================================================================
create policy inventory_items_select on public.inventory_items
  for select to authenticated using (public.is_org_member(organization_id));
create policy inventory_items_insert on public.inventory_items
  for insert to authenticated with check (public.has_org_role(organization_id, 'staff'));
create policy inventory_items_update on public.inventory_items
  for update to authenticated
  using (public.has_org_role(organization_id, 'staff'))
  with check (public.has_org_role(organization_id, 'staff'));
create policy inventory_items_delete on public.inventory_items
  for delete to authenticated using (public.has_org_role(organization_id, 'admin'));

create policy item_stock_levels_select on public.item_stock_levels
  for select to authenticated using (public.is_org_member(organization_id));
create policy item_stock_levels_write on public.item_stock_levels
  for all to authenticated
  using (public.has_org_role(organization_id, 'staff'))
  with check (public.has_org_role(organization_id, 'staff'));

create policy item_images_select on public.item_images
  for select to authenticated using (public.is_org_member(organization_id));
create policy item_images_write on public.item_images
  for all to authenticated
  using (public.has_org_role(organization_id, 'staff'))
  with check (public.has_org_role(organization_id, 'staff'));

create policy item_attachments_select on public.item_attachments
  for select to authenticated using (public.is_org_member(organization_id));
create policy item_attachments_write on public.item_attachments
  for all to authenticated
  using (public.has_org_role(organization_id, 'staff'))
  with check (public.has_org_role(organization_id, 'staff'));

create policy item_tags_all on public.item_tags
  for all to authenticated
  using (
    exists (
      select 1 from public.inventory_items it
      where it.id = item_id and public.has_org_role(it.organization_id, 'staff')
    )
  )
  with check (
    exists (
      select 1 from public.inventory_items it
      where it.id = item_id and public.has_org_role(it.organization_id, 'staff')
    )
  );

-- ============================================================================
-- STOCK MOVEMENTS — append-only
-- ============================================================================
create policy stock_movements_select on public.stock_movements
  for select to authenticated using (public.is_org_member(organization_id));
create policy stock_movements_insert on public.stock_movements
  for insert to authenticated with check (public.has_org_role(organization_id, 'staff'));
-- intentionally no update or delete policies — ledger is immutable from the client side

-- ============================================================================
-- PURCHASE ORDERS
-- ============================================================================
create policy purchase_orders_select on public.purchase_orders
  for select to authenticated using (public.is_org_member(organization_id));
create policy purchase_orders_write on public.purchase_orders
  for all to authenticated
  using (public.has_org_role(organization_id, 'manager'))
  with check (public.has_org_role(organization_id, 'manager'));

create policy purchase_order_items_select on public.purchase_order_items
  for select to authenticated using (public.is_org_member(organization_id));
create policy purchase_order_items_write on public.purchase_order_items
  for all to authenticated
  using (public.has_org_role(organization_id, 'manager'))
  with check (public.has_org_role(organization_id, 'manager'));

-- ============================================================================
-- NOTIFICATIONS
-- ============================================================================
create policy notifications_select_own on public.notifications
  for select to authenticated using (user_id = auth.uid());
create policy notifications_update_own on public.notifications
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
-- inserts done via service role from server-side workers

create policy notification_preferences_self on public.notification_preferences
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ============================================================================
-- ACTIVITY + AUDIT — read by managers/admins, no client write
-- ============================================================================
create policy activity_logs_select on public.activity_logs
  for select to authenticated using (public.has_org_role(organization_id, 'manager'));
create policy audit_logs_select on public.audit_logs
  for select to authenticated using (public.has_org_role(organization_id, 'admin'));

-- ============================================================================
-- PUSH TOKENS — self only
-- ============================================================================
create policy push_tokens_self on public.push_tokens
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ============================================================================
-- IMPORTS — managers manage, staff can see their own
-- ============================================================================
create policy import_jobs_select on public.import_jobs
  for select to authenticated using (public.is_org_member(organization_id));
create policy import_jobs_write on public.import_jobs
  for all to authenticated
  using (public.has_org_role(organization_id, 'manager'))
  with check (public.has_org_role(organization_id, 'manager'));

create policy import_job_errors_select on public.import_job_errors
  for select to authenticated
  using (
    exists (
      select 1 from public.import_jobs j
      where j.id = import_job_id and public.is_org_member(j.organization_id)
    )
  );

-- ============================================================================
-- BILLING EVENTS — service role only; no client policies (RLS enabled but no allows)
-- ============================================================================

-- ============================================================================
-- STORAGE BUCKETS — RLS on storage.objects per bucket
-- Path convention: {bucket}/{organization_id}/...
-- ============================================================================
create policy "item-images authenticated read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'item-images'
    and public.is_org_member((storage.foldername(name))[1]::uuid)
  );

create policy "item-images staff write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'item-images'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'staff')
  );

create policy "item-images staff update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'item-images'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'staff')
  );

create policy "item-images staff delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'item-images'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'staff')
  );

create policy "item-attachments authenticated read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'item-attachments'
    and public.is_org_member((storage.foldername(name))[1]::uuid)
  );

create policy "item-attachments staff write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'item-attachments'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'staff')
  );

create policy "org-logos public read"
  on storage.objects for select to anon, authenticated
  using (bucket_id = 'org-logos');

create policy "org-logos admin write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'org-logos'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'admin')
  );
