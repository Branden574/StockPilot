-- 0451_order_photo_audience_and_grants.sql
--
-- Who reads a Wet signature photo on an order, which table privileges the API
-- roles hold on order attachments, the legacy shipment tables and orders, and
-- which rules a new Schedule event follows (docket S3, part S3c). The number
-- is provisional: it is renumbered to the first free one when its turn comes.
--
-- TIER A. This file creates three read-only helper functions, restates four
-- row policies (two on order_request_attachments, two on schedule_events) and
-- one storage policy, revokes table privileges and writes comments. It
-- inserts, updates or deletes no stored row, and it creates, drops or retypes
-- no table, view, sequence or column.
--
-- ── WHAT IT DOES ──────────────────────────────────────────────────────────
-- 1. order_signature_photo_reader(order_id): true when the caller is a member
--    of the order's organization and either holds orders:approve there or is
--    the order's driver (assigned_delivery_user_id). It is not limited by
--    warehouse (owner brief decision a.19).
-- 2. "order_request_attachments read": a member reads an attachment row of
--    their organization when it is not a Wet signature photo (kind
--    'signature'), or when they added it (uploaded_by), or when
--    order_signature_photo_reader says yes. Drop-off, location and other
--    photos are read by every member, as before.
--    The uploader term keeps the app's write working for a manager without
--    orders:approve: OrderAttachmentsService.add (web panel and the phone's
--    finalize route) inserts with RETURNING, which reads the new row.
-- 3. "order_request_attachments manager insert": 0143's check restated with
--    one term added: uploaded_by is the caller or empty, so a row cannot name
--    someone else as the person who added it.
-- 4. "order-attachments read" (storage): 0142's check restated with
--    order_attachment_object_readable(name) added, so the stored file follows
--    its row. The helper answers false only when a Wet signature row for that
--    exact path exists (looked up by the order id in the path's second folder,
--    cast only when it has the uuid shape) and the caller neither added it nor
--    passes order_signature_photo_reader. A file with no row (an upload before
--    its row is written) stays readable to members, as before.
-- 5. Revokes, none of which an app path uses (re-checked 2026-11-13 on main
--    0f560ac8d: no app, phone or edge-function code reads or writes shipments
--    or shipment_lines, and none deletes order_requests; attachments are never
--    updated, and they have no UPDATE policy):
--      * every privilege on order_request_attachments from anon;
--      * UPDATE on order_request_attachments from authenticated;
--      * every privilege on shipments and shipment_lines from anon, and
--        SELECT, INSERT, UPDATE and DELETE on both from authenticated (the
--        service role keeps its own; post_shipment_shipped is service-role
--        only since 0356);
--      * DELETE on order_requests from authenticated (its delete policy is
--        using (false) since 0119; cancel is the app's way out).
--    No privilege is granted.
-- 6. bundle_in_org(bundle, org): 0362's order_request_in_org shape for kits.
--    True for no kit, true for a kit of the organization asked by a member of
--    it (or with no end user), false otherwise. Asked by a signed-in caller who
--    is not a member of the organization it names, it answers false, so it is
--    no existence oracle for other organizations' kits.
-- 7. schedule_events_insert: 0384's check restated verbatim, plus
--    bundle_in_org(bundle_id, organization_id), has_permission(organization,
--    'schedule:manage') and module_enabled(organization, 'schedule'): the
--    checks ScheduleService.create already makes (schedule.ts:376-378), and the
--    phone's New event button already asks for schedule:manage.
--    schedule_events_update: 0384's check restated verbatim plus
--    bundle_in_org. Its USING and the creator-or-manager rule are unchanged
--    (owner decision on S3 question 12: role rank on update is a later item).
--
-- ── WHAT IT DOES NOT CHANGE ───────────────────────────────────────────────
--   * The attachments delete policy, the bucket write, update and delete
--     policies, and every grant of service_role.
--   * Any stored row.
--   * No phone update and no web change is needed: the panel lists rows under
--     row security and signs only those (order-attachments.ts list), and the
--     phone lists rows and signs links under the member's own session.
--
-- ── ORDER ─────────────────────────────────────────────────────────────────
-- Applied after the queued kits listed in the pull request (0421 S49, S36a,
-- S67b, S27b, S46, S7a, S47, B94, the module plan check, S64, S9). None of
-- them restates a policy, function or grant this file restates. S9's
-- grants cleanup revokes anon on shipments too (the same revoke twice changes
-- nothing) and pins authenticated's shipment privileges in its own suite
-- (G2), which this file's suite re-pins when the two meet.
--
-- ── LOCKS ─────────────────────────────────────────────────────────────────
-- The CLI applies the file as one implicit transaction, so each lock is held
-- to the commit. The prelude takes every table lock the file needs, at once
-- and without waiting (0404's and 0415's pattern):
--   * order_request_attachments, schedule_events, storage.objects: ACCESS
--     EXCLUSIVE (ALTER POLICY);
--   * order_requests: ACCESS SHARE (the attachments insert check reads it);
--   * every existing table supautils.policy_grants lists for this role,
--     ACCESS EXCLUSIVE (supautils takes it on any policy statement).
-- REVOKE, CREATE FUNCTION and COMMENT take no lock on a table that conflicts
-- with readers. The storage policy is the last statement before the reset
-- (storage-policy-order.guard.test.ts).

-- PLAIN `set`, not `set local` (0303/0358): the CLI batch is not a
-- transaction block. Reset at the end.
set lock_timeout = '5s';

-- ═══ 1. The lock prelude ═══════════════════════════════════════════════════
-- A busy table fails the attempt at once; the rollback of the inner block
-- releases what it took and the next attempt starts 50 to 150 ms later. After
-- the 40th busy attempt the 55P03 is raised as it is and nothing in the file
-- is applied.
do $lock451$
declare
  v_grants text := nullif(current_setting('supautils.policy_grants', true), '');
  v_name   text;
  v_rel    regclass;
  v_try    integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.order_requests in access share mode nowait;
      lock table only public.order_request_attachments, public.schedule_events
        in access exclusive mode nowait;
      lock table only storage.objects in access exclusive mode nowait;
      if v_grants is not null then
        for v_name in
          select jsonb_array_elements_text(coalesce(v_grants::jsonb -> current_user::text, '[]'::jsonb))
        loop
          v_rel := to_regclass(v_name);
          if v_rel is not null then
            execute format('lock table only %s in access exclusive mode nowait', v_rel);
          end if;
        end loop;
      end if;
      exit;
    exception when lock_not_available then
      if v_try >= 40 then
        raise;
      end if;
    end;
    perform pg_sleep(0.05 + random() * 0.1);
  end loop;
end $lock451$;

-- ═══ 2. Who reads a Wet signature photo ════════════════════════════════════
create function public.order_signature_photo_reader(p_order_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.order_requests o
     where o.id = p_order_request_id
       and public.is_org_member(o.organization_id)
       and (   public.has_permission(o.organization_id, 'orders:approve')
            or o.assigned_delivery_user_id = (select auth.uid()))
  );
$$;
revoke all on function public.order_signature_photo_reader(uuid) from public, anon;
grant execute on function public.order_signature_photo_reader(uuid) to authenticated, service_role;
comment on function public.order_signature_photo_reader(uuid) is
  'S3c (0451): true when the caller is a member of the order''s organization and holds orders:approve there '
  '(not limited by warehouse) or is the order''s driver (assigned_delivery_user_id). Read-only boolean used by '
  'the order_request_attachments read policy and order_attachment_object_readable.';

alter policy "order_request_attachments read" on public.order_request_attachments
  using (
    public.is_org_member(organization_id)
    and (   kind <> 'signature'
         or uploaded_by = (select auth.uid())
         or public.order_signature_photo_reader(order_request_id))
  );
comment on policy "order_request_attachments read" on public.order_request_attachments is
  'S3c (0451): a member reads the attachments of their organization; a Wet signature photo (kind signature) '
  'only when they added it, hold orders:approve, or are the order''s driver (order_signature_photo_reader).';

-- 0143's check, restated verbatim, with the uploader term added last.
alter policy "order_request_attachments manager insert" on public.order_request_attachments
  with check (
    public.has_org_role(organization_id, 'manager')
    and exists (
      select 1 from public.order_requests o
      where o.id = order_request_attachments.order_request_id
        and o.organization_id = order_request_attachments.organization_id
        and o.status in (
          'staged_for_pickup', 'staged_for_delivery',
          'in_transit', 'signature_requested', 'completed'
        )
    )
    and split_part(storage_path, '/', 1) = organization_id::text
    and (uploaded_by is null or uploaded_by = (select auth.uid()))
  );
comment on policy "order_request_attachments manager insert" on public.order_request_attachments is
  'A manager adds an attachment to an order of the same organization in a delivery or completed status, under '
  'the organization''s folder (0143); since S3c (0451) uploaded_by is the caller or empty.';

-- The storage read's helper (the policy itself is the last statement).
create function public.order_attachment_object_readable(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select not exists (
    select 1
      from public.order_request_attachments a
     where a.order_request_id = (
             case when (storage.foldername(p_name))[2]
                       ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  then ((storage.foldername(p_name))[2])::uuid
             end)
       and a.storage_path = p_name
       and a.kind = 'signature'
       and a.uploaded_by is distinct from (select auth.uid())
       and not public.order_signature_photo_reader(a.order_request_id)
  );
$$;
revoke all on function public.order_attachment_object_readable(text) from public, anon;
grant execute on function public.order_attachment_object_readable(text) to authenticated, service_role;
comment on function public.order_attachment_object_readable(text) is
  'S3c (0451): false only when a Wet signature attachment row stores this exact path and the caller neither '
  'added it nor passes order_signature_photo_reader; true for every other name. Read-only boolean used by the '
  'order-attachments bucket read policy.';

-- ═══ 3. Table privileges ═══════════════════════════════════════════════════
revoke all on table public.order_request_attachments from anon;
revoke update on table public.order_request_attachments from authenticated;
revoke all on table public.shipments, public.shipment_lines from anon;
revoke select, insert, update, delete on table public.shipments, public.shipment_lines from authenticated;
revoke delete on table public.order_requests from authenticated;

-- ═══ 4. Schedule events: the kit's organization, schedule:manage, the module ═
create function public.bundle_in_org(p_bundle_id uuid, p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_bundle_id is null or (
    ((select auth.uid()) is null or public.is_org_member(p_org_id))
    and exists (
      select 1 from public.bundles
       where id = p_bundle_id and organization_id = p_org_id
    )
  );
$$;
revoke all on function public.bundle_in_org(uuid, uuid) from public, anon;
grant execute on function public.bundle_in_org(uuid, uuid) to authenticated, service_role;
comment on function public.bundle_in_org(uuid, uuid) is
  'S3c (0451): true for no kit, or for a kit of p_org_id asked by a member of p_org_id (or with no end user); '
  'false otherwise. 0362''s order_request_in_org shape. Read-only boolean used by the schedule_events write policies.';

-- 0384's text, restated verbatim, then the three S3c terms.
alter policy schedule_events_insert on public.schedule_events
  with check (
    (( SELECT public.is_org_member(schedule_events.organization_id) AS is_org_member)
      AND (created_by = auth.uid())
      AND ((warehouse_id IS NULL) OR public.user_can_access_warehouse(auth.uid(), warehouse_id, 'write'::text))
      AND ( SELECT public.warehouse_in_org(schedule_events.bundle_warehouse_id, schedule_events.organization_id) AS warehouse_in_org))
    AND ( SELECT public.order_request_in_org(schedule_events.order_request_id, schedule_events.organization_id) AS order_request_in_org)
    AND ( SELECT public.bundle_in_org(schedule_events.bundle_id, schedule_events.organization_id) AS bundle_in_org)
    AND ( SELECT public.has_permission(schedule_events.organization_id, 'schedule:manage'::text) AS has_permission)
    AND ( SELECT public.module_enabled(schedule_events.organization_id, 'schedule'::text) AS module_enabled)
  );

-- 0384's WITH CHECK, restated verbatim, then bundle_in_org. USING unchanged.
alter policy schedule_events_update on public.schedule_events
  with check (
    (( SELECT public.is_org_member(schedule_events.organization_id) AS is_org_member)
      AND ((created_by = auth.uid())
           OR ( SELECT public.has_org_role(schedule_events.organization_id, 'manager'::text) AS has_org_role))
      AND ( SELECT public.warehouse_in_org(schedule_events.warehouse_id, schedule_events.organization_id) AS warehouse_in_org)
      AND ( SELECT public.warehouse_in_org(schedule_events.bundle_warehouse_id, schedule_events.organization_id) AS warehouse_in_org))
    AND ( SELECT public.order_request_in_org(schedule_events.order_request_id, schedule_events.organization_id) AS order_request_in_org)
    AND ( SELECT public.bundle_in_org(schedule_events.bundle_id, schedule_events.organization_id) AS bundle_in_org)
  );

comment on policy schedule_events_insert on public.schedule_events is
  'A member with schedule:manage, in an organization with the Schedule module on, inserts their own event '
  '(created_by = the caller) in a warehouse they may write, with a bundle source warehouse (0203) and a kit '
  '(S3c, 0451) of the same organization, and no order of another organization (0384; authenticated cannot '
  'write order_request_id at all, the admin client links events).';
comment on policy schedule_events_update on public.schedule_events is
  'The creator or a manager updates an event; the new row keeps both warehouses (0203), its linked order '
  '(0384) and its kit (S3c, 0451) in the organization, so an event cannot be moved to another organization.';

-- ═══ 5. The order-attachments bucket follows its rows (last: storage) ══════
-- 0142's text with order_attachment_object_readable(name) added. Nothing may
-- follow it but the lock_timeout reset (storage-policy-order.guard.test.ts).
alter policy "order-attachments read" on storage.objects
  using (
    bucket_id = 'order-attachments'
    and public.is_org_member((storage.foldername(name))[1]::uuid)
    and public.order_attachment_object_readable(name)
  );

reset lock_timeout;
