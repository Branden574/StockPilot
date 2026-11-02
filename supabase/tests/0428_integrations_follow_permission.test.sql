-- supabase/tests/0428_integrations_follow_permission.test.sql
-- pgTAP proof for migration 0428 (docket S27, part b): the integration tables
-- follow the Manage integrations and Manage shipping permissions, and a
-- connection row's Vault pointer and identity are written only through the
-- app's checked path.
--
-- S.  Structure:
--     S1  the policies on the six tables are exactly the five new rules and
--         the four member read rules;
--     S2  none of them names a role helper (has_org_role) or a per-row
--         has_permission, and each new rule reads rls_orgs_with_permission
--         with its key(s);
--     S3  the four member read rules are unchanged;
--     S4  the five new rules' text is pinned;
--     S5  org_connections carries the guard trigger, enabled, BEFORE INSERT
--         OR UPDATE, FOR EACH ROW, beside its three triggers;
--     S6  the guard function's posture (invoker, plpgsql, empty search_path,
--         owner postgres); S7 no EXECUTE for PUBLIC, anon or authenticated;
--     S8  has_permission and rls_orgs_with_permission are unchanged;
--     S9  the plans run the hashed set, never a per-row resolver;
--     S10 the reviewed comments; S11 anon reads and writes nothing.
-- E.  16 personas: for each, the connection writes (insert, upsert, update,
--     delete of the QuickBooks and the EasyPost row), the replay of failed,
--     successful and pending exports, and the webhook endpoints and
--     deliveries, as a real authenticated session (every statement undone).
-- M.  connection_mappings and carrier_shipments: members read them, nobody
--     signed in writes them.
-- T.  The guard trigger: the pointer, the row's organization, provider and
--     id; the service role is not affected; the app's own writes pass.
-- A.  The migration's own preflight and lock prelude, replayed from the
--     statements the CLI recorded (0415's method).
--
-- Roles: fixtures as the test superuser. Every read or write as an API role
-- runs inside a subtransaction that is always undone (the role and claims
-- are set with set_config there), so pgTAP's own statements never run as an
-- API role. begin/rollback: nothing leaks. Namespace 527b0000.

begin;

select plan(42);

\set orgA '\'527b0000-0000-0000-0000-00000000000a\''
\set orgB '\'527b0000-0000-0000-0000-00000000000b\''
\set orgC '\'527b0000-0000-0000-0000-00000000000c\''
-- Connections: QuickBooks and EasyPost in A, B and C, Sage Intacct in A.
\set aqb '\'527b0000-0000-0000-0000-00000000a001\''
\set aep '\'527b0000-0000-0000-0000-00000000a002\''
\set asi '\'527b0000-0000-0000-0000-00000000a003\''
\set bqb '\'527b0000-0000-0000-0000-00000000b001\''
\set bep '\'527b0000-0000-0000-0000-00000000b002\''
\set cqb '\'527b0000-0000-0000-0000-00000000c001\''
\set cep '\'527b0000-0000-0000-0000-00000000c002\''
-- Vault pointers (opaque ids; no secret is stored by this test).
\set sAqb '\'527b0000-0000-0000-0000-0000000005a1\''
\set sAep '\'527b0000-0000-0000-0000-0000000005a2\''
\set sAsi '\'527b0000-0000-0000-0000-0000000005a3\''
\set sBqb '\'527b0000-0000-0000-0000-0000000005b1\''
\set sBep '\'527b0000-0000-0000-0000-0000000005b2\''
\set sCqb '\'527b0000-0000-0000-0000-0000000005c1\''
\set sCep '\'527b0000-0000-0000-0000-0000000005c2\''
\set whA  '\'527b0000-0000-0000-0000-0000000007a1\''
\set ordA '\'527b0000-0000-0000-0000-0000000008a1\''

-- Personas, by the last two digits of their ids:
--   01 owner of A
--   02 admin of A
--   03 admin of A whose own Manage integrations is taken away
--   04 admin of A whose own Manage shipping is taken away
--   05 manager of A given Manage integrations
--   06 manager of A given Manage shipping
--   07 manager of A, no grant        08 staff of A        09 viewer of A
--   10 disabled admin of A           11 expired Act-as admin seat in A
--   12 admin of A invited, not accepted
--   13 admin of C, where the admin role's Manage integrations is taken away
--   14 admin of C, same role, given Manage integrations back on their own
--   15 admin of B (another organization)
--   16 admin of A and admin of B
\set p01 '\'527b0000-0000-0000-0000-000000000101\''
\set p02 '\'527b0000-0000-0000-0000-000000000102\''
\set p03 '\'527b0000-0000-0000-0000-000000000103\''
\set p04 '\'527b0000-0000-0000-0000-000000000104\''
\set p05 '\'527b0000-0000-0000-0000-000000000105\''
\set p06 '\'527b0000-0000-0000-0000-000000000106\''
\set p07 '\'527b0000-0000-0000-0000-000000000107\''
\set p08 '\'527b0000-0000-0000-0000-000000000108\''
\set p09 '\'527b0000-0000-0000-0000-000000000109\''
\set p10 '\'527b0000-0000-0000-0000-000000000110\''
\set p11 '\'527b0000-0000-0000-0000-000000000111\''
\set p12 '\'527b0000-0000-0000-0000-000000000112\''
\set p13 '\'527b0000-0000-0000-0000-000000000113\''
\set p14 '\'527b0000-0000-0000-0000-000000000114\''
\set p15 '\'527b0000-0000-0000-0000-000000000115\''
\set p16 '\'527b0000-0000-0000-0000-000000000116\''

insert into auth.users (id, email, raw_user_meta_data)
  select ('527b0000-0000-0000-0000-0000000001' || lpad(g::text, 2, '0'))::uuid,
         'person' || g || '@s27b.test', '{}'::jsonb
    from generate_series(1, 16) g;
insert into public.organizations (id, name, slug) values
  (:orgA, 'S27b Org A', 's27b-org-a'),
  (:orgB, 'S27b Org B', 's27b-org-b'),
  (:orgC, 'S27b Org C', 's27b-org-c');
insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at) values
  (:orgA, :p01, 'owner',   now(), null),
  (:orgA, :p02, 'admin',   now(), null),
  (:orgA, :p03, 'admin',   now(), null),
  (:orgA, :p04, 'admin',   now(), null),
  (:orgA, :p05, 'manager', now(), null),
  (:orgA, :p06, 'manager', now(), null),
  (:orgA, :p07, 'manager', now(), null),
  (:orgA, :p08, 'staff',   now(), null),
  (:orgA, :p09, 'viewer',  now(), null),
  (:orgA, :p10, 'admin',   now(), null),
  (:orgA, :p11, 'admin',   now(), now() - interval '1 minute'),
  (:orgA, :p12, 'admin',   null,  null),
  (:orgC, :p13, 'admin',   now(), null),
  (:orgC, :p14, 'admin',   now(), null),
  (:orgB, :p15, 'admin',   now(), null),
  (:orgA, :p16, 'admin',   now(), null),
  (:orgB, :p16, 'admin',   now(), null);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :p03, 'integrations:manage', false),
  (:orgA, :p04, 'shipping:manage',     false),
  (:orgA, :p05, 'integrations:manage', true),
  (:orgA, :p06, 'shipping:manage',     true),
  (:orgC, :p14, 'integrations:manage', true);
insert into public.role_permission_overrides (organization_id, role, permission, granted) values
  (:orgC, 'admin', 'integrations:manage', false);
set local role to 'service_role';
update public.user_profiles set disabled_at = now(), disabled_reason = 'policy_violation' where id = :p10;
reset role;

insert into public.org_connections (id, organization_id, provider_id, status, secret_id, created_by) values
  (:aqb, :orgA, 'quickbooks',   'active', :sAqb, :p02),
  (:aep, :orgA, 'easypost',     'active', :sAep, :p02),
  (:asi, :orgA, 'sage_intacct', 'active', :sAsi, :p02),
  (:bqb, :orgB, 'quickbooks',   'active', :sBqb, :p15),
  (:bep, :orgB, 'easypost',     'active', :sBep, :p15),
  (:cqb, :orgC, 'quickbooks',   'active', :sCqb, :p13),
  (:cep, :orgC, 'easypost',     'active', :sCep, :p13);
-- One export in each state, in A and in C.
with ev as (
  insert into public.outbox_events (organization_id, topic, aggregate_type, payload)
  select v.o, 's27b.test', 's27b', jsonb_build_object('state', s.st)
    from (values (:orgA::uuid), (:orgC::uuid)) v(o),
         unnest(array['error', 'dead', 'success', 'pending']) s(st)
  returning id, organization_id, payload ->> 'state' as st
)
insert into public.connection_sync_log (connection_id, organization_id, outbox_event_id, topic, status)
select case when ev.organization_id = :orgA::uuid then :aqb::uuid else :cqb::uuid end,
       ev.organization_id, ev.id, 's27b.test', ev.st
  from ev;
insert into public.integration_endpoints (organization_id, type, url, secret, event_types) values
  (:orgA, 'webhook', 'https://example.com/s27b-a', 'placeholder-signing-value-a', '{stock.low}'),
  (:orgC, 'webhook', 'https://example.com/s27b-c', 'placeholder-signing-value-c', '{stock.low}');
insert into public.integration_deliveries (organization_id, endpoint_id, event_type, payload)
  select e.organization_id, e.id, 'stock.low', '{}'::jsonb from public.integration_endpoints e
   where e.organization_id in (:orgA, :orgC);
insert into public.connection_mappings (connection_id, organization_id, entity_type, local_id, external_id) values
  (:aqb, :orgA, 'supplier', gen_random_uuid(), 'S27B-1');
insert into public.warehouses (id, organization_id, name, code, status, manager_user_id) values
  (:whA, :orgA, 'S27b Main', 'WH-S27B', 'active', :p02);
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id,
                                   fulfillment_type, delivery_charter_id) values
  (:ordA, :orgA, :whA, 'pending_approval', 'internal', :p08, 'pickup', null);
insert into public.carrier_shipments (organization_id, order_request_id) values (:orgA, :ordA);

-- ══ Helpers ═══════════════════════════════════════════════════════════════
-- Every statement below goes through EXECUTE, so it is planned and
-- permission-checked on each call (a simple PL/pgSQL expression keeps its
-- prepared state for the transaction: docket S49's first red run).
--
-- p_sql run as p_as ('authenticated' with p_sub's claims, 'anon' or
-- 'service_role') after p_prep (as the superuser), ALWAYS undone: the rows
-- it changed, 'R' when it was refused (42501), or 'X<SQLSTATE>'.
create function pg_temp.dml(p_sub uuid, p_sql text, p_prep text default null, p_as text default 'authenticated')
returns text language plpgsql as $$
declare v_n bigint; v_state text;
begin
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_as, true);
    perform set_config('role', p_as, true);
    execute p_sql;
    get diagnostics v_n = row_count;
    raise exception using errcode = 'XXT27', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  return case v_state when 'XXT27' then v_n::text when '42501' then 'R' else 'X' || v_state end;
end $$;
-- A count read as p_sub (authenticated, or p_as), ALWAYS undone: the count,
-- or 'X<SQLSTATE>'.
create function pg_temp.cnt(p_sub uuid, p_sql text, p_as text default 'authenticated')
returns text language plpgsql as $$
declare v text; v_state text;
begin
  begin
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_as, true);
    perform set_config('role', p_as, true);
    execute p_sql into v;
    raise exception using errcode = 'XXT27', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  return case v_state when 'XXT27' then v else 'X' || v_state end;
end $$;

-- The connection writes of p_sub in p_org: insert (the row deleted first, as
-- the superuser), upsert (the API-key connect's own write), update and
-- delete, of the QuickBooks row and of the EasyPost row.
create function pg_temp.conn(p_sub uuid, p_org uuid) returns text language plpgsql as $$
declare v text := ''; v_p text;
begin
  foreach v_p in array array['quickbooks', 'easypost'] loop
    v := v || format(' ins_%s:', left(v_p, 2)) || pg_temp.dml(p_sub,
      format('insert into public.org_connections (organization_id, provider_id, created_by) values (%L, %L, %L)', p_org, v_p, p_sub),
      format('delete from public.org_connections where organization_id = %L and provider_id = %L', p_org, v_p));
  end loop;
  foreach v_p in array array['quickbooks', 'easypost'] loop
    v := v || format(' ups_%s:', left(v_p, 2)) || pg_temp.dml(p_sub,
      format($q$insert into public.org_connections (organization_id, provider_id, created_by) values (%L, %L, %L)
                on conflict (organization_id, provider_id) do update set created_by = excluded.created_by$q$, p_org, v_p, p_sub));
  end loop;
  foreach v_p in array array['quickbooks', 'easypost'] loop
    v := v || format(' upd_%s:', left(v_p, 2)) || pg_temp.dml(p_sub,
      format($q$update public.org_connections set settings = settings || '{"s27b": 1}'::jsonb
                 where organization_id = %L and provider_id = %L$q$, p_org, v_p));
  end loop;
  foreach v_p in array array['quickbooks', 'easypost'] loop
    v := v || format(' del_%s:', left(v_p, 2)) || pg_temp.dml(p_sub,
      format('delete from public.org_connections where organization_id = %L and provider_id = %L', p_org, v_p));
  end loop;
  return btrim(v);
end $$;

-- The replays of p_sub in p_org: a failed export ('error', 'dead') back to
-- pending, a successful one to pending, a pending one again, and a failed
-- one to success.
create function pg_temp.sync(p_sub uuid, p_org uuid) returns text language plpgsql as $$
declare
  v_set text := $s$set status = 'pending', attempts = 0, next_attempt_at = null, last_error = null$s$;
begin
  return 'err:' || pg_temp.dml(p_sub, format('update public.connection_sync_log %s where organization_id = %L and status = %L', v_set, p_org, 'error'))
    || ' dead:' || pg_temp.dml(p_sub, format('update public.connection_sync_log %s where organization_id = %L and status = %L', v_set, p_org, 'dead'))
    || ' ok2pend:' || pg_temp.dml(p_sub, format('update public.connection_sync_log %s where organization_id = %L and status = %L', v_set, p_org, 'success'))
    || ' pend:' || pg_temp.dml(p_sub, format('update public.connection_sync_log %s where organization_id = %L and status = %L', v_set, p_org, 'pending'))
    || ' err2ok:' || pg_temp.dml(p_sub, format($q$update public.connection_sync_log set status = 'success'
                                                  where organization_id = %L and status = 'error'$q$, p_org));
end $$;

-- The webhook endpoints and deliveries of p_sub in p_org: an endpoint read
-- with its signing value, an insert, an update, a delete, and a delivery
-- read.
create function pg_temp.ep(p_sub uuid, p_org uuid) returns text language plpgsql as $$
begin
  return 'read:' || pg_temp.cnt(p_sub, format('select count(*) from public.integration_endpoints where organization_id = %L and secret is not null', p_org))
    || ' ins:' || pg_temp.dml(p_sub, format($q$insert into public.integration_endpoints (organization_id, type, url, event_types)
                                               values (%L, 'slack', 'https://example.com/s27b-new', '{stock.low}')$q$, p_org))
    || ' upd:' || pg_temp.dml(p_sub, format($q$update public.integration_endpoints set url = 'https://example.com/s27b-moved'
                                               where organization_id = %L$q$, p_org))
    || ' del:' || pg_temp.dml(p_sub, format('delete from public.integration_endpoints where organization_id = %L', p_org))
    || ' dlv:' || pg_temp.cnt(p_sub, format('select count(*) from public.integration_deliveries where organization_id = %L', p_org));
end $$;

-- connection_mappings and carrier_shipments in A as p_sub: read, insert,
-- update, delete of each.
create function pg_temp.side(p_sub uuid) returns text language plpgsql as $$
declare v_a uuid := '527b0000-0000-0000-0000-00000000000a';
begin
  return 'map:' || pg_temp.cnt(p_sub, format('select count(*) from public.connection_mappings where organization_id = %L', v_a))
    || '/' || pg_temp.dml(p_sub, format($q$insert into public.connection_mappings (connection_id, organization_id, entity_type, local_id, external_id)
                                          values ('527b0000-0000-0000-0000-00000000a001', %L, 'supplier', gen_random_uuid(), 'S27B-2')$q$, v_a))
    || '/' || pg_temp.dml(p_sub, format($q$update public.connection_mappings set external_id = 'S27B-3' where organization_id = %L$q$, v_a))
    || '/' || pg_temp.dml(p_sub, format('delete from public.connection_mappings where organization_id = %L', v_a))
    || ' shp:' || pg_temp.cnt(p_sub, format('select count(*) from public.carrier_shipments where organization_id = %L', v_a))
    || '/' || pg_temp.dml(p_sub, format($q$insert into public.carrier_shipments (organization_id, order_request_id)
                                          values (%L, '527b0000-0000-0000-0000-0000000008a1')$q$, v_a))
    || '/' || pg_temp.dml(p_sub, format($q$update public.carrier_shipments set carrier = 'S27B' where organization_id = %L$q$, v_a))
    || '/' || pg_temp.dml(p_sub, format('delete from public.carrier_shipments where organization_id = %L', v_a));
end $$;

-- The plan of p_sql as p_sub (authenticated), ALWAYS undone, or
-- 'X<SQLSTATE>'.
create function pg_temp.plan_as(p_sub uuid, p_sql text) returns text language plpgsql as $$
declare v text := ''; v_line text; v_state text;
begin
  begin
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', p_sub::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    perform set_config('role', 'authenticated', true);
    for v_line in execute 'explain (costs off, verbose) ' || p_sql loop
      v := v || v_line || E'\n';
    end loop;
    raise exception using errcode = 'XXT27', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  return case when v_state = 'XXT27' then v else 'X' || v_state end;
end $$;

-- The policies on the six tables, one line each, deparsed with search_path
-- pinned (so the text does not depend on the session's):
-- table.policy|command|permissive|roles|USING|CHECK.
create function pg_temp.policies() returns setof text language sql stable
  set search_path = public, extensions
as $$
  select c.relname || '.' || pol.polname || '|' || pol.polcmd::text || '|' || pol.polpermissive::text || '|'
         || (select string_agg(case x when 0 then 'public' else x::regrole::text end, ',' order by 1)
               from unnest(pol.polroles) x)
         || '|' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '-')
         || '|' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '-')
    from pg_policy pol
    join pg_class c on c.oid = pol.polrelid
   where pol.polrelid in ('public.org_connections'::regclass, 'public.connection_sync_log'::regclass,
                          'public.integration_endpoints'::regclass, 'public.integration_deliveries'::regclass,
                          'public.connection_mappings'::regclass, 'public.carrier_shipments'::regclass)
   order by c.relname, pol.polname
$$;

-- ══ S. Structure ══════════════════════════════════════════════════════════
-- S4 and S10 pin md5s of text the migration writes (the policies, deparsed by
-- pg_temp.policies(), and the comments); none of it names the migration's
-- number, so a rename leaves these values alone.
select is(
  (select string_agg(split_part(l, '|', 1) || ':' || split_part(l, '|', 2) || ':' || split_part(l, '|', 3)
                     || ':' || split_part(l, '|', 4), ', ' order by l collate "C") from pg_temp.policies() l),
  'carrier_shipments.carrier_shipments_select:r:true:authenticated, '
  'connection_mappings.connection_mappings_select:r:true:authenticated, '
  'connection_sync_log.connection_sync_log_replay:w:true:authenticated, '
  'connection_sync_log.connection_sync_log_select:r:true:authenticated, '
  'integration_deliveries.integration_deliveries_select:r:true:authenticated, '
  'integration_endpoints.integration_endpoints_manage:*:true:authenticated, '
  'org_connections.org_connections_insert:a:true:authenticated, '
  'org_connections.org_connections_select:r:true:authenticated, '
  'org_connections.org_connections_update:w:true:authenticated',
  'S1: the six tables hold exactly the five new rules and the four member read rules: no write rule on connection_mappings or carrier_shipments, and no DELETE rule on org_connections');

select is(
  (select coalesce(string_agg(split_part(l, '|', 1), ', ' order by l collate "C"), 'none') from pg_temp.policies() l
    where l ~* '\mhas_org_role\M' or l ~* '\mhas_permission\M')
  || ' | ' ||
  (select string_agg(split_part(l, '|', 1) || ':'
                     || (position('rls_orgs_with_permission(''integrations:manage''::text)' in l) > 0)::text || '/'
                     || (position('rls_orgs_with_permission(''shipping:manage''::text)' in l) > 0)::text, ', ' order by l collate "C")
     from pg_temp.policies() l
    where split_part(l, '|', 1) in ('org_connections.org_connections_insert', 'org_connections.org_connections_update',
                                    'connection_sync_log.connection_sync_log_replay',
                                    'integration_endpoints.integration_endpoints_manage',
                                    'integration_deliveries.integration_deliveries_select')),
  'none | connection_sync_log.connection_sync_log_replay:true/true, '
  'integration_deliveries.integration_deliveries_select:true/false, '
  'integration_endpoints.integration_endpoints_manage:true/false, '
  'org_connections.org_connections_insert:true/true, org_connections.org_connections_update:true/true',
  'S2: no rule on the six tables names has_org_role or a per-row has_permission; the connection and replay rules read both keys'' sets, the endpoint and delivery rules Manage integrations''');

select is(
  (select string_agg(split_part(l, '|', 1) || ':' || md5(split_part(l, '|', 5)), ', ' order by l collate "C") from pg_temp.policies() l
    where split_part(l, '|', 1) like '%\_select' and split_part(l, '|', 1) <> 'integration_deliveries.integration_deliveries_select'),
  'carrier_shipments.carrier_shipments_select:18c56f48bbf23a4726bac4b92133f24b, '
  'connection_mappings.connection_mappings_select:02fc0f5839c8fc6706548f6c9b9338da, '
  'connection_sync_log.connection_sync_log_select:b185f37e459a86cfc01b71a1e5027213, '
  'org_connections.org_connections_select:a9fb1ec37f58a25b93d2b6efc128b107',
  'S3: the four member read rules are 0146''s and 0149''s, unchanged');

select is(
  (select string_agg(split_part(l, '|', 1) || ':' || md5(l), ', ' order by l collate "C") from pg_temp.policies() l
    where split_part(l, '|', 1) in ('org_connections.org_connections_insert', 'org_connections.org_connections_update',
                                    'connection_sync_log.connection_sync_log_replay',
                                    'integration_endpoints.integration_endpoints_manage',
                                    'integration_deliveries.integration_deliveries_select')),
  'connection_sync_log.connection_sync_log_replay:b64f627d8b4e50671072a0940627f35e, '
  'integration_deliveries.integration_deliveries_select:0e8836b39e2a9f367cfa9ec00826e18c, '
  'integration_endpoints.integration_endpoints_manage:9125a9e673f70b74cf47599efacc42a6, '
  'org_connections.org_connections_insert:a689e097532cbb0955fe92b78420349c, '
  'org_connections.org_connections_update:8f6f502542d95a2191201296206aab92',
  'S4: the five new rules are exactly the migration''s text (command, roles, USING and CHECK)');

select is(
  (select string_agg(t.tgname || ':' || t.tgenabled::text || ':' || t.tgtype::text || ':' || p.proname, ', '
                     order by t.tgname)
     from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.org_connections'::regclass and not t.tgisinternal),
  'org_connections_client_guard:O:23:_guard_org_connections_client_writes, '
  'org_connections_set_updated_at:O:19:tg_set_updated_at, '
  'zzz_deleted_users_ins:O:7:tg_mark_deleted_users, zzz_deleted_users_upd:O:19:tg_mark_deleted_users',
  'S5: org_connections carries the guard trigger (enabled, BEFORE INSERT OR UPDATE, FOR EACH ROW) beside its three triggers');

select is(
  (select p.prosecdef::text || ':' || p.provolatile::text || ':' || coalesce(array_to_string(p.proconfig, ';'), '-')
          || ':' || pg_get_userbyid(p.proowner) || ':' || l.lanname || ':' || p.prorettype::regtype::text
     from pg_proc p join pg_language l on l.oid = p.prolang
    where p.oid = to_regprocedure('public._guard_org_connections_client_writes()')),
  'false:v:search_path="":postgres:plpgsql:trigger',
  'S6: the guard function is SECURITY INVOKER (current_user is the caller), plpgsql, with an empty search_path, owned by postgres');

select is(
  (select has_function_privilege('anon', p.oid, 'execute')::text || '/'
          || has_function_privilege('authenticated', p.oid, 'execute')::text || '/'
          || (p.proacl is null or exists (select 1 from unnest(p.proacl) a where a::text like '=%'))::text
     from pg_proc p where p.oid = to_regprocedure('public._guard_org_connections_client_writes()')),
  'false/false/false',
  'S7: anon and authenticated cannot execute the guard function, and no PUBLIC grant survives (0329''s rule for trigger functions)');

select is(
  (select string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc) || ':' || p.prosecdef::text || ':'
                     || has_function_privilege('authenticated', p.oid, 'execute')::text, ', ' order by p.oid::regprocedure::text)
     from pg_proc p
    where p.oid in ('public.has_permission(uuid,text)'::regprocedure, 'public.rls_orgs_with_permission(text)'::regprocedure)),
  'has_permission(uuid,text):cc0accdad7e2fdf4f88aa82aa887e85f:true:true, '
  'rls_orgs_with_permission(text):c346a5c3447b75be554030c0e505a497:true:true',
  'S8: has_permission and rls_orgs_with_permission are unchanged, definer, and executable by authenticated (the rules run as the reader)');

select is(
  (select (position('hashed SubPlan' in d) > 0)::text || '/' || (position('rls_orgs_with_permission' in d) > 0)::text || '/'
          || (d ~* '\m(has_org_role|has_permission)\M')::text
          || ' | ' || (position('hashed SubPlan' in u) > 0)::text || '/' || (position('rls_orgs_with_permission' in u) > 0)::text || '/'
          || (u ~* '\m(has_org_role|has_permission)\M')::text
     from (select pg_temp.plan_as(:p05, 'select count(*) from public.integration_deliveries') as d,
                  pg_temp.plan_as(:p05, 'update public.org_connections set settings = settings') as u) s),
  'true/true/false | true/true/false',
  'S9: a delivery read and a connection update run the hashed key set, never a per-row resolver (pattern 19)');

select is(
  (select string_agg(pol.polname || ':' || coalesce(md5(obj_description(pol.oid, 'pg_policy')), '-'), ', ' order by pol.polname)
     from pg_policy pol
    where pol.polname in ('org_connections_insert', 'org_connections_update', 'connection_sync_log_replay',
                          'integration_endpoints_manage', 'integration_deliveries_select'))
  || ' | ' || coalesce(md5(obj_description(to_regprocedure('public._guard_org_connections_client_writes()'), 'pg_proc')), '-')
  || ' | ' || coalesce((select md5(obj_description(t.oid, 'pg_trigger')) from pg_trigger t
                         where t.tgrelid = 'public.org_connections'::regclass and t.tgname = 'org_connections_client_guard'), '-'),
  'connection_sync_log_replay:c57af0c86d75c3ad7a987aee273a0eae, integration_deliveries_select:d3ac8eb8e04d5ac40fc29f57c16a4c84, '
  'integration_endpoints_manage:711b36b7a5dded857051dc133287e4bf, org_connections_insert:4b9d4051105f6fce320f01523772b399, '
  'org_connections_update:06e7311d54491e8ef818310c940d09f8 | 4f954187f98179f8c9af12d4bc8746ec | 20e96f73ac35b240af4a43b6f0c9b7b9',
  'S10: the five rules, the guard function and its trigger carry the reviewed comments');

select is(
  pg_temp.dml(null, format('insert into public.org_connections (organization_id, provider_id) values (%L, %L)', :orgA, 'zendesk'), null, 'anon')
  || '/' || pg_temp.dml(null, 'update public.org_connections set settings = settings', null, 'anon')
  || '/' || pg_temp.cnt(null, 'select count(*) from public.integration_endpoints', 'anon')
  || '/' || pg_temp.cnt(null, 'select count(*) from public.integration_deliveries', 'anon'),
  'R/0/0/0',
  'S11: anon writes and reads nothing on the integration tables');

-- ══ E. The personas ═══════════════════════════════════════════════════════
-- Each line: the connection writes | the replays | endpoints and deliveries.
--   connection: ins/ups/upd/del of the QuickBooks (qu) and EasyPost (ea) row;
--   1 = the row was written, 0 = no row passed the rule, R = refused (42501).
select is(pg_temp.conn(:p01, :orgA) || ' | ' || pg_temp.sync(:p01, :orgA) || ' | ' || pg_temp.ep(:p01, :orgA),
  'ins_qu:1 ins_ea:1 ups_qu:1 ups_ea:1 upd_qu:1 upd_ea:1 del_qu:0 del_ea:0 | err:1 dead:1 ok2pend:0 pend:0 err2ok:R | read:1 ins:1 upd:1 del:1 dlv:1',
  'E01: the owner writes both connections, replays failed exports only, and manages webhooks; nobody deletes a connection row');
select is(pg_temp.conn(:p02, :orgA) || ' | ' || pg_temp.sync(:p02, :orgA) || ' | ' || pg_temp.ep(:p02, :orgA),
  'ins_qu:1 ins_ea:1 ups_qu:1 ups_ea:1 upd_qu:1 upd_ea:1 del_qu:0 del_ea:0 | err:1 dead:1 ok2pend:0 pend:0 err2ok:R | read:1 ins:1 upd:1 del:1 dlv:1',
  'E02: an admin (both keys by default) as the owner');
select is(pg_temp.conn(:p03, :orgA) || ' | ' || pg_temp.sync(:p03, :orgA) || ' | ' || pg_temp.ep(:p03, :orgA),
  'ins_qu:R ins_ea:1 ups_qu:R ups_ea:1 upd_qu:0 upd_ea:1 del_qu:0 del_ea:0 | err:1 dead:1 ok2pend:0 pend:0 err2ok:R | read:0 ins:R upd:0 del:0 dlv:0',
  'E03: an admin whose Manage integrations is taken away writes only the EasyPost row, can still replay (Manage shipping), and reads or writes no webhook');
select is(pg_temp.conn(:p04, :orgA) || ' | ' || pg_temp.sync(:p04, :orgA) || ' | ' || pg_temp.ep(:p04, :orgA),
  'ins_qu:1 ins_ea:R ups_qu:1 ups_ea:R upd_qu:1 upd_ea:0 del_qu:0 del_ea:0 | err:1 dead:1 ok2pend:0 pend:0 err2ok:R | read:1 ins:1 upd:1 del:1 dlv:1',
  'E04: an admin whose Manage shipping is taken away writes no EasyPost row and keeps everything Manage integrations gives');
select is(pg_temp.conn(:p05, :orgA) || ' | ' || pg_temp.sync(:p05, :orgA) || ' | ' || pg_temp.ep(:p05, :orgA),
  'ins_qu:1 ins_ea:R ups_qu:1 ups_ea:R upd_qu:1 upd_ea:0 del_qu:0 del_ea:0 | err:1 dead:1 ok2pend:0 pend:0 err2ok:R | read:1 ins:1 upd:1 del:1 dlv:1',
  'E05: a manager given Manage integrations connects QuickBooks, replays and manages webhooks, and writes no EasyPost row');
select is(pg_temp.conn(:p06, :orgA) || ' | ' || pg_temp.sync(:p06, :orgA) || ' | ' || pg_temp.ep(:p06, :orgA),
  'ins_qu:R ins_ea:1 ups_qu:R ups_ea:1 upd_qu:0 upd_ea:1 del_qu:0 del_ea:0 | err:1 dead:1 ok2pend:0 pend:0 err2ok:R | read:0 ins:R upd:0 del:0 dlv:0',
  'E06: a manager given Manage shipping connects EasyPost and replays, and writes no QuickBooks row and no webhook');
select is(pg_temp.conn(:p07, :orgA) || ' | ' || pg_temp.sync(:p07, :orgA) || ' | ' || pg_temp.ep(:p07, :orgA),
  'ins_qu:R ins_ea:R ups_qu:R ups_ea:R upd_qu:0 upd_ea:0 del_qu:0 del_ea:0 | err:0 dead:0 ok2pend:0 pend:0 err2ok:0 | read:0 ins:R upd:0 del:0 dlv:0',
  'E07: a manager with neither key writes nothing');
select is(pg_temp.conn(:p08, :orgA) || ' | ' || pg_temp.sync(:p08, :orgA) || ' | ' || pg_temp.ep(:p08, :orgA),
  'ins_qu:R ins_ea:R ups_qu:R ups_ea:R upd_qu:0 upd_ea:0 del_qu:0 del_ea:0 | err:0 dead:0 ok2pend:0 pend:0 err2ok:0 | read:0 ins:R upd:0 del:0 dlv:0',
  'E08: staff write nothing');
select is(pg_temp.conn(:p09, :orgA) || ' | ' || pg_temp.sync(:p09, :orgA) || ' | ' || pg_temp.ep(:p09, :orgA),
  'ins_qu:R ins_ea:R ups_qu:R ups_ea:R upd_qu:0 upd_ea:0 del_qu:0 del_ea:0 | err:0 dead:0 ok2pend:0 pend:0 err2ok:0 | read:0 ins:R upd:0 del:0 dlv:0',
  'E09: a viewer writes nothing');
select is(pg_temp.conn(:p10, :orgA) || ' | ' || pg_temp.sync(:p10, :orgA) || ' | ' || pg_temp.ep(:p10, :orgA),
  'ins_qu:R ins_ea:R ups_qu:R ups_ea:R upd_qu:0 upd_ea:0 del_qu:0 del_ea:0 | err:0 dead:0 ok2pend:0 pend:0 err2ok:0 | read:0 ins:R upd:0 del:0 dlv:0',
  'E10: a disabled admin writes and reads nothing');
select is(pg_temp.conn(:p11, :orgA) || ' | ' || pg_temp.sync(:p11, :orgA) || ' | ' || pg_temp.ep(:p11, :orgA),
  'ins_qu:R ins_ea:R ups_qu:R ups_ea:R upd_qu:0 upd_ea:0 del_qu:0 del_ea:0 | err:0 dead:0 ok2pend:0 pend:0 err2ok:0 | read:0 ins:R upd:0 del:0 dlv:0',
  'E11: an expired Act-as admin seat writes and reads nothing');
select is(pg_temp.conn(:p12, :orgA) || ' | ' || pg_temp.sync(:p12, :orgA) || ' | ' || pg_temp.ep(:p12, :orgA),
  'ins_qu:R ins_ea:R ups_qu:R ups_ea:R upd_qu:0 upd_ea:0 del_qu:0 del_ea:0 | err:0 dead:0 ok2pend:0 pend:0 err2ok:0 | read:0 ins:R upd:0 del:0 dlv:0',
  'E12: an admin who has not accepted the invitation writes and reads nothing');
select is(pg_temp.conn(:p13, :orgC) || ' | ' || pg_temp.sync(:p13, :orgC) || ' | ' || pg_temp.ep(:p13, :orgC),
  'ins_qu:R ins_ea:1 ups_qu:R ups_ea:1 upd_qu:0 upd_ea:1 del_qu:0 del_ea:0 | err:1 dead:1 ok2pend:0 pend:0 err2ok:R | read:0 ins:R upd:0 del:0 dlv:0',
  'E13: in C, where the admin role''s Manage integrations is taken away, an admin keeps only what Manage shipping gives');
select is(pg_temp.conn(:p14, :orgC) || ' | ' || pg_temp.sync(:p14, :orgC) || ' | ' || pg_temp.ep(:p14, :orgC),
  'ins_qu:1 ins_ea:1 ups_qu:1 ups_ea:1 upd_qu:1 upd_ea:1 del_qu:0 del_ea:0 | err:1 dead:1 ok2pend:0 pend:0 err2ok:R | read:1 ins:1 upd:1 del:1 dlv:1',
  'E14: an admin of that role given Manage integrations back on their own has both keys again (the member''s override wins)');
select is(pg_temp.conn(:p15, :orgA) || ' | ' || pg_temp.sync(:p15, :orgA) || ' | ' || pg_temp.ep(:p15, :orgA),
  'ins_qu:R ins_ea:R ups_qu:R ups_ea:R upd_qu:0 upd_ea:0 del_qu:0 del_ea:0 | err:0 dead:0 ok2pend:0 pend:0 err2ok:0 | read:0 ins:R upd:0 del:0 dlv:0',
  'E15: an admin of another organization writes and reads nothing in A');
select is(pg_temp.conn(:p16, :orgA) || ' | ' || pg_temp.sync(:p16, :orgA) || ' | ' || pg_temp.ep(:p16, :orgA),
  'ins_qu:1 ins_ea:1 ups_qu:1 ups_ea:1 upd_qu:1 upd_ea:1 del_qu:0 del_ea:0 | err:1 dead:1 ok2pend:0 pend:0 err2ok:R | read:1 ins:1 upd:1 del:1 dlv:1',
  'E16: an admin of A and B has both keys in A');

-- ══ M. Mappings and carrier shipments ═════════════════════════════════════
-- map/shp: read count / insert / update / delete.
select is(
  (select string_agg(right(p::text, 2) || ' ' || pg_temp.side(p), ', ' order by p)
     from unnest(array[:p01, :p02, :p03, :p05, :p06, :p07, :p08, :p09, :p16]::uuid[]) p),
  '01 map:1/R/0/0 shp:1/R/0/0, 02 map:1/R/0/0 shp:1/R/0/0, 03 map:1/R/0/0 shp:1/R/0/0, '
  '05 map:1/R/0/0 shp:1/R/0/0, 06 map:1/R/0/0 shp:1/R/0/0, 07 map:1/R/0/0 shp:1/R/0/0, '
  '08 map:1/R/0/0 shp:1/R/0/0, 09 map:1/R/0/0 shp:1/R/0/0, 16 map:1/R/0/0 shp:1/R/0/0',
  'M1: every member reads the connection mappings and carrier shipments, and none, the owner included, writes them (only the service role does)');
select is(
  (select string_agg(right(p::text, 2) || ' ' || pg_temp.side(p), ', ' order by p)
     from unnest(array[:p10, :p11, :p12, :p15]::uuid[]) p),
  '10 map:0/R/0/0 shp:0/R/0/0, 11 map:0/R/0/0 shp:0/R/0/0, 12 map:0/R/0/0 shp:0/R/0/0, 15 map:0/R/0/0 shp:0/R/0/0',
  'M2: a disabled admin, an expired seat, an invitation and another organization''s admin read and write neither');

-- ══ T. The guard trigger ══════════════════════════════════════════════════
select is(
  pg_temp.dml(:p02, format('update public.org_connections set secret_id = %L where id = %L', :sAep, :aqb))
  || '/' || pg_temp.dml(:p05, format('update public.org_connections set secret_id = %L where id = %L', :sAep, :aqb))
  || '/' || pg_temp.dml(:p06, format('update public.org_connections set secret_id = %L where id = %L', :sAqb, :aep))
  || '/' || pg_temp.dml(:p02, format('update public.org_connections set secret_id = gen_random_uuid() where id = %L', :asi)),
  'R/R/R/R',
  'T1: a member who may write the row cannot point it at another Vault secret, or at a new one');
select is(
  pg_temp.dml(:p02, format('update public.org_connections set secret_id = null where id = %L', :aqb))
  || '/' || pg_temp.dml(:p02, format('update public.org_connections set secret_id = secret_id, last_error = null where id = %L', :aqb))
  || '/' || pg_temp.dml(:p05, format('update public.org_connections set secret_id = null where id = %L', :aqb))
  || '/' || pg_temp.dml(:p06, format('update public.org_connections set secret_id = null where id = %L', :aep)),
  '1/1/1/1',
  'T2: the pointer may be kept or cleared (Disconnect clears it)');
select is(
  pg_temp.dml(:p02, format('insert into public.org_connections (organization_id, provider_id, secret_id) values (%L, %L, %L)', :orgA, 'quickbooks', :sAqb),
              format('delete from public.org_connections where id = %L', :aqb))
  || '/' || pg_temp.dml(:p05, format('insert into public.org_connections (organization_id, provider_id, secret_id) values (%L, %L, gen_random_uuid())', :orgA, 'quickbooks'),
              format('delete from public.org_connections where id = %L', :aqb))
  || '/' || pg_temp.dml(:p06, format('insert into public.org_connections (organization_id, provider_id, secret_id) values (%L, %L, %L)', :orgA, 'easypost', :sAep),
              format('delete from public.org_connections where id = %L', :aep)),
  'R/R/R',
  'T3: a new row may not name a Vault secret');
select is(
  pg_temp.dml(:p16, format('update public.org_connections set organization_id = %L where id = %L', :orgB, :asi))
  || '/' || pg_temp.dml(:p16, format($q$update public.org_connections set settings = settings || '{"s27b": 2}'::jsonb where id = %L$q$, :asi)),
  'R/1',
  'T4: a member who holds the key in two organizations cannot move a row between them (control: they can still change its settings)');
select is(
  pg_temp.dml(:p02, format('update public.org_connections set provider_id = %L where id = %L', 'other_provider', :asi))
  || '/' || pg_temp.dml(:p02, format('update public.org_connections set provider_id = %L where id = %L', 'easypost', :asi))
  || '/' || pg_temp.dml(:p05, format('update public.org_connections set provider_id = %L where id = %L', 'other_provider', :asi))
  || '/' || pg_temp.dml(:p02, format('update public.org_connections set id = gen_random_uuid() where id = %L', :asi)),
  'R/R/R/R',
  'T5: a row''s provider and id cannot change');
select is(
  pg_temp.dml(null, format('update public.org_connections set secret_id = %L where id = %L', :sAep, :aqb), null, 'service_role')
  || '/' || pg_temp.dml(null, format('update public.org_connections set organization_id = %L where id = %L', :orgB, :asi), null, 'service_role')
  || '/' || pg_temp.dml(null, format('update public.org_connections set provider_id = %L where id = %L', 'other_provider', :asi), null, 'service_role')
  || '/' || pg_temp.dml(null, format('insert into public.org_connections (organization_id, provider_id, secret_id) values (%L, %L, gen_random_uuid())', :orgA, 'quickbooks'),
                        format('delete from public.org_connections where id = %L', :aqb), 'service_role'),
  '1/1/1/1',
  'T6: the service role (the connect activation, the OAuth callbacks, the token refreshes) is not affected');
select is(
  -- beginConnect's upsert (OAuth start), the API-key connect's first write,
  -- setZendeskSubdomain's upsert (a new row), the account mapping save and
  -- Disconnect, as the app sends them.
  pg_temp.dml(:p05, format($q$insert into public.org_connections (organization_id, provider_id, status, oauth_state, settings, created_by)
                              values (%L, 'quickbooks', 'pending', 'state-placeholder', '{"env": "sandbox"}', %L)
                              on conflict (organization_id, provider_id) do update set status = excluded.status,
                                oauth_state = excluded.oauth_state, settings = excluded.settings, created_by = excluded.created_by$q$, :orgA, :p02))
  || '/' || pg_temp.dml(:p06, format($q$insert into public.org_connections (organization_id, provider_id, created_by) values (%L, 'easypost', %L)
                                        on conflict (organization_id, provider_id) do update set created_by = excluded.created_by$q$, :orgA, :p02))
  || '/' || pg_temp.dml(:p05, format($q$insert into public.org_connections (organization_id, provider_id, external_account_id, settings, created_by)
                                        values (%L, 'zendesk', 'sampleorg', '{"subdomain": "sampleorg"}', %L)
                                        on conflict (organization_id, provider_id) do update set external_account_id = excluded.external_account_id,
                                          settings = excluded.settings, created_by = excluded.created_by$q$, :orgA, :p05))
  || '/' || pg_temp.dml(:p05, format($q$update public.org_connections set settings = settings || '{"accountIds": {"billExpense": "1"}}'::jsonb
                                        where organization_id = %L and provider_id = 'quickbooks'$q$, :orgA))
  || '/' || pg_temp.dml(:p05, format($q$update public.org_connections set status = 'disconnected', secret_id = null, oauth_state = null
                                        where organization_id = %L and provider_id = 'quickbooks'$q$, :orgA))
  || '/' || pg_temp.dml(:p06, format($q$update public.org_connections set status = 'disconnected', secret_id = null, oauth_state = null
                                        where organization_id = %L and provider_id = 'easypost'$q$, :orgA)),
  '1/1/1/1/1/1',
  'T7: the app''s own writes for a member given the key pass (OAuth start, API-key connect, Zendesk subdomain, settings save, Disconnect)');
select is(
  pg_temp.dml(:p05, format($q$update public.org_connections set status = 'active', last_error = null
                              where organization_id = %L and provider_id = 'quickbooks'$q$, :orgA))
  || '/' || pg_temp.dml(:p05, format($q$update public.org_connections set provider_id = 'easypost' where id = %L$q$, :aqb))
  || '/' || pg_temp.dml(:p06, format($q$update public.org_connections set provider_id = 'easypost' where id = %L$q$, :aqb)),
  '1/R/0',
  'T8: a key holder updates their provider''s row and cannot carry it into the other key''s provider; the other key''s holder cannot reach it at all');

-- ══ A. The migration's own preflight and lock prelude ══════════════════════
-- The statements the CLI recorded for version 0428 that contain p_tag. The
-- tags are the file's own, $pre_s27b$ and $lock_s27b$.
create function pg_temp.mig(p_tag text) returns text language sql stable as $$
  select coalesce(string_agg(st, E';\n'), '')
    from supabase_migrations.schema_migrations m, unnest(m.statements) st
   where m.version = '0428' and position(p_tag in st) > 0
$$;
create function pg_temp.mig_count(p_tag text) returns bigint language sql stable as $$
  select count(*)
    from supabase_migrations.schema_migrations m, unnest(m.statements) st
   where m.version = '0428' and position(p_tag in st) > 0
$$;
-- The pre-0428 state: 0146's, 0149's, 0152's and 0169's rules, and no guard.
-- (This is also the rollback's body.)
create function pg_temp.pre_0428() returns text language sql immutable as $$
  select $p$drop policy org_connections_insert on public.org_connections;
drop policy org_connections_update on public.org_connections;
drop policy connection_sync_log_replay on public.connection_sync_log;
drop policy integration_endpoints_manage on public.integration_endpoints;
drop policy integration_deliveries_select on public.integration_deliveries;
drop trigger org_connections_client_guard on public.org_connections;
drop function public._guard_org_connections_client_writes();
create policy org_connections_write on public.org_connections
  for all to authenticated
  using ((select public.has_org_role(organization_id,'admin')))
  with check ((select public.has_org_role(organization_id,'admin')));
create policy connection_mappings_write on public.connection_mappings
  for all to authenticated
  using ((select public.has_org_role(organization_id,'manager')))
  with check ((select public.has_org_role(organization_id,'manager')));
create policy carrier_shipments_write on public.carrier_shipments
  for all to authenticated
  using ((select public.has_org_role(organization_id,'manager')))
  with check ((select public.has_org_role(organization_id,'manager')));
create policy connection_sync_log_admin_replay on public.connection_sync_log
  for update to authenticated
  using ((select public.has_org_role(organization_id, 'admin')))
  with check ((select public.has_org_role(organization_id, 'admin')) and status = 'pending');
create policy integration_endpoints_admin_all on public.integration_endpoints
  for all to authenticated
  using (public.has_org_role(organization_id, 'admin'))
  with check (public.has_org_role(organization_id, 'admin'));
create policy integration_deliveries_admin_read on public.integration_deliveries
  for select to authenticated
  using (public.has_org_role(organization_id, 'admin'))$p$
$$;
-- The preflight run again after p_prep, ALWAYS undone: 'ok', or
-- '<sqlstate>:<hint>:' and the checks its message reports, sorted; 'missing'
-- when the CLI recorded no preflight (an empty EXECUTE would read as 'ok').
create function pg_temp.try_pre(p_prep text) returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text;
begin
  if pg_temp.mig('$pre_s27b$') = '' then
    return 'missing';
  end if;
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    execute pg_temp.mig('$pre_s27b$');
    raise exception using errcode = 'XXT27', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XXT27' then
    return 'ok';
  end if;
  return v_state || ':' || coalesce(nullif(v_hint, ''), '-') || ':'
         || coalesce((select string_agg(m[1], ', ' order by m[1] collate "C")
                        from regexp_matches(v_msg, '(\S+ drifted|\S+ missing|admin defaults|NOT NULL columns|row security|triggers are|already exists|integration policies)', 'g') m),
                     v_msg);
end $$;
-- The tables (outside the catalogs) this backend holds in ACCESS EXCLUSIVE
-- mode after p_sql, ALWAYS undone (the locks go with the subtransaction);
-- 'missing' for an empty p_sql.
create function pg_temp.ae_locks(p_sql text) returns text language plpgsql as $$
declare v text;
begin
  if p_sql = '' then
    return 'missing';
  end if;
  begin
    if p_sql is not null then
      execute p_sql;
    end if;
    select string_agg(distinct n.nspname || '.' || c.relname, ',' order by n.nspname || '.' || c.relname) into v
      from pg_locks l
      join pg_class c on c.oid = l.relation
      join pg_namespace n on n.oid = c.relnamespace
     where l.pid = pg_backend_pid() and l.locktype = 'relation' and l.granted
       and l.mode = 'AccessExclusiveLock' and c.relpersistence = 'p'
       and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema');
    raise exception using errcode = 'XXT27', message = 'undo';
  exception when sqlstate 'XXT27' then
    null;
  end;
  return coalesce(v, 'none');
end $$;

select is(
  pg_temp.mig_count('$pre_s27b$')::text || '/' || pg_temp.mig_count('$lock_s27b$')::text,
  '1/1',
  'A1: the CLI recorded 0428''s preflight and lock prelude exactly once each (this section runs that text)');

select is(
  pg_temp.try_pre(null),
  '55000:s27b_preflight:already exists, integration policies, triggers are',
  'A2: run again after 0428, the preflight stops before changing anything (55000) and names the guard function, the rules and the trigger 0428 changed');

select is(
  pg_temp.try_pre(pg_temp.pre_0428()) || ' / ' || pg_temp.try_pre(pg_temp.pre_0428() || $p$;set local search_path = ''$p$)
  || ' / ' || pg_temp.try_pre(pg_temp.pre_0428() || $p$;set local search_path = pg_catalog$p$),
  'ok / ok / ok',
  'A3: on the pre-0428 state (the rollback''s body) the preflight passes, under the session''s search_path, an empty one and pg_catalog alone');

select is(
  pg_temp.try_pre(pg_temp.pre_0428() || $p$;
create or replace function public.has_permission(org_id uuid, perm text) returns boolean
language sql stable security definer set search_path = public as $f$ select false $f$$p$)
  || ' / ' || pg_temp.try_pre(pg_temp.pre_0428() || $p$;
revoke execute on function public.rls_orgs_with_permission(text) from authenticated$p$)
  || ' / ' || pg_temp.try_pre(pg_temp.pre_0428() || $p$;
create policy s27b_extra on public.integration_endpoints for select to authenticated using (true)$p$)
  || ' / ' || pg_temp.try_pre(pg_temp.pre_0428() || $p$;
delete from public.role_default_permissions where role = 'admin' and permission = 'shipping:manage'$p$)
  || ' / ' || pg_temp.try_pre(pg_temp.pre_0428() || $p$;
alter table public.connection_mappings disable row level security$p$)
  || ' / ' || pg_temp.try_pre(pg_temp.pre_0428() || $p$;
create trigger s27b_extra before update on public.org_connections for each row execute function public.tg_set_updated_at()$p$)
  || ' / ' || pg_temp.try_pre(pg_temp.pre_0428() || $p$;
alter table public.org_connections alter column provider_id drop not null$p$),
  '55000:s27b_preflight:public.has_permission(uuid,text) drifted / '
  '55000:s27b_preflight:public.rls_orgs_with_permission(text) drifted / '
  '55000:s27b_preflight:integration policies / '
  '55000:s27b_preflight:admin defaults / '
  '55000:s27b_preflight:row security / '
  '55000:s27b_preflight:triggers are / '
  '55000:s27b_preflight:NOT NULL columns',
  'A4: on that state each planted drift stops it and is named: the resolver''s body, authenticated losing EXECUTE on the set helper, a further rule on a table, a missing admin default, row security off, a further trigger, a nullable provider');

select is(
  pg_temp.ae_locks(null) || ' / ' || pg_temp.ae_locks(pg_temp.mig('$lock_s27b$')),
  'none / ' || (select string_agg(x, ',' order by x) from (
                  select unnest(array['public.carrier_shipments', 'public.connection_mappings', 'public.connection_sync_log',
                                      'public.integration_deliveries', 'public.integration_endpoints', 'public.org_connections']) as x
                  union
                  select n.nspname || '.' || c.relname
                    from jsonb_array_elements_text(coalesce(nullif(current_setting('supautils.policy_grants', true), '')::jsonb
                                                            -> current_user::text, '[]'::jsonb)) g(name)
                    join pg_class c on c.oid = to_regclass(g.name)
                    join pg_namespace n on n.oid = c.relnamespace) s),
  'A5: the lock prelude takes ACCESS EXCLUSIVE on the six tables and on every table supautils.policy_grants lists for this role, at once, and on nothing else');

select * from finish();
rollback;
