-- supabase/tests/0466_retry_keys_written_by_their_functions.test.sql
--
-- Proves migration 0466: a row of idempotency_keys is written by the function
-- that uses it, and each function answers a replay only with the record its
-- key stands for.
--
--   P  posture: the four bodies (their live text plus the lines tagged
--      '-- 0466' and nothing else), the ledger fingerprint, the flag around
--      each key write, the functions' own posture, the guard function and its
--      trigger, the table grants and policies (unchanged).
--   G  the guard: an API role's direct insert, update or delete of a key row,
--      at every rank, is refused; a stale or empty flag is refused; the
--      service role and the table owner are not held; an organization's
--      removal still removes its key rows; every function that writes the
--      table is SECURITY DEFINER or raises the flag (the census).
--   C  recounts: first call and replay, a replay of a call that made no count,
--      a stored answer naming another count, the flag put back, and the
--      earlier body refused by the guard (a call in flight during the push).
--   S  shortfall drafts: first call and replay, another manager's replay,
--      another order, a stored answer for another order, a draft made by
--      someone else, the flag put back, and the earlier body refused.
--   N  a fresh receipt post or kit hand-out whose key a receipt or
--      distribution of the same purchase order or kit already carries.
--
-- Every refusal and every check that changes a stored row runs inside an
-- undone subtransaction (pg_temp.attempt), so one check never sees another's
-- change. Namespace 0466. Made-up data only. Wrapped in begin/rollback.

begin;
select plan(33);

\set org   '\'04660000-0000-0000-0000-00000000000a\''
\set orgX  '\'04660000-0000-0000-0000-00000000000b\''
\set own   '\'04660000-0000-0000-0000-0000000000a0\''
\set adm   '\'04660000-0000-0000-0000-0000000000a1\''
\set mgr   '\'04660000-0000-0000-0000-0000000000a2\''
\set mgr2  '\'04660000-0000-0000-0000-0000000000a3\''
\set stf   '\'04660000-0000-0000-0000-0000000000a4\''
\set vwr   '\'04660000-0000-0000-0000-0000000000a5\''
\set whA   '\'04660000-0000-0000-0000-0000000000c1\''
\set sup   '\'04660000-0000-0000-0000-0000000000c2\''
\set itR   '\'04660000-0000-0000-0000-0000000000d1\''
\set itC1  '\'04660000-0000-0000-0000-0000000000d2\''
\set itC2  '\'04660000-0000-0000-0000-0000000000d3\''
\set iRc1  '\'04660000-0000-0000-0000-0000000000d4\''
\set iRc2  '\'04660000-0000-0000-0000-0000000000d5\''
\set iSh   '\'04660000-0000-0000-0000-0000000000d6\''
\set po1   '\'04660000-0000-0000-0000-0000000000e1\''
\set l1    '\'04660000-0000-0000-0000-0000000000e2\''
\set bn    '\'04660000-0000-0000-0000-0000000000f1\''
\set ordS  '\'04660000-0000-0000-0000-0000000000f2\''
\set ordS2 '\'04660000-0000-0000-0000-0000000000f3\''
\set kOrg  '\'04660000-0000-0000-0000-0000000000f4\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,  '0466-own@test.local',  '{}'::jsonb),
  (:adm,  '0466-adm@test.local',  '{}'::jsonb),
  (:mgr,  '0466-mgr@test.local',  '{}'::jsonb),
  (:mgr2, '0466-mgr2@test.local', '{}'::jsonb),
  (:stf,  '0466-stf@test.local',  '{}'::jsonb),
  (:vwr,  '0466-vwr@test.local',  '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:org,  '0466 Retry Keys',   '0466-retry-keys'),
  (:orgX, '0466 Retry Keys X', '0466-retry-keys-x');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org,  :own,  'owner',   now()),
  (:org,  :adm,  'admin',   now()),
  (:org,  :mgr,  'manager', now()),
  (:org,  :mgr2, 'manager', now()),
  (:org,  :stf,  'staff',   now()),
  (:org,  :vwr,  'viewer',  now()),
  (:orgX, :own,  'owner',   now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :org, '0466 Main', 'WH-0466A', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:org, :stf, :whA, true),
  (:org, :vwr, :whA, true);
insert into public.organization_modules (organization_id, module_id, tier, enabled) values
  (:org, 'bundles', 'optional', true)
  on conflict (organization_id, module_id) do update set enabled = true;
insert into public.suppliers (id, organization_id, name) values
  (:sup, :org, '0466 Supplier');
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type, is_bundle, supplier_id, unit_cost) values
  (:itR,  :org, :whA, '0466-R',  'Received part 0466',  0,   'active', 'none', false, null, 1),
  (:itC1, :org, :whA, '0466-C1', 'Kit part one 0466',   100, 'active', 'none', false, null, 1),
  (:itC2, :org, :whA, '0466-C2', 'Kit part two 0466',   100, 'active', 'none', false, null, 1),
  (:iRc1, :org, :whA, '0466-Q1', 'Counted part one',    5,   'active', 'none', false, null, 1),
  (:iRc2, :org, :whA, '0466-Q2', 'Counted part two',    5,   'active', 'none', false, null, 1),
  (:iSh,  :org, :whA, '0466-S',  'Short part 0466',     0,   'active', 'none', false, :sup, 2);
insert into public.purchase_orders (id, organization_id, po_number, status) values
  (:po1, :org, 'PO-0466-1', 'ordered');
insert into public.purchase_order_items
  (id, organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost) values
  (:l1, :org, :po1, :itR, 100, 0, 1);
insert into public.bundles (id, organization_id, name, sku, is_active, preassembly_enabled) values
  (:bn, :org, '0466 Kit', 'KIT-0466', true, false);
insert into public.bundle_components (bundle_id, item_id, quantity, is_optional) values
  (:bn, :itC1, 1, false),
  (:bn, :itC2, 2, false);
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type) values
  (:ordS,  :org, :whA, 'pending_approval', 'internal', :stf, 'pickup'),
  (:ordS2, :org, :whA, 'pending_approval', 'internal', :stf, 'pickup');
insert into public.order_request_lines (order_request_id, item_id, quantity_requested, created_at) values
  (:ordS,  :iSh, 6, '2026-09-01 10:00:00+00'),
  (:ordS2, :iSh, 1, '2026-09-01 10:00:00+00');
-- A key row of orgX (G6: removing the organization removes it).
insert into public.idempotency_keys (id, organization_id, scope, key, request_hash, status) values
  (:kOrg, :orgX, 'receipt', 'x-1', 'h-x', 'completed');

-- ══ Helpers ═══════════════════════════════════════════════════════════════
-- pg_temp.hint drops supautils' generic "Grant the required privileges ..."
-- hint on privilege errors, which depends on the image.
create function pg_temp.hint(p_hint text) returns text language sql immutable as $$
  select case when p_hint is null or p_hint = ''
                or p_hint like 'Grant the required privileges to the current role with:%'
              then '-' else p_hint end
$$;
-- One statement as p_as with p_sub's claims, then ALWAYS undone (0464's
-- helper). 'ok:<rows>[:<p_check>]' (p_prep and p_check as the superuser,
-- inside the undone subtransaction), else '<sqlstate>:<hint or ->:<message>'.
create function pg_temp.attempt(p_as text, p_sub uuid, p_sql text, p_prep text default null, p_check text default null)
returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text; v_n bigint; v_seen text;
begin
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_as, true);
    perform set_config('role', p_as, true);
    execute p_sql;
    get diagnostics v_n = row_count;
    perform set_config('role', 'none', true);
    if p_check is not null then
      execute p_check into v_seen;
    end if;
    raise exception using errcode = 'XX404', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  if v_state = 'XX404' then
    return 'ok:' || v_n::text || coalesce(':' || v_seen, '');
  end if;
  return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
end $$;
-- A call that stays: run p_sql (one value) as an authenticated p_sub, keep its
-- effects, return the value.
create function pg_temp.keep(p_sub uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claim.sub', p_sub::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into v;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  return v;
end $$;
create function pg_temp.rcpt_sql(p_qty numeric, p_key text, p_hash text) returns text language sql immutable as $$
  select format($q$select (public.post_receipt_v2(%L, %L, jsonb_build_array(jsonb_build_object(
                    'po_line_id', %L, 'qty_received', %s, 'qty_accepted', %s, 'qty_rejected', 0, 'unit_cost', 1)), %L, %L, null)).id$q$,
                '04660000-0000-0000-0000-0000000000e1', '04660000-0000-0000-0000-0000000000c1',
                '04660000-0000-0000-0000-0000000000e2', p_qty, p_qty, p_key, p_hash)
$$;
create function pg_temp.kit_sql(p_qty numeric, p_key text) returns text language sql immutable as $$
  select format($q$select public.distribute_bundle(%L, %s, %L, false, null, null, %L)$q$,
                '04660000-0000-0000-0000-0000000000f1', p_qty, '04660000-0000-0000-0000-0000000000c1', p_key)
$$;
create function pg_temp.rc_sql(p_items uuid[], p_key text) returns text language sql immutable as $$
  select format($q$select public.start_targeted_recount(%L, null, %L::uuid[], null, %L)::text$q$,
                '04660000-0000-0000-0000-00000000000a', p_items, p_key)
$$;
create function pg_temp.sh_sql(p_order uuid, p_qty numeric, p_key text) returns text language sql immutable as $$
  select format($q$select public.draft_order_shortfall_pos(%L, jsonb_build_array(jsonb_build_object('item_id', %L, 'quantity', %s)), %L)::text$q$,
                p_order, '04660000-0000-0000-0000-0000000000d6', p_qty, p_key)
$$;
-- A definition with every line tagged '-- 0466' removed: the body as it was
-- before 0466 (P1 proves it by md5).
create function pg_temp.pre0466(p_sig text) returns text language sql stable as $$
  select regexp_replace(pg_get_functiondef(to_regprocedure(p_sig)), E'\n[^\n]*-- 0466[^\n]*', '', 'g')
$$;
create temp table ans (k text primary key, v text);

-- ══ P. Posture ════════════════════════════════════════════════════════════
select is(
  (select string_agg(v.k || '=' || md5(p.prosrc) || '|' || md5(regexp_replace(p.prosrc, E'\n[^\n]*-- 0466[^\n]*', '', 'g'))
                     || '|' || (select count(*) from regexp_matches(p.prosrc, '-- 0466', 'g'))::text, ' ' order by v.k)
     from (values ('kit',       'ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)'),
                  ('rcpt',      'ledger.post_receipt_v2(uuid,uuid,jsonb,text,text,text)'),
                  ('recount',   'public.start_targeted_recount(uuid,uuid[],uuid[],text,text)'),
                  ('shortfall', 'public.draft_order_shortfall_pos(uuid,jsonb,text)')) v(k, sig)
     join pg_proc p on p.oid = v.sig::regprocedure),
  'kit=52aa32489d62af5c89355b67f6493ea3|f0fac64fbdabf5870422e7b8fc3f7df3|7 '
  'rcpt=43d8753704c547012befef950747b965|ecd99069fa482371ac5bafeb3363b248|7 '
  'recount=5096548529d92d7a7e8aec2b4791e305|b22850a25b3b92d9a5f1ed02aa717aad|10 '
  'shortfall=7434557682c40aa984ef27d90fa77e22|1cf3a02ed7cb4b231ccc5f1e54ba0277|16',
  'P1: each body is 0466''s text, and removing its lines tagged -- 0466 (7, 7, 10 and 16) gives the live pre-0466 body exactly (f0fac64f, ecd99069, b22850a2, 1cf3a02e): the added lines are the only change');
-- 0383 Z2 and 0385 Z2 pin a fingerprint of every ledger.* function (their
-- query, verbatim): it moves from the pre-0466 pin by the two ledger bodies alone.
create function pg_temp.ledger_fp() returns text language sql stable as $$
  select md5(string_agg(p.oid::regprocedure::text || '|' || md5(p.prosrc) || '|' || p.prosecdef || '|' || coalesce(p.proconfig::text, '') || '|' || pg_get_userbyid(p.proowner) || '|' || coalesce(p.proacl::text, ''), E'\n' order by p.oid::regprocedure::text)) || '|' || count(*)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'ledger'
$$;
create function pg_temp.ledger_fp_pre0466() returns text language plpgsql as $$
declare v text;
begin
  begin
    execute pg_temp.pre0466('ledger.post_receipt_v2(uuid,uuid,jsonb,text,text,text)');
    execute pg_temp.pre0466('ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)');
    v := pg_temp.ledger_fp();
    raise exception using errcode = 'XX404', message = 'undo';
  exception when sqlstate 'XX404' then
    null;
  end;
  return v;
end $$;
select is(
  pg_temp.ledger_fp() || ' / ' || pg_temp.ledger_fp_pre0466(),
  '7e62f415c0fee59d829acffae47f602c|18 / ee07dd0a0c69b01b77f39c5791aea9e4|18',
  'P2: the ledger.* fingerprint 0383 Z2 and 0385 Z2 pin is 7e62f415|18 after 0466, and with the two ledger bodies taken back to their pre-0466 text it is the pre-0466 pin (ee07dd0a|18) exactly: nothing else in ledger moved');
select is(
  (select string_agg(v.k || '=' || (select string_agg(case when m[1] = 'pg_current_xact_id()::text' then 'raise' when m[1] = 'coalesce(v_idem_prev, '''')' then 'restore' else m[1] end, ',')
                                      from regexp_matches(p.prosrc, $r$set_config\('stockpilot\.idempotency_write', ([^;]+), true\);$r$, 'g') m)
                     || '|' || (select count(*) from regexp_matches(p.prosrc, 'stockpilot\.', 'g'))::text
                     || '|' || (p.prosrc ~ $r$v_idem_prev\s+text := current_setting\('stockpilot\.idempotency_write', true\);$r$)::text, ' ' order by v.k)
     from (values ('kit',       'ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)'),
                  ('rcpt',      'ledger.post_receipt_v2(uuid,uuid,jsonb,text,text,text)'),
                  ('recount',   'public.start_targeted_recount(uuid,uuid[],uuid[],text,text)'),
                  ('shortfall', 'public.draft_order_shortfall_pos(uuid,jsonb,text)')) v(k, sig)
     join pg_proc p on p.oid = v.sig::regprocedure),
  'kit=raise,restore,raise,restore|5|true rcpt=raise,restore|3|true recount=raise,restore,raise,restore|5|true shortfall=raise,restore,raise,restore|5|true',
  'P3: each of the four writers raises stockpilot.idempotency_write to the transaction id and puts back the value it read on entry, once around each key write, and names no other stockpilot setting');
select is(
  (select string_agg(p.oid::regprocedure::text || ':' || p.prosecdef::text || ':' || coalesce(p.proconfig::text, '') || ':' || pg_get_userbyid(p.proowner)
                     || ':' || has_function_privilege('anon', p.oid, 'execute')::text
                     || ':' || has_function_privilege('authenticated', p.oid, 'execute')::text
                     || ':' || has_function_privilege('service_role', p.oid, 'execute')::text, E'\n' order by p.oid::regprocedure::text)
     from pg_proc p
    where p.oid in ('public.start_targeted_recount(uuid,uuid[],uuid[],text,text)'::regprocedure,
                    'public.draft_order_shortfall_pos(uuid,jsonb,text)'::regprocedure)),
  E'draft_order_shortfall_pos(uuid,jsonb,text):false:{"search_path=public, pg_temp",lock_timeout=5s}:postgres:false:true:false\n'
  'start_targeted_recount(uuid,uuid[],uuid[],text,text):false:{search_path=public,lock_timeout=5s}:postgres:false:true:true',
  'P4: the recount and shortfall functions stay SECURITY INVOKER with their SET clauses, owner and EXECUTE');
select is(
  (select p.prosecdef::text || ':' || coalesce(p.proconfig::text, '') || ':' || pg_get_userbyid(p.proowner) || ':' || pg_get_function_result(p.oid)
          || ':' || has_function_privilege('anon', p.oid, 'execute')::text
          || ':' || has_function_privilege('authenticated', p.oid, 'execute')::text
          || ':' || has_function_privilege('service_role', p.oid, 'execute')::text
          || ':' || (obj_description(p.oid, 'pg_proc') is not null)::text
     from pg_proc p where p.oid = 'public.tg_idempotency_keys_guard()'::regprocedure),
  'false:{search_path=public}:postgres:trigger:false:false:false:true',
  'P5: the guard function is SECURITY INVOKER (search_path public, owner postgres, commented), returns trigger, and no API role may execute it');
select is(
  (select string_agg(t.tgname || ':' || t.tgtype::text || ':' || t.tgenabled::text || ':' || t.tgfoid::regproc::text, ', ' order by t.tgname)
     from pg_trigger t where t.tgrelid = 'public.idempotency_keys'::regclass and not t.tgisinternal),
  'idempotency_keys_updated_at:19:O:tg_set_updated_at, trg_zz_idempotency_keys_guard:31:O:tg_idempotency_keys_guard',
  'P6: idempotency_keys has its updated_at trigger and the guard: BEFORE INSERT OR UPDATE OR DELETE, FOR EACH ROW, enabled');
select is(
  (select string_agg(r.rolname || '=' || coalesce((select string_agg(x.privilege_type, ',' order by x.privilege_type)
                                                     from aclexplode((select c.relacl from pg_class c where c.oid = 'public.idempotency_keys'::regclass)) x
                                                    where x.grantee = r.oid), '-'), ' ' order by r.rolname)
     from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role'))
  || ' / ' || (select string_agg(p.polname || ':' || md5(coalesce(pg_get_expr(p.polqual, p.polrelid), '') || '|' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')), ' ' order by p.polname)
                 from pg_policy p where p.polrelid = 'public.idempotency_keys'::regclass),
  'anon=- authenticated=INSERT,SELECT,UPDATE service_role=DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE / idempotency_keys_select:eb17b677029b044445592f7722266228 idempotency_keys_write:c5ff715c8a328c17c7ec09d12d315576',
  'P7: the table grants are 0464''s and the two policies are unchanged');

-- ══ G. The guard ══════════════════════════════════════════════════════════
create function pg_temp.ins(p_key text) returns text language sql immutable as $$
  select format($q$insert into public.idempotency_keys (organization_id, scope, key, request_hash, status) values (%L, 'receipt', %L, 'h', 'in_progress')$q$,
                '04660000-0000-0000-0000-00000000000a', p_key)
$$;
-- A key row to update and delete (written as the table owner).
insert into public.idempotency_keys (organization_id, scope, key, request_hash, status) values
  (:org, 'receipt', 'g-1', 'h-g', 'completed');
select is(
  (select string_agg(v.who || '=' || pg_temp.attempt('authenticated', v.sub, pg_temp.ins('g-ins-' || v.who)), E'\n' order by v.n)
     from (values (1, 'owner', :own::uuid), (2, 'admin', :adm::uuid), (3, 'manager', :mgr::uuid),
                  (4, 'staff', :stf::uuid), (5, 'viewer', :vwr::uuid)) v(n, who, sub)),
  E'owner=42501:idempotency_key_through_rpc:idempotency_key_through_rpc\n'
  'admin=42501:idempotency_key_through_rpc:idempotency_key_through_rpc\n'
  'manager=42501:idempotency_key_through_rpc:idempotency_key_through_rpc\n'
  'staff=42501:idempotency_key_through_rpc:idempotency_key_through_rpc\n'
  'viewer=42501:idempotency_key_through_rpc:idempotency_key_through_rpc',
  'G1: a direct insert of a key row by a signed-in member is refused 42501 idempotency_key_through_rpc at every rank');
select is(
  (select string_agg(v.who || '=' || pg_temp.attempt('authenticated', v.sub,
            $q$update public.idempotency_keys set status = 'completed', resource_id = gen_random_uuid() where key = 'g-1'$q$), E'\n' order by v.n)
     from (values (1, 'owner', :own::uuid), (2, 'admin', :adm::uuid), (3, 'manager', :mgr::uuid),
                  (4, 'staff', :stf::uuid), (5, 'viewer', :vwr::uuid)) v(n, who, sub)),
  E'owner=42501:idempotency_key_through_rpc:idempotency_key_through_rpc\n'
  'admin=42501:idempotency_key_through_rpc:idempotency_key_through_rpc\n'
  'manager=42501:idempotency_key_through_rpc:idempotency_key_through_rpc\n'
  'staff=ok:0\n'
  'viewer=ok:0',
  'G2: a direct update of a key row is refused 42501 idempotency_key_through_rpc for owner, admin and manager; staff and viewers reach no row to change (the write policy)');
select is(
  (select string_agg(v.who || '=' || pg_temp.attempt(v.role, v.sub, $q$delete from public.idempotency_keys where key = 'g-1'$q$), E'\n' order by v.n)
     from (values (1, 'owner', 'authenticated', :own::uuid), (2, 'manager', 'authenticated', :mgr::uuid),
                  (3, 'anon', 'anon', null::uuid)) v(n, who, role, sub)),
  E'owner=42501:-:permission denied for table idempotency_keys\n'
  'manager=42501:-:permission denied for table idempotency_keys\n'
  'anon=42501:-:permission denied for table idempotency_keys',
  'G3: a direct delete of a key row is refused by the table grant (0464), at every rank and for anon');
select is(
  pg_temp.attempt('authenticated', :mgr, pg_temp.ins('g-stale'),
    $q$select set_config('stockpilot.idempotency_write', ((pg_current_xact_id()::text)::bigint - 1)::text, true)$q$)
  || E'\n' || pg_temp.attempt('authenticated', :mgr, pg_temp.ins('g-empty'),
    $q$select set_config('stockpilot.idempotency_write', '', true)$q$)
  || E'\n' || pg_temp.attempt('authenticated', :mgr, pg_temp.ins('g-word'),
    $q$select set_config('stockpilot.idempotency_write', 'on', true)$q$),
  E'42501:idempotency_key_through_rpc:idempotency_key_through_rpc\n'
  '42501:idempotency_key_through_rpc:idempotency_key_through_rpc\n'
  '42501:idempotency_key_through_rpc:idempotency_key_through_rpc',
  'G4: a flag naming another transaction, the empty value a function leaves after its call, or any other value is refused');
select is(
  pg_temp.attempt('authenticated', :mgr, pg_temp.ins('g-flag'),
    $q$select set_config('stockpilot.idempotency_write', pg_current_xact_id()::text, true)$q$,
    $q$select count(*)::text from public.idempotency_keys where key = 'g-flag'$q$),
  'ok:1:1',
  'G5: with the flag equal to this transaction''s id (what the four functions set around their own key write, and an API caller cannot), the write goes through: the guard admits exactly that');
select is(
  pg_temp.attempt('service_role', null, pg_temp.ins('g-svc'))
  || ' ' || pg_temp.attempt('service_role', null, $q$update public.idempotency_keys set status = 'failed' where key = 'g-1'$q$)
  || ' ' || pg_temp.attempt('service_role', null, $q$delete from public.idempotency_keys where key = 'g-1'$q$)
  || ' ' || pg_temp.attempt('postgres', null, $q$update public.idempotency_keys set status = 'failed' where key = 'g-1'$q$)
  || ' ' || pg_temp.attempt('postgres', null, $q$delete from public.idempotency_keys where key = 'g-1'$q$),
  'ok:1 ok:1 ok:1 ok:1 ok:1',
  'G6: the service role (the weekly digest''s claims) and the table owner insert, update and delete key rows as before');
select is(
  pg_temp.attempt('postgres', null, $q$delete from public.organizations where id = '04660000-0000-0000-0000-00000000000b'$q$, null,
    $q$select count(*)::text from public.idempotency_keys where id = '04660000-0000-0000-0000-0000000000f4'$q$),
  'ok:1:0',
  'G7: removing an organization still removes its key rows (the cascade runs as the table owner)');
-- The census: every function whose body writes idempotency_keys.
select is(
  (select string_agg(p.oid::regprocedure::text || ':' ||
            case when p.prosecdef and pg_get_userbyid(p.proowner) = 'postgres' then 'definer'
                 when p.prosrc ~ $r$set_config\('stockpilot\.idempotency_write', pg_current_xact_id\(\)::text, true\)$r$ then 'flag'
                 else 'NEITHER' end, E'\n' order by p.oid::regprocedure::text)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname not like 'pg\_temp%'
      and p.prosrc ~* $r$(insert\s+into|update|delete\s+from)\s+(public\.)?idempotency_keys\M$r$),
  E'approve_return(uuid,integer,jsonb,boolean):definer\n'
  'change_return_replacement(uuid,integer,jsonb,text,text,jsonb):definer\n'
  'create_requester_return_request(uuid,jsonb,uuid,jsonb):definer\n'
  'create_return_request(uuid,jsonb,uuid):definer\n'
  'draft_order_shortfall_pos(uuid,jsonb,text):flag\n'
  'ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text):flag\n'
  'ledger.post_receipt_v2(uuid,uuid,jsonb,text,text,text):flag\n'
  'start_targeted_recount(uuid,uuid[],uuid[],text,text):flag',
  'G8: every function that writes idempotency_keys is SECURITY DEFINER owned by postgres (the guard does not hold it) or raises the flag around its key writes; a new writer is a reviewed change here');

-- ══ C. Recounts ═══════════════════════════════════════════════════════════
insert into ans select 'c1', pg_temp.keep(:mgr, pg_temp.rc_sql(array[:iRc1]::uuid[], 'rc-1'));
insert into ans select 'c1b', pg_temp.keep(:mgr, pg_temp.rc_sql(array[:iRc1]::uuid[], 'rc-1'));
select is(
  (select jsonb_build_object(
            'created', (select v::jsonb->'created' from ans where k = 'c1'),
            'replay',  (select v::jsonb->'replay' from ans where k = 'c1b'),
            'same',    (select (v::jsonb - 'replay' - 'created') from ans where k = 'c1b') = (select (v::jsonb - 'replay' - 'created') from ans where k = 'c1'),
            'counts',  (select count(*) from public.cycle_counts where organization_id = :org),
            'key',     (select k.status || ':' || (k.resource_id::text = (select v::jsonb->>'cycleCountId' from ans where k = 'c1'))::text
                          from public.idempotency_keys k where k.organization_id = :org and k.scope = 'targeted_recount' and k.key = 'rc-1'))),
  jsonb_build_object('created', true, 'replay', true, 'same', true, 'counts', 1, 'key', 'completed:true'),
  'C1: a recount with a key starts one count and stores the key completed with it; the replay answers the same count with replay true');
-- A call that makes no count (the item is already being counted).
insert into ans select 'c2', pg_temp.keep(:mgr, pg_temp.rc_sql(array[:iRc1]::uuid[], 'rc-2'));
select is(
  (select (v::jsonb->>'cycleCountId') is null from ans where k = 'c2')::text
  || '|' || (pg_temp.keep(:mgr, pg_temp.rc_sql(array[:iRc1]::uuid[], 'rc-2'))::jsonb->>'replay')
  || '|' || (select count(*) from public.cycle_counts where organization_id = :org),
  'true|true|1',
  'C2: the replay of a call that made no count (its item already counting) is answered, with no count');
select is(
  pg_temp.attempt('authenticated', :mgr, pg_temp.rc_sql(array[:iRc1]::uuid[], 'rc-1'),
    $q$update public.idempotency_keys set response = jsonb_set(response, '{cycleCountId}', to_jsonb(gen_random_uuid()::text))
        where organization_id = '04660000-0000-0000-0000-00000000000a' and scope = 'targeted_recount' and key = 'rc-1'$q$)
  || E'\n' || pg_temp.attempt('authenticated', :mgr, pg_temp.rc_sql(array[:iRc1]::uuid[], 'rc-1'),
    $q$update public.idempotency_keys set resource_id = gen_random_uuid()
        where organization_id = '04660000-0000-0000-0000-00000000000a' and scope = 'targeted_recount' and key = 'rc-1'$q$),
  E'P0001:idempotency_conflict:idempotency_conflict\n'
  'P0001:idempotency_conflict:idempotency_conflict',
  'C3: a replay whose stored answer names another count than its key row is P0001 idempotency_conflict, whichever of the two differs');
select is(
  pg_temp.attempt('authenticated', :mgr2, pg_temp.rc_sql(array[:iRc1]::uuid[], 'rc-1')),
  'ok:1',
  'C4: another manager''s replay of the same request is still answered (the count is the organization''s; no term reads the count through the caller''s row rules)');
do $$ begin perform set_config('stockpilot.idempotency_write', 'before-c5', true); end $$;
insert into ans select 'c5', pg_temp.keep(:mgr, pg_temp.rc_sql(array[:iRc2]::uuid[], 'rc-5'));
select is(
  (select v::jsonb->>'created' from ans where k = 'c5') || '|' || current_setting('stockpilot.idempotency_write', true),
  'true|before-c5',
  'C5: after a recount with a key the flag holds the value it had before the call');
do $$ begin perform set_config('stockpilot.idempotency_write', '', true); end $$;
select is(
  pg_temp.attempt('authenticated', :mgr, pg_temp.rc_sql(array[:iRc2]::uuid[], 'rc-old'),
    pg_temp.pre0466('public.start_targeted_recount(uuid,uuid[],uuid[],text,text)'))
  || ' / ' || (select count(*) from public.cycle_counts where organization_id = :org)
  || ' / ' || (select count(*) from public.idempotency_keys where organization_id = :org and key = 'rc-old'),
  '42501:idempotency_key_through_rpc:idempotency_key_through_rpc / 2 / 0',
  'C6: the pre-0466 recount body (a call in flight during the push) is refused 42501 at its key write and leaves nothing behind');

-- ══ S. Shortfall drafts ═══════════════════════════════════════════════════
insert into ans select 's1', pg_temp.keep(:mgr, pg_temp.sh_sql(:ordS, 2, 'sh-1'));
select count(*) as "posS" from public.purchase_orders where organization_id = :org \gset
insert into ans select 's1b', pg_temp.keep(:mgr, pg_temp.sh_sql(:ordS, 2.0, 'sh-1'));
select is(
  (select jsonb_build_object(
            'first',  (select v::jsonb->'replay' from ans where k = 's1'),
            'again',  (select v::jsonb->'replay' from ans where k = 's1b'),
            'same',   (select v::jsonb - 'replay' from ans where k = 's1b') = (select v::jsonb - 'replay' from ans where k = 's1'),
            'drafts', jsonb_array_length((select v::jsonb->'created' from ans where k = 's1')),
            'pos',    (select count(*) from public.purchase_orders where organization_id = :org) = :posS)),
  jsonb_build_object('first', false, 'again', true, 'same', true, 'drafts', 1, 'pos', true),
  'S1: a shortfall draft with a key makes one draft; the same person''s replay answers it with replay true and drafts nothing');
select is(
  pg_temp.attempt('authenticated', :mgr2, pg_temp.sh_sql(:ordS, 2, 'sh-1'))
  || E'\n' || pg_temp.attempt('authenticated', :mgr, pg_temp.sh_sql(:ordS2, 1, 'sh-1')),
  E'P0001:idempotency_conflict:idempotency_conflict\n'
  'P0001:idempotency_conflict:idempotency_conflict',
  'S2: the key sent by another manager of the organization, or for another order, is P0001 idempotency_conflict (the message and hint the web caller matches)');
select is(
  pg_temp.attempt('authenticated', :mgr, pg_temp.sh_sql(:ordS, 2, 'sh-1'),
    format($q$update public.idempotency_keys set resource_id = %L where organization_id = %L and scope = 'order_shortfall_po' and key = 'sh-1'$q$, :ordS2, :org))
  || E'\n' || pg_temp.attempt('authenticated', :mgr, pg_temp.sh_sql(:ordS, 2, 'sh-1'),
    format($q$update public.idempotency_keys set response = jsonb_set(response, '{orderId}', to_jsonb(%L::text)) where organization_id = %L and scope = 'order_shortfall_po' and key = 'sh-1'$q$, :ordS2, :org))
  || E'\n' || pg_temp.attempt('authenticated', :mgr, pg_temp.sh_sql(:ordS, 2, 'sh-1'),
    format($q$update public.purchase_orders set created_by = %L where id = (select (v::jsonb->'created'->0->>'purchaseOrderId')::uuid from pg_temp.ans where k = 's1')$q$, :mgr2)),
  E'P0001:idempotency_conflict:idempotency_conflict\n'
  'P0001:idempotency_conflict:idempotency_conflict\n'
  'P0001:idempotency_conflict:idempotency_conflict',
  'S3: a replay is refused P0001 idempotency_conflict when the key row names another order, when the stored answer names another order, or when a stored draft was made by someone else');
select is(
  pg_temp.attempt('authenticated', :mgr, pg_temp.sh_sql(:ordS, 2, 'sh-1'),
    format($q$delete from public.purchase_orders where id = (select (v::jsonb->'created'->0->>'purchaseOrderId')::uuid from pg_temp.ans where k = 's1')$q$)),
  'P0001:shortfall_po_internal:draft_order_shortfall_pos_internal: a stored draft could not be read',
  'S4: a stored draft that no longer exists keeps the answer it had before 0466 (the existing internal error), not idempotency_conflict');
do $$ begin perform set_config('stockpilot.idempotency_write', 'before-s5', true); end $$;
insert into ans select 's5', pg_temp.keep(:mgr, pg_temp.sh_sql(:ordS, 1, 'sh-5'));
select is(
  (select v::jsonb->>'replay' from ans where k = 's5') || '|' || current_setting('stockpilot.idempotency_write', true),
  'false|before-s5',
  'S5: after a shortfall draft with a key the flag holds the value it had before the call');
do $$ begin perform set_config('stockpilot.idempotency_write', '', true); end $$;
select is(
  pg_temp.attempt('authenticated', :mgr, pg_temp.sh_sql(:ordS, 1, 'sh-old'),
    pg_temp.pre0466('public.draft_order_shortfall_pos(uuid,jsonb,text)'))
  || ' / ' || ((select count(*) from public.purchase_orders where organization_id = :org) = :posS + 1)::text
  || ' / ' || (select count(*) from public.idempotency_keys where organization_id = :org and key = 'sh-old'),
  '42501:idempotency_key_through_rpc:idempotency_key_through_rpc / true / 0',
  'S6: the pre-0466 shortfall body (a call in flight during the push) is refused 42501 at its key write and leaves nothing behind');

-- ══ N. A key already on a receipt or distribution ═══════════════════════════
insert into ans select 'r1', pg_temp.keep(:mgr, pg_temp.rcpt_sql(2, 'rk-1', 'h-1'));
select is(
  pg_temp.attempt('authenticated', :mgr, pg_temp.rcpt_sql(2, 'rk-1', 'h-1'), null, $q$select 'replayed'$q$)
  || E'\n' || pg_temp.attempt('authenticated', :mgr, pg_temp.rcpt_sql(2, 'rk-1', 'h-1'),
    $q$update public.idempotency_keys set key = 'rk-1-moved' where organization_id = '04660000-0000-0000-0000-00000000000a' and scope = 'receipt' and key = 'rk-1'$q$)
  || E'\n' || pg_temp.attempt('authenticated', :mgr, pg_temp.rcpt_sql(2, 'rk-1', 'h-1'),
    $q$delete from public.idempotency_keys where organization_id = '04660000-0000-0000-0000-00000000000a' and scope = 'receipt' and key = 'rk-1'$q$)
  || E'\n' || (select count(*) from public.receipts where organization_id = :org and idempotency_key = 'rk-1'),
  E'ok:1:replayed\n'
  '55000:-:idempotency_conflict\n'
  '55000:-:idempotency_conflict\n'
  '1',
  'N1: a receipt key with no key row is refused 55000 idempotency_conflict when a receipt of the purchase order already carries it (the key row renamed or gone); the replay with the key row is answered');
select is(
  pg_temp.attempt('authenticated', :mgr, pg_temp.rcpt_sql(1, 'rk-2', 'h-2'), null,
    $q$select count(*)::text from public.receipts where organization_id = '04660000-0000-0000-0000-00000000000a'$q$),
  'ok:1:2',
  'N2: a receipt with a new key still posts');
insert into ans select 'd1', pg_temp.keep(:mgr, pg_temp.kit_sql(1, 'kk-1'));
select is(
  pg_temp.attempt('authenticated', :mgr, pg_temp.kit_sql(1, 'kk-1'), null, $q$select 'replayed'$q$)
  || E'\n' || pg_temp.attempt('authenticated', :mgr, pg_temp.kit_sql(1, 'kk-1'),
    $q$update public.idempotency_keys set key = 'kk-1-moved' where organization_id = '04660000-0000-0000-0000-00000000000a' and scope = 'bundle_distribution' and key = 'kk-1'$q$)
  || E'\n' || pg_temp.attempt('authenticated', :mgr, pg_temp.kit_sql(1, 'kk-1'),
    $q$delete from public.idempotency_keys where organization_id = '04660000-0000-0000-0000-00000000000a' and scope = 'bundle_distribution' and key = 'kk-1'$q$)
  || E'\n' || (select count(*) from public.bundle_distributions where bundle_id = :bn and idempotency_key = 'kk-1'),
  E'ok:1:replayed\n'
  '55000:-:idempotency_conflict\n'
  '55000:-:idempotency_conflict\n'
  '1',
  'N3: a kit key with no key row is refused 55000 idempotency_conflict when a distribution of the kit already carries it; the replay with the key row is answered');
select is(
  pg_temp.attempt('authenticated', :mgr, pg_temp.kit_sql(1, 'kk-2'), null,
    $q$select count(*)::text from public.bundle_distributions where bundle_id = '04660000-0000-0000-0000-0000000000f1'$q$)
  || ' ' || pg_temp.attempt('authenticated', :mgr, pg_temp.kit_sql(1, null), null,
    $q$select count(*)::text from public.bundle_distributions where bundle_id = '04660000-0000-0000-0000-0000000000f1'$q$),
  'ok:1:2 ok:1:2',
  'N4: a hand-out with a new key, or with no key, still goes through');
select is(
  (select count(*) from public.idempotency_keys where organization_id = :org and scope in ('receipt', 'bundle_distribution') and key in ('rk-1', 'kk-1'))::text
  || '|' || current_setting('stockpilot.idempotency_write', true),
  '2|',
  'N5: the key rows the receipt and the hand-out wrote are there, and the flag is empty again after the calls');

-- ══ D. Docs ═══════════════════════════════════════════════════════════════
select ok(
  (select obj_description('public.tg_idempotency_keys_guard()'::regprocedure, 'pg_proc') ~ 'stockpilot\.idempotency_write'),
  'D1: the guard''s comment names the flag it reads');

select * from finish();
rollback;
