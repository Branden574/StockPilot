-- 0033_schedule_events_warehouse_scoped.sql
-- ============================================================================
-- Tighten RLS on schedule_events so events pinned to a warehouse are
-- only visible to staff with access to that warehouse. Managers / admins
-- get all-access via the existing user_can_access_warehouse() helper —
-- no special case here.
--
-- Policy shape:
--   • Events with warehouse_id IS NULL → visible to every org member
--     (treat as org-wide announcement, e.g. "company holiday").
--   • Events with a warehouse pin → visible only to users that
--     user_can_access_warehouse() approves for the 'read' op.
--
-- Insert / update / delete follow the same gate so a DC4 user can't
-- create an event under a warehouse they don't have access to. The
-- existing "created_by = auth.uid()" check on insert is preserved.
-- ============================================================================

drop policy if exists schedule_events_select on public.schedule_events;
create policy schedule_events_select on public.schedule_events
  for select to authenticated
  using (
    public.is_org_member(organization_id)
    and (
      warehouse_id is null
      or public.user_can_access_warehouse(auth.uid(), warehouse_id, 'read')
    )
  );

drop policy if exists schedule_events_insert on public.schedule_events;
create policy schedule_events_insert on public.schedule_events
  for insert to authenticated
  with check (
    public.is_org_member(organization_id)
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
    public.is_org_member(organization_id)
    and (
      warehouse_id is null
      or public.user_can_access_warehouse(auth.uid(), warehouse_id, 'write')
    )
  )
  with check (
    public.is_org_member(organization_id)
    and (
      warehouse_id is null
      or public.user_can_access_warehouse(auth.uid(), warehouse_id, 'write')
    )
  );

drop policy if exists schedule_events_delete on public.schedule_events;
create policy schedule_events_delete on public.schedule_events
  for delete to authenticated
  using (
    public.is_org_member(organization_id)
    and (
      warehouse_id is null
      or public.user_can_access_warehouse(auth.uid(), warehouse_id, 'write')
    )
  );
