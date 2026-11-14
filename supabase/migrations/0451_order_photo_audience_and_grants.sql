-- 0451_order_photo_audience_and_grants.sql
--
-- Who reads, removes and replaces a Wet signature photo on an order and its
-- stored file, which stored file an attachment row may name, which table
-- privileges the API roles hold on order attachments, the legacy shipment
-- tables and orders, and what a Schedule event write asks (docket S3, part
-- S3c). The number is provisional: it is renumbered to the first free one
-- when its turn comes.
--
-- TIER A. This file adds one unique index, creates three read-only helper
-- functions, restates three row policies on order_request_attachments, three
-- on schedule_events and the four order-attachments policies on
-- storage.objects, revokes table privileges and writes comments. It inserts,
-- updates or deletes no stored row, and it creates, drops or retypes no
-- table, view, sequence or column. The unique index is built over the rows
-- already stored; the preflight right after the lock prelude stops the file,
-- before any change, when two rows name the same stored file.
--
-- ── WHAT IT DOES ──────────────────────────────────────────────────────────
-- 1. order_request_attachments_storage_path_key: each stored file is named by
--    at most one attachment row.
-- 2. order_signature_photo_reader(order_id): true when the caller is a member
--    of the order's organization and either holds orders:approve there or is
--    the order's driver (assigned_delivery_user_id). Any warehouse (owner
--    brief decision a.19).
-- 3. order_request_attachments, the three row policies:
--      read    a member of the organization; a Wet signature photo (kind
--              'signature') only for the person who added it (uploaded_by),
--              or when order_signature_photo_reader says yes.
--      insert  0143's check, plus: the path is exactly
--              {organization}/{this order}/{file}, the file part follows the
--              web's file-name rule (OBJECT_FILENAME_SEGMENT: 1 to 120 of
--              A-Z a-z 0-9 _ -, then one to three .ext of 1 to 10 letters or
--              digits); the stored file is already in the bucket and its rule
--              (item 4) lets the caller read it; uploaded_by is the caller or
--              empty.
--      delete  a manager (0142), and for a Wet signature photo the same
--              audience as read.
--    The app writes with RETURNING (OrderAttachmentsService.add, used by the
--    web panel and the phone's finalize route), which reads the new row back
--    through the uploader term.
-- 4. order_attachment_object_readable(name, owner): the stored file's rule.
--    When a row names the file, the row's rule decides (a Wet signature file
--    for its uploader or order_signature_photo_reader). When no row names it
--    yet, the member who uploaded it (the object's owner_id, or owner on an
--    older storage server) or a member who holds orders:approve in the
--    organization of its first folder.
-- 5. The order-attachments bucket, its four policies dropped and created
--    again (the way 0142 created them): read asks membership and the file's
--    rule; write is 0142's manager check; update (USING and WITH CHECK) and
--    delete ask the manager check and the file's rule.
-- 6. Revokes; no privilege is granted:
--      * every privilege on order_request_attachments from anon;
--      * UPDATE on order_request_attachments from authenticated (it has no
--        UPDATE policy);
--      * every privilege on shipments and shipment_lines from anon, and
--        SELECT, INSERT, UPDATE and DELETE on both from authenticated (the
--        service role keeps its own; post_shipment_shipped is service-role
--        only since 0356);
--      * DELETE on order_requests from authenticated (its delete policy is
--        using (false) since 0119; cancel is the app's way out).
--    Re-checked 2026-11-13 on main: no app, phone or edge-function code reads
--    or writes shipments or shipment_lines, deletes order_requests or updates
--    an attachment row.
-- 7. bundle_in_org(bundle, org): 0362's order_request_in_org shape for kits.
--    True for no kit, or for a kit of p_org_id asked by a member of p_org_id
--    (or with no end user); false otherwise.
-- 8. schedule_events, every write asks schedule:manage and the Schedule
--    module (the checks ScheduleService.create, .update and .delete make,
--    schedule.ts:376-378, 452-453, 760-761):
--      insert  0384's check, plus bundle_in_org, schedule:manage and the
--              module.
--      update  0384's USING and WITH CHECK (the creator or a manager), plus
--              schedule:manage and the module, and bundle_in_org in WITH
--              CHECK.
--      delete  0140's USING (the creator or a manager), plus schedule:manage
--              and the module.
--    The order flows (autoScheduleFromOrder, assignDelivery's driver sync,
--    syncOrderScheduleEvent, bringOrderEventInStep) and the reminder job
--    write through the admin client; revise_order_needed_by is SECURITY
--    DEFINER.
-- 9. The web's OrderAttachmentsService.add asks the same path shape (HI-8,
--    orderAttachmentPathShape: {organization}/{this order}/{file}, with
--    OBJECT_FILENAME_SEGMENT as the file part; a guard test ties the two).
--    OrderAttachmentsService.list signs a stored row's path only when it is
--    under the organization's folder with no ?, # or whitespace and no
--    empty, . or .. segment; any other row is listed without a link.
--
-- ── ORDER ─────────────────────────────────────────────────────────────────
-- Applied after the queued kits listed in the pull request (0421 S49, S36a,
-- S67b, S27b, S46, S7a, S47, B94, the module plan check, S64, S9). None of
-- them restates a policy, function or grant this file restates. S9's
-- grants cleanup revokes anon on shipments too (the same revoke twice changes
-- nothing) and pins authenticated's shipment privileges in its own suite
-- (G2), which is re-pinned when the two meet.
--
-- ── LOCKS ─────────────────────────────────────────────────────────────────
-- The CLI applies the file as one implicit transaction, so each lock is held
-- to the commit. The preflight reads the catalogs only, in a block it always
-- undoes, so it holds no table lock afterwards. The prelude then takes
-- every table lock the file needs, at once and without waiting (0404's and
-- 0415's pattern):
--   * order_request_attachments, schedule_events, storage.objects: ACCESS
--     EXCLUSIVE (the policy statements; the index's SHARE lock is covered);
--   * order_requests and bundles: ACCESS SHARE (the attachments insert check
--     and the helpers' bodies read them when they are created);
--   * every existing table supautils.policy_grants lists for this role,
--     ACCESS EXCLUSIVE (supautils takes it on any policy statement).
-- REVOKE, CREATE FUNCTION and COMMENT take no other table lock. The storage
-- policies are the last statements before the reset
-- (storage-policy-order.guard.test.ts). scripts/db-concurrency/
-- 0451_migration_lock_footprint.sh proves the footprint.

-- PLAIN `set`, not `set local` (0303/0358): the CLI batch is not a
-- transaction block. Reset at the end.
set lock_timeout = '5s';

-- ═══ 0. Preflight (catalogs only) ══════════════════════════════════════════
-- Each policy this file restates or drops has the text (command, permissive,
-- roles, USING and WITH CHECK, md5 as 0420 pins them) measured on a stack at
-- 0420, no other policy is on those tables or under the order-attachments
-- name, and the objects this file adds are not there yet. Any difference
-- stops the file before it changes anything (55000, hint s3c_preflight).
-- Deparsing a policy whose expression reads another table takes ACCESS SHARE
-- on it until the transaction ends, so the reading runs in a block that is
-- always undone: the file holds no table lock before the prelude.
-- search_path is pinned inside the block (undone with it) so the deparsed
-- text does not depend on the session's. Variables keep their values when the
-- block is undone.
do $pre451$
declare
  v_bad text := '';
  r     record;
begin
  begin
    perform set_config('search_path', 'public, extensions', true);
    for r in
      select coalesce(v.tbl, g.tbl) as tbl, coalesce(v.pol, g.pol) as pol, v.want, g.got
        from (values
          ('public.order_request_attachments', 'order_request_attachments manager delete', '8d1c75406f54a184e3fce3a43e4e1229'),
          ('public.order_request_attachments', 'order_request_attachments manager insert', '72eca4c51e0712f78f3b712b5ac7ef37'),
          ('public.order_request_attachments', 'order_request_attachments read',           'bb3ac0c41dec908f7a4386e7ae99cab9'),
          ('public.schedule_events', 'schedule_events_delete', 'a51a628c9dc54deae0e9d3f561f0934d'),
          ('public.schedule_events', 'schedule_events_insert', '5f59edceac81ccd576d3ca8f77bce9ac'),
          ('public.schedule_events', 'schedule_events_select', 'bcae5d917a0c612de0e8b0951e00e376'),
          ('public.schedule_events', 'schedule_events_update', 'c3be89e76538b3e7db86f170530c68d6'),
          ('storage.objects', 'order-attachments manager delete', '0fa41c18b3b7cbb4549894d0b0f88c97'),
          ('storage.objects', 'order-attachments manager update', '64cb9e4392e29ad09cbf8625f9faebd9'),
          ('storage.objects', 'order-attachments manager write',  '40ec634fc037fe7b46e6c15cc3d70226'),
          ('storage.objects', 'order-attachments read',           'd3b2c4ced0d653826eb686b07dff2d9d')
        ) v(tbl, pol, want)
        full join (
          select n.nspname || '.' || c.relname as tbl, pol.polname as pol,
                 md5(pol.polcmd::text || '|' || pol.polpermissive::text || '|'
                     || (select string_agg(case x when 0 then 'public' else x::regrole::text end, ',' order by 1)
                           from unnest(pol.polroles) x)
                     || '|' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')
                     || '|' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')) as got
            from pg_policy pol join pg_class c on c.oid = pol.polrelid
            join pg_namespace n on n.oid = c.relnamespace
           where c.oid in ('public.order_request_attachments'::regclass, 'public.schedule_events'::regclass)
              or (c.oid = 'storage.objects'::regclass and pol.polname like 'order-attachments %')
        ) g on g.tbl = v.tbl and g.pol = v.pol
    loop
      if r.want is null then
        v_bad := v_bad || format(' unexpected policy %s on %s;', r.pol, r.tbl);
      elsif r.got is distinct from r.want then
        v_bad := v_bad || format(' policy %s on %s drifted (%s);', r.pol, r.tbl, coalesce(r.got, 'missing'));
      end if;
    end loop;
    raise exception using errcode = 'XX420', message = 'undo';
  exception when sqlstate 'XX420' then
    null;
  end;
  if to_regprocedure('public.order_signature_photo_reader(uuid)') is not null
     or to_regprocedure('public.order_attachment_object_readable(text,text)') is not null
     or to_regprocedure('public.bundle_in_org(uuid,uuid)') is not null
     or to_regclass('public.order_request_attachments_storage_path_key') is not null then
    v_bad := v_bad || ' a function or index this file adds already exists;';
  end if;
  if v_bad <> '' then
    raise exception 's3c_preflight:%', v_bad using errcode = '55000', hint = 's3c_preflight';
  end if;
end
$pre451$;

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
      lock table only public.order_requests, public.bundles in access share mode nowait;
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

-- ═══ 2. One row per stored file ════════════════════════════════════════════
-- Counted with the table locked, so the count is exact. The message carries
-- the count only.
do $dup451$
declare
  v_dup bigint;
begin
  select count(*) into v_dup
    from (select storage_path from public.order_request_attachments
           group by storage_path having count(*) > 1) d;
  if v_dup > 0 then
    raise exception 's3c_preflight: % stored file path(s) are named by more than one attachment row; resolve them before this migration', v_dup
      using errcode = '55000', hint = 's3c_preflight';
  end if;
end
$dup451$;

create unique index order_request_attachments_storage_path_key
  on public.order_request_attachments (storage_path);
comment on index public.order_request_attachments_storage_path_key is
  'S3c (0451): each stored file in the order-attachments bucket is named by at most one attachment row.';

-- ═══ 3. Who reads and removes a Wet signature photo ════════════════════════
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
  '(any warehouse) or is the order''s driver (assigned_delivery_user_id). Read-only boolean used by the '
  'order_request_attachments read and delete policies and order_attachment_object_readable.';

alter policy "order_request_attachments read" on public.order_request_attachments
  using (
    public.is_org_member(organization_id)
    and (   kind <> 'signature'
         or uploaded_by = (select auth.uid())
         or public.order_signature_photo_reader(order_request_id))
  );
comment on policy "order_request_attachments read" on public.order_request_attachments is
  'S3c (0451): a member reads the attachments of their organization; a Wet signature photo (kind signature) '
  'when they added it, hold orders:approve, or are the order''s driver (order_signature_photo_reader).';

-- The stored file's rule, used by the insert check below and by the bucket
-- policies (which come last).
create function public.order_attachment_object_readable(p_name text, p_owner text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    -- A row names the file: the row's rule decides.
    (select a.kind <> 'signature'
            or coalesce(a.uploaded_by = (select auth.uid()), false)
            or public.order_signature_photo_reader(a.order_request_id)
       from public.order_request_attachments a
      where a.storage_path = p_name),
    -- No row names it yet: its uploader, or an approver of its organization.
    coalesce(p_owner = ((select auth.uid())::text), false)
    or coalesce((
      select public.is_org_member(f.org) and public.has_permission(f.org, 'orders:approve')
        from (select case when (storage.foldername(p_name))[1]
                                 ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                          then ((storage.foldername(p_name))[1])::uuid
                     end as org) f), false)
  );
$$;
revoke all on function public.order_attachment_object_readable(text, text) from public, anon;
grant execute on function public.order_attachment_object_readable(text, text) to authenticated, service_role;
comment on function public.order_attachment_object_readable(text, text) is
  'S3c (0451): the rule for a stored file in the order-attachments bucket. When an attachment row names the '
  'file, the row''s rule (a Wet signature file for its uploader or order_signature_photo_reader); when none does, '
  'the member who uploaded it (p_owner: the object''s owner_id, else owner) or a member holding orders:approve in '
  'the organization of its first folder. Read-only boolean used by the attachments insert check and the bucket''s read, update and delete policies.';

-- 0143's check, restated verbatim, with the path, file and uploader terms
-- added last. The file-name pattern is the same rule as the web's
-- OBJECT_FILENAME_SEGMENT (apps/web/src/lib/storage-path.ts), which
-- OrderAttachmentsService.add asks through orderAttachmentPathShape;
-- storage-path.order-attachments-db-rule.guard.test.ts fails when one changes
-- without the other. The file term asks that the stored file is already in
-- the order-attachments bucket and that its rule lets the caller read it
-- (order_attachment_object_readable): every flow uploads the file before it
-- files the row.
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
    and storage_path = organization_id::text || '/' || order_request_id::text || '/'
                       || split_part(storage_path, '/', 3)
    and split_part(storage_path, '/', 3) ~ '^[A-Za-z0-9_-]{1,120}(\.[A-Za-z0-9]{1,10}){1,3}$'
    and exists (
      select 1 from storage.objects so
       where so.bucket_id = 'order-attachments'
         and so.name = order_request_attachments.storage_path
         and public.order_attachment_object_readable(so.name, coalesce(so.owner_id, so.owner::text))
    )
    and (uploaded_by is null or uploaded_by = (select auth.uid()))
  );
comment on policy "order_request_attachments manager insert" on public.order_request_attachments is
  'A manager adds an attachment to an order of the same organization in a delivery or completed status (0143); '
  'since S3c (0451) its path is exactly {organization}/{order}/{file} with the web''s file-name rule, the stored '
  'file is in the bucket and readable to the caller under order_attachment_object_readable, and uploaded_by is the '
  'caller or empty.';

-- 0142's USING, with the read rule's Wet signature term added.
alter policy "order_request_attachments manager delete" on public.order_request_attachments
  using (
    public.has_org_role(organization_id, 'manager')
    and (   kind <> 'signature'
         or uploaded_by = (select auth.uid())
         or public.order_signature_photo_reader(order_request_id))
  );
comment on policy "order_request_attachments manager delete" on public.order_request_attachments is
  'A manager removes an attachment of their organization (0142); since S3c (0451) a Wet signature photo only '
  'when they added it or order_signature_photo_reader says yes.';

-- ═══ 4. Table privileges ═══════════════════════════════════════════════════
revoke all on table public.order_request_attachments from anon;
revoke update on table public.order_request_attachments from authenticated;
revoke all on table public.shipments, public.shipment_lines from anon;
revoke select, insert, update, delete on table public.shipments, public.shipment_lines from authenticated;
revoke delete on table public.order_requests from authenticated;

-- ═══ 5. Schedule events: schedule:manage, the module, the kit ══════════════
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

-- 0384's text, restated verbatim, then the S3c terms.
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

-- 0384's USING and WITH CHECK, restated verbatim, then the S3c terms.
alter policy schedule_events_update on public.schedule_events
  using (
    (( SELECT public.is_org_member(schedule_events.organization_id) AS is_org_member)
      AND ((created_by = auth.uid())
           OR ( SELECT public.has_org_role(schedule_events.organization_id, 'manager'::text) AS has_org_role)))
    AND ( SELECT public.has_permission(schedule_events.organization_id, 'schedule:manage'::text) AS has_permission)
    AND ( SELECT public.module_enabled(schedule_events.organization_id, 'schedule'::text) AS module_enabled)
  )
  with check (
    (( SELECT public.is_org_member(schedule_events.organization_id) AS is_org_member)
      AND ((created_by = auth.uid())
           OR ( SELECT public.has_org_role(schedule_events.organization_id, 'manager'::text) AS has_org_role))
      AND ( SELECT public.warehouse_in_org(schedule_events.warehouse_id, schedule_events.organization_id) AS warehouse_in_org)
      AND ( SELECT public.warehouse_in_org(schedule_events.bundle_warehouse_id, schedule_events.organization_id) AS warehouse_in_org))
    AND ( SELECT public.order_request_in_org(schedule_events.order_request_id, schedule_events.organization_id) AS order_request_in_org)
    AND ( SELECT public.bundle_in_org(schedule_events.bundle_id, schedule_events.organization_id) AS bundle_in_org)
    AND ( SELECT public.has_permission(schedule_events.organization_id, 'schedule:manage'::text) AS has_permission)
    AND ( SELECT public.module_enabled(schedule_events.organization_id, 'schedule'::text) AS module_enabled)
  );

-- 0140's USING, restated verbatim, then the S3c terms.
alter policy schedule_events_delete on public.schedule_events
  using (
    (( SELECT public.is_org_member(schedule_events.organization_id) AS is_org_member)
      AND ((created_by = auth.uid())
           OR ( SELECT public.has_org_role(schedule_events.organization_id, 'manager'::text) AS has_org_role)))
    AND ( SELECT public.has_permission(schedule_events.organization_id, 'schedule:manage'::text) AS has_permission)
    AND ( SELECT public.module_enabled(schedule_events.organization_id, 'schedule'::text) AS module_enabled)
  );

comment on policy schedule_events_insert on public.schedule_events is
  'A member with schedule:manage, in an organization with the Schedule module on, inserts their own event '
  '(created_by = the caller) in a warehouse they may write, with a bundle source warehouse (0203) and a kit '
  '(S3c, 0451) of the same organization, and no order of another organization (0384; authenticated cannot '
  'write order_request_id at all, the admin client links events).';
comment on policy schedule_events_update on public.schedule_events is
  'The creator or a manager, holding schedule:manage with the Schedule module on (S3c, 0451), updates an event; '
  'the new row keeps both warehouses (0203), its linked order (0384) and its kit (0451) in the organization.';
comment on policy schedule_events_delete on public.schedule_events is
  'The creator or a manager, holding schedule:manage with the Schedule module on (S3c, 0451), deletes an event.';

-- ═══ 6. The order-attachments bucket (last: storage) ═══════════════════════
-- 0142's four policies dropped and created again, the way 0142 created them.
-- Nothing may follow them but the lock_timeout reset
-- (storage-policy-order.guard.test.ts).
drop policy "order-attachments read" on storage.objects;
drop policy "order-attachments manager write" on storage.objects;
drop policy "order-attachments manager update" on storage.objects;
drop policy "order-attachments manager delete" on storage.objects;

create policy "order-attachments read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'order-attachments'
    and public.is_org_member((storage.foldername(name))[1]::uuid)
    and public.order_attachment_object_readable(name, coalesce(owner_id, owner::text))
  );

create policy "order-attachments manager write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'order-attachments'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'manager')
  );

create policy "order-attachments manager update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'order-attachments'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'manager')
    and public.order_attachment_object_readable(name, coalesce(owner_id, owner::text))
  )
  with check (
    bucket_id = 'order-attachments'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'manager')
    and public.order_attachment_object_readable(name, coalesce(owner_id, owner::text))
  );

create policy "order-attachments manager delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'order-attachments'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'manager')
    and public.order_attachment_object_readable(name, coalesce(owner_id, owner::text))
  );

reset lock_timeout;
