-- supabase/tests/0464_retry_keys_match_their_record.test.sql
--
-- Proves migration 0464: a retry answers only the record its key was written
-- with.
--
--   P  posture: the grants on idempotency_keys, the policies (unchanged), the
--      kit key column, the two bodies (their live text plus the lines tagged
--      '-- 0464' and nothing else) and the transaction flag around each key
--      write.
--   D  direct table access by API roles: anon and a manager's DELETE and
--      TRUNCATE are refused; a manager still reads the organization's rows.
--   R  receipts: first post and replay, an edited retry, every term of the
--      match, a receipt posted by the pre-0464 body, a reversed receipt, a
--      staff member, and 0366's kit-stock refusal.
--   K  kits: the key stored on the distribution, replay, every term of the
--      match, a distribution made by the pre-0464 body (its key row written in
--      the same transaction), keyless sends, a five-decimal quantity, the
--      Schedule's completion path.
--   F  the flag: it carries the transaction id at each key write and the
--      previous value comes back.
--
-- Every refusal and every check that changes a stored row runs inside an
-- undone subtransaction (pg_temp.attempt), so one check never sees another's
-- change. The whole file is one transaction, so every now() in it is the
-- same instant; the checks that depend on time move one timestamp by hand.
-- Namespace 0464. Made-up data only. Wrapped in begin/rollback.

begin;
select plan(37);

\set org   '\'04640000-0000-0000-0000-00000000000a\''
\set orgB  '\'04640000-0000-0000-0000-00000000000b\''
\set mgr   '\'04640000-0000-0000-0000-0000000000a1\''
\set mgr2  '\'04640000-0000-0000-0000-0000000000a2\''
\set stf   '\'04640000-0000-0000-0000-0000000000a3\''
\set mgrD  '\'04640000-0000-0000-0000-0000000000a4\''
\set whA   '\'04640000-0000-0000-0000-0000000000c1\''
\set whA2  '\'04640000-0000-0000-0000-0000000000c2\''
\set whB   '\'04640000-0000-0000-0000-0000000000c3\''
\set itR   '\'04640000-0000-0000-0000-0000000000d1\''
\set itK   '\'04640000-0000-0000-0000-0000000000d2\''
\set itC1  '\'04640000-0000-0000-0000-0000000000d3\''
\set itC2  '\'04640000-0000-0000-0000-0000000000d4\''
\set po1   '\'04640000-0000-0000-0000-0000000000e1\''
\set l1    '\'04640000-0000-0000-0000-0000000000e2\''
\set lK    '\'04640000-0000-0000-0000-0000000000e3\''
\set po2   '\'04640000-0000-0000-0000-0000000000e5\''
\set l2    '\'04640000-0000-0000-0000-0000000000e6\''
\set bn    '\'04640000-0000-0000-0000-0000000000f1\''
\set bn2   '\'04640000-0000-0000-0000-0000000000f3\''
\set ev    '\'04640000-0000-0000-0000-0000000000f2\''
\set gone  '\'04640000-0000-0000-0000-0000000000ff\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr,  '0464-mgr@test.local',  '{}'::jsonb),
  (:mgr2, '0464-mgr2@test.local', '{}'::jsonb),
  (:stf,  '0464-stf@test.local',  '{}'::jsonb),
  (:mgrD, '0464-mgrd@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:org,  '0464 Retry Keys',   '0464-retry-keys'),
  (:orgB, '0464 Retry Keys B', '0464-retry-keys-b');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :mgr,  'manager', now()),
  (:org, :mgr2, 'manager', now()),
  (:org, :stf,  'staff',   now()),
  (:org, :mgrD, 'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA,  :org,  '0464 Main',  'WH-0464A',  'active'),
  (:whA2, :org,  '0464 Annex', 'WH-0464A2', 'active'),
  (:whB,  :orgB, '0464 Bee',   'WH-0464B',  'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:org, :stf, :whA, true);
-- mgrD: the Schedule's completion path (schedule:manage, no bundles:distribute).
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:org, :mgrD, 'bundles:distribute', false);
insert into public.organization_modules (organization_id, module_id, tier, enabled) values
  (:org, 'bundles',  'optional', true),
  (:org, 'schedule', 'optional', true)
  on conflict (organization_id, module_id) do update set enabled = true;
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type, is_bundle) values
  (:itR,  :org, :whA, '0464-R',           'Received part 0464',      0,   'active', 'none', false),
  (:itK,  :org, :whA, '__BUNDLE__0464k',  'Reading Kit 0464',        0,   'active', 'none', true),
  (:itC1, :org, :whA, '0464-C1',          'Kit part one 0464',       100, 'active', 'none', false),
  (:itC2, :org, :whA, '0464-C2',          'Kit part two 0464',       100, 'active', 'none', false);
insert into public.purchase_orders (id, organization_id, po_number, status) values
  (:po1, :org, 'PO-0464-1', 'ordered'),
  (:po2, :org, 'PO-0464-2', 'ordered');
insert into public.purchase_order_items
  (id, organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost) values
  (:l1, :org, :po1, :itR, 100, 0, 1),
  (:lK, :org, :po1, :itK, 5,   0, 1),
  (:l2, :org, :po2, :itR, 100, 0, 1);
-- bn: 1 x C1 + 2 x C2, built from components only. bn2: another kit of the
-- same components (K4's kit term).
insert into public.bundles (id, organization_id, name, sku, is_active, preassembly_enabled) values
  (:bn,  :org, '0464 Kit',       'KIT-0464',   true, false),
  (:bn2, :org, '0464 Kit Two',   'KIT-0464-2', true, false);
insert into public.bundle_components (bundle_id, item_id, quantity, is_optional) values
  (:bn,  :itC1, 1, false),
  (:bn,  :itC2, 2, false),
  (:bn2, :itC1, 1, false),
  (:bn2, :itC2, 2, false);
-- ev: a completed event handing out 1 x bn from whA (what the Schedule saves
-- before it calls distribute_bundle).
insert into public.schedule_events
  (id, organization_id, title, starts_at, warehouse_id, status, bundle_id, bundle_quantity, bundle_warehouse_id, created_by, updated_by) values
  (:ev, :org, 'Kit day 0464', now() - interval '1 hour', :whA, 'completed', :bn, 1, :whA, :mgr, :mgr);

-- ══ Helpers ═══════════════════════════════════════════════════════════════
-- pg_temp.hint drops supautils' generic "Grant the required privileges ..."
-- hint on privilege errors, which depends on the image.
create function pg_temp.hint(p_hint text) returns text language sql immutable as $$
  select case when p_hint is null or p_hint = ''
                or p_hint like 'Grant the required privileges to the current role with:%'
              then '-' else p_hint end
$$;
-- One statement as p_as with p_sub's claims, then ALWAYS undone (0415's
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
  if v_state = 'XX404' then
    return 'ok:' || v_n::text || coalesce(':' || v_seen, '');
  end if;
  return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
end $$;
-- The receipt call text: one line of po_line p_line, p_qty accepted.
create function pg_temp.rcpt_sql(p_po uuid, p_wh uuid, p_line uuid, p_qty numeric, p_key text, p_hash text)
returns text language sql immutable as $$
  select format($q$select (public.post_receipt_v2(%L, %L, jsonb_build_array(jsonb_build_object(
                    'po_line_id', %L, 'qty_received', %s, 'qty_accepted', %s, 'qty_rejected', 0, 'unit_cost', 1)), %L, %L, null)).id$q$,
                p_po, p_wh, p_line, p_qty, p_qty, p_key, p_hash)
$$;
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
-- A definition with every line tagged '-- 0464' removed: the body as it was
-- before 0464 (P4 proves it by md5). 0466 later added lines tagged '-- 0466'
-- to both bodies (each an added line only, 0466 P1); they are removed too.
create function pg_temp.pre0464(p_sig text) returns text language sql stable as $$
  select regexp_replace(pg_get_functiondef(to_regprocedure(p_sig)), E'\n[^\n]*-- (0464|0466)[^\n]*', '', 'g')
$$;
create temp table defs (k text primary key, def text not null);
insert into defs (k, def) values
  ('rcpt', pg_get_functiondef('ledger.post_receipt_v2(uuid,uuid,jsonb,text,text,text)'::regprocedure)),
  ('kit',  pg_get_functiondef('ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)'::regprocedure));
create temp table ids (k text primary key, id uuid);
-- The flag probe: a trigger that records, at each write to idempotency_keys,
-- whether stockpilot.idempotency_write then carries the transaction id.
-- Created here, undone with the file.
create temp table flag_seen (n serial, op text, scope text, carries_xid boolean);
grant insert on flag_seen to authenticated;
grant usage on sequence flag_seen_n_seq to authenticated;
create function public._t0464_flag_probe() returns trigger language plpgsql as $$
begin
  insert into pg_temp.flag_seen (op, scope, carries_xid)
  values (tg_op, new.scope, coalesce(current_setting('stockpilot.idempotency_write', true), '') = pg_current_xact_id()::text);
  return new;
end $$;
create trigger _t0464_flag_probe before insert or update on public.idempotency_keys
  for each row execute function public._t0464_flag_probe();

-- ══ P. Posture ════════════════════════════════════════════════════════════
select is(
  (select string_agg(g.rolname || '=' || coalesce((select string_agg(x.privilege_type, ',' order by x.privilege_type)
                                                     from pg_class c, aclexplode(c.relacl) x
                                                    where c.oid = 'public.idempotency_keys'::regclass
                                                      and x.grantee = case when g.rolname = 'PUBLIC' then 0::oid
                                                                           else (select o.oid from pg_roles o where o.rolname = g.rolname) end), ''),
                     ' ' order by g.n)
     from (values (1, 'anon'), (2, 'authenticated'), (3, 'service_role'), (4, 'PUBLIC')) g(n, rolname))
  || ' colgrants=' || (select count(*) from pg_attribute a where a.attrelid = 'public.idempotency_keys'::regclass and a.attacl is not null),
  'anon= authenticated=INSERT,SELECT,UPDATE service_role=DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE PUBLIC= colgrants=0',
  'P1: idempotency_keys: anon holds nothing, authenticated holds SELECT, INSERT and UPDATE, service_role holds all eight, PUBLIC nothing, no column grant');
select is(
  (select string_agg(p.policyname || ':' || p.cmd || ':' || md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')), ' ' order by p.policyname)
     from pg_policies p where p.schemaname = 'public' and p.tablename = 'idempotency_keys'),
  'idempotency_keys_select:SELECT:eb17b677029b044445592f7722266228 idempotency_keys_write:ALL:c5ff715c8a328c17c7ec09d12d315576',
  'P2: the two idempotency_keys policies are unchanged (0013 select, 0140 write)');
select is(
  (select a.atttypid::regtype::text || '|' || (not a.attnotnull)::text || '|' || a.atthasdef::text || '|' || coalesce(a.attacl::text, '-')
          || '|' || coalesce(col_description(a.attrelid, a.attnum), '-')
     from pg_attribute a
    where a.attrelid = 'public.bundle_distributions'::regclass and a.attname = 'idempotency_key' and not a.attisdropped),
  'text|true|false|-|The retry key of the call that made this distribution (0464), set by ledger.distribute_bundle; null for a call without one and for a distribution made before 0464.',
  'P3: bundle_distributions.idempotency_key is a nullable text column with no default and no column grant');
select is(
  -- Re-pinned by 0466 (was kit f0fac64f, rcpt ecd99069): 0466 added lines tagged
  -- -- 0466 to both bodies (0466 P1); they are removed with this file's own.
  (select string_agg(v.k || '=' || md5(p.prosrc) || '|' || md5(regexp_replace(p.prosrc, E'\n[^\n]*-- (0464|0466)[^\n]*', '', 'g'))
                     || '|' || (select count(*) from regexp_matches(p.prosrc, '-- 0464', 'g'))::text, ' ' order by v.k)
     from (values ('kit',  'ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)'),
                  ('rcpt', 'ledger.post_receipt_v2(uuid,uuid,jsonb,text,text,text)')) v(k, sig)
     join pg_proc p on p.oid = v.sig::regprocedure),
  'kit=52aa32489d62af5c89355b67f6493ea3|ebe22d594c11813464c7d50accae54a7|17 rcpt=43d8753704c547012befef950747b965|f044c3a1ea7b125a094a42f736db77c8|12',
  'P4: each body is 0464''s text, and removing its lines tagged -- 0464 (17 and 12) gives the live pre-0464 body exactly (ebe22d59, f044c3a1): the added lines are the only change');
select is(
  (select string_agg(p.oid::regprocedure::text || ':' || p.prosecdef::text || ':' || p.proconfig::text || ':' || pg_get_userbyid(p.proowner)
                     || ':' || has_function_privilege('anon', p.oid, 'execute')::text
                     || ':' || has_function_privilege('authenticated', p.oid, 'execute')::text
                     || ':' || has_function_privilege('service_role', p.oid, 'execute')::text
                     || ':' || (obj_description(p.oid, 'pg_proc') is not null)::text, ' ' order by p.proname)
     from pg_proc p
    where p.oid in ('ledger.post_receipt_v2(uuid,uuid,jsonb,text,text,text)'::regprocedure,
                    'ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)'::regprocedure)),
  'ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text):false:{search_path=public}:postgres:false:true:true:true '
  'ledger.post_receipt_v2(uuid,uuid,jsonb,text,text,text):false:{"search_path=public, extensions"}:postgres:false:true:true:true',
  'P5: both bodies stay SECURITY INVOKER with their search_path, owner, comment and EXECUTE (authenticated and service_role, not anon)');
select is(
  (select string_agg(v.k || '=' || (select string_agg(case when m[1] = 'pg_current_xact_id()::text' then 'raise' when m[1] = 'coalesce(v_idem_prev, '''')' then 'restore' else m[1] end, ',')
                                      from regexp_matches(p.prosrc, $r$set_config\('stockpilot\.idempotency_write', ([^;]+), true\);$r$, 'g') m)
                     || '|' || (select count(*) from regexp_matches(p.prosrc, 'stockpilot\.', 'g'))::text
                     || '|' || (p.prosrc ~ $r$v_idem_prev\s+text := current_setting\('stockpilot\.idempotency_write', true\);$r$)::text, ' ' order by v.k)
     from (values ('kit',  'ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)'),
                  ('rcpt', 'ledger.post_receipt_v2(uuid,uuid,jsonb,text,text,text)')) v(k, sig)
     join pg_proc p on p.oid = v.sig::regprocedure),
  'kit=raise,restore,raise,restore|5|true rcpt=raise,restore|3|true',
  'P6: each body raises stockpilot.idempotency_write to the transaction id and puts back the value it read on entry, once around each key write (kit: the insert and the update; receipt: the insert), and names no other stockpilot setting');
select ok(
  (select position('po_line_items_not_orderable(v_org, array[v_item_id])' in p.prosrc) > 0
          and position($t$hint = 'po_line_bundle'$t$ in p.prosrc) > 0
     from pg_proc p where p.oid = 'ledger.post_receipt_v2(uuid,uuid,jsonb,text,text,text)'::regprocedure),
  'P7: the receipt body still carries 0366''s kit-stock refusal');
-- 0383 Z2 and 0385 Z2 pin a fingerprint of every ledger.* function (their
-- query, verbatim): it moves from the pre-0464 pin by the two bodies alone.
create function pg_temp.ledger_fp() returns text language sql stable as $$
  select md5(string_agg(p.oid::regprocedure::text || '|' || md5(p.prosrc) || '|' || p.prosecdef || '|' || coalesce(p.proconfig::text, '') || '|' || pg_get_userbyid(p.proowner) || '|' || coalesce(p.proacl::text, ''), E'\n' order by p.oid::regprocedure::text)) || '|' || count(*)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'ledger'
$$;
create function pg_temp.ledger_fp_pre0464() returns text language plpgsql as $$
declare v text;
begin
  begin
    execute pg_temp.pre0464('ledger.post_receipt_v2(uuid,uuid,jsonb,text,text,text)');
    execute pg_temp.pre0464('ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)');
    v := pg_temp.ledger_fp();
    raise exception using errcode = 'XX404', message = 'undo';
  exception when sqlstate 'XX404' then
    null;
  end;
  return v;
end $$;
-- Re-pinned by 0466 (was ee07dd0a0c69b01b77f39c5791aea9e4|18 / the same second
-- value): 0466 added tagged lines to the same two bodies (0466 P2).
select is(
  pg_temp.ledger_fp() || ' / ' || pg_temp.ledger_fp_pre0464(),
  '7e62f415c0fee59d829acffae47f602c|18 / cfc031524c8052a69fceab91be550768|18',
  'P8: the ledger.* fingerprint 0383 Z2 and 0385 Z2 pin is 7e62f415|18 after 0464 and 0466, and with the two bodies taken back to their pre-0464 text it is the pre-0464 pin (cfc03152|18) exactly: nothing else in ledger moved');

-- ══ R. Receipts ═══════════════════════════════════════════════════════════
insert into ids (k, id) values ('r1',  pg_temp.keep(:mgr, pg_temp.rcpt_sql(:po1, :whA, :l1, 2, 'rk-1', 'h-1'))::uuid);
insert into ids (k, id) values ('r1b', pg_temp.keep(:mgr, pg_temp.rcpt_sql(:po1, :whA, :l1, 2, 'rk-1', 'h-1'))::uuid);
insert into ids (k, id) values ('r2',  pg_temp.keep(:mgr, pg_temp.rcpt_sql(:po2, :whA, :l2, 1, 'rk-2', 'h-2'))::uuid);
insert into ids (k, id) values ('r3',  pg_temp.keep(:mgr, pg_temp.rcpt_sql(:po1, :whA2, :l1, 1, 'rk-3', 'h-1'))::uuid);
select is(
  (select (select id from ids where k = 'r1b') = (select id from ids where k = 'r1'))::text
  || '|' || (select count(*) from public.receipts where purchase_order_id = :po1 and idempotency_key = 'rk-1')
  || '|' || (select quantity_on_hand from public.inventory_items where id = :itR)::int
  || '|' || (select count(*) from public.idempotency_keys where organization_id = :org and scope = 'receipt'),
  'true|1|4|3',
  'R1: a receipt post and its replay give one receipt, and stock is received once (2 + 1 + 1 from the three keys)');
select is(
  pg_temp.attempt('authenticated', :mgr, pg_temp.rcpt_sql(:po1, :whA, :l1, 3, 'rk-1', 'h-1-edited')),
  '55000:-:idempotency_conflict',
  'R2: the same key with edited lines is refused 55000 idempotency_conflict');
-- Every term of the match, one at a time (each fixture change made by the
-- superuser and undone).
select is(
  pg_temp.attempt('authenticated', :mgr, pg_temp.rcpt_sql(:po1, :whA, :l1, 2, 'rk-1', 'h-1'),
    format($p$update public.idempotency_keys set resource_id = %L where organization_id = %L and scope = 'receipt' and key = 'rk-1'$p$,
           (select id from ids where k = 'r2'), :org)) || ' / '
  || pg_temp.attempt('authenticated', :mgr, pg_temp.rcpt_sql(:po1, :whA, :l1, 2, 'rk-1', 'h-1'),
    format($p$update public.idempotency_keys set resource_id = %L where organization_id = %L and scope = 'receipt' and key = 'rk-1'$p$,
           (select id from ids where k = 'r3'), :org)) || ' / '
  || pg_temp.attempt('authenticated', :mgr, pg_temp.rcpt_sql(:po1, :whA, :l1, 2, 'rk-1', 'h-1'),
    format($p$update public.idempotency_keys set resource_id = %L where organization_id = %L and scope = 'receipt' and key = 'rk-1'$p$,
           :gone, :org)),
  '55000:-:idempotency_conflict / 55000:-:idempotency_conflict / 55000:-:idempotency_conflict',
  'R3: a replay is answered only with the receipt of this purchase order, warehouse and key: under the key another purchase order''s receipt, another warehouse''s or none answers 55000 idempotency_conflict');
select is(
  (select string_agg(v.col || '=' || pg_temp.attempt('authenticated', :mgr, pg_temp.rcpt_sql(:po1, :whA, :l1, 2, 'rk-1', 'h-1'),
                                                      format('update public.receipts set %s where id = %L', v.sets, (select id from ids where k = 'r1'))),
                     ' ' order by v.n)
     from (values (1, 'organization_id',   format('organization_id = %L', :orgB)),
                  (2, 'purchase_order_id', format('purchase_order_id = %L', :po2)),
                  (3, 'warehouse_id',      format('warehouse_id = %L', :whA2)),
                  (4, 'idempotency_key',   $s$idempotency_key = 'rk-other'$s$),
                  (5, 'received_by',       format('received_by = %L', :mgr2)),
                  (6, 'immutable_hash',    $s$immutable_hash = md5('other')$s$)) v(n, col, sets)),
  'organization_id=55000:-:idempotency_conflict purchase_order_id=55000:-:idempotency_conflict warehouse_id=55000:-:idempotency_conflict '
  'idempotency_key=55000:-:idempotency_conflict received_by=55000:-:idempotency_conflict immutable_hash=55000:-:idempotency_conflict',
  'R4: a replay is answered only with a receipt of this organization, purchase order and warehouse that carries this key, was received by the caller and carries this request''s hash: each term alone answers 55000');
select is(
  pg_temp.attempt('authenticated', :mgr, pg_temp.rcpt_sql(:po1, :whA, :l1, 9, 'rk-1', 'h-9'),
    format($p$update public.idempotency_keys set request_hash = 'h-9' where organization_id = %L and scope = 'receipt' and key = 'rk-1'$p$, :org)),
  '55000:-:idempotency_conflict',
  'R5: a replay is answered only with a receipt that carries this request''s own hash, whatever the key row holds: other lines under the same key answer 55000');
select is(
  pg_temp.attempt('authenticated', :mgr2, pg_temp.rcpt_sql(:po1, :whA, :l1, 2, 'rk-1', 'h-1')) || ' / '
  || pg_temp.attempt('authenticated', :stf, pg_temp.rcpt_sql(:po1, :whA, :l1, 2, 'rk-1', 'h-1')),
  '55000:-:idempotency_conflict / P0002:-:po_not_found',
  'R6: the same key and lines sent by another manager are refused 55000; a staff member is refused as before (the purchase order is not theirs to receive: P0002)');
select is(
  pg_temp.attempt('authenticated', :mgr, pg_temp.rcpt_sql(:po1, :whA, :lK, 1, 'rk-kit', 'h-kit')),
  '22023:po_line_bundle:"Reading Kit 0464" is a pre-assembled kit, so it can''t be received: receiving it would add kits without using any of their components. Leave this line at 0 and receive the rest; kits are built from their components.',
  'R7: a line for a kit''s pre-assembled stock is still refused 22023 po_line_bundle (0366)');
-- A receipt posted by the pre-0464 body, replayed by 0464's.
do $$ begin execute pg_temp.pre0464('ledger.post_receipt_v2(uuid,uuid,jsonb,text,text,text)'); end $$;
select is(md5(prosrc), 'f044c3a1ea7b125a094a42f736db77c8', 'R8a: the receipt body is the pre-0464 one for the next post')
  from pg_proc where oid = 'ledger.post_receipt_v2(uuid,uuid,jsonb,text,text,text)'::regprocedure;
-- (0466's guard on idempotency_keys is off for this one post: the pre-0464 body
-- writes its key row without the flag.)
alter table public.idempotency_keys disable trigger trg_zz_idempotency_keys_guard;
insert into ids (k, id) values ('rOld', pg_temp.keep(:mgr, pg_temp.rcpt_sql(:po2, :whA, :l2, 1, 'rk-old', 'h-old'))::uuid);
alter table public.idempotency_keys enable trigger trg_zz_idempotency_keys_guard;
do $$ begin execute (select def from pg_temp.defs where k = 'rcpt'); end $$;
select is(
  (select md5(prosrc) from pg_proc where oid = 'ledger.post_receipt_v2(uuid,uuid,jsonb,text,text,text)'::regprocedure)
  || '|' || (pg_temp.keep(:mgr, pg_temp.rcpt_sql(:po2, :whA, :l2, 1, 'rk-old', 'h-old'))::uuid = (select id from ids where k = 'rOld'))::text
  || '|' || (select count(*) from public.receipts where idempotency_key = 'rk-old'),
  '43d8753704c547012befef950747b965|true|1',
  'R8: a receipt posted by the pre-0464 body is answered by 0464''s body (as 0466 restates it) on replay');
-- A reversed receipt still replays to itself.
select lives_ok(
  format($s$select pg_temp.keep(%L, format('select public.reverse_receipt(%%L, %%L)::text', %L::uuid, 'test reversal 0464'))$s$,
         :mgr, (select id from ids where k = 'r2')),
  'R9a: the second receipt is reversed');
select is(
  (select status from public.receipts where id = (select id from ids where k = 'r2'))
  || '|' || (pg_temp.keep(:mgr, pg_temp.rcpt_sql(:po2, :whA, :l2, 1, 'rk-2', 'h-2'))::uuid = (select id from ids where k = 'r2'))::text,
  'reversed|true',
  'R9: a reversed receipt still answers its own replay');

-- ══ K. Kits ═══════════════════════════════════════════════════════════════
create function pg_temp.kit_sql(p_qty numeric, p_key text, p_wh uuid default '04640000-0000-0000-0000-0000000000c1',
                                p_short boolean default false, p_event uuid default null)
returns text language sql immutable as $$
  select format('select public.distribute_bundle(%L, %s, %L, %L, %L, null, %L)::text',
                '04640000-0000-0000-0000-0000000000f1', p_qty, p_wh, p_short, p_event, p_key)
$$;
insert into ids (k, id) values ('d1',  pg_temp.keep(:mgr, pg_temp.kit_sql(1, 'kk-1'))::uuid);
insert into ids (k, id) values ('d1b', pg_temp.keep(:mgr, pg_temp.kit_sql(1, 'kk-1'))::uuid);
select is(
  ((select id from ids where k = 'd1b') = (select id from ids where k = 'd1'))::text
  || '|' || (select idempotency_key from public.bundle_distributions where id = (select id from ids where k = 'd1'))
  || '|' || (select count(*) from public.bundle_distributions where bundle_id = :bn)
  || '|' || (select string_agg(quantity_on_hand::int::text, '/' order by sku) from public.inventory_items where id in (:itC1, :itC2)),
  'true|kk-1|1|99/98',
  'K1: a keyed hand-out stores its key on the distribution, and its replay answers that distribution with the components drawn once');
insert into ids (k, id) values ('d2', pg_temp.keep(:mgr, pg_temp.kit_sql(1, 'kk-2'))::uuid);
insert into ids (k, id) values ('d3', pg_temp.keep(:mgr, pg_temp.kit_sql(1, null))::uuid);
select is(
  pg_temp.attempt('authenticated', :mgr, pg_temp.kit_sql(1, 'kk-1'),
    format($p$update public.idempotency_keys set resource_id = %L where organization_id = %L and scope = 'bundle_distribution' and key = 'kk-1'$p$,
           (select id from ids where k = 'd2'), :org)),
  '55000:-:idempotency_conflict',
  'K2: a replay is answered only with the distribution made under this key: another one of the same kit, warehouse, quantity and person, made under another key, answers 55000');
select is(
  pg_temp.attempt('authenticated', :mgr, pg_temp.kit_sql(1, 'kk-1'),
    format($p$update public.idempotency_keys set resource_id = %L where organization_id = %L and scope = 'bundle_distribution' and key = 'kk-1';
              update public.bundle_distributions set distributed_at = distributed_at - interval '1 minute' where id = %L$p$,
           (select id from ids where k = 'd3'), :org, (select id from ids where k = 'd3'))),
  '55000:-:idempotency_conflict',
  'K3: a distribution with no key is answered only when it was made with the key row: one made at another time answers 55000');
select is(
  (select string_agg(v.col || '=' || pg_temp.attempt('authenticated', :mgr, pg_temp.kit_sql(1, 'kk-1'),
                                                      format('update public.bundle_distributions set %s where id = %L', v.sets, (select id from ids where k = 'd1'))),
                     ' ' order by v.n)
     from (values (1, 'organization_id', format('organization_id = %L', :orgB)),
                  (7, 'bundle_id',       format('bundle_id = %L', :bn2)),
                  (2, 'warehouse_id',    format('warehouse_id = %L', :whA2)),
                  (3, 'quantity',        'quantity = 2'),
                  (4, 'distributed_by',  format('distributed_by = %L', :mgr2)),
                  (5, 'idempotency_key', $s$idempotency_key = 'kk-other'$s$),
                  (6, 'no key, other time', $s$idempotency_key = null, distributed_at = distributed_at - interval '1 second'$s$)) v(n, col, sets)),
  'organization_id=55000:-:idempotency_conflict warehouse_id=55000:-:idempotency_conflict quantity=55000:-:idempotency_conflict '
  'distributed_by=55000:-:idempotency_conflict idempotency_key=55000:-:idempotency_conflict no key, other time=55000:-:idempotency_conflict '
  'bundle_id=55000:-:idempotency_conflict',
  'K4: a replay is answered only with a distribution of this organization, kit, warehouse and quantity, handed out by the caller, that carries this key (or, carrying none, was made with the key row): each term alone answers 55000');
select is(
  pg_temp.attempt('authenticated', :mgr, pg_temp.kit_sql(1, 'kk-1'),
    format('update public.bundle_distributions set bundle_id = %L where id = %L', :bn, (select id from ids where k = 'd1'))),
  'ok:1',
  'K4b: control: the same update with nothing changed still replays');
select is(
  pg_temp.attempt('authenticated', :mgr2, pg_temp.kit_sql(1, 'kk-1')) || ' / '
  || pg_temp.attempt('authenticated', :mgr, pg_temp.kit_sql(2, 'kk-1')) || ' / '
  || pg_temp.attempt('authenticated', :mgr, pg_temp.kit_sql(1, 'kk-1', :whA2)) || ' / '
  || pg_temp.attempt('authenticated', :mgr, pg_temp.kit_sql(1, 'kk-1', :whA, true)) || ' / '
  || pg_temp.attempt('authenticated', :mgr, pg_temp.kit_sql(1, 'kk-1', :whA, false, :ev)),
  '55000:-:idempotency_conflict / 55000:-:idempotency_conflict / 55000:-:idempotency_conflict / 55000:-:idempotency_conflict / 55000:-:idempotency_conflict',
  'K5: the same key sent by another manager, or with another quantity, warehouse, shortage flag or event, is refused 55000');
select is(
  pg_temp.attempt('authenticated', :mgr, pg_temp.kit_sql(1, 'kk-1'),
    format($p$update public.idempotency_keys set status = 'in_progress' where organization_id = %L and scope = 'bundle_distribution' and key = 'kk-1'$p$, :org)),
  '55000:-:idempotency_conflict',
  'K6: a key that did not complete answers 55000, as before');
-- Keyless sends: new each time, no key row, no key stored.
insert into ids (k, id) values ('d4', pg_temp.keep(:mgr, pg_temp.kit_sql(1, null))::uuid);
select is(
  ((select id from ids where k = 'd4') <> (select id from ids where k = 'd3'))::text
  || '|' || (select count(*) from public.bundle_distributions where id in ((select id from ids where k = 'd3'), (select id from ids where k = 'd4')) and idempotency_key is null)
  || '|' || (select count(*) from public.idempotency_keys where organization_id = :org and scope = 'bundle_distribution'),
  'true|2|2',
  'K7: keyless hand-outs are new each time, store no key and write no key row (the two key rows are kk-1 and kk-2)');
-- A five-decimal quantity is stored at the column's scale and still replays.
insert into ids (k, id) values ('d5',  pg_temp.keep(:mgr, pg_temp.kit_sql(2.12345, 'kk-5'))::uuid);
insert into ids (k, id) values ('d5b', pg_temp.keep(:mgr, pg_temp.kit_sql(2.12345, 'kk-5'))::uuid);
select is(
  ((select id from ids where k = 'd5b') = (select id from ids where k = 'd5'))::text
  || '|' || (select quantity::text from public.bundle_distributions where id = (select id from ids where k = 'd5')),
  'true|2.1235',
  'K8: a five-decimal quantity is stored as 2.1235 and its replay answers the same distribution');
-- A distribution made by the pre-0464 body (no key stored), whose key row the
-- same call wrote, replays under 0464's body.
do $$ begin execute pg_temp.pre0464('ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)'); end $$;
select is(md5(prosrc), 'ebe22d594c11813464c7d50accae54a7', 'K9a: the kit body is the pre-0464 one for the next hand-out')
  from pg_proc where oid = 'ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)'::regprocedure;
alter table public.idempotency_keys disable trigger trg_zz_idempotency_keys_guard;
insert into ids (k, id) values ('dOld', pg_temp.keep(:mgr, pg_temp.kit_sql(1, 'kk-old'))::uuid);
alter table public.idempotency_keys enable trigger trg_zz_idempotency_keys_guard;
do $$ begin execute (select def from pg_temp.defs where k = 'kit'); end $$;
select is(
  (select md5(prosrc) from pg_proc where oid = 'ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)'::regprocedure)
  || '|' || coalesce((select idempotency_key from public.bundle_distributions where id = (select id from ids where k = 'dOld')), 'null')
  || '|' || ((select d.distributed_at from public.bundle_distributions d where d.id = (select id from ids where k = 'dOld'))
             = (select k.created_at from public.idempotency_keys k where k.organization_id = :org and k.scope = 'bundle_distribution' and k.key = 'kk-old'))::text
  || '|' || (pg_temp.keep(:mgr, pg_temp.kit_sql(1, 'kk-old'))::uuid = (select id from ids where k = 'dOld'))::text
  || '|' || (select count(*) from public.bundle_distributions where bundle_id = :bn),
  '52aa32489d62af5c89355b67f6493ea3|null|true|true|6',
  'K9: a distribution made by the pre-0464 body carries no key and the time of its key row, and 0464''s body (as 0466 restates it) answers its replay with it');
select is(
  pg_temp.attempt('authenticated', :mgr, pg_temp.kit_sql(1, 'kk-old'),
    format('update public.bundle_distributions set distributed_at = distributed_at - interval ''1 second'' where id = %L', (select id from ids where k = 'dOld'))),
  '55000:-:idempotency_conflict',
  'K9b: a pre-0464 distribution is answered only at the time of its key row: at another time it answers 55000');
-- The Schedule's completion path: no key, the event named.
select is(
  pg_temp.attempt('authenticated', :mgrD,
    format($q$select public.distribute_bundle(%L, 1, %L, true, %L, 'Auto-distributed on event completion')$q$, :bn, :whA, :ev), null,
    format($c$select count(*)::text || '|' || count(*) filter (where idempotency_key is null)::text
                || '|' || (select count(*) from public.idempotency_keys where organization_id = %L and scope = 'bundle_distribution')::text
               from public.bundle_distributions where schedule_event_id = %L$c$, :org, :ev)),
  'ok:1:1|1|4',
  'K10: the Schedule''s completion of an event hands out its kit with no key (one distribution, no key stored, no key row added)');

-- ══ D. Direct access by API roles ═════════════════════════════════════════
select is(
  pg_temp.attempt('authenticated', :mgr, format($s$delete from public.idempotency_keys where organization_id = %L and key = 'rk-1'$s$, :org)) || ' / '
  || pg_temp.attempt('authenticated', :mgr, 'truncate public.idempotency_keys') || ' / '
  || pg_temp.attempt('anon', null, 'select count(*) from public.idempotency_keys') || ' / '
  || pg_temp.attempt('anon', null, format($s$insert into public.idempotency_keys (organization_id, scope, key, request_hash) values (%L, 'receipt', 'anon-0464', 'x')$s$, :org),
                     'drop trigger _t0464_flag_probe on public.idempotency_keys'),
  '42501:-:permission denied for table idempotency_keys / 42501:-:permission denied for table idempotency_keys / '
  '42501:-:permission denied for table idempotency_keys / 42501:-:permission denied for table idempotency_keys',
  'D1: a manager''s DELETE and TRUNCATE, and anon''s read and write, of idempotency_keys are refused 42501');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select 1 from public.idempotency_keys where organization_id = %L', :org)) || ' / '
  || pg_temp.attempt('authenticated', :mgr, format('select 1 from public.idempotency_keys where organization_id = %L', :orgB),
                     format($p$insert into public.idempotency_keys (organization_id, scope, key, request_hash) values (%L, 'receipt', 'b-0464', 'x')$p$, :orgB)),
  'ok:8 / ok:0',
  'D2: a manager still reads the organization''s key rows (eight: four receipt keys, four kit keys) and none of another organization''s');

-- ══ F. The flag ═══════════════════════════════════════════════════════════
truncate pg_temp.flag_seen;
select is(
  pg_temp.attempt('authenticated', :mgr, pg_temp.rcpt_sql(:po1, :whA, :l1, 1, 'rk-f', 'h-f'),
    $p$select set_config('stockpilot.idempotency_write', 'outer value', true)$p$,
    $c$select (select string_agg(op || ':' || scope || ':' || carries_xid::text, ',' order by n) from pg_temp.flag_seen)
              || '|' || coalesce(current_setting('stockpilot.idempotency_write', true), 'unset')$c$) || ' / '
  || pg_temp.attempt('authenticated', :mgr, pg_temp.kit_sql(1, 'kk-f'),
    $p$select set_config('stockpilot.idempotency_write', 'outer value', true)$p$,
    $c$select (select string_agg(op || ':' || scope || ':' || carries_xid::text, ',' order by n) from pg_temp.flag_seen)
              || '|' || coalesce(current_setting('stockpilot.idempotency_write', true), 'unset')$c$),
  'ok:1:INSERT:receipt:true|outer value / ok:1:INSERT:bundle_distribution:true,UPDATE:bundle_distribution:true|outer value',
  'F1: at each key write the flag carries the transaction id, and afterwards the value it had before the call is back');
select is(
  pg_temp.attempt('authenticated', :mgr, pg_temp.kit_sql(1, 'kk-g'), null,
    $c$select coalesce(current_setting('stockpilot.idempotency_write', true), 'unset')$c$),
  'ok:1:',
  'F2: with no value before the call, the flag is empty after it');
select is(
  pg_temp.attempt('authenticated', :mgr, pg_temp.kit_sql(1, null), null,
    $c$select count(*)::text from pg_temp.flag_seen$c$) || ' / '
  || pg_temp.attempt('authenticated', :mgr, pg_temp.kit_sql(1, 'kk-1'), null,
    $c$select count(*)::text from pg_temp.flag_seen$c$),
  'ok:1:0 / ok:1:0',
  'F3: a keyless hand-out and a replay write no key row');

select * from finish();
rollback;
