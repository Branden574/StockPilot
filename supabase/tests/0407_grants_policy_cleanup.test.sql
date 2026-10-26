-- supabase/tests/0407_grants_policy_cleanup.test.sql
-- pgTAP proof for migration 0407 (small fixes slice 4): database permission
-- clean-up with no change to anything the apps do.
--
-- R. The six report_* functions: service_role holds EXECUTE on none of them,
--    authenticated on all, anon and PUBLIC on none; no body names
--    service_role, every body refuses a call with no user first, and each is
--    pinned. With EXECUTE granted back for this test only, service_role with
--    no user is refused 42501 unauthenticated: the rollout branch is gone.
-- G. Table privileges named one by one: anon holds nothing on shipments,
--    shipment_lines or idempotency_keys; authenticated holds SELECT, INSERT
--    and UPDATE on idempotency_keys and no DELETE; neither holds INSERT on
--    maintenance_request_attachments, which authenticated still reads and
--    deletes from; service_role keeps everything it held.
-- T. TRUNCATE, REFERENCES, TRIGGER and MAINTAIN: no public relation gives
--    them to anon or authenticated, the postgres role's default privileges
--    (in public and database-wide) give them to neither, and a table created
--    now gets none of them for either.
-- P. idempotency_keys policies: SELECT, INSERT and UPDATE for managers of the
--    key's organization, no FOR ALL and no DELETE policy. A viewer and a
--    staff member read no key; a manager reads their organization's keys and
--    no other's, cannot delete one, cannot update or insert another
--    organization's, and a staff member cannot insert one. A manager's
--    receipt is recorded and replayed through its key (post_receipt_v2 reads
--    the committed key with SELECT ... FOR UPDATE, which the UPDATE policy
--    also filters).
-- M. maintenance_request_attachments: no INSERT policy, the SELECT and
--    DELETE policies unchanged, and a direct insert with a user's token is
--    refused by privilege.
-- A. item_attachments: RLS on and no policy, so a manager reads no row and
--    cannot insert one; no storage.objects policy names the item-attachments
--    bucket. (Whether the migration deletes the bucket, and refuses when it
--    holds anything, is proven against a database that has the bucket by
--    scripts/db-concurrency/0407_migration_guards.sh: no local or CI stack
--    has it while migrations run, because the CLI creates config.toml's
--    buckets after them.)
-- I. item_images: the storage_path, thumb_path and organization_id indexes
--    exist, and the 0381 path probe and organization filter can use them.
--
-- Persona calls run as `authenticated` with request.jwt.claim.sub set; no
-- statement here calls a function the current role cannot execute (a
-- permission-denied function call crashes older local images, 0225's note).
-- begin/rollback: nothing leaks. Namespace 04070000.

begin;

select plan(30);

\set orgA   '\'04070000-0000-0000-0000-00000000000a\''
\set orgB   '\'04070000-0000-0000-0000-00000000000b\''
\set mgrA   '\'04070000-0000-0000-0000-0000000000a1\''
\set stfA   '\'04070000-0000-0000-0000-0000000000a2\''
\set vwrA   '\'04070000-0000-0000-0000-0000000000a3\''
\set mgrB   '\'04070000-0000-0000-0000-0000000000b1\''
\set wh     '\'04070000-0000-0000-0000-0000000000c1\''
\set item   '\'04070000-0000-0000-0000-0000000000d1\''
\set po     '\'04070000-0000-0000-0000-0000000000e1\''
\set poline '\'04070000-0000-0000-0000-0000000000f1\''

-- ── Fixtures (as the test superuser: RLS does not apply) ───────────────────
insert into auth.users (id, email, raw_user_meta_data) values
  (:mgrA, 'manager-a@example.test', '{}'::jsonb),
  (:stfA, 'staff-a@example.test',   '{}'::jsonb),
  (:vwrA, 'viewer-a@example.test',  '{}'::jsonb),
  (:mgrB, 'manager-b@example.test', '{}'::jsonb);
insert into public.organizations (id, name, slug) values
  (:orgA, '0407 Org A', 'org-0407-a'),
  (:orgB, '0407 Org B', 'org-0407-b');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :mgrA, 'manager', now()),
  (:orgA, :stfA, 'staff',   now()),
  (:orgA, :vwrA, 'viewer',  now()),
  (:orgB, :mgrB, 'manager', now());
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :orgA, '0407 Warehouse', 'WH-0407', 'active');
insert into public.inventory_items
  (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status, tracking_type)
  values (:item, :orgA, :wh, '0407 Widget', 'SKU-0407', 0, 'active', 'none');
insert into public.purchase_orders (id, organization_id, po_number, status)
  values (:po, :orgA, 'PO-0407', 'ordered');
insert into public.purchase_order_items
  (id, organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost)
  values (:poline, :orgA, :po, :item, 10, 0, 5);
insert into public.idempotency_keys (organization_id, scope, key, request_hash, status) values
  (:orgA, 'test_0407', 'a-1', 'h', 'completed'),
  (:orgB, 'test_0407', 'b-1', 'h', 'completed');

create temp table t407 (k text primary key, v text);
grant all on t407 to authenticated, service_role;

create temp table fns (fn text primary key, sig regprocedure not null);
insert into fns values
  ('report_movement_type_summary',  'public.report_movement_type_summary(uuid, timestamptz)'),
  ('report_top_movers',             'public.report_top_movers(uuid, timestamptz, integer)'),
  ('report_shrinkage_totals',       'public.report_shrinkage_totals(uuid, timestamptz)'),
  ('report_item_out_movements',     'public.report_item_out_movements(uuid, timestamptz)'),
  ('report_bundle_activity',        'public.report_bundle_activity(uuid, timestamptz)'),
  ('report_bundle_component_value', 'public.report_bundle_component_value(uuid, timestamptz)');

-- ══ R. Report functions (4.2) ══════════════════════════════════════════════
select is(
  (select count(*) from fns f where has_function_privilege('service_role', f.sig, 'execute')),
  0::bigint,
  'R1: service_role cannot execute any of the six report functions (0380''s rollout grant is gone)');

select is(
  (select count(*) from fns f
    where has_function_privilege('authenticated', f.sig, 'execute')
      and not has_function_privilege('anon', f.sig, 'execute')
      and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       where p.oid = f.sig and a.grantee = 0)),
  6::bigint,
  'R2: authenticated can execute all six; anon and PUBLIC none');

select is(
  (select string_agg(f.fn || '|' || md5(p.prosrc), E'\n' order by f.fn)
     from fns f join pg_proc p on p.oid = f.sig
    where p.prosrc !~ 'service_role'
      and p.prosrc ~ $re$if \(select auth\.uid\(\)\) is null then\s+raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';\s+elsif$re$),
  E'report_bundle_activity|b1a1c669d65bb8b9ab68104941d10ce9\n'
  'report_bundle_component_value|121aa414ae7314df080886f3a41d3eed\n'
  'report_item_out_movements|237823f53d503b9c787e9c481d6a8de5\n'
  'report_movement_type_summary|42233e0aa916ae19bb416d3f1f56180c\n'
  'report_shrinkage_totals|9b5bcbea4bce96eb397fb554df28157a\n'
  'report_top_movers|3345ef4a35b5db0be5da578b4888fdec',
  'R3: no body names service_role, each refuses a call with no user first, and each is 0380''s body without its service-role test');

-- EXECUTE back for this test only (rolled back): the body itself refuses.
grant execute on function public.report_top_movers(uuid, timestamptz, integer) to service_role;
set local role service_role;
set local "request.jwt.claim.sub" to '';
select throws_ok(
  $$ select * from public.report_top_movers('04070000-0000-0000-0000-00000000000a'::uuid, now() - interval '30 days', 5) $$,
  '42501', 'unauthenticated',
  'R4: service_role with no user is refused 42501 unauthenticated by the body itself');
reset role;
revoke execute on function public.report_top_movers(uuid, timestamptz, integer) from service_role;

-- ══ G. Table privileges named one by one (4.1, 4.4, 4.5) ═══════════════════
select is(
  (select array_agg(t || ':' || p order by t, p)
     from unnest(array['public.shipments', 'public.shipment_lines']) t,
          unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) p
    where has_table_privilege('anon', t, p)),
  null::text[],
  'G1: anon holds no privilege on shipments or shipment_lines');

select ok(
  (select bool_and(has_table_privilege('authenticated', t, p))
     from unnest(array['public.shipments', 'public.shipment_lines']) t,
          unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p)
  and (select bool_and(has_table_privilege('service_role', t, p))
     from unnest(array['public.shipments', 'public.shipment_lines']) t,
          unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) p),
  'G2: authenticated keeps SELECT, INSERT, UPDATE and DELETE on both (its policies decide), service_role keeps all eight');

select is(
  (select array_agg(r || ':' || p order by r, p)
     from unnest(array['anon', 'authenticated', 'service_role']) r,
          unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) p
    where has_table_privilege(r, 'public.idempotency_keys', p)),
  array['authenticated:INSERT', 'authenticated:SELECT', 'authenticated:UPDATE',
        'service_role:DELETE', 'service_role:INSERT', 'service_role:MAINTAIN', 'service_role:REFERENCES',
        'service_role:SELECT', 'service_role:TRIGGER', 'service_role:TRUNCATE', 'service_role:UPDATE'],
  'G3: idempotency_keys: anon holds nothing, authenticated only SELECT, INSERT and UPDATE, service_role everything');

select is(
  (select array_agg(r || ':' || p order by r, p)
     from unnest(array['anon', 'authenticated', 'service_role']) r,
          unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
    where has_table_privilege(r, 'public.maintenance_request_attachments', p)),
  array['anon:DELETE', 'anon:SELECT', 'anon:UPDATE',
        'authenticated:DELETE', 'authenticated:SELECT', 'authenticated:UPDATE',
        'service_role:DELETE', 'service_role:INSERT', 'service_role:SELECT', 'service_role:UPDATE'],
  'G4: maintenance_request_attachments: only service_role inserts; reads, updates and deletes are unchanged (their policies decide)');

-- ══ T. TRUNCATE, REFERENCES, TRIGGER and MAINTAIN (4.3) ════════════════════
select is(
  (select count(*)
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and a.grantee in ('anon'::regrole, 'authenticated'::regrole)
      and a.privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN')),
  0::bigint,
  'T1: no relation in public gives anon or authenticated TRUNCATE, REFERENCES, TRIGGER or MAINTAIN');

-- Only the four are judged: what the same defaults give for SELECT, INSERT,
-- UPDATE and DELETE is 0402's business and changes with config.toml's
-- auto_expose_new_tables, not with this file.
select is(
  (select array_agg(case when d.defaclnamespace = 0 then '(database-wide)' else d.defaclnamespace::regnamespace::text end || ':'
                    || a.grantee::regrole::text || ':' || a.privilege_type order by 1)
     from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a
    where d.defaclrole = 'postgres'::regrole
      and (d.defaclnamespace = 'public'::regnamespace or d.defaclnamespace = 0)
      and d.defaclobjtype = 'r'
      and a.grantee in ('anon'::regrole, 'authenticated'::regrole)
      and a.privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN')),
  null::text[],
  'T2: the postgres role''s default table privileges, in public and database-wide, give anon and authenticated none of the four');

create table public.t407_probe (id int primary key);
select is(
  (select array_agg(r || ':' || p order by r, p)
     from unnest(array['anon', 'authenticated']) r,
          unnest(array['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) p
    where has_table_privilege(r, 'public.t407_probe', p)),
  null::text[],
  'T3: a table created in public now gives anon and authenticated none of the four (default privileges)');
drop table public.t407_probe;

-- ══ P. idempotency_keys policies (4.4) ══════════════════════════════════════
select is(
  (select string_agg(pol.polname || '|' || pol.polcmd::text || '|' || pol.polpermissive::text || '|'
                     || pol.polroles::regrole[]::text || '|'
                     || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '-') || '|'
                     || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '-'), E'\n' order by pol.polname)
     from pg_policy pol where pol.polrelid = 'public.idempotency_keys'::regclass),
  E'idempotency_keys_insert|a|true|{authenticated}|-|( SELECT has_org_role(idempotency_keys.organization_id, \'manager\'::text) AS has_org_role)\n'
  'idempotency_keys_select|r|true|{authenticated}|( SELECT has_org_role(idempotency_keys.organization_id, ''manager''::text) AS has_org_role)|-\n'
  'idempotency_keys_update|w|true|{authenticated}|( SELECT has_org_role(idempotency_keys.organization_id, ''manager''::text) AS has_org_role)|( SELECT has_org_role(idempotency_keys.organization_id, ''manager''::text) AS has_org_role)',
  'P1: idempotency_keys has a SELECT, an INSERT and an UPDATE policy for managers of the key''s organization, and no FOR ALL or DELETE policy');

set local role authenticated;
set local "request.jwt.claim.sub" to '04070000-0000-0000-0000-0000000000a3';
select is((select count(*) from public.idempotency_keys), 0::bigint,
  'P2: a viewer reads no key (any member did before 0407)');
set local "request.jwt.claim.sub" to '04070000-0000-0000-0000-0000000000a2';
select is((select count(*) from public.idempotency_keys), 0::bigint,
  'P3: a staff member reads no key');
set local "request.jwt.claim.sub" to '04070000-0000-0000-0000-0000000000a1';
select is((select array_agg(key order by key) from public.idempotency_keys where scope = 'test_0407'),
  array['a-1'],
  'P4: a manager reads their organization''s keys and none of another organization''s');
select throws_ok(
  $$ delete from public.idempotency_keys where key = 'a-1' $$,
  '42501', null,
  'P5: a manager cannot delete a key (no DELETE privilege, no DELETE policy)');
with u as (update public.idempotency_keys set status = 'in_progress' where key = 'b-1' returning 1)
select is((select count(*) from u), 0::bigint,
  'P6: a manager''s update of another organization''s key changes nothing');
select throws_ok(
  $$ insert into public.idempotency_keys (organization_id, scope, key, request_hash, status)
     values ('04070000-0000-0000-0000-00000000000b', 'test_0407', 'a-2', 'h', 'in_progress') $$,
  '42501', null,
  'P7: a manager cannot record a key for another organization');
set local "request.jwt.claim.sub" to '04070000-0000-0000-0000-0000000000a2';
select throws_ok(
  $$ insert into public.idempotency_keys (organization_id, scope, key, request_hash, status)
     values ('04070000-0000-0000-0000-00000000000a', 'test_0407', 'a-3', 'h', 'in_progress') $$,
  '42501', null,
  'P8: a staff member cannot record a key');

-- A manager's receipt, then the same call again: the replay answers the
-- first receipt through the committed key.
set local "request.jwt.claim.sub" to '04070000-0000-0000-0000-0000000000a1';
do $$
declare v_id uuid;
begin
  for i in 1..2 loop
    select r.id into v_id
      from public.post_receipt_v2(
        '04070000-0000-0000-0000-0000000000e1'::uuid,
        '04070000-0000-0000-0000-0000000000c1'::uuid,
        jsonb_build_array(jsonb_build_object(
          'po_line_id', '04070000-0000-0000-0000-0000000000f1',
          'qty_received', 2, 'qty_accepted', 2, 'qty_rejected', 0, 'unit_cost', 5)),
        'receipt-0407', 'hash-0407', null) r;
    insert into t407 values ('receipt-' || i, v_id::text);
  end loop;
end $$;
reset role;

select is(
  (select v from t407 where k = 'receipt-2'),
  (select v from t407 where k = 'receipt-1'),
  'P9: the second call with the same key answers the first receipt');
select is(
  (select array[(select count(*) from public.receipts where purchase_order_id = :po)::numeric,
                (select quantity_on_hand from public.inventory_items where id = :item),
                (select count(*) from public.idempotency_keys
                  where organization_id = :orgA and scope = 'receipt' and key = 'receipt-0407'
                    and status = 'completed' and resource_id::text = (select v from t407 where k = 'receipt-1'))::numeric]),
  array[1, 2, 1]::numeric[],
  'P10: one receipt, stock on record up once, and the manager''s key recorded as completed for it');

-- ══ M. maintenance_request_attachments (4.5) ═══════════════════════════════
select is(
  (select array_agg(pol.polname || ':' || pol.polcmd::text order by pol.polname)
     from pg_policy pol where pol.polrelid = 'public.maintenance_request_attachments'::regclass),
  array['maintenance_request_attachments_delete:d', 'maintenance_request_attachments_select:r'],
  'M1: maintenance_request_attachments keeps its SELECT and DELETE policies and has no INSERT policy');

set local role authenticated;
set local "request.jwt.claim.sub" to '04070000-0000-0000-0000-0000000000a1';
select throws_ok(
  $$ insert into public.maintenance_request_attachments (organization_id) values ('04070000-0000-0000-0000-00000000000a') $$,
  '42501', 'permission denied for table maintenance_request_attachments',
  'M2: an insert with a user''s token is refused by privilege, before any policy (finalize inserts with the service role)');
reset role;

-- ══ A. item_attachments and the item-attachments storage policies (4.6) ═══
insert into public.item_attachments (organization_id, item_id, storage_path, filename)
  values (:orgA, :item, '04070000-0000-0000-0000-00000000000a/items/04070000-0000-0000-0000-0000000000d1/a.pdf', 'a.pdf');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.item_attachments'::regclass)
  and not exists (select 1 from pg_policy where polrelid = 'public.item_attachments'::regclass),
  'A1: item_attachments keeps row level security on and has no policy');

set local role authenticated;
set local "request.jwt.claim.sub" to '04070000-0000-0000-0000-0000000000a1';
select is((select count(*) from public.item_attachments), 0::bigint,
  'A2: a manager reads no item_attachments row');
select throws_ok(
  $$ insert into public.item_attachments (organization_id, item_id, storage_path, filename)
     values ('04070000-0000-0000-0000-00000000000a', '04070000-0000-0000-0000-0000000000d1',
             '04070000-0000-0000-0000-00000000000a/items/04070000-0000-0000-0000-0000000000d1/b.pdf', 'b.pdf') $$,
  '42501', null,
  'A3: a manager cannot insert an item_attachments row');
reset role;

select is(
  (select count(*) from pg_policy pol
    where pol.polrelid = 'storage.objects'::regclass
      and (pol.polname ilike '%item-attachments%'
           or coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') ~ 'item-attachments'
           or coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') ~ 'item-attachments')),
  0::bigint,
  'A4: no storage.objects policy names the item-attachments bucket');

-- ══ I. item_images indexes (4.8) ═══════════════════════════════════════════
select is(
  (select array_agg(pg_get_indexdef(i.indexrelid) order by pg_get_indexdef(i.indexrelid))
     from pg_index i
    where i.indrelid = 'public.item_images'::regclass
      and i.indexrelid::regclass::text in ('item_images_storage_path_idx', 'item_images_thumb_path_idx',
                                           'item_images_organization_id_idx')),
  array['CREATE INDEX item_images_organization_id_idx ON public.item_images USING btree (organization_id)',
        'CREATE INDEX item_images_storage_path_idx ON public.item_images USING btree (storage_path)',
        'CREATE INDEX item_images_thumb_path_idx ON public.item_images USING btree (thumb_path)'],
  'I1: item_images has plain btree indexes on storage_path, thumb_path and organization_id');

-- The planner's choice at real sizes was measured (0407's header); here the
-- sequential scan is turned off so the plans show the indexes can serve the
-- queries' own predicates.
set local enable_seqscan = off;
create function pg_temp.plan_of(p_sql text) returns text language plpgsql as $$
declare v text; l text;
begin
  v := '';
  for l in execute 'explain (costs off) ' || p_sql loop
    v := v || l || E'\n';
  end loop;
  return v;
end $$;

select ok(
  pg_temp.plan_of($q$ select 1 from public.item_images r
                       where r.storage_path = 'x/y/z.webp' $q$) ~ 'item_images_storage_path_idx'
  and pg_temp.plan_of($q$ select 1 from public.item_images r
                           where r.thumb_path = 'x/y/z.webp' $q$) ~ 'item_images_thumb_path_idx'
  and pg_temp.plan_of($q$ select item_id from public.item_images
                           where organization_id in ('04070000-0000-0000-0000-00000000000a') $q$)
        ~ 'item_images_organization_id_idx',
  'I2: a lookup by storage_path, by thumb_path (the two halves of the 0381 path probe and of the shared-object read) and by organization (rls_item_image_shared_paths) can each use its index');
reset enable_seqscan;

-- ══ The migration's guards, read from the catalog ═════════════════════════
select ok(
  not exists (select 1 from pg_proc p where p.oid in (select sig from fns) and p.prosrc ~ '40001|40P01'),
  'X1: no restated body raises 40001 or 40P01');

select * from finish();
rollback;
