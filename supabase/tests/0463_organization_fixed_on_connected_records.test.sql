-- supabase/tests/NNNN_organization_fixed_on_connected_records.test.sql
-- (NNNN = the migration's number, given in ship order; nothing in this file
-- reads it)
-- pgTAP proof for the migration that keeps the organization of a customer,
-- a stored API key, a connection, a connection mapping, a sync log entry, a
-- notification endpoint, a public request link, a queued event, a supplier
-- and a charter fixed: for the API roles an update that changes
-- organization_id is refused 42501 (tg_organization_id_fixed, bound BEFORE
-- UPDATE on each table, only when organization_id changes). No stored row
-- changes. Every line states what the database does with the migration
-- applied.
--
-- Personas (organization A unless named):
--   own      owner
--   adm      admin
--   mgr      manager
--   both     owner of A and owner of B
--   bothAdm  admin of A and admin of B
--   bothMgr  manager of A and manager of B
--   bothPerm staff of A and of B, with customers:manage, suppliers:manage
--            and public_links:manage in both
--   ownStf   owner of A and staff of B
--   ownVwr   owner of A and viewer of B
-- Rows: one of each table in A and one in B (a connection, its mapping, a
-- queued event and its pending sync log entry in each), and a price list of
-- each organization.
--
-- F.  The fixture is what the matrices assume.
-- M.  For each table, moving a row of A to B by update is refused 42501 for
--     every persona whose rank lets them change the row in A (M1 to M10).
-- U.  An upsert onto a row of A that proposes organization B is refused
--     (U1).
-- K.  Updates that keep the organization (an ordinary column, the same
--     organization_id sent again) and new rows of A are as before (K1, K2).
-- R.  service_role, and a SECURITY DEFINER body owned by postgres that an
--     API role calls, are not held; anon changes no row (R1 to R3).
-- P.  tg_organization_id_fixed is unchanged, and it is bound exactly once on
--     each of the ten tables, BEFORE UPDATE FOR EACH ROW, only when
--     organization_id changes (P1, P2).
-- Z.  Nothing the refused writes and the undone attempts touched was left
--     changed.
--
-- Roles: fixtures as the test superuser. Every attempt runs through
-- pg_temp.attempt (always undone), which switches role and claims with
-- set_config inside a subtransaction (the 0387 helpers, as 0419, 0423 and
-- 0462 use them). begin/rollback: nothing leaks.
-- Namespace 04630000; undo code XX463.

begin;

select plan(21);

\set orgA     '\'04630000-0000-0000-0000-00000000000a\''
\set orgB     '\'04630000-0000-0000-0000-00000000000b\''
\set own      '\'04630000-0000-0000-0000-0000000000a1\''
\set adm      '\'04630000-0000-0000-0000-0000000000a2\''
\set mgr      '\'04630000-0000-0000-0000-0000000000a3\''
\set both     '\'04630000-0000-0000-0000-0000000000a4\''
\set bothAdm  '\'04630000-0000-0000-0000-0000000000a5\''
\set bothMgr  '\'04630000-0000-0000-0000-0000000000a6\''
\set bothPerm '\'04630000-0000-0000-0000-0000000000a7\''
\set ownStf   '\'04630000-0000-0000-0000-0000000000a8\''
\set ownVwr   '\'04630000-0000-0000-0000-0000000000a9\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,      'b463-own@b463.test',      '{}'::jsonb),
  (:adm,      'b463-adm@b463.test',      '{}'::jsonb),
  (:mgr,      'b463-mgr@b463.test',      '{}'::jsonb),
  (:both,     'b463-both@b463.test',     '{}'::jsonb),
  (:bothAdm,  'b463-bothadm@b463.test',  '{}'::jsonb),
  (:bothMgr,  'b463-bothmgr@b463.test',  '{}'::jsonb),
  (:bothPerm, 'b463-bothperm@b463.test', '{}'::jsonb),
  (:ownStf,   'b463-ownstf@b463.test',   '{}'::jsonb),
  (:ownVwr,   'b463-ownvwr@b463.test',   '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:orgA, 'B463 Records Org A', 'b463-records-org-a'),
  (:orgB, 'B463 Records Org B', 'b463-records-org-b');
insert into public.organization_members (organization_id, user_id, role, accepted_at, all_warehouses) values
  (:orgA, :own,      'owner',   now(), true),
  (:orgA, :adm,      'admin',   now(), true),
  (:orgA, :mgr,      'manager', now(), true),
  (:orgA, :both,     'owner',   now(), true),
  (:orgB, :both,     'owner',   now(), true),
  (:orgA, :bothAdm,  'admin',   now(), true),
  (:orgB, :bothAdm,  'admin',   now(), true),
  (:orgA, :bothMgr,  'manager', now(), true),
  (:orgB, :bothMgr,  'manager', now(), true),
  (:orgA, :bothPerm, 'staff',   now(), true),
  (:orgB, :bothPerm, 'staff',   now(), true),
  (:orgA, :ownStf,   'owner',   now(), true),
  (:orgB, :ownStf,   'staff',   now(), true),
  (:orgA, :ownVwr,   'owner',   now(), true),
  (:orgB, :ownVwr,   'viewer',  now(), true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted)
select o, :bothPerm, p, true
  from unnest(array[:orgA, :orgB]::uuid[]) o,
       unnest(array['customers:manage', 'suppliers:manage', 'public_links:manage']) p;

-- One row of each table in A and in B; fx names them (tbl, org letter, id).
create temp table fx (tbl text, org text, id uuid, primary key (tbl, org));
do $f$
declare
  o record; v uuid; c uuid; e uuid;
begin
  for o in select * from (values ('A', '04630000-0000-0000-0000-00000000000a'::uuid, 'quickbooks'),
                                 ('B', '04630000-0000-0000-0000-00000000000b'::uuid, 'sage_intacct')) x(l, id, provider) loop
    insert into public.customers (organization_id, name) values (o.id, 'B463 Customer ' || o.l) returning id into v;
    insert into fx values ('customers', o.l, v);
    insert into public.api_keys (organization_id, name, key_hash, key_prefix, scopes)
      values (o.id, 'B463 key ' || o.l, md5('b463 key ' || o.l) || md5('b463 hash ' || o.l), 'sk_b463', '{}') returning id into v;
    insert into fx values ('api_keys', o.l, v);
    insert into public.org_connections (organization_id, provider_id, status) values (o.id, o.provider, 'active') returning id into c;
    insert into fx values ('org_connections', o.l, c);
    insert into public.connection_mappings (connection_id, organization_id, entity_type, external_id)
      values (c, o.id, 'item', 'B463-EXT-' || o.l) returning id into v;
    insert into fx values ('connection_mappings', o.l, v);
    insert into public.outbox_events (organization_id, topic, aggregate_type, payload)
      values (o.id, 'item.created', 'item', '{}'::jsonb) returning id into e;
    insert into fx values ('outbox_events', o.l, e);
    insert into public.connection_sync_log (connection_id, organization_id, outbox_event_id, topic, status)
      values (c, o.id, e, 'item.created', 'pending') returning id into v;
    insert into fx values ('connection_sync_log', o.l, v);
    insert into public.integration_endpoints (organization_id, type, url, event_types)
      values (o.id, 'webhook', 'https://hooks.b463.test/' || o.l, '{}') returning id into v;
    insert into fx values ('integration_endpoints', o.l, v);
    insert into public.public_request_links (organization_id, name, token_hash)
      values (o.id, 'B463 link ' || o.l, md5('b463 link ' || o.l) || md5('b463 token ' || o.l)) returning id into v;
    insert into fx values ('public_request_links', o.l, v);
    insert into public.suppliers (organization_id, name) values (o.id, 'B463 Supplier ' || o.l) returning id into v;
    insert into fx values ('suppliers', o.l, v);
    insert into public.charters (organization_id, name) values (o.id, 'B463 Charter ' || o.l) returning id into v;
    insert into fx values ('charters', o.l, v);
  end loop;
end $f$;
create function pg_temp.fx(p_tbl text, p_org text) returns uuid language sql stable as $$
  select id from fx where tbl = p_tbl and org = p_org
$$;

-- ══ Helpers (0387's, as 0419, 0423 and 0462 use them) ════════════════════
create function pg_temp.hint(p_hint text) returns text language sql immutable as $$
  select case when p_hint is null or p_hint = ''
                or p_hint like 'Grant the required privileges to the current role with:%'
              then '-' else p_hint end
$$;
-- One statement as p_as with p_sub's claims, then ALWAYS undone. 'ok:<rows>
-- [:<p_check>]' (p_check as the superuser, inside the undone subtransaction),
-- else '<sqlstate>:<hint or ->:<message>'.
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
    raise exception using errcode = 'XX463', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XX463' then
    return 'ok:' || v_n::text || coalesce(':' || v_seen, '');
  end if;
  return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
end $$;

create temp table persona (who text primary key, id uuid);
insert into persona (who, id) values
  ('own', :own), ('adm', :adm), ('mgr', :mgr), ('both', :both), ('bothAdm', :bothAdm), ('bothMgr', :bothMgr),
  ('bothPerm', :bothPerm), ('ownStf', :ownStf), ('ownVwr', :ownVwr);

-- The same statement for each named persona, each call undone:
-- 'who=<attempt>, who=<attempt>, ...'.
create function pg_temp.each(p_who text[], p_sql text)
returns text language plpgsql as $$
declare v text := ''; w text;
begin
  foreach w in array p_who loop
    v := v || case when v = '' then '' else ', ' end || w || '='
           || pg_temp.attempt('authenticated', (select p.id from persona p where p.who = w), p_sql);
  end loop;
  return v;
end $$;
-- What each() returns when every persona gets the same answer.
create function pg_temp.same(p_who text[], p_res text) returns text language sql immutable as $$
  select string_agg(w || '=' || p_res, ', ' order by o) from unnest(p_who) with ordinality u(w, o)
$$;
-- The move of the table's row of A to B, by update.
create function pg_temp.move_sql(p_tbl text) returns text language sql stable as $$
  select format('update public.%I set organization_id = %L where id = %L',
                p_tbl, '04630000-0000-0000-0000-00000000000b', pg_temp.fx(p_tbl, 'A'))
$$;

-- Who may change a row of A, per rule: an admin rule (owner and admin), a
-- manager rule (and manager), and the two with a permission as well.
create temp table rank_of (rule text primary key, who text[]);
insert into rank_of values
  ('admin',        array['own', 'adm', 'both', 'bothAdm', 'ownStf', 'ownVwr']),
  ('admin_perm',   array['own', 'adm', 'both', 'bothAdm', 'bothPerm', 'ownStf', 'ownVwr']),
  ('manager',      array['own', 'adm', 'mgr', 'both', 'bothAdm', 'bothMgr', 'ownStf', 'ownVwr']),
  ('manager_perm', array['own', 'adm', 'mgr', 'both', 'bothAdm', 'bothMgr', 'bothPerm', 'ownStf', 'ownVwr']);
create function pg_temp.who(p_rule text) returns text[] language sql stable as $$
  select who from rank_of where rule = p_rule
$$;

-- What the Z line compares: every row of the ten tables in the two
-- organizations, with its organization and its whole content.
create function pg_temp.state() returns text language plpgsql stable as $$
declare v text := ''; t text; s text;
begin
  foreach t in array array['customers', 'api_keys', 'org_connections', 'connection_mappings', 'connection_sync_log',
                           'integration_endpoints', 'public_request_links', 'outbox_events', 'suppliers', 'charters'] loop
    execute format($q$select coalesce(string_agg(x.id::text || '/' || x.organization_id::text || '/' || md5(row_to_json(x)::text), ',' order by x.id), '-')
                        from public.%I x where x.organization_id in (%L, %L)$q$,
                   t, '04630000-0000-0000-0000-00000000000a', '04630000-0000-0000-0000-00000000000b')
      into s;
    v := v || t || ':' || s || ' # ';
  end loop;
  return v;
end $$;
create temp table snap as select pg_temp.state() as v;

-- ══ F. The fixture ════════════════════════════════════════════════════════
select is(
  (select string_agg(p.who || ':' || coalesce(ma.role, '-') || '/' || coalesce(mb.role, '-'), ' ' order by p.who collate "C")
     from persona p
     left join public.organization_members ma on ma.user_id = p.id and ma.organization_id = :orgA
     left join public.organization_members mb on mb.user_id = p.id and mb.organization_id = :orgB),
  'adm:admin/- both:owner/owner bothAdm:admin/admin bothMgr:manager/manager bothPerm:staff/staff '
  || 'mgr:manager/- own:owner/- ownStf:owner/staff ownVwr:owner/viewer',
  'F1: each persona''s rank in organization A and in organization B');
select is(
  (select count(*)::text || '/' || count(distinct tbl)::text || '/' || count(*) filter (where org = 'A')::text from fx),
  '20/10/10',
  'F2: one row of each of the ten tables in organization A and one in organization B');

-- ══ M. Moving a row of A to B, by update ═════════════════════════════════
select is(pg_temp.each(pg_temp.who('manager_perm'), pg_temp.move_sql('customers')),
          pg_temp.same(pg_temp.who('manager_perm'), '42501:-:A customer cannot be moved to another organization.'),
  'M1: a customer of A moved to B by every rank that may change it (manager, customers:manage, and members of both): refused 42501');
select is(pg_temp.each(pg_temp.who('admin'), pg_temp.move_sql('api_keys')),
          pg_temp.same(pg_temp.who('admin'), '42501:-:A stored API key cannot be moved to another organization.'),
  'M2: a stored API key of A moved to B by every rank that may change it (admin, and members of both): refused 42501');
select is(pg_temp.each(pg_temp.who('admin'), pg_temp.move_sql('org_connections')),
          pg_temp.same(pg_temp.who('admin'), '42501:-:A connection cannot be moved to another organization.'),
  'M3: a connection of A moved to B by every rank that may change it (admin, and members of both): refused 42501');
select is(pg_temp.each(pg_temp.who('manager'), pg_temp.move_sql('connection_mappings')),
          pg_temp.same(pg_temp.who('manager'), '42501:-:A connection mapping cannot be moved to another organization.'),
  'M4: a connection mapping of A moved to B by every rank that may change it (manager, and members of both): refused 42501');
select is(pg_temp.each(pg_temp.who('admin'), pg_temp.move_sql('connection_sync_log')),
          pg_temp.same(pg_temp.who('admin'), '42501:-:A sync log entry cannot be moved to another organization.'),
  'M5: a pending sync log entry of A moved to B by every rank that may change it (admin, and members of both): refused 42501');
select is(pg_temp.each(pg_temp.who('admin'), pg_temp.move_sql('integration_endpoints')),
          pg_temp.same(pg_temp.who('admin'), '42501:-:A notification endpoint cannot be moved to another organization.'),
  'M6: a notification endpoint of A moved to B by every rank that may change it (admin, and members of both): refused 42501');
select is(pg_temp.each(pg_temp.who('admin_perm'), pg_temp.move_sql('public_request_links')),
          pg_temp.same(pg_temp.who('admin_perm'), '42501:-:A public request link cannot be moved to another organization.'),
  'M7: a public request link of A moved to B by every rank that may change it (admin, public_links:manage, and members of both): refused 42501');
select is(pg_temp.each(pg_temp.who('admin'), pg_temp.move_sql('outbox_events')),
          pg_temp.same(pg_temp.who('admin'), '42501:-:A queued event cannot be moved to another organization.'),
  'M8: a queued event of A moved to B by every rank that may change it (admin, and members of both): refused 42501');
select is(pg_temp.each(pg_temp.who('manager_perm'), pg_temp.move_sql('suppliers')),
          pg_temp.same(pg_temp.who('manager_perm'), '42501:-:A supplier cannot be moved to another organization.'),
  'M9: a supplier of A moved to B by every rank that may change it (manager, suppliers:manage, and members of both): refused 42501');
select is(pg_temp.each(pg_temp.who('admin'), pg_temp.move_sql('charters')),
          pg_temp.same(pg_temp.who('admin'), '42501:-:A charter cannot be moved to another organization.'),
  'M10: a charter of A moved to B by every rank that may change it (admin, and members of both): refused 42501');

-- ══ U. Upsert proposing organization B ════════════════════════════════════
-- By the owner of both (bothPerm for public request links is covered by M7).
-- connection_sync_log has no insert rule for members, so its upsert is
-- refused at the insert check.
select is(
  pg_temp.attempt('authenticated', :both, format($q$insert into public.customers (id, organization_id, name) values (%L, %L, 'B463 Customer A')
     on conflict (id) do update set organization_id = excluded.organization_id$q$, pg_temp.fx('customers', 'A'), :orgB))
  || ' / ' || pg_temp.attempt('authenticated', :both, format($q$insert into public.api_keys (id, organization_id, name, key_hash, key_prefix, scopes)
     values (%L, %L, 'B463 key A', md5('b463 key A') || md5('b463 hash A'), 'sk_b463', '{}')
     on conflict (id) do update set organization_id = excluded.organization_id$q$, pg_temp.fx('api_keys', 'A'), :orgB))
  || ' / ' || pg_temp.attempt('authenticated', :both, format($q$insert into public.org_connections (id, organization_id, provider_id, status)
     values (%L, %L, 'quickbooks', 'active')
     on conflict (id) do update set organization_id = excluded.organization_id$q$, pg_temp.fx('org_connections', 'A'), :orgB))
  || ' / ' || pg_temp.attempt('authenticated', :both, format($q$insert into public.connection_mappings (id, connection_id, organization_id, entity_type, external_id)
     values (%L, %L, %L, 'item', 'B463-EXT-A')
     on conflict (id) do update set organization_id = excluded.organization_id$q$, pg_temp.fx('connection_mappings', 'A'), pg_temp.fx('org_connections', 'A'), :orgB))
  || ' / ' || pg_temp.attempt('authenticated', :both, format($q$insert into public.connection_sync_log (id, connection_id, organization_id, outbox_event_id, topic, status)
     values (%L, %L, %L, %L, 'item.created', 'pending')
     on conflict (id) do update set organization_id = excluded.organization_id$q$, pg_temp.fx('connection_sync_log', 'A'), pg_temp.fx('org_connections', 'A'), :orgB, pg_temp.fx('outbox_events', 'A')))
  || ' / ' || pg_temp.attempt('authenticated', :both, format($q$insert into public.integration_endpoints (id, organization_id, type, url, event_types)
     values (%L, %L, 'webhook', 'https://hooks.b463.test/A', '{}')
     on conflict (id) do update set organization_id = excluded.organization_id$q$, pg_temp.fx('integration_endpoints', 'A'), :orgB))
  || ' / ' || pg_temp.attempt('authenticated', :both, format($q$insert into public.public_request_links (id, organization_id, name, token_hash)
     values (%L, %L, 'B463 link A', md5('b463 link A') || md5('b463 token A'))
     on conflict (id) do update set organization_id = excluded.organization_id$q$, pg_temp.fx('public_request_links', 'A'), :orgB))
  || ' / ' || pg_temp.attempt('authenticated', :both, format($q$insert into public.outbox_events (id, organization_id, topic, aggregate_type, payload)
     values (%L, %L, 'item.created', 'item', '{}')
     on conflict (id) do update set organization_id = excluded.organization_id$q$, pg_temp.fx('outbox_events', 'A'), :orgB))
  || ' / ' || pg_temp.attempt('authenticated', :both, format($q$insert into public.suppliers (id, organization_id, name) values (%L, %L, 'B463 Supplier A')
     on conflict (id) do update set organization_id = excluded.organization_id$q$, pg_temp.fx('suppliers', 'A'), :orgB))
  || ' / ' || pg_temp.attempt('authenticated', :both, format($q$insert into public.charters (id, organization_id, name) values (%L, %L, 'B463 Charter A')
     on conflict (id) do update set organization_id = excluded.organization_id$q$, pg_temp.fx('charters', 'A'), :orgB)),
  '42501:-:A customer cannot be moved to another organization.'
  || ' / 42501:-:A stored API key cannot be moved to another organization.'
  || ' / 42501:-:A connection cannot be moved to another organization.'
  || ' / 42501:-:A connection mapping cannot be moved to another organization.'
  || ' / 42501:-:new row violates row-level security policy for table "connection_sync_log"'
  || ' / 42501:-:A notification endpoint cannot be moved to another organization.'
  || ' / 42501:-:A public request link cannot be moved to another organization.'
  || ' / 42501:-:A queued event cannot be moved to another organization.'
  || ' / 42501:-:A supplier cannot be moved to another organization.'
  || ' / 42501:-:A charter cannot be moved to another organization.',
  'U1: an upsert onto a row of A of each table that proposes organization B, by the owner of both: refused 42501');

-- ══ K. Updates that keep the organization, and new rows ══════════════════
select is(
  pg_temp.each(array['mgr', 'both', 'bothPerm'],
    format($q$update public.customers set name = 'B463 Customer A2', organization_id = %L where id = %L$q$, :orgA, pg_temp.fx('customers', 'A')))
  || ' / ' || pg_temp.each(array['adm', 'both'],
    format($q$update public.api_keys set revoked_at = now(), organization_id = %L where id = %L$q$, :orgA, pg_temp.fx('api_keys', 'A')))
  || ' / ' || pg_temp.each(array['adm', 'both'],
    format($q$update public.org_connections set last_error = 'B463 retry', organization_id = %L where id = %L$q$, :orgA, pg_temp.fx('org_connections', 'A')))
  || ' / ' || pg_temp.each(array['mgr', 'both'],
    format($q$update public.connection_mappings set external_meta = '{"n": 1}', organization_id = %L where id = %L$q$, :orgA, pg_temp.fx('connection_mappings', 'A')))
  || ' / ' || pg_temp.each(array['adm', 'both'],
    format($q$update public.connection_sync_log set attempts = 0, organization_id = %L where id = %L$q$, :orgA, pg_temp.fx('connection_sync_log', 'A')))
  || ' / ' || pg_temp.each(array['adm', 'both'],
    format($q$update public.integration_endpoints set enabled = false, organization_id = %L where id = %L$q$, :orgA, pg_temp.fx('integration_endpoints', 'A')))
  || ' / ' || pg_temp.each(array['adm', 'both', 'bothPerm'],
    format($q$update public.public_request_links set active = false, name = 'B463 link A2', organization_id = %L where id = %L$q$, :orgA, pg_temp.fx('public_request_links', 'A')))
  || ' / ' || pg_temp.each(array['adm', 'both'],
    format($q$update public.outbox_events set published_at = now(), organization_id = %L where id = %L$q$, :orgA, pg_temp.fx('outbox_events', 'A')))
  || ' / ' || pg_temp.each(array['mgr', 'both', 'bothPerm'],
    format($q$update public.suppliers set name = 'B463 Supplier A2', deleted_at = now(), organization_id = %L where id = %L$q$, :orgA, pg_temp.fx('suppliers', 'A')))
  || ' / ' || pg_temp.each(array['adm', 'both'],
    format($q$update public.charters set status = 'archived', organization_id = %L where id = %L$q$, :orgA, pg_temp.fx('charters', 'A'))),
  'mgr=ok:1, both=ok:1, bothPerm=ok:1 / adm=ok:1, both=ok:1 / adm=ok:1, both=ok:1 / mgr=ok:1, both=ok:1 / adm=ok:1, both=ok:1'
  || ' / adm=ok:1, both=ok:1 / adm=ok:1, both=ok:1, bothPerm=ok:1 / adm=ok:1, both=ok:1 / mgr=ok:1, both=ok:1, bothPerm=ok:1'
  || ' / adm=ok:1, both=ok:1',
  'K1: updates of a row of A that keep its organization (an ordinary column, the same organization_id sent again), by the ranks that may change it: as before');
select is(
  pg_temp.each(array['mgr'], format($q$insert into public.customers (organization_id, name) values (%L, 'B463 New customer')$q$, :orgA))
  || ' / ' || pg_temp.each(array['adm'], format($q$insert into public.api_keys (organization_id, name, key_hash, key_prefix, scopes)
       values (%L, 'B463 New key', md5('b463 new') || md5('b463 new key'), 'sk_b463', '{}')$q$, :orgA))
  || ' / ' || pg_temp.each(array['adm'], format($q$insert into public.org_connections (organization_id, provider_id, status) values (%L, 'zendesk', 'pending')$q$, :orgA))
  || ' / ' || pg_temp.each(array['mgr'], format($q$insert into public.connection_mappings (connection_id, organization_id, entity_type, external_id)
       values (%L, %L, 'item', 'B463-EXT-NEW')$q$, pg_temp.fx('org_connections', 'A'), :orgA))
  || ' / ' || pg_temp.each(array['adm'], format($q$insert into public.integration_endpoints (organization_id, type, url, event_types)
       values (%L, 'webhook', 'https://hooks.b463.test/new', '{}')$q$, :orgA))
  || ' / ' || pg_temp.each(array['bothPerm'], format($q$insert into public.public_request_links (organization_id, name, token_hash)
       values (%L, 'B463 New link', md5('b463 new link') || md5('b463 new token'))$q$, :orgA))
  || ' / ' || pg_temp.each(array['adm'], format($q$insert into public.outbox_events (organization_id, topic, aggregate_type, payload)
       values (%L, 'item.created', 'item', '{}')$q$, :orgA))
  || ' / ' || pg_temp.each(array['bothPerm'], format($q$insert into public.suppliers (organization_id, name) values (%L, 'B463 New supplier')$q$, :orgA))
  || ' / ' || pg_temp.each(array['adm'], format($q$insert into public.charters (organization_id, name) values (%L, 'B463 New charter')$q$, :orgA)),
  'mgr=ok:1 / adm=ok:1 / adm=ok:1 / mgr=ok:1 / adm=ok:1 / bothPerm=ok:1 / adm=ok:1 / bothPerm=ok:1 / adm=ok:1',
  'K2: new rows of A (every table a member may insert into): as before');

-- ══ R. Roles the guard does not hold ══════════════════════════════════════
create temp table r_out (tbl text primary key, res text);
do $r1$
declare t text;
begin
  foreach t in array array['customers', 'api_keys', 'org_connections', 'connection_mappings', 'connection_sync_log',
                           'integration_endpoints', 'public_request_links', 'outbox_events', 'suppliers', 'charters'] loop
    insert into r_out values (t, pg_temp.attempt('service_role', null, pg_temp.move_sql(t), null,
      format('select (organization_id = %L)::text from public.%I where id = %L', '04630000-0000-0000-0000-00000000000b', t, pg_temp.fx(t, 'A'))));
  end loop;
end $r1$;
select is(
  (select string_agg(tbl || '=' || res, ', ' order by tbl collate "C") from r_out),
  'api_keys=ok:1:true, charters=ok:1:true, connection_mappings=ok:1:true, connection_sync_log=ok:1:true, customers=ok:1:true, '
  || 'integration_endpoints=ok:1:true, org_connections=ok:1:true, outbox_events=ok:1:true, public_request_links=ok:1:true, suppliers=ok:1:true',
  'R1: the service role is not held by the guard on any of the ten tables');

-- A SECURITY DEFINER body owned by postgres, called by an owner of A only:
-- inside it current_user is postgres, so the guard lets the row through.
create function public.b463_definer_move(p_tbl text, p_id uuid, p_org uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  execute format('update public.%I set organization_id = %L where id = %L', p_tbl, p_org, p_id);
end $$;
revoke all on function public.b463_definer_move(text, uuid, uuid) from public, anon;
grant execute on function public.b463_definer_move(text, uuid, uuid) to authenticated;
truncate r_out;
do $r2$
declare t text;
begin
  foreach t in array array['customers', 'api_keys', 'org_connections', 'connection_mappings', 'connection_sync_log',
                           'integration_endpoints', 'public_request_links', 'outbox_events', 'suppliers', 'charters'] loop
    insert into r_out values (t, pg_temp.attempt('authenticated', '04630000-0000-0000-0000-0000000000a1',
      format('select public.b463_definer_move(%L, %L, %L)', t, pg_temp.fx(t, 'A'), '04630000-0000-0000-0000-00000000000b'), null,
      format('select (organization_id = %L)::text from public.%I where id = %L', '04630000-0000-0000-0000-00000000000b', t, pg_temp.fx(t, 'A'))));
  end loop;
end $r2$;
select is(
  (select string_agg(tbl || '=' || res, ', ' order by tbl collate "C") from r_out),
  'api_keys=ok:1:true, charters=ok:1:true, connection_mappings=ok:1:true, connection_sync_log=ok:1:true, customers=ok:1:true, '
  || 'integration_endpoints=ok:1:true, org_connections=ok:1:true, outbox_events=ok:1:true, public_request_links=ok:1:true, suppliers=ok:1:true',
  'R2: a SECURITY DEFINER body owned by postgres, called by an owner of A, is not held by the guard');
drop function public.b463_definer_move(text, uuid, uuid);

truncate r_out;
do $r3$
declare t text;
begin
  foreach t in array array['customers', 'api_keys', 'org_connections', 'connection_mappings', 'connection_sync_log',
                           'integration_endpoints', 'public_request_links', 'outbox_events', 'suppliers', 'charters'] loop
    insert into r_out values (t, pg_temp.attempt('anon', null, pg_temp.move_sql(t)));
  end loop;
end $r3$;
select is(
  (select string_agg(distinct res, ', ') || ' x' || count(*)::text from r_out),
  'ok:0 x10',
  'R3: anon changes no row of the ten tables');

-- ══ P. The guard and its bindings ═════════════════════════════════════════
select is(
  (select md5(p.prosrc) || '|' || p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ','), '-')
          || '|' || pg_get_userbyid(p.proowner)
          || '|' || has_function_privilege('anon', p.oid, 'execute')::text
          || '|' || has_function_privilege('authenticated', p.oid, 'execute')::text
          || '|' || has_function_privilege('service_role', p.oid, 'execute')::text
     from pg_proc p where p.oid = to_regprocedure('public.tg_organization_id_fixed()')),
  '9054291fa6f24646' || 'ece8de5570134e38' || '|false|search_path=public|postgres|false|false|false',
  'P1: tg_organization_id_fixed is the body the bindings rely on, SECURITY INVOKER with search_path public, owned by postgres, executable by no API role');
select is(
  (select string_agg(t.tgrelid::regclass::text || ':' || t.tgname || ':' || t.tgtype::text || ':' || t.tgenabled::text
                     || ':' || pg_get_triggerdef(t.oid), E'\n' order by t.tgrelid::regclass::text collate "C")
     from pg_trigger t
    where t.tgfoid = to_regprocedure('public.tg_organization_id_fixed()')
      and t.tgrelid in ('public.customers'::regclass, 'public.api_keys'::regclass, 'public.org_connections'::regclass,
                        'public.connection_mappings'::regclass, 'public.connection_sync_log'::regclass,
                        'public.integration_endpoints'::regclass, 'public.public_request_links'::regclass,
                        'public.outbox_events'::regclass, 'public.suppliers'::regclass, 'public.charters'::regclass)),
  'api_keys:trg_zz_api_keys_organization_fixed:19:O:CREATE TRIGGER trg_zz_api_keys_organization_fixed'
  || ' BEFORE UPDATE ON public.api_keys FOR EACH ROW WHEN ((new.organization_id IS DISTINCT FROM old.organization_id))'
  || ' EXECUTE FUNCTION tg_organization_id_fixed(''stored API key'')' || E'\n'
  || 'charters:trg_zz_charters_organization_fixed:19:O:CREATE TRIGGER trg_zz_charters_organization_fixed'
  || ' BEFORE UPDATE ON public.charters FOR EACH ROW WHEN ((new.organization_id IS DISTINCT FROM old.organization_id))'
  || ' EXECUTE FUNCTION tg_organization_id_fixed(''charter'')' || E'\n'
  || 'connection_mappings:trg_zz_connection_mappings_organization_fixed:19:O:CREATE TRIGGER trg_zz_connection_mappings_organization_fixed'
  || ' BEFORE UPDATE ON public.connection_mappings FOR EACH ROW WHEN ((new.organization_id IS DISTINCT FROM old.organization_id))'
  || ' EXECUTE FUNCTION tg_organization_id_fixed(''connection mapping'')' || E'\n'
  || 'connection_sync_log:trg_zz_connection_sync_log_organization_fixed:19:O:CREATE TRIGGER trg_zz_connection_sync_log_organization_fixed'
  || ' BEFORE UPDATE ON public.connection_sync_log FOR EACH ROW WHEN ((new.organization_id IS DISTINCT FROM old.organization_id))'
  || ' EXECUTE FUNCTION tg_organization_id_fixed(''sync log entry'')' || E'\n'
  || 'customers:trg_zz_customers_organization_fixed:19:O:CREATE TRIGGER trg_zz_customers_organization_fixed'
  || ' BEFORE UPDATE ON public.customers FOR EACH ROW WHEN ((new.organization_id IS DISTINCT FROM old.organization_id))'
  || ' EXECUTE FUNCTION tg_organization_id_fixed(''customer'')' || E'\n'
  || 'integration_endpoints:trg_zz_integration_endpoints_organization_fixed:19:O:CREATE TRIGGER trg_zz_integration_endpoints_organization_fixed'
  || ' BEFORE UPDATE ON public.integration_endpoints FOR EACH ROW WHEN ((new.organization_id IS DISTINCT FROM old.organization_id))'
  || ' EXECUTE FUNCTION tg_organization_id_fixed(''notification endpoint'')' || E'\n'
  || 'org_connections:trg_zz_org_connections_organization_fixed:19:O:CREATE TRIGGER trg_zz_org_connections_organization_fixed'
  || ' BEFORE UPDATE ON public.org_connections FOR EACH ROW WHEN ((new.organization_id IS DISTINCT FROM old.organization_id))'
  || ' EXECUTE FUNCTION tg_organization_id_fixed(''connection'')' || E'\n'
  || 'outbox_events:trg_zz_outbox_events_organization_fixed:19:O:CREATE TRIGGER trg_zz_outbox_events_organization_fixed'
  || ' BEFORE UPDATE ON public.outbox_events FOR EACH ROW WHEN ((new.organization_id IS DISTINCT FROM old.organization_id))'
  || ' EXECUTE FUNCTION tg_organization_id_fixed(''queued event'')' || E'\n'
  || 'public_request_links:trg_zz_public_request_links_organization_fixed:19:O:CREATE TRIGGER trg_zz_public_request_links_organization_fixed'
  || ' BEFORE UPDATE ON public.public_request_links FOR EACH ROW WHEN ((new.organization_id IS DISTINCT FROM old.organization_id))'
  || ' EXECUTE FUNCTION tg_organization_id_fixed(''public request link'')' || E'\n'
  || 'suppliers:trg_zz_suppliers_organization_fixed:19:O:CREATE TRIGGER trg_zz_suppliers_organization_fixed'
  || ' BEFORE UPDATE ON public.suppliers FOR EACH ROW WHEN ((new.organization_id IS DISTINCT FROM old.organization_id))'
  || ' EXECUTE FUNCTION tg_organization_id_fixed(''supplier'')',
  'P2: the guard is bound exactly once on each of the ten tables, BEFORE UPDATE FOR EACH ROW, only when organization_id changes');

-- ══ Z. Nothing left changed ═══════════════════════════════════════════════
select is(pg_temp.state(), (select v from snap),
  'Z1: the refused writes and the undone attempts left every row of the ten tables in both organizations as it was');

select * from finish();
rollback;
