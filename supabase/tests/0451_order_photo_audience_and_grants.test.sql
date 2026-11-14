-- supabase/tests/0451_order_photo_audience_and_grants.test.sql
-- pgTAP proof for migration 0451 (docket S3, part S3c).
--
-- A. Wet signature photos (kind 'signature'), rows and stored files: read and
--    removed by people who may approve orders (orders:approve, any role, any
--    warehouse), the order's driver (read) and the person who added it. Each
--    stored file is named by at most one row, a row's path is exactly
--    {organization}/{its order}/{file} with the web's file-name rule
--    (OBJECT_FILENAME_SEGMENT), the stored file is already in the bucket and
--    readable to the caller, and a row names the caller or nobody as the
--    person who added it. A stored file no row names is read by the member
--    who uploaded it and by approvers of its organization. The bucket's
--    update and delete rules ask the same as its read rule. The web's and the
--    phone's file names and the app's INSERT ... RETURNING pass; the service
--    role's writes are not bound by row rules.
-- G. Table privileges: anon holds nothing on order_request_attachments,
--    shipments or shipment_lines; authenticated holds SELECT, INSERT and
--    DELETE on attachments, no SELECT, INSERT, UPDATE or DELETE on shipments
--    or shipment_lines, and no DELETE on order_requests; service_role keeps
--    its privileges.
-- S. Schedule events: every write asks schedule:manage and the Schedule
--    module; an insert or update names a kit of the event's organization; the
--    creator or a manager updates and deletes. The web's, the phone's and the
--    admin client's writes are covered.
-- F. The three helpers: SECURITY DEFINER, STABLE, search_path pinned, no
--    EXECUTE for anon; what each answers.
-- P. Policy text: the restated policies carry the new terms and keep every
--    earlier one; the unique index.
-- Personas: anon, a viewer, staff, staff granted orders:approve, staff who
-- drives the order, staff granted schedule:manage, a manager, two managers
-- whose orders:approve is turned off, a manager whose schedule:manage is
-- turned off, an admin, the owner, a manager of another organization, a
-- pending manager, a disabled manager, a manager on an expired act-as seat,
-- and the service role. Made-up data only.

begin;
select plan(57);

\set orgA   '\'e5451000-0000-4000-8000-00000000000a\''
\set orgB   '\'e5451000-0000-4000-8000-00000000000b\''
\set own    '\'e5451000-0000-4000-8000-0000000000a0\''
\set mgrY   '\'e5451000-0000-4000-8000-0000000000a1\''
\set mgrN   '\'e5451000-0000-4000-8000-0000000000a2\''
\set mgrN2  '\'e5451000-0000-4000-8000-0000000000a3\''
\set stf    '\'e5451000-0000-4000-8000-0000000000a4\''
\set stfAp  '\'e5451000-0000-4000-8000-0000000000a5\''
\set stfDrv '\'e5451000-0000-4000-8000-0000000000a6\''
\set stfSch '\'e5451000-0000-4000-8000-0000000000a7\''
\set vwr    '\'e5451000-0000-4000-8000-0000000000a8\''
\set adm    '\'e5451000-0000-4000-8000-0000000000a9\''
\set mgrS0  '\'e5451000-0000-4000-8000-0000000000aa\''
\set mgrP   '\'e5451000-0000-4000-8000-0000000000ab\''
\set mgrD   '\'e5451000-0000-4000-8000-0000000000ac\''
\set mgrX   '\'e5451000-0000-4000-8000-0000000000ad\''
\set mgrB   '\'e5451000-0000-4000-8000-0000000000b1\''
\set whA    '\'e5451000-0000-4000-8000-0000000000d1\''
\set whB    '\'e5451000-0000-4000-8000-0000000000d2\''
\set oDone  '\'e5451000-0000-4000-8000-000000000201\''
\set oDone2 '\'e5451000-0000-4000-8000-000000000202\''
\set bunA   '\'e5451000-0000-4000-8000-000000000401\''
\set bunB   '\'e5451000-0000-4000-8000-000000000402\''
\set evA    '\'e5451000-0000-4000-8000-000000000501\''
\set evSch  '\'e5451000-0000-4000-8000-000000000502\''
\set evStf  '\'e5451000-0000-4000-8000-000000000503\''
\set P1     '\'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/11111111-1111-4111-8111-111111111111.jpg\''
\set P2     '\'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/22222222-2222-4222-8222-222222222222.jpg\''
\set P3     '\'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000202/33333333-3333-4333-8333-333333333333.jpg\''
\set P4     '\'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/44444444-4444-4444-8444-444444444444.jpg\''
\set P5     '\'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/55555555-5555-4555-8555-555555555555.jpg\''
\set R1     '\'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/r1r1r1r1r1r1.jpg\''
\set R2     '\'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/r2r2r2r2r2r2.jpg\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:own,    's3c-own@example.test',    '{}'::jsonb), (:mgrY,  's3c-mgry@example.test',  '{}'::jsonb),
  (:mgrN,   's3c-mgrn@example.test',   '{}'::jsonb), (:mgrN2, 's3c-mgrn2@example.test', '{}'::jsonb),
  (:stf,    's3c-stf@example.test',    '{}'::jsonb), (:stfAp, 's3c-stfap@example.test', '{}'::jsonb),
  (:stfDrv, 's3c-stfdrv@example.test', '{}'::jsonb), (:stfSch, 's3c-stfsch@example.test', '{}'::jsonb),
  (:vwr,    's3c-vwr@example.test',    '{}'::jsonb), (:adm,   's3c-adm@example.test',   '{}'::jsonb),
  (:mgrS0,  's3c-mgrs0@example.test',  '{}'::jsonb), (:mgrP,  's3c-mgrp@example.test',  '{}'::jsonb),
  (:mgrD,   's3c-mgrd@example.test',   '{}'::jsonb), (:mgrX,  's3c-mgrx@example.test',  '{}'::jsonb),
  (:mgrB,   's3c-mgrb@example.test',   '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:orgA, 'S3c Test A', 's3c-test-a'), (:orgB, 'S3c Test B', 's3c-test-b');
update public.organizations set mfa_policy = 'optional' where id in (:orgA, :orgB);
insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at) values
  (:orgA, :own, 'owner', now(), null),   (:orgA, :adm, 'admin', now(), null),
  (:orgA, :mgrY, 'manager', now(), null), (:orgA, :mgrN, 'manager', now(), null), (:orgA, :mgrN2, 'manager', now(), null),
  (:orgA, :mgrS0, 'manager', now(), null),
  (:orgA, :stf, 'staff', now(), null),   (:orgA, :stfAp, 'staff', now(), null),
  (:orgA, :stfDrv, 'staff', now(), null), (:orgA, :stfSch, 'staff', now(), null),
  (:orgA, :vwr, 'viewer', now(), null),
  (:orgA, :mgrP, 'manager', null, null),                         -- invited, not accepted
  (:orgA, :mgrD, 'manager', now(), null),                        -- disabled below
  (:orgA, :mgrX, 'manager', now(), now() - interval '1 hour'),   -- act-as seat, expired
  (:orgB, :mgrB, 'manager', now(), null);
update public.user_profiles set disabled_at = now(), disabled_reason = 'policy_violation' where id = :mgrD;
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgA, 'S3c Main', 'WH-S3CA', 'active'), (:whB, :orgB, 'S3c B', 'WH-S3CB', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, charter_id, is_primary) values
  (:orgA, :stf, :whA, null, true), (:orgA, :stfAp, :whA, null, true),
  (:orgA, :stfDrv, :whA, null, true), (:orgA, :stfSch, :whA, null, true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :mgrN, 'orders:approve', false), (:orgA, :mgrN2, 'orders:approve', false),
  (:orgA, :stfAp, 'orders:approve', true), (:orgA, :stfSch, 'schedule:manage', true),
  (:orgA, :mgrS0, 'schedule:manage', false);

-- Two completed orders: oDone is driven by stfDrv, oDone2 has no driver.
insert into public.order_requests (id, organization_id, warehouse_id, source, status, requester_user_id,
                                   fulfillment_type, assigned_delivery_user_id) values
  (:oDone,  :orgA, :whA, 'internal', 'completed', :stf, 'pickup', :stfDrv),
  (:oDone2, :orgA, :whA, 'internal', 'completed', :stf, 'pickup', null);
insert into public.bundles (id, organization_id, name) values
  (:bunA, :orgA, 'S3c A kit'), (:bunB, :orgB, 'S3c B kit');

-- Rows: on oDone a drop-off photo and a Wet signature photo added by the
-- approving manager, and a Wet signature photo with no uploader (an older
-- phone's write); on oDone2 a Wet signature photo. Files for each, and two
-- files no row names yet, uploaded by mgrN2 (owner_id on this storage server;
-- owner alone on an older one).
insert into public.order_request_attachments (organization_id, order_request_id, storage_path, kind, content_type, uploaded_by) values
  (:orgA, :oDone,  :P1, 'dropoff_photo', 'image/jpeg', :mgrY),
  (:orgA, :oDone,  :P2, 'signature',     'image/jpeg', :mgrY),
  (:orgA, :oDone2, :P3, 'signature',     'image/jpeg', :mgrY),
  (:orgA, :oDone,  :P5, 'signature',     'image/jpeg', null);
insert into storage.objects (bucket_id, name, owner, owner_id) values
  ('order-attachments', :P1, null, null), ('order-attachments', :P2, null, null),
  ('order-attachments', :P3, null, null), ('order-attachments', :P5, null, null),
  ('order-attachments', :R1, null, 'e5451000-0000-4000-8000-0000000000a3'),
  ('order-attachments', :R2, :mgrN2, null);
insert into public.schedule_events (id, organization_id, title, starts_at, status, created_by) values
  (:evA,   :orgA, 'S3c manager event', now() + interval '2 days', 'scheduled', :mgrY),
  (:evSch, :orgA, 'S3c staff event',   now() + interval '2 days', 'scheduled', :stfSch),
  (:evStf, :orgA, 'S3c older event',   now() + interval '2 days', 'scheduled', :stf);

-- Runs p_sql as p_as with p_sub's claims; returns its single value, or
-- ERR:<sqlstate>. The role and claims are put back either way.
create function pg_temp.run(p_as text, p_sub uuid, p_sql text) returns text language plpgsql as $$
declare v_state text; v text;
begin
  begin
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claims',
      jsonb_build_object('sub', p_sub, 'role', p_as, 'aal', 'aal1')::text, true);
    perform set_config('role', p_as, true);
    execute p_sql into v;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
    return 'ERR:' || v_state;
  end;
  return coalesce(v, 'null');
end $$;
-- Runs a write (no RETURNING needed) as p_as, reads p_check as postgres, then
-- undoes both: returns 'rows=<affected>' plus '|<check>', or ERR:<sqlstate>.
create function pg_temp.undo(p_as text, p_sub uuid, p_sql text, p_check text default null) returns text language plpgsql as $$
declare v_n bigint; v_c text; v_state text; v_msg text;
begin
  begin
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claims',
      jsonb_build_object('sub', p_sub, 'role', p_as, 'aal', 'aal1')::text, true);
    perform set_config('role', p_as, true);
    execute p_sql;
    get diagnostics v_n = row_count;
    perform set_config('role', 'none', true);
    if p_check is not null then execute p_check into v_c; end if;
    raise exception using errcode = 'XS3C0', message = 'rows=' || v_n || coalesce('|' || v_c, '');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state = 'XS3C0' then return v_msg; end if;
    return 'ERR:' || v_state;
  end;
end $$;
-- The app's attachment write (OrderAttachmentsService.add): INSERT ... RETURNING id.
create function pg_temp.ins(p_order uuid, p_path text, p_kind text, p_uploader text) returns text language sql as $$
  select format($q$with i as (insert into public.order_request_attachments (organization_id, order_request_id, storage_path, kind, uploaded_by)
                               values (%L, %L, %L, %L, %s) returning id) select count(*)::text from i$q$,
                'e5451000-0000-4000-8000-00000000000a', p_order, p_path, p_kind, p_uploader)
$$;
-- Puts a stored file at p_path (owner and owner_id p_owner) when p_obj, files
-- a row for it as p_sub through the app's INSERT ... RETURNING, and undoes
-- both: returns the insert's value, or ERR:<sqlstate>.
create function pg_temp.tryf(p_sub uuid, p_order uuid, p_path text, p_owner uuid, p_obj boolean default true,
                             p_kind text default 'dropoff_photo', p_uploader text default '(select auth.uid())',
                             p_as text default 'authenticated') returns text language plpgsql as $$
declare v text; v_state text; v_msg text;
begin
  begin
    if p_obj then
      insert into storage.objects (bucket_id, name, owner, owner_id)
      values ('order-attachments', p_path, p_owner, p_owner::text);
    end if;
    v := pg_temp.run(p_as, p_sub, pg_temp.ins(p_order, p_path, p_kind, p_uploader));
    raise exception using errcode = 'XS3C0', message = v;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state = 'XS3C0' then return v_msg; end if;
    return 'ERR:' || v_state;
  end;
end $$;
-- Signature rows / other rows the caller reads in org A.
create function pg_temp.sig() returns text language sql as $$
  select $q$select count(*) filter (where kind = 'signature')::text || '/' || count(*) filter (where kind <> 'signature')::text
              from public.order_request_attachments where organization_id = 'e5451000-0000-4000-8000-00000000000a'$q$
$$;
-- Stored files the caller reads in org A's folder.
create function pg_temp.objs() returns text language sql as $$
  select $q$select count(*)::text from storage.objects where bucket_id = 'order-attachments' and name like 'e5451000-0000-4000-8000-00000000000a/%'$q$
$$;
create function pg_temp.obj(p_name text) returns text language sql as $$
  select format($q$select count(*)::text from storage.objects where bucket_id = 'order-attachments' and name = %L$q$, p_name)
$$;
-- Events in the web's shape (ScheduleService.create), with an optional kit,
-- and in the phone's shape (apps/mobile/app/schedule/new.tsx: no created_by).
create function pg_temp.ev_web(p_sub uuid, p_bundle uuid) returns text language sql as $$
  select format($q$with i as (insert into public.schedule_events (organization_id, title, starts_at, status, bundle_id, bundle_quantity, bundle_warehouse_id, created_by)
                    values (%L, 'S3c event', now() + interval '1 day', 'scheduled', %L, %s, %L, %L) returning 1) select count(*)::text from i$q$,
                'e5451000-0000-4000-8000-00000000000a', p_bundle,
                case when p_bundle is null then 'null' else '1' end,
                case when p_bundle is null then null else 'e5451000-0000-4000-8000-0000000000d1' end, p_sub)
$$;
create function pg_temp.ev_phone() returns text language sql as $$
  select $q$with i as (insert into public.schedule_events (organization_id, title, starts_at, ends_at, all_day, location_text, warehouse_id, requester_name)
              values ('e5451000-0000-4000-8000-00000000000a', 'S3c phone', now() + interval '1 day', now() + interval '1 day 1 hour',
                      false, 'Dock 2', 'e5451000-0000-4000-8000-0000000000d1', 'Sample School') returning 1) select count(*)::text from i$q$
$$;

-- ══ A. Wet signature photos ════════════════════════════════════════════════
insert into storage.objects (bucket_id, name, owner, owner_id) values ('order-attachments', :P4, :mgrN, :mgrN);
select is(
  pg_temp.run('authenticated', :mgrN, pg_temp.ins(:oDone, :P4, 'signature', '(select auth.uid())')),
  '1',
  'A1: a manager whose orders:approve is off uploads a Wet signature photo and adds its row through INSERT ... RETURNING');

select is(
  pg_temp.run('authenticated', :mgrN, pg_temp.sig()) || ' ' || pg_temp.run('authenticated', :mgrN2, pg_temp.sig()),
  '1/1 0/1',
  'A2: a manager whose orders:approve is off reads the Wet signature photo they added and none other');
select is(
  pg_temp.run('authenticated', :vwr, pg_temp.sig()) || ' ' || pg_temp.run('authenticated', :stf, pg_temp.sig()),
  '0/1 0/1',
  'A3: a viewer and a staff member read no Wet signature photo');
select is(
  pg_temp.run('authenticated', :stfDrv, pg_temp.sig()),
  '3/1',
  'A4: the driver of an order reads the Wet signature photos of that order only');
select is(
  pg_temp.run('authenticated', :stfAp, pg_temp.sig()) || ' ' || pg_temp.run('authenticated', :mgrY, pg_temp.sig())
  || ' ' || pg_temp.run('authenticated', :adm, pg_temp.sig()) || ' ' || pg_temp.run('authenticated', :own, pg_temp.sig()),
  '4/1 4/1 4/1 4/1',
  'A5: staff granted orders:approve, a manager, an admin and the owner read every Wet signature photo');
select is(
  pg_temp.run('authenticated', :mgrB, pg_temp.sig()) || ' ' || pg_temp.run('anon', null, pg_temp.sig())
  || ' ' || pg_temp.run('service_role', null, pg_temp.sig()),
  '0/0 ERR:42501 4/1',
  'A6: a manager of another organization reads no row of this one; anon holds no privilege; the service role reads every row');
select is(
  pg_temp.run('authenticated', :vwr, format('select count(*)::text from public.order_request_attachments where storage_path = %L', :P5))
  || ' ' || pg_temp.run('authenticated', :mgrN2, format('select count(*)::text from public.order_request_attachments where storage_path = %L', :P5))
  || ' ' || pg_temp.run('authenticated', :stfAp, format('select count(*)::text from public.order_request_attachments where storage_path = %L', :P5))
  || ' ' || pg_temp.run('authenticated', :vwr, pg_temp.obj(:P5))
  || ' ' || pg_temp.run('authenticated', :mgrN2, pg_temp.obj(:P5))
  || ' ' || pg_temp.run('authenticated', :stfAp, pg_temp.obj(:P5)),
  '0 0 1 0 0 1',
  'A7: a Wet signature photo with no uploader is read, row and file, by approvers only');
select is(
  pg_temp.run('authenticated', :mgrP, pg_temp.sig()) || ' ' || pg_temp.run('authenticated', :mgrD, pg_temp.sig())
  || ' ' || pg_temp.run('authenticated', :mgrX, pg_temp.sig())
  || ' ' || pg_temp.run('authenticated', :mgrP, pg_temp.objs()) || ' ' || pg_temp.run('authenticated', :mgrD, pg_temp.objs())
  || ' ' || pg_temp.run('authenticated', :mgrX, pg_temp.objs()),
  '0/0 0/0 0/0 0 0 0',
  'A8: a pending manager, a disabled manager and a manager on an expired act-as seat read no row and no file');

-- The insert rule.
select is(
  pg_temp.tryf(:mgrN, :oDone, 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/66666666-6666-4666-8666-666666666666.jpg', :mgrN,
               true, 'signature', quote_literal('e5451000-0000-4000-8000-0000000000a1')),
  'ERR:42501',
  'A9: a row names the caller or nobody as the person who added it');
insert into storage.objects (bucket_id, name, owner, owner_id) values
  ('order-attachments', 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/77777777-7777-4777-8777-777777777777.jpg', :mgrY, :mgrY);
select is(
  pg_temp.run('authenticated', :mgrY, pg_temp.ins(:oDone, 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/77777777-7777-4777-8777-777777777777.jpg', 'dropoff_photo', 'null'))
  || ' ' || pg_temp.run('authenticated', :vwr, pg_temp.ins(:oDone, 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/88888888-8888-4888-8888-888888888888.jpg', 'dropoff_photo', '(select auth.uid())')),
  '1 ERR:42501',
  'A10: a manager adds a row with no uploader named; a viewer adds none');
-- The rest of the file reads the bucket as it was: the A10 row stays, its file goes.
do $$ begin
  perform set_config('storage.allow_delete_query', 'true', true);
  delete from storage.objects where bucket_id = 'order-attachments'
     and name = 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/77777777-7777-4777-8777-777777777777.jpg';
  perform set_config('storage.allow_delete_query', 'false', true);
end $$;
select is(
  pg_temp.tryf(:mgrY, :oDone, 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000202/99999999-9999-4999-8999-999999999999.jpg', :mgrY)
  || ' ' || pg_temp.tryf(:mgrY, :oDone, 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/', :mgrY)
  || ' ' || pg_temp.tryf(:mgrY, :oDone, 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/sub/a1.jpg', :mgrY)
  || ' ' || pg_temp.tryf(:mgrY, :oDone, 'e5451000-0000-4000-8000-00000000000a/a2.jpg', :mgrY),
  'ERR:42501 ERR:42501 ERR:42501 ERR:42501',
  'A11: a row''s path is exactly {organization}/{its order}/{file}: another order''s folder, an empty file part, a fourth part and a two-part path are refused');
select is(
  pg_temp.run('authenticated', :mgrN2, pg_temp.ins(:oDone, :P1, 'dropoff_photo', '(select auth.uid())'))
  || ' ' || pg_temp.run('authenticated', :mgrY, pg_temp.ins(:oDone, :P2, 'other', '(select auth.uid())'))
  || ' ' || pg_temp.run('authenticated', :mgrN2, pg_temp.ins(:oDone, :P3, 'dropoff_photo', '(select auth.uid())'))
  || ' ' || pg_temp.run('service_role', null, pg_temp.ins(:oDone, :P2, 'other', 'null')),
  'ERR:23505 ERR:23505 ERR:42501 ERR:23505',
  'A12: a second row naming a stored file another row names is refused (the unique path; another order''s file by the path rule too), for the service role as well');
select is(
  pg_temp.tryf(:mgrY, :oDone, 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/a1b2c3d4e5f6.jpg?x', :mgrY)
  || ' ' || pg_temp.tryf(:mgrY, :oDone, 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/a1b2c3d4e5f6.jpg#x', :mgrY)
  || ' ' || pg_temp.tryf(:mgrY, :oDone, 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/a1b2c3d4e5f6.jpg/', :mgrY)
  || ' ' || pg_temp.tryf(:mgrY, :oDone, 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/a1b2c3d4e5f6.jpg ', :mgrY)
  || ' ' || pg_temp.tryf(:mgrY, :oDone, 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/a1b2c3d4e5f6.jpg;x', :mgrY)
  || ' ' || pg_temp.tryf(:mgrY, :oDone, 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/a1b2c3d4e5f6.jpg&x', :mgrY)
  || ' ' || pg_temp.tryf(:mgrY, :oDone, 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/a1b2c3d4e5f6', :mgrY)
  || ' ' || pg_temp.tryf(:mgrY, :oDone, 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/' || repeat('a', 121) || '.jpg', :mgrY),
  'ERR:42501 ERR:42501 ERR:42501 ERR:42501 ERR:42501 ERR:42501 ERR:42501 ERR:42501',
  'A23: the file part follows the web''s file-name rule: a name with ?, #, a trailing slash, a trailing space, ; or &, with no extension, or longer than 120 before its extension is refused');
select is(
  pg_temp.tryf(:mgrN, :oDone, 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4.webp', :mgrN)
  || ' ' || pg_temp.tryf(:mgrN, :oDone, 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/k3j9x0q2m7ab.jpg', :mgrN, true, 'signature')
  || ' ' || pg_temp.tryf(:mgrY, :oDone, 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c5.pdf', :mgrY)
  || ' ' || pg_temp.tryf(:mgrN, :oDone, 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/' || repeat('a', 120) || '.jpg', :mgrN),
  '1 1 1 1',
  'A24: the web''s {uuid}.{ext} and the phone''s {12 base-36}.{ext} names pass through INSERT ... RETURNING, for the uploader whose orders:approve is off and for an approver; 120 before the extension passes');
select is(
  pg_temp.tryf(:mgrN, :oDone, :R1, null, false)
  || ' ' || pg_temp.tryf(:mgrN2, :oDone, :R1, null, false)
  || ' ' || pg_temp.tryf(:mgrN2, :oDone, :R2, null, false)
  || ' ' || pg_temp.tryf(:mgrY, :oDone, :R1, null, false)
  || ' ' || pg_temp.tryf(:mgrY, :oDone, 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/c0ffee000001.jpg', null, false),
  'ERR:42501 1 1 1 ERR:42501',
  'A25: a row names a stored file the caller reads: another manager without orders:approve cannot file a row for a file someone else uploaded; its uploader (owner_id, or owner) and an approver can; a path with no stored file is refused');
select is(
  pg_temp.tryf(null, :oDone, 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/c0ffee000002.jpg', null, false, 'other', 'null', 'service_role')
  || ' ' || pg_temp.tryf(null, :oDone, 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/c0ffee000003.jpg?x', null, true, 'other', 'null', 'service_role'),
  '1 1',
  'A26: the service role''s writes are not bound by the row rules');

-- Stored files.
select is(
  pg_temp.run('authenticated', :vwr, pg_temp.objs()) || ' ' || pg_temp.run('authenticated', :stf, pg_temp.objs())
  || ' ' || pg_temp.run('authenticated', :mgrN, pg_temp.objs()) || ' ' || pg_temp.run('authenticated', :mgrN2, pg_temp.objs()),
  '1 1 2 3',
  'A13: files follow their rows: a viewer and staff read the drop-off file; a manager whose orders:approve is off reads it and the files they uploaded');
select is(
  pg_temp.run('authenticated', :stfDrv, pg_temp.objs()) || ' ' || pg_temp.run('authenticated', :stfAp, pg_temp.objs())
  || ' ' || pg_temp.run('authenticated', :mgrY, pg_temp.objs()) || ' ' || pg_temp.run('authenticated', :own, pg_temp.objs()),
  '4 7 7 7',
  'A14: the driver reads the files of the order they drive; an approver, a manager and the owner read every file');
select is(
  pg_temp.run('authenticated', :mgrB, pg_temp.objs()) || ' ' || pg_temp.run('anon', null, pg_temp.objs())
  || ' ' || pg_temp.run('service_role', null, pg_temp.objs()),
  '0 0 7',
  'A15: another organization''s manager and anon read no file; the service role reads every file');
select is(
  pg_temp.run('authenticated', :mgrN2, pg_temp.obj(:R1)) || ' ' || pg_temp.run('authenticated', :mgrN2, pg_temp.obj(:R2))
  || ' ' || pg_temp.run('authenticated', :mgrN, pg_temp.obj(:R1)) || ' ' || pg_temp.run('authenticated', :vwr, pg_temp.obj(:R1))
  || ' ' || pg_temp.run('authenticated', :stfDrv, pg_temp.obj(:R1)) || ' ' || pg_temp.run('authenticated', :stfAp, pg_temp.obj(:R1)),
  '1 1 0 0 0 1',
  'A16: a file no row names is read by the member who uploaded it (owner_id, or owner) and by an approver of its organization');

-- Removal and replacement of rows and files. The Storage API's delete sets
-- storage.allow_delete_query for its statement (storage.protect_delete asks
-- it); the test does the same. Every write below is undone.
do $$ begin perform set_config('storage.allow_delete_query', 'true', true); end $$;
select is(
  pg_temp.undo('authenticated', :mgrN2, format('delete from public.order_request_attachments where id = %L', (select id from public.order_request_attachments where storage_path = :P2 and uploaded_by = :mgrY limit 1)),
               format('select count(*)::text from public.order_request_attachments where storage_path = %L', :P2)),
  'rows=0|1',
  'A17: a manager whose orders:approve is off removes, by id and without RETURNING, no Wet signature row they did not add');
select is(
  pg_temp.undo('authenticated', :mgrN2, 'delete from public.order_request_attachments where true',
               $q$select count(*) filter (where kind = 'signature')::text || '/' || count(*)::text from public.order_request_attachments where organization_id = 'e5451000-0000-4000-8000-00000000000a'$q$),
  'rows=2|4/4',
  'A18: that manager''s delete with no column filter removes the two other rows only; every Wet signature row is kept');
select is(
  pg_temp.undo('authenticated', :mgrN2, format('delete from storage.objects where bucket_id = %L and name = %L', 'order-attachments', :P2),
               format('select count(*)::text from storage.objects where name = %L', :P2))
  || ' ' || pg_temp.undo('authenticated', :mgrN2, $q$delete from storage.objects where true$q$,
               $q$select count(*)::text from storage.objects where bucket_id = 'order-attachments' and name like 'e5451000-0000-4000-8000-00000000000a/%'$q$),
  'rows=0|1 rows=3|4',
  'A19: that manager removes no Wet signature file; a delete with no column filter removes only the drop-off file and the files they uploaded');
select is(
  pg_temp.undo('authenticated', :mgrN2, format($q$update storage.objects set name = %L where bucket_id = 'order-attachments' and name = %L$q$,
                                              'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/moved.jpg', :P2))
  || ' ' || pg_temp.undo('authenticated', :mgrN2, $q$update storage.objects set version = 'v2' where bucket_id = 'order-attachments'$q$)
  || ' ' || pg_temp.undo('authenticated', :mgrN2, format($q$insert into storage.objects (bucket_id, name, owner_id) values ('order-attachments', %L, %L)
                                                         on conflict (bucket_id, name) do update set version = 'v3'$q$, :P2, :mgrN2)),
  'rows=0 rows=3 ERR:42501',
  'A20: that manager cannot move, update or upsert over a Wet signature file; a bucket-wide update reaches only the files they read');
select is(
  pg_temp.undo('authenticated', :mgrY, format('delete from public.order_request_attachments where storage_path = %L', :P3))
  || ' ' || pg_temp.undo('authenticated', :mgrY, format('delete from storage.objects where bucket_id = %L and name = %L', 'order-attachments', :P3))
  || ' ' || pg_temp.undo('authenticated', :mgrN, format('delete from public.order_request_attachments where storage_path = %L', :P4))
  || ' ' || pg_temp.undo('authenticated', :mgrN, format('delete from storage.objects where bucket_id = %L and name = %L', 'order-attachments', :P4)),
  'rows=1 rows=1 rows=1 rows=1',
  'A21: an approving manager removes a Wet signature row and file; the manager who added one removes theirs');
select is(
  pg_temp.undo('authenticated', :mgrN2, format('delete from storage.objects where bucket_id = %L and name = %L', 'order-attachments', :R1))
  || ' ' || pg_temp.undo('authenticated', :mgrN, format('delete from storage.objects where bucket_id = %L and name = %L', 'order-attachments', :R1)),
  'rows=1 rows=0',
  'A22: a file no row names is removed by the manager who uploaded it (the panel''s clean-up) and not by another manager without orders:approve');
do $$ begin perform set_config('storage.allow_delete_query', 'false', true); end $$;

-- ══ G. Table privileges ════════════════════════════════════════════════════
select is(
  coalesce((select string_agg(p, ',' order by p)
              from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p
             where has_table_privilege('anon', 'public.order_request_attachments', p)), '-')
  || '|' || (select string_agg(p, ',' order by p) from unnest(array['SELECT','INSERT','UPDATE','DELETE']) p
              where has_table_privilege('authenticated', 'public.order_request_attachments', p))
  || '|' || (select string_agg(p, ',' order by p) from unnest(array['SELECT','INSERT','UPDATE','DELETE']) p
              where has_table_privilege('service_role', 'public.order_request_attachments', p)),
  '-|DELETE,INSERT,SELECT|DELETE,INSERT,SELECT,UPDATE',
  'G1: anon holds nothing on order_request_attachments; authenticated holds SELECT, INSERT and DELETE; service_role holds all four');
select is(
  coalesce((select string_agg(r || ':' || t || ':' || p, ',' order by r, t, p)
     from unnest(array['anon', 'authenticated']) r,
          unnest(array['public.shipments', 'public.shipment_lines']) t,
          unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p
    where has_table_privilege(r, t, p) and not (r = 'authenticated' and p in ('TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'))), '-'),
  '-',
  'G2: anon holds nothing on shipments or shipment_lines, and authenticated holds no SELECT, INSERT, UPDATE or DELETE on them');
select ok(
  (select bool_and(has_table_privilege('service_role', t, p))
     from unnest(array['public.shipments', 'public.shipment_lines']) t,
          unnest(array['SELECT','INSERT','UPDATE','DELETE']) p),
  'G3: service_role holds SELECT, INSERT, UPDATE and DELETE on shipments and shipment_lines');
select is(
  pg_temp.run('authenticated', :mgrY, $q$select count(*)::text from public.shipments$q$)
  || ' ' || pg_temp.run('authenticated', :mgrY, $q$select count(*)::text from public.shipment_lines$q$)
  || ' ' || pg_temp.run('service_role', null, $q$select (count(*) >= 0)::text from public.shipments$q$),
  'ERR:42501 ERR:42501 true',
  'G4: a manager reads neither legacy shipment table; the service role reads them');
select is(
  has_table_privilege('authenticated', 'public.order_requests', 'DELETE')::text
  || '|' || has_table_privilege('authenticated', 'public.order_requests', 'SELECT')::text
  || '|' || has_table_privilege('service_role', 'public.order_requests', 'DELETE')::text,
  'false|true|true',
  'G5: authenticated holds no DELETE on order_requests and holds SELECT; service_role holds DELETE');
select is(
  pg_temp.run('authenticated', :own, format($q$with d as (delete from public.order_requests where id = %L returning 1) select count(*)::text from d$q$, :oDone2)),
  'ERR:42501',
  'G6: the owner cannot delete an order row through the API');
select is(
  pg_temp.run('authenticated', :mgrY, format($q$select status from public.order_requests where id = %L$q$, :oDone)),
  'completed',
  'G7: a member reads an order of their organization');

-- ══ S. Schedule events ═════════════════════════════════════════════════════
select is(
  pg_temp.run('authenticated', :mgrY, pg_temp.ev_web(:mgrY, :bunB)) || ' ' || pg_temp.run('authenticated', :mgrY, pg_temp.ev_web(:mgrY, :bunA)),
  'ERR:42501 1',
  'S1: an event names a kit of its own organization (the web''s insert with a kit)');
select is(
  pg_temp.run('authenticated', :vwr, pg_temp.ev_web(:vwr, null)) || ' ' || pg_temp.run('authenticated', :stf, pg_temp.ev_phone())
  || ' ' || pg_temp.run('authenticated', :mgrS0, pg_temp.ev_web(:mgrS0, null)),
  'ERR:42501 ERR:42501 ERR:42501',
  'S2: adding an event asks schedule:manage (a viewer, staff, and a manager with schedule:manage turned off are refused)');
select is(
  pg_temp.run('authenticated', :stfSch, pg_temp.ev_phone()) || ' ' || pg_temp.run('authenticated', :own, pg_temp.ev_web(:own, null))
  || ' ' || pg_temp.run('authenticated', :adm, pg_temp.ev_web(:adm, null)),
  '1 1 1',
  'S3: staff granted schedule:manage add an event the phone''s way; the owner and an admin add one the web''s way');
select is(
  pg_temp.run('authenticated', :mgrB, pg_temp.ev_web(:mgrB, null)),
  'ERR:42501',
  'S4: a manager of another organization cannot add an event to this one');
select is(
  pg_temp.undo('authenticated', :mgrS0, format($q$update public.schedule_events set title = 'S3c x' where id = %L$q$, :evA))
  || ' ' || pg_temp.undo('authenticated', :mgrS0, format('delete from public.schedule_events where id = %L', :evA))
  || ' ' || pg_temp.undo('authenticated', :stf, format($q$update public.schedule_events set title = 'S3c x', bundle_id = %L, bundle_quantity = 1, bundle_warehouse_id = %L where id = %L$q$, :bunA, :whA, :evStf))
  || ' ' || pg_temp.undo('authenticated', :stf, format('delete from public.schedule_events where id = %L', :evStf)),
  'rows=0 rows=0 rows=0 rows=0',
  'S5: updating or deleting an event asks schedule:manage (a manager with it turned off, and an event''s creator without it)');
update public.organization_modules set enabled = false where organization_id = :orgA and module_id = 'schedule';
select is(
  pg_temp.run('authenticated', :mgrY, pg_temp.ev_web(:mgrY, null)) || ' ' || pg_temp.run('authenticated', :stfSch, pg_temp.ev_phone())
  || ' ' || pg_temp.undo('authenticated', :mgrY, format($q$update public.schedule_events set title = 'S3c x' where id = %L$q$, :evA))
  || ' ' || pg_temp.undo('authenticated', :mgrY, format('delete from public.schedule_events where id = %L', :evA)),
  'ERR:42501 ERR:42501 rows=0 rows=0',
  'S6: every event write asks the Schedule module');
update public.organization_modules set enabled = true where organization_id = :orgA and module_id = 'schedule';
select is(
  pg_temp.run('authenticated', :mgrY, format($q$with u as (update public.schedule_events set bundle_id = %L, bundle_quantity = 1, bundle_warehouse_id = %L where id = %L returning 1) select count(*)::text from u$q$, :bunB, :whA, :evA))
  || ' ' || pg_temp.undo('authenticated', :mgrY, format($q$update public.schedule_events set bundle_id = %L, bundle_quantity = 1, bundle_warehouse_id = %L where id = %L$q$, :bunA, :whA, :evA)),
  'ERR:42501 rows=1',
  'S7: an update keeps the event''s kit in its organization');
select is(
  pg_temp.undo('authenticated', :stfSch, format($q$update public.schedule_events set title = 'S3c moved' where id = %L$q$, :evSch))
  || ' ' || pg_temp.undo('authenticated', :mgrY, format($q$update public.schedule_events set title = 'S3c manager edit' where id = %L$q$, :evSch))
  || ' ' || pg_temp.undo('authenticated', :stfSch, format('delete from public.schedule_events where id = %L', :evSch))
  || ' ' || pg_temp.undo('authenticated', :mgrY, format('delete from public.schedule_events where id = %L', :evSch))
  || ' ' || pg_temp.undo('authenticated', :stfSch, format($q$update public.schedule_events set title = 'S3c other' where id = %L$q$, :evA)),
  'rows=1 rows=1 rows=1 rows=1 rows=0',
  'S8: with schedule:manage the creator and a manager update and delete an event; staff update only their own');
select is(
  pg_temp.run('service_role', null, format($q$with i as (insert into public.schedule_events (organization_id, title, starts_at, status, created_by, order_request_id, assigned_user_id)
       values (%L, 'S3c order event', now() + interval '3 days', 'scheduled', %L, %L, %L) returning 1) select count(*)::text from i$q$, :orgA, :mgrY, :oDone, :stfDrv))
  || ' ' || pg_temp.undo('service_role', null, format($q$update public.schedule_events set status = 'completed' where order_request_id = %L$q$, :oDone)),
  '1 rows=1',
  'S9: the admin client links an order''s event and closes it (autoScheduleFromOrder, syncOrderScheduleEvent)');

-- ══ F. The helpers ═════════════════════════════════════════════════════════
select is(
  (select string_agg(p.oid::regprocedure::text || ':' || p.prosecdef::text || ':' || p.provolatile::text || ':'
                     || coalesce(array_to_string(p.proconfig, ';'), '-') || ':'
                     || has_function_privilege('anon', p.oid, 'execute')::text || ':'
                     || has_function_privilege('authenticated', p.oid, 'execute')::text || ':'
                     || has_function_privilege('service_role', p.oid, 'execute')::text, ' ' order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('bundle_in_org', 'order_attachment_object_readable', 'order_signature_photo_reader')),
  'bundle_in_org(uuid,uuid):true:s:search_path=public, pg_temp:false:true:true '
  || 'order_attachment_object_readable(text,text):true:s:search_path=public, pg_temp:false:true:true '
  || 'order_signature_photo_reader(uuid):true:s:search_path=public, pg_temp:false:true:true',
  'F1: the three helpers are SECURITY DEFINER and STABLE with search_path pinned; authenticated and service_role may run them, anon may not');
select is(
  pg_temp.run('authenticated', :mgrY, format('select public.bundle_in_org(%L, %L)::text', :bunA, :orgA))
  || ' ' || pg_temp.run('authenticated', :mgrY, format('select public.bundle_in_org(%L, %L)::text', :bunB, :orgA))
  || ' ' || pg_temp.run('authenticated', :mgrY, format('select public.bundle_in_org(null, %L)::text', :orgA))
  || ' ' || pg_temp.run('authenticated', :mgrB, format('select public.bundle_in_org(%L, %L)::text', :bunA, :orgA))
  || ' ' || pg_temp.run('service_role', null, format('select public.bundle_in_org(%L, %L)::text', :bunA, :orgA)),
  'true false true false true',
  'F2: bundle_in_org: own kit true, another organization''s kit false, no kit true, asked by a non-member false, no end user true');
select is(
  pg_temp.run('authenticated', :stfDrv, format('select public.order_signature_photo_reader(%L)::text', :oDone))
  || ' ' || pg_temp.run('authenticated', :stfDrv, format('select public.order_signature_photo_reader(%L)::text', :oDone2))
  || ' ' || pg_temp.run('authenticated', :stfAp, format('select public.order_signature_photo_reader(%L)::text', :oDone2))
  || ' ' || pg_temp.run('authenticated', :mgrN, format('select public.order_signature_photo_reader(%L)::text', :oDone))
  || ' ' || pg_temp.run('authenticated', :mgrB, format('select public.order_signature_photo_reader(%L)::text', :oDone))
  || ' ' || pg_temp.run('authenticated', :mgrP, format('select public.order_signature_photo_reader(%L)::text', :oDone))
  || ' ' || pg_temp.run('authenticated', :mgrD, format('select public.order_signature_photo_reader(%L)::text', :oDone))
  || ' ' || pg_temp.run('authenticated', :mgrX, format('select public.order_signature_photo_reader(%L)::text', :oDone))
  || ' ' || pg_temp.run('anon', null, format('select public.order_signature_photo_reader(%L)::text', :oDone)),
  'true false true false false false false false ERR:42501',
  'F3: order_signature_photo_reader: the driver for their order, an approver for any order, false for others (pending, disabled, expired act-as and another organization included); anon may not call it');
select is(
  pg_temp.run('authenticated', :stfAp, format('select public.order_attachment_object_readable(%L, null)::text', 'not-a-uuid/x/y.jpg'))
  || ' ' || pg_temp.run('authenticated', :stfAp, format('select public.order_attachment_object_readable(%L, null)::text', :R1))
  || ' ' || pg_temp.run('authenticated', :vwr, format('select public.order_attachment_object_readable(%L, %L)::text', :R1, :mgrN2))
  || ' ' || pg_temp.run('authenticated', :mgrN2, format('select public.order_attachment_object_readable(%L, %L)::text', :R1, :mgrN2)),
  'false true false true',
  'F4: order_attachment_object_readable for a name no row names: false when its first folder is not an organization id, true for an approver or the uploader, false for others');

-- ══ P. Policy text and the index ═══════════════════════════════════════════
select is(
  (select string_agg(policyname || ':' || cmd || ':' || array_to_string(roles, ','), ',' order by policyname) from pg_policies
    where schemaname = 'public' and tablename = 'order_request_attachments'),
  'order_request_attachments manager delete:DELETE:authenticated,order_request_attachments manager insert:INSERT:authenticated,order_request_attachments read:SELECT:authenticated',
  'P1: order_request_attachments has three policies to authenticated (read, insert, delete)');
select ok(
  (select qual like '%is_org_member(organization_id)%'
      and qual like '%kind <> ''signature''::text%'
      and qual like '%uploaded_by = ( SELECT auth.uid()%'
      and qual like '%order_signature_photo_reader(order_request_id)%'
     from pg_policies
    where schemaname = 'public' and tablename = 'order_request_attachments' and policyname = 'order_request_attachments read'),
  'P2: the attachments read policy: membership, and a Wet signature photo for its uploader or order_signature_photo_reader');
select ok(
  (select with_check like '%has_org_role(organization_id, ''manager''::text)%'
      and with_check like '%staged_for_pickup%signature_requested%completed%'
      and with_check like '%storage_path = %(organization_id)::text%(order_request_id)::text%split_part(storage_path, ''/''::text, 3)%'
      and strpos(with_check, 'split_part(storage_path, ''/''::text, 3) ~ ''^[A-Za-z0-9_-]{1,120}(\.[A-Za-z0-9]{1,10}){1,3}$''::text') > 0
      and with_check like '%storage.objects so%so.bucket_id = ''order-attachments''::text%so.name = order_request_attachments.storage_path%order_attachment_object_readable(so.name, COALESCE(so.owner_id, (so.owner)::text))%'
      and with_check like '%uploaded_by IS NULL%uploaded_by = ( SELECT auth.uid()%'
     from pg_policies
    where schemaname = 'public' and tablename = 'order_request_attachments' and policyname = 'order_request_attachments manager insert'),
  'P3: the attachments insert policy: 0143''s manager, order, status and folder terms, the exact path with the web''s file-name rule, the stored file the caller reads, and the uploader term');
select ok(
  (select qual like '%has_org_role(organization_id, ''manager''::text)%'
      and qual like '%kind <> ''signature''::text%uploaded_by = ( SELECT auth.uid()%order_signature_photo_reader(order_request_id)%'
     from pg_policies
    where schemaname = 'public' and tablename = 'order_request_attachments' and policyname = 'order_request_attachments manager delete'),
  'P4: the attachments delete policy: a manager, and a Wet signature photo for its uploader or order_signature_photo_reader');
select is(
  (select string_agg(policyname || ':' || cmd
                     || ':' || (coalesce(qual, '') like '%order_attachment_object_readable(name, COALESCE(owner_id, (owner)::text))%')::text
                     || ':' || (coalesce(with_check, '') like '%order_attachment_object_readable(name, COALESCE(owner_id, (owner)::text))%')::text,
                     ',' order by policyname)
     from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'order-attachments %'),
  'order-attachments manager delete:DELETE:true:false,order-attachments manager update:UPDATE:true:true,'
  || 'order-attachments manager write:INSERT:false:false,order-attachments read:SELECT:true:false',
  'P5: the bucket has four policies; read, update (USING and WITH CHECK) and delete ask the file''s rule');
select ok(
  (select bool_and(coalesce(qual, '') || coalesce(with_check, '') like '%bucket_id = ''order-attachments''::text%')
      and bool_and(case when cmd = 'SELECT' then qual like '%is_org_member(((storage.foldername(name))[1])::uuid)%'
                        else coalesce(qual, with_check) like '%has_org_role(((storage.foldername(name))[1])::uuid, ''manager''::text)%' end)
     from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'order-attachments %'),
  'P6: the bucket policies keep 0142''s bucket, membership and manager terms');
select ok(
  (select with_check like '%is_org_member%created_by = auth.uid()%user_can_access_warehouse%warehouse_in_org(schedule_events.bundle_warehouse_id%order_request_in_org%bundle_in_org(schedule_events.bundle_id, schedule_events.organization_id)%has_permission(schedule_events.organization_id, ''schedule:manage''::text)%module_enabled(schedule_events.organization_id, ''schedule''::text)%'
     from pg_policies
    where schemaname = 'public' and tablename = 'schedule_events' and policyname = 'schedule_events_insert'),
  'P7: schedule_events_insert: 0384''s terms, the kit, schedule:manage and the module');
select ok(
  (select qual like '%is_org_member%created_by = auth.uid()%has_org_role%has_permission(schedule_events.organization_id, ''schedule:manage''::text)%module_enabled(schedule_events.organization_id, ''schedule''::text)%'
      and with_check like '%is_org_member%created_by = auth.uid()%has_org_role%warehouse_in_org(schedule_events.warehouse_id%warehouse_in_org(schedule_events.bundle_warehouse_id%order_request_in_org%bundle_in_org(schedule_events.bundle_id, schedule_events.organization_id)%has_permission(schedule_events.organization_id, ''schedule:manage''::text)%module_enabled(schedule_events.organization_id, ''schedule''::text)%'
     from pg_policies
    where schemaname = 'public' and tablename = 'schedule_events' and policyname = 'schedule_events_update'),
  'P8: schedule_events_update: the creator or a manager, schedule:manage and the module in USING and WITH CHECK, and 0384''s and the kit''s terms in WITH CHECK');
select ok(
  (select qual like '%is_org_member%created_by = auth.uid()%has_org_role%has_permission(schedule_events.organization_id, ''schedule:manage''::text)%module_enabled(schedule_events.organization_id, ''schedule''::text)%'
     from pg_policies
    where schemaname = 'public' and tablename = 'schedule_events' and policyname = 'schedule_events_delete'),
  'P9: schedule_events_delete: the creator or a manager, schedule:manage and the module');
select is(
  (select i.indisunique::text || ':' || pg_get_indexdef(i.indexrelid)
     from pg_index i where i.indexrelid = to_regclass('public.order_request_attachments_storage_path_key')),
  'true:CREATE UNIQUE INDEX order_request_attachments_storage_path_key ON public.order_request_attachments USING btree (storage_path)',
  'P10: order_request_attachments_storage_path_key is a unique index on storage_path');
select is(
  (select string_agg(policyname || ':' || cmd, ',' order by policyname) from pg_policies
    where schemaname = 'public' and tablename = 'schedule_events'),
  'schedule_events_delete:DELETE,schedule_events_insert:INSERT,schedule_events_select:SELECT,schedule_events_update:UPDATE',
  'P11: schedule_events has the same four policies');

select * from finish();
rollback;
