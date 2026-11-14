-- supabase/tests/0451_order_photo_audience_and_grants.test.sql
-- pgTAP proof for migration 0451 (docket S3, part S3c).
--
-- A. Who reads a Wet signature photo (kind 'signature') on an order, row and
--    stored file alike: people who may approve orders (orders:approve, any
--    role, not limited by warehouse), the order's driver, and the person who
--    added it. Every other photo kind is read by every member, as before. A
--    manager without orders:approve still adds one through the app's
--    INSERT ... RETURNING and reads it back; a row cannot name someone else as
--    the person who added it.
-- G. Table privileges: anon holds nothing on order_request_attachments,
--    shipments or shipment_lines; authenticated holds SELECT, INSERT and
--    DELETE on attachments, nothing on shipments or shipment_lines, and no
--    DELETE on order_requests; service_role keeps its privileges.
-- S. A new Schedule event needs schedule:manage, the Schedule module on, and
--    a kit of its own organization; an update keeps the kit in the
--    organization. The web's, the phone's and the admin client's ways keep
--    working.
-- F. The three helpers: SECURITY DEFINER, STABLE, search_path pinned, no
--    EXECUTE for anon; bundle_in_org answers only to members.
-- P. Policy text: the four restated policies carry the new terms and keep
--    every earlier one.
-- Personas: anon, a viewer, staff, staff granted orders:approve, staff who
-- drives the order, staff granted schedule:manage, a manager, two managers
-- whose orders:approve is turned off, an admin, the owner, a manager of
-- another organization, and the service role. Made-up data only.

begin;
select plan(43);

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
\set mgrB   '\'e5451000-0000-4000-8000-0000000000b1\''
\set whA    '\'e5451000-0000-4000-8000-0000000000d1\''
\set whB    '\'e5451000-0000-4000-8000-0000000000d2\''
\set oDone  '\'e5451000-0000-4000-8000-000000000201\''
\set oDone2 '\'e5451000-0000-4000-8000-000000000202\''
\set bunA   '\'e5451000-0000-4000-8000-000000000401\''
\set bunB   '\'e5451000-0000-4000-8000-000000000402\''
\set evA    '\'e5451000-0000-4000-8000-000000000501\''
\set evSch  '\'e5451000-0000-4000-8000-000000000502\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:own,    's3c-own@example.test',    '{}'::jsonb), (:mgrY,  's3c-mgry@example.test',  '{}'::jsonb),
  (:mgrN,   's3c-mgrn@example.test',   '{}'::jsonb), (:mgrN2, 's3c-mgrn2@example.test', '{}'::jsonb),
  (:stf,    's3c-stf@example.test',    '{}'::jsonb), (:stfAp, 's3c-stfap@example.test', '{}'::jsonb),
  (:stfDrv, 's3c-stfdrv@example.test', '{}'::jsonb), (:stfSch, 's3c-stfsch@example.test', '{}'::jsonb),
  (:vwr,    's3c-vwr@example.test',    '{}'::jsonb), (:adm,   's3c-adm@example.test',   '{}'::jsonb),
  (:mgrB,   's3c-mgrb@example.test',   '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:orgA, 'S3c Test A', 's3c-test-a'), (:orgB, 'S3c Test B', 's3c-test-b');
update public.organizations set mfa_policy = 'optional' where id in (:orgA, :orgB);
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :own, 'owner', now()),   (:orgA, :adm, 'admin', now()),
  (:orgA, :mgrY, 'manager', now()), (:orgA, :mgrN, 'manager', now()), (:orgA, :mgrN2, 'manager', now()),
  (:orgA, :stf, 'staff', now()),   (:orgA, :stfAp, 'staff', now()),
  (:orgA, :stfDrv, 'staff', now()), (:orgA, :stfSch, 'staff', now()),
  (:orgA, :vwr, 'viewer', now()),
  (:orgB, :mgrB, 'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgA, 'S3c Main', 'WH-S3CA', 'active'), (:whB, :orgB, 'S3c B', 'WH-S3CB', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, charter_id, is_primary) values
  (:orgA, :stf, :whA, null, true), (:orgA, :stfAp, :whA, null, true),
  (:orgA, :stfDrv, :whA, null, true), (:orgA, :stfSch, :whA, null, true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :mgrN, 'orders:approve', false), (:orgA, :mgrN2, 'orders:approve', false),
  (:orgA, :stfAp, 'orders:approve', true), (:orgA, :stfSch, 'schedule:manage', true);

-- Two completed orders: oDone is driven by stfDrv, oDone2 has no driver.
insert into public.order_requests (id, organization_id, warehouse_id, source, status, requester_user_id,
                                   fulfillment_type, assigned_delivery_user_id) values
  (:oDone,  :orgA, :whA, 'internal', 'completed', :stf, 'pickup', :stfDrv),
  (:oDone2, :orgA, :whA, 'internal', 'completed', :stf, 'pickup', null);
insert into public.bundles (id, organization_id, name) values
  (:bunA, :orgA, 'S3c A kit'), (:bunB, :orgB, 'S3c B kit');

-- Proof rows: on oDone a drop-off photo and a Wet signature photo, both added
-- by the approving manager; on oDone2 one Wet signature photo. And the files.
insert into public.order_request_attachments (organization_id, order_request_id, storage_path, kind, content_type, uploaded_by) values
  (:orgA, :oDone,  'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/11111111-1111-4111-8111-111111111111.jpg', 'dropoff_photo', 'image/jpeg', :mgrY),
  (:orgA, :oDone,  'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/22222222-2222-4222-8222-222222222222.jpg', 'signature',     'image/jpeg', :mgrY),
  (:orgA, :oDone2, 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000202/33333333-3333-4333-8333-333333333333.jpg', 'signature',     'image/jpeg', :mgrY);
insert into storage.objects (bucket_id, name) values
  ('order-attachments', 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/11111111-1111-4111-8111-111111111111.jpg'),
  ('order-attachments', 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/22222222-2222-4222-8222-222222222222.jpg'),
  ('order-attachments', 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000202/33333333-3333-4333-8333-333333333333.jpg');

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
-- The app's attachment write (OrderAttachmentsService.add): INSERT ... RETURNING id.
create function pg_temp.ins_ret(p_kind text, p_file text, p_uploader text) returns text language sql as $$
  select format($q$with i as (insert into public.order_request_attachments (organization_id, order_request_id, storage_path, kind, uploaded_by)
                               values (%L, %L, %L, %L, %s) returning id) select count(*)::text from i$q$,
                'e5451000-0000-4000-8000-00000000000a', 'e5451000-0000-4000-8000-000000000201',
                'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/' || p_file, p_kind, p_uploader)
$$;
-- Signature rows and non-signature rows the caller reads on both orders.
create function pg_temp.sig() returns text language sql as $$
  select $q$select count(*) filter (where kind = 'signature')::text || '/' || count(*) filter (where kind <> 'signature')::text
              from public.order_request_attachments where organization_id = 'e5451000-0000-4000-8000-00000000000a'$q$
$$;
-- Stored files the caller reads in org A's folder.
create function pg_temp.objs() returns text language sql as $$
  select $q$select count(*)::text from storage.objects where bucket_id = 'order-attachments' and name like 'e5451000-0000-4000-8000-00000000000a/%'$q$
$$;
-- An event insert in the web's shape (ScheduleService.create), with an optional kit.
create function pg_temp.ev_web(p_sub uuid, p_bundle uuid) returns text language sql as $$
  select format($q$with i as (insert into public.schedule_events (organization_id, title, starts_at, status, bundle_id, bundle_quantity, bundle_warehouse_id, created_by)
                    values (%L, 'S3c event', now() + interval '1 day', 'scheduled', %L, %s, %L, %L) returning 1) select count(*)::text from i$q$,
                'e5451000-0000-4000-8000-00000000000a', p_bundle,
                case when p_bundle is null then 'null' else '1' end,
                case when p_bundle is null then null else 'e5451000-0000-4000-8000-0000000000d1' end, p_sub)
$$;
-- An event insert in the phone's shape (apps/mobile/app/schedule/new.tsx): no created_by, no RETURNING.
create function pg_temp.ev_phone() returns text language sql as $$
  select $q$with i as (insert into public.schedule_events (organization_id, title, starts_at, ends_at, all_day, location_text, warehouse_id, requester_name)
              values ('e5451000-0000-4000-8000-00000000000a', 'S3c phone', now() + interval '1 day', now() + interval '1 day 1 hour',
                      false, 'Dock 2', 'e5451000-0000-4000-8000-0000000000d1', 'Sample School') returning 1) select count(*)::text from i$q$
$$;

-- ══ A. Who reads a Wet signature photo ═════════════════════════════════════
select is(
  pg_temp.run('authenticated', :mgrN, pg_temp.ins_ret('signature', '44444444-4444-4444-8444-444444444444.jpg', '(select auth.uid())')),
  '1',
  'A1: a manager whose orders:approve is off adds a Wet signature photo through INSERT ... RETURNING');
insert into storage.objects (bucket_id, name) values
  ('order-attachments', 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/44444444-4444-4444-8444-444444444444.jpg');

select is(
  pg_temp.run('authenticated', :mgrN, pg_temp.sig()),
  '1/1',
  'A2: that manager reads the Wet signature photo they added and the drop-off photo, and no other Wet signature photo');
select is(
  pg_temp.run('authenticated', :mgrN2, pg_temp.sig()),
  '0/1',
  'A3: a manager whose orders:approve is off reads the drop-off photo and no Wet signature photo they did not add');
select is(
  pg_temp.run('authenticated', :vwr, pg_temp.sig()) || ' ' || pg_temp.run('authenticated', :stf, pg_temp.sig()),
  '0/1 0/1',
  'A4: a viewer and a staff member read the drop-off photo and no Wet signature photo');
select is(
  pg_temp.run('authenticated', :stfDrv, pg_temp.sig()),
  '2/1',
  'A5: the driver of an order reads the Wet signature photos of that order, and not those of an order they do not drive');
select is(
  pg_temp.run('authenticated', :stfAp, pg_temp.sig()) || ' ' || pg_temp.run('authenticated', :mgrY, pg_temp.sig())
  || ' ' || pg_temp.run('authenticated', :adm, pg_temp.sig()) || ' ' || pg_temp.run('authenticated', :own, pg_temp.sig()),
  '3/1 3/1 3/1 3/1',
  'A6: staff granted orders:approve, a manager, an admin and the owner read every Wet signature photo');
select is(
  pg_temp.run('authenticated', :mgrB, pg_temp.sig()) || ' ' || pg_temp.run('anon', null, pg_temp.sig()),
  '0/0 ERR:42501',
  'A7: a manager of another organization reads no attachment of this one; anon holds no privilege on the table');
select is(
  pg_temp.run('service_role', null, pg_temp.sig()),
  '3/1',
  'A8: the service role reads every attachment row');
select is(
  pg_temp.run('authenticated', :mgrN, pg_temp.ins_ret('signature', '55555555-5555-4555-8555-555555555555.jpg', quote_literal('e5451000-0000-4000-8000-0000000000a1'))),
  'ERR:42501',
  'A9: an attachment row naming someone else as the person who added it is refused');
select is(
  pg_temp.run('authenticated', :mgrY, pg_temp.ins_ret('dropoff_photo', '66666666-6666-4666-8666-666666666666.jpg', 'null')),
  '1',
  'A10: a row with no uploader is still accepted (uploaded_by is the caller or empty)');
select is(
  pg_temp.run('authenticated', :vwr, pg_temp.ins_ret('dropoff_photo', '77777777-7777-4777-8777-777777777777.jpg', '(select auth.uid())')),
  'ERR:42501',
  'A11: a viewer still cannot add an attachment');

-- The stored files follow the rows.
select is(
  pg_temp.run('authenticated', :vwr, pg_temp.objs()) || ' ' || pg_temp.run('authenticated', :stf, pg_temp.objs())
  || ' ' || pg_temp.run('authenticated', :mgrN2, pg_temp.objs()),
  '1 1 1',
  'A12: a viewer, a staff member and a manager whose orders:approve is off read the drop-off file and no Wet signature file');
select is(
  pg_temp.run('authenticated', :mgrN, pg_temp.objs()),
  '2',
  'A13: the manager who added a Wet signature photo reads its file and the drop-off file');
select is(
  pg_temp.run('authenticated', :stfDrv, pg_temp.objs()) || ' ' || pg_temp.run('authenticated', :stfAp, pg_temp.objs())
  || ' ' || pg_temp.run('authenticated', :mgrY, pg_temp.objs()) || ' ' || pg_temp.run('authenticated', :own, pg_temp.objs()),
  '3 4 4 4',
  'A14: the driver reads the files of the order they drive; an approver, a manager and the owner read every file');
select is(
  pg_temp.run('authenticated', :mgrB, pg_temp.objs()) || ' ' || pg_temp.run('anon', null, pg_temp.objs())
  || ' ' || pg_temp.run('service_role', null, pg_temp.objs()),
  '0 0 4',
  'A15: another organization''s manager and anon read no file; the service role reads every file');
select is(
  pg_temp.run('authenticated', :vwr, $q$select public.order_attachment_object_readable('e5451000-0000-4000-8000-00000000000a/not-a-uuid/x.jpg')::text$q$)
  || ' ' || pg_temp.run('authenticated', :vwr, $q$select public.order_attachment_object_readable('e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000201/88888888-8888-4888-8888-888888888888.jpg')::text$q$),
  'true true',
  'A16: a file name whose second folder is not an order id, and a file with no row yet (an upload before its row), stay readable');

-- Removal: a manager removes only what they read. The Storage API's delete
-- sets storage.allow_delete_query for its own statement (storage.protect_delete
-- refuses a direct delete without it); the test does the same.
do $$ begin perform set_config('storage.allow_delete_query', 'true', true); end $$;
select is(
  pg_temp.run('authenticated', :mgrN2, $q$with d as (delete from public.order_request_attachments where kind = 'signature' and organization_id = 'e5451000-0000-4000-8000-00000000000a' returning 1) select count(*)::text from d$q$)
  || ' ' || pg_temp.run('authenticated', :mgrN2, $q$with d as (delete from storage.objects where bucket_id = 'order-attachments' and name like 'e5451000-0000-4000-8000-00000000000a/e5451000-0000-4000-8000-000000000202/%' returning 1) select count(*)::text from d$q$),
  '0 0',
  'A17: a manager whose orders:approve is off removes no Wet signature row or file they did not add');
do $$ begin perform set_config('storage.allow_delete_query', 'false', true); end $$;
select is(
  pg_temp.run('authenticated', :mgrY, $q$with d as (delete from public.order_request_attachments where order_request_id = 'e5451000-0000-4000-8000-000000000202' returning 1) select count(*)::text from d$q$),
  '1',
  'A18: an approving manager still removes a Wet signature photo');

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
  'G1: anon holds nothing on order_request_attachments; authenticated holds SELECT, INSERT and DELETE; service_role keeps all four');
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
  'G3: service_role keeps SELECT, INSERT, UPDATE and DELETE on shipments and shipment_lines');
select is(
  pg_temp.run('authenticated', :mgrY, $q$select count(*)::text from public.shipments$q$)
  || ' ' || pg_temp.run('authenticated', :mgrY, $q$select count(*)::text from public.shipment_lines$q$)
  || ' ' || pg_temp.run('service_role', null, $q$select (count(*) >= 0)::text from public.shipments$q$),
  'ERR:42501 ERR:42501 true',
  'G4: a manager reads neither legacy shipment table; the service role still does');
select is(
  has_table_privilege('authenticated', 'public.order_requests', 'DELETE')::text
  || '|' || has_table_privilege('authenticated', 'public.order_requests', 'SELECT')::text
  || '|' || has_table_privilege('service_role', 'public.order_requests', 'DELETE')::text,
  'false|true|true',
  'G5: authenticated holds no DELETE on order_requests and keeps SELECT; service_role keeps DELETE');
select is(
  pg_temp.run('authenticated', :own, format($q$with d as (delete from public.order_requests where id = %L returning 1) select count(*)::text from d$q$, :oDone2)),
  'ERR:42501',
  'G6: the owner cannot delete an order row through the API');
select is(
  pg_temp.run('authenticated', :mgrY, format($q$select status from public.order_requests where id = %L$q$, :oDone)),
  'completed',
  'G7: members still read orders');

-- ══ S. Schedule events ═════════════════════════════════════════════════════
select is(
  pg_temp.run('authenticated', :mgrY, pg_temp.ev_web(:mgrY, :bunB)) || ' ' || pg_temp.run('authenticated', :mgrY, pg_temp.ev_web(:mgrY, :bunA)),
  'ERR:42501 1',
  'S1: a manager cannot add an event with another organization''s kit; with their own kit it is added (the web''s way)');
select is(
  pg_temp.run('authenticated', :vwr, pg_temp.ev_web(:vwr, null)) || ' ' || pg_temp.run('authenticated', :stf, pg_temp.ev_phone()),
  'ERR:42501 ERR:42501',
  'S2: a viewer and a staff member without schedule:manage cannot add an event');
select is(
  pg_temp.run('authenticated', :stfSch, pg_temp.ev_phone()) || ' ' || pg_temp.run('authenticated', :own, pg_temp.ev_web(:own, null))
  || ' ' || pg_temp.run('authenticated', :adm, pg_temp.ev_web(:adm, null)),
  '1 1 1',
  'S3: staff granted schedule:manage add an event the phone''s way; the owner and an admin add one the web''s way');
select is(
  pg_temp.run('authenticated', :mgrB, pg_temp.ev_web(:mgrB, null)),
  'ERR:42501',
  'S4: a manager of another organization cannot add an event to this one');
update public.organization_modules set enabled = false where organization_id = :orgA and module_id = 'schedule';
select is(
  pg_temp.run('authenticated', :mgrY, pg_temp.ev_web(:mgrY, null)) || ' ' || pg_temp.run('authenticated', :stfSch, pg_temp.ev_phone()),
  'ERR:42501 ERR:42501',
  'S5: with the Schedule module off nobody adds an event');
update public.organization_modules set enabled = true where organization_id = :orgA and module_id = 'schedule';

-- Updates: an event of each kind, written as the server would.
insert into public.schedule_events (id, organization_id, title, starts_at, status, created_by) values
  (:evA, :orgA, 'S3c manager event', now() + interval '2 days', 'scheduled', :mgrY),
  (:evSch, :orgA, 'S3c staff event', now() + interval '2 days', 'scheduled', :stfSch);
select is(
  pg_temp.run('authenticated', :mgrY, format($q$with u as (update public.schedule_events set bundle_id = %L, bundle_quantity = 1, bundle_warehouse_id = %L where id = %L returning 1) select count(*)::text from u$q$, :bunB, :whA, :evA))
  || ' ' || pg_temp.run('authenticated', :mgrY, format($q$with u as (update public.schedule_events set bundle_id = %L, bundle_quantity = 1, bundle_warehouse_id = %L where id = %L returning 1) select count(*)::text from u$q$, :bunA, :whA, :evA)),
  'ERR:42501 1',
  'S6: an update cannot point an event at another organization''s kit; its own kit is accepted');
select is(
  pg_temp.run('authenticated', :stfSch, format($q$with u as (update public.schedule_events set title = 'S3c staff event moved' where id = %L returning 1) select count(*)::text from u$q$, :evSch))
  || ' ' || pg_temp.run('authenticated', :mgrY, format($q$with u as (update public.schedule_events set title = 'S3c staff event, manager edit' where id = %L returning 1) select count(*)::text from u$q$, :evSch)),
  '1 1',
  'S7: the creator and a manager still update an event');
select is(
  pg_temp.run('service_role', null, format($q$with i as (insert into public.schedule_events (organization_id, title, starts_at, status, created_by, order_request_id, assigned_user_id)
       values (%L, 'S3c order event', now() + interval '3 days', 'scheduled', %L, %L, %L) returning 1) select count(*)::text from i$q$, :orgA, :mgrY, :oDone, :stfDrv)),
  '1',
  'S8: the admin client still links an order''s event (autoScheduleFromOrder)');

-- ══ F. The helpers ═════════════════════════════════════════════════════════
select is(
  (select string_agg(p.proname || ':' || p.prosecdef::text || ':' || p.provolatile::text || ':'
                     || coalesce(array_to_string(p.proconfig, ';'), '-') || ':'
                     || has_function_privilege('anon', p.oid, 'execute')::text || ':'
                     || has_function_privilege('authenticated', p.oid, 'execute')::text || ':'
                     || has_function_privilege('service_role', p.oid, 'execute')::text, ' ' order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('bundle_in_org', 'order_attachment_object_readable', 'order_signature_photo_reader')),
  'bundle_in_org:true:s:search_path=public, pg_temp:false:true:true '
  || 'order_attachment_object_readable:true:s:search_path=public, pg_temp:false:true:true '
  || 'order_signature_photo_reader:true:s:search_path=public, pg_temp:false:true:true',
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
  || ' ' || pg_temp.run('anon', null, format('select public.order_signature_photo_reader(%L)::text', :oDone)),
  'true false true false false ERR:42501',
  'F3: order_signature_photo_reader: the driver for their order only, an approver for any order, false for a non-approver and for another organization; anon may not call it');

-- ══ P. Policy text ═════════════════════════════════════════════════════════
select is(
  (select array_to_string(roles, ',') || '|' || cmd from pg_policies
    where schemaname = 'public' and tablename = 'order_request_attachments' and policyname = 'order_request_attachments read'),
  'authenticated|SELECT',
  'P1: the attachments read policy stays SELECT to authenticated');
select ok(
  (select qual like '%is_org_member(organization_id)%'
      and qual like '%kind <> ''signature''::text%'
      and qual like '%uploaded_by = ( SELECT auth.uid()%'
      and qual like '%order_signature_photo_reader(order_request_id)%'
     from pg_policies
    where schemaname = 'public' and tablename = 'order_request_attachments' and policyname = 'order_request_attachments read'),
  'P2: the attachments read policy is membership, then a Wet signature photo only for its uploader or order_signature_photo_reader');
select ok(
  (select with_check like '%has_org_role(organization_id, ''manager''::text)%'
      and with_check like '%staged_for_pickup%signature_requested%completed%'
      and with_check like '%split_part(storage_path, ''/''::text, 1) = (organization_id)::text%'
      and with_check like '%uploaded_by IS NULL%uploaded_by = ( SELECT auth.uid()%'
     from pg_policies
    where schemaname = 'public' and tablename = 'order_request_attachments' and policyname = 'order_request_attachments manager insert'),
  'P3: the attachments insert policy keeps 0143''s manager, order, status and folder terms and adds the uploader term');
select ok(
  (select qual like '%bucket_id = ''order-attachments''%'
      and qual like '%is_org_member(%foldername(name))[1])::uuid)%'
      and qual like '%order_attachment_object_readable(name)%'
      and qual not like '%has_org_role%'
     from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'order-attachments read'),
  'P4: the bucket read policy keeps the bucket and membership terms and adds order_attachment_object_readable');
select ok(
  (select with_check like '%is_org_member%created_by = auth.uid()%user_can_access_warehouse%warehouse_in_org(schedule_events.bundle_warehouse_id%order_request_in_org%bundle_in_org(schedule_events.bundle_id, schedule_events.organization_id)%has_permission(schedule_events.organization_id, ''schedule:manage''::text)%module_enabled(schedule_events.organization_id, ''schedule''::text)%'
     from pg_policies
    where schemaname = 'public' and tablename = 'schedule_events' and policyname = 'schedule_events_insert'),
  'P5: schedule_events_insert keeps every 0384 term and adds the kit, schedule:manage and module terms');
select ok(
  (select with_check like '%is_org_member%created_by = auth.uid()%has_org_role%warehouse_in_org(schedule_events.warehouse_id%warehouse_in_org(schedule_events.bundle_warehouse_id%order_request_in_org%bundle_in_org(schedule_events.bundle_id, schedule_events.organization_id)%'
      and qual not like '%bundle_in_org%'
      and qual like '%is_org_member%created_by = auth.uid()%has_org_role%'
     from pg_policies
    where schemaname = 'public' and tablename = 'schedule_events' and policyname = 'schedule_events_update'),
  'P6: schedule_events_update keeps every 0384 term, adds the kit term to its check, and its USING is unchanged');
select is(
  (select string_agg(policyname || ':' || cmd, ',' order by policyname) from pg_policies
    where schemaname = 'public' and tablename = 'order_request_attachments'),
  'order_request_attachments manager delete:DELETE,order_request_attachments manager insert:INSERT,order_request_attachments read:SELECT',
  'P7: order_request_attachments has the same three policies (no UPDATE policy)');

select * from finish();
rollback;
