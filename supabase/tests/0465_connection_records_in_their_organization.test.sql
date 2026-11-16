-- supabase/tests/NNNN_connection_records_in_their_organization.test.sql
-- (NNNN = the migration's number, given in ship order; nothing in this file
-- reads it)
-- pgTAP proof for the migration that keeps a connection's mappings and sync
-- log entries in its organization and lets a connection name only the
-- stored secret the server created for it:
--   * connection_mappings_write asks connection_in_org of the new row;
--   * connection_sync_log_admin_replay asks connection_in_org and
--     outbox_event_in_org of the new row;
--   * tg_org_connection_secret_set (BEFORE INSERT and BEFORE UPDATE on
--     org_connections, when secret_id is set to a secret) refuses the API
--     roles, and holds every other role to the Vault secret stored for the
--     connection (connection_secret_is_own);
--   * connector_secret_get decrypts a connector secret only while every
--     connection naming it is the one it was stored for, and
--     connector_secret_delete removes a connector secret only once no
--     connection names it.
-- No stored row changes. Every line states what the database does with the
-- migration applied.
--
-- Personas (organization A unless named):
--   own      owner                       adm      admin
--   mgr      manager                     admVwr   admin of A, viewer of B
--   admStf   admin of A, staff of B      admMgr   admin of A, manager of B
--   bothAdm  admin of A and of B         mgrVwr   manager of A, viewer of B
--   bothMgr  manager of A and of B
-- Rows: in A and in B a QuickBooks connection with its Vault secret (made-up
-- values, named 'connector:<connection id>'), a mapping, a queued event and
-- a dead sync log entry for it; in A an EasyPost connection whose secret
-- carries the organization-and-provider name, with no secret_id yet; and a
-- Vault secret that is not a connector secret.
--
-- F.  The fixture is what the matrices assume.
-- S.  A connection's secret (S1 to S11).
-- M.  A mapping names a connection of its own organization (M1 to M4).
-- L.  A sync log entry names a connection and a queued event of its own
--     organization (L1 to L3).
-- P.  The helpers, the trigger, the two rules and the two Vault reads are
--     the bodies the lines rely on; 0463's guard is untouched (P1 to P5).
-- Z.  Nothing the refused writes and the undone attempts touched was left
--     changed.
--
-- Roles: fixtures as the test superuser. Every attempt runs through
-- pg_temp.attempt (always undone), which switches role and claims with
-- set_config inside a subtransaction (the 0387 helpers, as 0423, 0462 and
-- 0463 use them). No decrypted value is printed: the lines compare it.
-- begin/rollback: nothing leaks.
-- Namespace 04650000; undo code XX465.

begin;

select plan(26);

\set orgA     '\'04650000-0000-0000-0000-00000000000a\''
\set orgB     '\'04650000-0000-0000-0000-00000000000b\''
\set own      '\'04650000-0000-0000-0000-0000000000a1\''
\set adm      '\'04650000-0000-0000-0000-0000000000a2\''
\set mgr      '\'04650000-0000-0000-0000-0000000000a3\''
\set admVwr   '\'04650000-0000-0000-0000-0000000000a4\''
\set admStf   '\'04650000-0000-0000-0000-0000000000a5\''
\set admMgr   '\'04650000-0000-0000-0000-0000000000a6\''
\set bothAdm  '\'04650000-0000-0000-0000-0000000000a7\''
\set mgrVwr   '\'04650000-0000-0000-0000-0000000000a8\''
\set bothMgr  '\'04650000-0000-0000-0000-0000000000a9\''
\set connA    '\'04650000-0000-0000-0000-0000000000c1\''
\set connB    '\'04650000-0000-0000-0000-0000000000c2\''
\set connA2   '\'04650000-0000-0000-0000-0000000000c3\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,     'b465-own@b465.test',     '{}'::jsonb),
  (:adm,     'b465-adm@b465.test',     '{}'::jsonb),
  (:mgr,     'b465-mgr@b465.test',     '{}'::jsonb),
  (:admVwr,  'b465-admvwr@b465.test',  '{}'::jsonb),
  (:admStf,  'b465-admstf@b465.test',  '{}'::jsonb),
  (:admMgr,  'b465-admmgr@b465.test',  '{}'::jsonb),
  (:bothAdm, 'b465-bothadm@b465.test', '{}'::jsonb),
  (:mgrVwr,  'b465-mgrvwr@b465.test',  '{}'::jsonb),
  (:bothMgr, 'b465-bothmgr@b465.test', '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:orgA, 'B465 Connections Org A', 'b465-connections-org-a'),
  (:orgB, 'B465 Connections Org B', 'b465-connections-org-b');
insert into public.organization_members (organization_id, user_id, role, accepted_at, all_warehouses) values
  (:orgA, :own,     'owner',   now(), true),
  (:orgA, :adm,     'admin',   now(), true),
  (:orgA, :mgr,     'manager', now(), true),
  (:orgA, :admVwr,  'admin',   now(), true),
  (:orgB, :admVwr,  'viewer',  now(), true),
  (:orgA, :admStf,  'admin',   now(), true),
  (:orgB, :admStf,  'staff',   now(), true),
  (:orgA, :admMgr,  'admin',   now(), true),
  (:orgB, :admMgr,  'manager', now(), true),
  (:orgA, :bothAdm, 'admin',   now(), true),
  (:orgB, :bothAdm, 'admin',   now(), true),
  (:orgA, :mgrVwr,  'manager', now(), true),
  (:orgB, :mgrVwr,  'viewer',  now(), true),
  (:orgA, :bothMgr, 'manager', now(), true),
  (:orgB, :bothMgr, 'manager', now(), true);

-- fx names the fixture rows (key, id).
create temp table fx (k text primary key, id uuid);
insert into public.org_connections (id, organization_id, provider_id, status) values
  (:connA,  :orgA, 'quickbooks', 'active'),
  (:connB,  :orgB, 'quickbooks', 'active'),
  (:connA2, :orgA, 'easypost',   'pending');
insert into fx values ('connA', :connA), ('connB', :connB), ('connA2', :connA2);
do $f$
declare
  v uuid; e uuid;
  o record;
begin
  -- Made-up secrets, named as connector_secret_put names them.
  insert into fx values ('secA', vault.create_secret('{"accessToken":"b465-made-up-a","refreshToken":"","expiresAt":""}',
                                                     'connector:04650000-0000-0000-0000-0000000000c1', 'connector secret'));
  insert into fx values ('secB', vault.create_secret('{"accessToken":"b465-made-up-b","refreshToken":"","expiresAt":""}',
                                                     'connector:04650000-0000-0000-0000-0000000000c2', 'connector secret'));
  insert into fx values ('secA2', vault.create_secret('{"apiKey":"b465-made-up-a2","accessToken":"b465-made-up-a2"}',
                                                      'connector:04650000-0000-0000-0000-00000000000a:easypost', 'connector secret'));
  insert into fx values ('secOther', vault.create_secret('{"x":"b465-made-up-other"}', 'b465-not-a-connector', 'b465 test'));
  update public.org_connections set secret_id = (select id from fx where k = 'secA') where id = '04650000-0000-0000-0000-0000000000c1';
  update public.org_connections set secret_id = (select id from fx where k = 'secB') where id = '04650000-0000-0000-0000-0000000000c2';

  for o in select * from (values ('A', '04650000-0000-0000-0000-00000000000a'::uuid, '04650000-0000-0000-0000-0000000000c1'::uuid),
                                 ('B', '04650000-0000-0000-0000-00000000000b'::uuid, '04650000-0000-0000-0000-0000000000c2'::uuid)) x(l, org, conn) loop
    insert into public.connection_mappings (connection_id, organization_id, entity_type, local_id, external_id)
      values (o.conn, o.org, 'supplier', gen_random_uuid(), 'B465-VENDOR-' || o.l) returning id into v;
    insert into fx values ('map' || o.l, v);
    insert into public.outbox_events (organization_id, topic, aggregate_type, payload)
      values (o.org, 'receipt.posted', 'receipt', '{}'::jsonb) returning id into e;
    insert into fx values ('evt' || o.l, e);
    insert into public.connection_sync_log (connection_id, organization_id, outbox_event_id, topic, status, attempts)
      values (o.conn, o.org, e, 'receipt.posted', 'dead', 8) returning id into v;
    insert into fx values ('log' || o.l, v);
  end loop;
end $f$;
create function pg_temp.fx(p_k text) returns uuid language sql stable as $$
  select id from fx where k = p_k
$$;

-- ══ Helpers (0387's, as 0423, 0462 and 0463 use them) ════════════════════
create function pg_temp.hint(p_hint text) returns text language sql immutable as $$
  select case when p_hint is null or p_hint = ''
                or p_hint like 'Grant the required privileges to the current role with:%'
              then '-' else p_hint end
$$;
-- One statement as p_as with p_sub's claims, then ALWAYS undone. 'ok:<rows>
-- [:<p_check>]' (p_check as the superuser, inside the undone subtransaction),
-- else '<sqlstate>:<hint or ->:<message>'. p_prep runs as the superuser first.
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
    raise exception using errcode = 'XX465', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XX465' then
    return 'ok:' || v_n::text || coalesce(':' || v_seen, '');
  end if;
  return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
end $$;
-- A SELECT's single value as p_as (always undone): 'v:<value>' or the error.
create function pg_temp.val(p_as text, p_sub uuid, p_sql text, p_prep text default null)
returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text; v_seen text; v_out text;
begin
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_as, true);
    perform set_config('role', p_as, true);
    execute p_sql into v_seen;
    perform set_config('role', 'none', true);
    v_out := 'v:' || coalesce(v_seen, 'null');
    raise exception using errcode = 'XX465', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XX465' then
    return v_out;
  end if;
  return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
end $$;

-- A connection row that names a secret it was not stored for (the guard's
-- update trigger off for this one statement, inside the undone attempt), for
-- the Vault read lines.
create function pg_temp.plant(p_conn uuid, p_secret uuid) returns void language plpgsql as $$
begin
  if exists (select 1 from pg_trigger
              where tgrelid = 'public.org_connections'::regclass and tgname = 'trg_zz_org_connections_secret_update') then
    alter table public.org_connections disable trigger trg_zz_org_connections_secret_update;
    update public.org_connections set secret_id = p_secret where id = p_conn;
    alter table public.org_connections enable trigger trg_zz_org_connections_secret_update;
  else
    update public.org_connections set secret_id = p_secret where id = p_conn;
  end if;
end $$;

create temp table persona (who text primary key, id uuid);
insert into persona (who, id) values
  ('own', :own), ('adm', :adm), ('mgr', :mgr), ('admVwr', :admVwr), ('admStf', :admStf), ('admMgr', :admMgr),
  ('bothAdm', :bothAdm), ('mgrVwr', :mgrVwr), ('bothMgr', :bothMgr);

-- The same statement for each named persona, each call undone:
-- 'who=<attempt>, who=<attempt>, ...'.
create function pg_temp.each(p_who text[], p_sql text, p_prep text default null, p_check text default null)
returns text language plpgsql as $$
declare v text := ''; w text;
begin
  foreach w in array p_who loop
    v := v || case when v = '' then '' else ', ' end || w || '='
           || pg_temp.attempt('authenticated', (select p.id from persona p where p.who = w), p_sql, p_prep, p_check);
  end loop;
  return v;
end $$;
-- What each() returns when every persona gets the same answer.
create function pg_temp.same(p_who text[], p_res text) returns text language sql immutable as $$
  select string_agg(w || '=' || p_res, ', ' order by o) from unnest(p_who) with ordinality u(w, o)
$$;

-- Who may change a row of A: the connection and sync log rules ask an admin
-- (owner and admin), the mapping rule a manager.
create temp table rank_of (rule text primary key, who text[]);
insert into rank_of values
  ('admin',   array['own', 'adm', 'admVwr', 'admStf', 'admMgr', 'bothAdm']),
  ('manager', array['own', 'adm', 'mgr', 'admVwr', 'admStf', 'admMgr', 'bothAdm', 'mgrVwr', 'bothMgr']);
create function pg_temp.who(p_rule text) returns text[] language sql stable as $$
  select who from rank_of where rule = p_rule
$$;

-- What the Z line compares: the rows of the three tables in the two
-- organizations, whole, and the fixture's Vault secrets by id and name.
create function pg_temp.state() returns text language plpgsql stable as $$
declare v text := ''; t text; s text;
begin
  foreach t in array array['org_connections', 'connection_mappings', 'connection_sync_log', 'outbox_events'] loop
    execute format($q$select coalesce(string_agg(x.id::text || '/' || md5(row_to_json(x)::text), ',' order by x.id), '-')
                        from public.%I x where x.organization_id in (%L, %L)$q$,
                   t, '04650000-0000-0000-0000-00000000000a', '04650000-0000-0000-0000-00000000000b')
      into s;
    v := v || t || ':' || s || ' # ';
  end loop;
  select coalesce(string_agg(s.id::text || '/' || s.name, ',' order by s.id), '-') into s
    from vault.secrets s where s.id in (select id from fx where k like 'sec%');
  return v || 'vault:' || s;
end $$;
create temp table snap as select pg_temp.state() as v;

-- ══ F. The fixture ════════════════════════════════════════════════════════
select is(
  (select string_agg(p.who || ':' || coalesce(ma.role, '-') || '/' || coalesce(mb.role, '-'), ' ' order by p.who collate "C")
     from persona p
     left join public.organization_members ma on ma.user_id = p.id and ma.organization_id = :orgA
     left join public.organization_members mb on mb.user_id = p.id and mb.organization_id = :orgB),
  'adm:admin/- admMgr:admin/manager admStf:admin/staff admVwr:admin/viewer bothAdm:admin/admin bothMgr:manager/manager '
  || 'mgr:manager/- mgrVwr:manager/viewer own:owner/-',
  'F1: each persona''s rank in organization A and in organization B');
select is(
  (select string_agg(c.provider_id || ':' || c.organization_id::text || ':' || coalesce((c.secret_id = s.id)::text, 'none')
                     || ':' || coalesce(s.name, '-'), ', ' order by c.id)
     from public.org_connections c left join vault.secrets s on s.id = c.secret_id
    where c.organization_id in (:orgA, :orgB)),
  'quickbooks:04650000-0000-0000-0000-00000000000a:true:connector:04650000-0000-0000-0000-0000000000c1, '
  || 'quickbooks:04650000-0000-0000-0000-00000000000b:true:connector:04650000-0000-0000-0000-0000000000c2, '
  || 'easypost:04650000-0000-0000-0000-00000000000a:none:-',
  'F2: A''s and B''s QuickBooks connections name the Vault secret stored for each; A''s EasyPost connection names none yet');

-- ══ S. A connection's secret ══════════════════════════════════════════════
select is(
  pg_temp.each(pg_temp.who('admin'), format('update public.org_connections set secret_id = %L where id = %L', pg_temp.fx('secB'), :connA)),
  pg_temp.same(pg_temp.who('admin'), '42501:-:A connection''s stored secret is set by the server only.'),
  'S1: A''s connection pointed at B''s stored secret, by every rank that may change it (admin, and admin of A with any rank in B): refused 42501');
select is(
  pg_temp.each(pg_temp.who('admin'), format('update public.org_connections set secret_id = %L where id = %L', pg_temp.fx('secA'), :connA),
               format('update public.org_connections set secret_id = null where id = %L', :connA))
  || ' / ' || pg_temp.each(array['adm'], format('update public.org_connections set secret_id = %L where id = %L', gen_random_uuid(), :connA)),
  pg_temp.same(pg_temp.who('admin'), '42501:-:A connection''s stored secret is set by the server only.')
  || ' / adm=42501:-:A connection''s stored secret is set by the server only.',
  'S2: a member never sets a connection''s secret_id, not even back to its own stored secret, nor to any other id: refused 42501');
select is(
  pg_temp.attempt('authenticated', :adm, format($q$insert into public.org_connections (organization_id, provider_id, status, secret_id)
     values (%L, 'zendesk', 'pending', %L)$q$, :orgA, pg_temp.fx('secB')))
  || ' / ' || pg_temp.attempt('authenticated', :bothAdm, format($q$insert into public.org_connections (organization_id, provider_id, status, secret_id)
     values (%L, 'quickbooks', 'pending', %L)
     on conflict (organization_id, provider_id) do update set secret_id = excluded.secret_id$q$, :orgA, pg_temp.fx('secB'))),
  '42501:-:A connection''s stored secret is set by the server only.'
  || ' / 42501:-:A connection''s stored secret is set by the server only.',
  'S3: a new connection of A naming a stored secret, and an upsert onto A''s connection that names one: refused 42501');
select is(
  -- disconnect (ConnectionsService.disconnect): status, secret_id NULL, oauth_state; asks for the row back
  pg_temp.each(array['own', 'adm', 'bothAdm'],
    format($q$update public.org_connections set status = 'disconnected', secret_id = null, oauth_state = null
               where organization_id = %L and provider_id = 'quickbooks' returning id$q$, :orgA),
    null, format('select (secret_id is null and status = %L)::text from public.org_connections where id = %L', 'disconnected', :connA))
  -- the OAuth connect upsert (beginConnect), the API-key row write and the Zendesk subdomain save
  || ' / ' || pg_temp.each(array['adm', 'admVwr'],
    format($q$insert into public.org_connections (organization_id, provider_id, status, oauth_state, settings, created_by)
               values (%L, 'quickbooks', 'pending', 'b465-state', '{"env":"sandbox"}', %L)
               on conflict (organization_id, provider_id) do update set organization_id = excluded.organization_id,
                 provider_id = excluded.provider_id, status = excluded.status, oauth_state = excluded.oauth_state,
                 settings = excluded.settings, created_by = excluded.created_by returning id$q$, :orgA, :adm),
    null, format('select (secret_id = %L)::text from public.org_connections where id = %L', pg_temp.fx('secA'), :connA))
  || ' / ' || pg_temp.each(array['own'],
    format($q$insert into public.org_connections (organization_id, provider_id, created_by) values (%L, 'easypost', %L)
               on conflict (organization_id, provider_id) do update set organization_id = excluded.organization_id,
                 provider_id = excluded.provider_id, created_by = excluded.created_by returning id$q$, :orgA, :own))
  || ' / ' || pg_temp.each(array['adm'],
    format($q$insert into public.org_connections (organization_id, provider_id, external_account_id, settings, created_by)
               values (%L, 'zendesk', 'b465sub', '{"subdomain":"b465sub"}', %L)
               on conflict (organization_id, provider_id) do update set organization_id = excluded.organization_id,
                 provider_id = excluded.provider_id, external_account_id = excluded.external_account_id,
                 settings = excluded.settings, created_by = excluded.created_by$q$, :orgA, :adm))
  -- the account mapping save (settings only)
  || ' / ' || pg_temp.each(array['adm'],
    format($q$update public.org_connections set settings = '{"accountIds":{"ap":"33"}}' where id = %L and organization_id = %L returning id$q$, :connA, :orgA)),
  'own=ok:1:true, adm=ok:1:true, bothAdm=ok:1:true / adm=ok:1:true, admVwr=ok:1:true / own=ok:1 / adm=ok:1 / adm=ok:1',
  'S4: a member''s own connection writes (disconnect clearing secret_id, the connect and Zendesk upserts, a settings save) are as before, and keep the stored secret');
select is(
  -- an OAuth callback / activateConnection after the secret was put for the row (row cleared first, as a reconnect)
  pg_temp.attempt('service_role', null,
    format($q$update public.org_connections set status = 'active', secret_id = %L, oauth_state = null, last_connected_at = now()
               where id = %L and organization_id = %L$q$, pg_temp.fx('secA'), :connA, :orgA),
    format('update public.org_connections set secret_id = null, status = %L where id = %L', 'pending', :connA),
    format('select (secret_id = %L)::text from public.org_connections where id = %L', pg_temp.fx('secA'), :connA))
  -- a first API-key secret named for the organization and provider (the older name)
  || ' / ' || pg_temp.attempt('service_role', null,
    format($q$update public.org_connections set status = 'active', secret_id = %L where id = %L$q$, pg_temp.fx('secA2'), :connA2))
  -- a token refresh writing back the same id
  || ' / ' || pg_temp.attempt('service_role', null,
    format($q$update public.org_connections set secret_id = %L, updated_at = now() where id = %L$q$, pg_temp.fx('secA'), :connA)),
  'ok:1:true / ok:1 / ok:1',
  'S5: the service role sets a connection''s secret_id to the Vault secret stored for it (either name), and writes the same id back');
select is(
  pg_temp.attempt('service_role', null, format('update public.org_connections set secret_id = %L where id = %L', pg_temp.fx('secB'), :connA))
  || ' / ' || pg_temp.attempt('service_role', null, format('update public.org_connections set secret_id = %L where id = %L', pg_temp.fx('secOther'), :connA))
  || ' / ' || pg_temp.attempt('service_role', null, format('update public.org_connections set secret_id = %L where id = %L', gen_random_uuid(), :connA))
  || ' / ' || pg_temp.attempt('service_role', null, format('update public.org_connections set secret_id = %L where id = %L', pg_temp.fx('secA'), :connA2))
  || ' / ' || pg_temp.attempt('service_role', null, format($q$insert into public.org_connections (organization_id, provider_id, status, secret_id)
       values (%L, 'zendesk', 'active', %L)$q$, :orgA, pg_temp.fx('secB'))),
  '42501:-:A connection names only a secret stored for it.'
  || ' / 42501:-:A connection names only a secret stored for it.'
  || ' / 42501:-:A connection names only a secret stored for it.'
  || ' / 42501:-:A connection names only a secret stored for it.'
  || ' / 42501:-:A connection names only a secret stored for it.',
  'S6: the service role naming another organization''s secret, a secret that is not a connector secret, no secret, or another connection''s secret: refused 42501');

-- A SECURITY DEFINER body owned by postgres, called by an owner of A only:
-- the stored-secret check holds every role but the API roles' refusal.
create function public.b465_definer_secret(p_conn uuid, p_secret uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.org_connections set secret_id = p_secret where id = p_conn;
end $$;
revoke all on function public.b465_definer_secret(uuid, uuid) from public, anon;
grant execute on function public.b465_definer_secret(uuid, uuid) to authenticated;
select is(
  pg_temp.attempt('authenticated', :own, format('select public.b465_definer_secret(%L, %L)', :connA, pg_temp.fx('secB')))
  || ' / ' || pg_temp.attempt('authenticated', :own, format('select public.b465_definer_secret(%L, %L)', :connA, pg_temp.fx('secA')),
                              format('update public.org_connections set secret_id = null where id = %L', :connA),
                              format('select (secret_id = %L)::text from public.org_connections where id = %L', pg_temp.fx('secA'), :connA)),
  '42501:-:A connection names only a secret stored for it. / ok:1:true',
  'S7: a SECURITY DEFINER body owned by postgres sets only the Vault secret stored for the connection');
drop function public.b465_definer_secret(uuid, uuid);

select is(
  pg_temp.val('service_role', null, format($q$select (public.connector_secret_get(%L) ->> 'accessToken' = 'b465-made-up-a')::text$q$, pg_temp.fx('secA')))
  || ' / ' || pg_temp.val('service_role', null, format($q$select (public.connector_secret_get(%L) ->> 'apiKey' = 'b465-made-up-a2')::text$q$, pg_temp.fx('secA2')),
                          format('select pg_temp.plant(%L, %L)', :connA2, pg_temp.fx('secA2')))
  -- while a row of A names B's secret, B's secret is decrypted for no one
  || ' / ' || pg_temp.val('service_role', null, format('select (public.connector_secret_get(%L) is null)::text', pg_temp.fx('secB')),
                          format('select pg_temp.plant(%L, %L)', :connA, pg_temp.fx('secB')))
  || ' / ' || pg_temp.val('service_role', null, format('select (public.connector_secret_get(%L) is null)::text', pg_temp.fx('secOther'))),
  'v:true / v:true / v:true / v:true',
  'S8: connector_secret_get decrypts a connection''s own stored secret (either name), and not a secret another organization''s connection names, nor a secret that is not a connector secret');
select is(
  -- a secret B's connection still names stays
  pg_temp.attempt('service_role', null, format('select public.connector_secret_delete(%L)', pg_temp.fx('secB')),
    format('select pg_temp.plant(%L, null)', :connA),
    format('select count(*)::text from vault.secrets where id = %L', pg_temp.fx('secB')))
  || ' / ' || pg_temp.attempt('service_role', null, format('select public.connector_secret_delete(%L)', pg_temp.fx('secOther')), null,
    format('select count(*)::text from vault.secrets where id = %L', pg_temp.fx('secOther')))
  -- B's own disconnect: the row is cleared first, then its secret goes
  || ' / ' || pg_temp.attempt('service_role', null, format('select public.connector_secret_delete(%L)', pg_temp.fx('secB')),
    format('update public.org_connections set status = %L, secret_id = null where id = %L', 'disconnected', :connB),
    format('select count(*)::text from vault.secrets where id = %L', pg_temp.fx('secB'))),
  'ok:1:1 / ok:1:1 / ok:1:0',
  'S9: connector_secret_delete keeps a secret a connection still names, and a secret that is not a connector secret; a disconnect that cleared its row removes its secret');
select is(
  pg_temp.attempt('authenticated', :own, format('select public.connector_secret_get(%L)', pg_temp.fx('secA')))
  || ' / ' || pg_temp.attempt('authenticated', :own, format('select public.connector_secret_delete(%L)', pg_temp.fx('secA')))
  || ' / ' || pg_temp.attempt('authenticated', :own, format('select public.connection_secret_is_own(%L, %L, %L, %L)', pg_temp.fx('secA'), :connA, :orgA, 'quickbooks'))
  || ' / ' || pg_temp.attempt('anon', null, format('select public.connection_secret_is_own(%L, %L, %L, %L)', pg_temp.fx('secA'), :connA, :orgA, 'quickbooks'))
  || ' / ' || pg_temp.val('authenticated', :adm, format('select (secret_id = %L)::text from public.org_connections where id = %L', pg_temp.fx('secA'), :connA)),
  '42501:-:permission denied for function connector_secret_get'
  || ' / 42501:-:permission denied for function connector_secret_delete'
  || ' / 42501:-:permission denied for function connection_secret_is_own'
  || ' / 42501:-:permission denied for function connection_secret_is_own'
  || ' / v:true',
  'S10: no member calls the Vault reads or the stored-secret check; a member of A reads its connection''s secret_id handle (disconnect, labels and the Intacct import read it)');

-- The token refresh (drainer, cron drain-outbox and Intacct import), as the
-- service role: read the row's secret, put the refreshed secret under
-- 'connector:<connection id>', and write the id back when it changed. For a
-- connection whose live secret carries 'connector:<organization id>:<provider>',
-- the put creates the secret named for the connection and the row moves to it.
create function public.b465_refresh(p_conn uuid) returns text
language plpgsql security invoker set search_path = public as $$
declare v_old uuid; v_new uuid; v_s jsonb;
begin
  select secret_id into v_old from public.org_connections where id = p_conn;
  v_s := public.connector_secret_get(v_old);
  if v_s is null then
    return 'connector secret not found';
  end if;
  v_new := public.connector_secret_put(v_s || '{"accessToken":"b465-rotated-a2"}'::jsonb, 'connector:' || p_conn::text);
  if v_new is distinct from v_old then
    update public.org_connections set secret_id = v_new, updated_at = now() where id = p_conn;
  end if;
  return 'new_is_old=' || (v_new = v_old)::text
      || ' row_names_new=' || (select (c.secret_id = v_new)::text from public.org_connections c where c.id = p_conn)
      || ' new_name_is_connection=' || (select (s.name = 'connector:' || p_conn::text)::text from vault.secrets s where s.id = v_new)
      || ' new_reads=' || (public.connector_secret_get(v_new) ->> 'accessToken' = 'b465-rotated-a2')::text
      || ' old_named=' || (select count(*)::text from public.org_connections c where c.secret_id = v_old);
end $$;
revoke all on function public.b465_refresh(uuid) from public, anon, authenticated;
grant execute on function public.b465_refresh(uuid) to service_role;
select is(
  pg_temp.val('service_role', null, format('select public.b465_refresh(%L)', :connA2),
              format($q$update public.org_connections set secret_id = %L, status = 'active' where id = %L$q$, pg_temp.fx('secA2'), :connA2)),
  'v:new_is_old=false row_names_new=true new_name_is_connection=true new_reads=true old_named=0',
  'S11: a token refresh as the service role moves a connection from its organization-and-provider secret to the secret named for the connection; the row reads the new secret through connector_secret_get and no connection names the old one');
drop function public.b465_refresh(uuid);

-- ══ M. Mappings ═══════════════════════════════════════════════════════════
select is(
  pg_temp.each(pg_temp.who('manager'), format($q$insert into public.connection_mappings (connection_id, organization_id, entity_type, local_id, external_id)
     values (%L, %L, 'supplier', gen_random_uuid(), 'B465-EVIL')$q$, :connB, :orgA)),
  pg_temp.same(pg_temp.who('manager'), '42501:-:new row violates row-level security policy for table "connection_mappings"'),
  'M1: a mapping of A naming B''s connection, by every rank that may write A''s mappings (manager, and members of both): refused 42501');
select is(
  pg_temp.each(pg_temp.who('manager'), format('update public.connection_mappings set connection_id = %L where id = %L', :connB, pg_temp.fx('mapA'))),
  pg_temp.same(pg_temp.who('manager'), '42501:-:new row violates row-level security policy for table "connection_mappings"'),
  'M2: A''s mapping pointed at B''s connection, by every rank that may change it: refused 42501');
select is(
  pg_temp.attempt('authenticated', :bothMgr, format($q$insert into public.connection_mappings (connection_id, organization_id, entity_type, local_id, external_id)
     values (%L, %L, 'supplier', %L, 'B465-EVIL')
     on conflict (connection_id, entity_type, local_id) do update set external_id = excluded.external_id$q$, :connB, :orgA, gen_random_uuid()))
  || ' / ' || pg_temp.attempt('authenticated', :admMgr, format($q$insert into public.connection_mappings (id, connection_id, organization_id, entity_type, external_id)
     values (%L, %L, %L, 'supplier', 'B465-VENDOR-A')
     on conflict (id) do update set connection_id = excluded.connection_id$q$, pg_temp.fx('mapA'), :connB, :orgA)),
  '42501:-:new row violates row-level security policy for table "connection_mappings"'
  || ' / 42501:-:new row violates row-level security policy for table "connection_mappings"',
  'M3: an upsert of a mapping of A that names B''s connection, new or onto A''s mapping: refused 42501');
select is(
  pg_temp.each(array['mgr', 'bothMgr'], format($q$insert into public.connection_mappings (connection_id, organization_id, entity_type, local_id, external_id)
     values (%L, %L, 'supplier', gen_random_uuid(), 'B465-NEW')$q$, :connA, :orgA))
  || ' / ' || pg_temp.each(array['mgr', 'admVwr'], format($q$update public.connection_mappings set external_id = 'B465-VENDOR-A2', external_meta = '{"n":1}',
     connection_id = %L, organization_id = %L where id = %L$q$, :connA, :orgA, pg_temp.fx('mapA')))
  || ' / ' || pg_temp.each(array['mgrVwr'], format($q$insert into public.connection_mappings (connection_id, organization_id, entity_type, local_id, external_id)
     values (%L, %L, 'supplier', (select local_id from public.connection_mappings where id = %L), 'B465-VENDOR-A3')
     on conflict (connection_id, entity_type, local_id) do update set external_id = excluded.external_id$q$, :connA, :orgA, pg_temp.fx('mapA')))
  || ' / ' || pg_temp.each(array['mgr'], format('delete from public.connection_mappings where id = %L', pg_temp.fx('mapA')))
  -- the drainer's write (service role): upsert on (connection_id, entity_type, local_id)
  || ' / ' || pg_temp.attempt('service_role', null, format($q$insert into public.connection_mappings (connection_id, organization_id, entity_type, local_id, external_id, external_meta, updated_at)
     values (%L, %L, 'bill', gen_random_uuid(), 'B465-BILL', '{}', now())
     on conflict (connection_id, entity_type, local_id) do update set external_id = excluded.external_id$q$, :connA, :orgA)),
  'mgr=ok:1, bothMgr=ok:1 / mgr=ok:1, admVwr=ok:1 / mgrVwr=ok:1 / mgr=ok:1 / ok:1',
  'M4: mappings of A naming A''s connection (insert, edit, upsert, delete), and the drainer''s upsert as the service role: as before');

-- ══ L. Sync log entries ═══════════════════════════════════════════════════
select is(
  pg_temp.each(pg_temp.who('admin'), format($q$update public.connection_sync_log set connection_id = %L, status = 'pending', attempts = 99 where id = %L$q$,
                                            :connB, pg_temp.fx('logA'))),
  pg_temp.same(pg_temp.who('admin'), '42501:-:new row violates row-level security policy for table "connection_sync_log"'),
  'L1: A''s sync log entry pointed at B''s connection, by every rank that may re-queue it (admin, and admin of A with any rank in B): refused 42501');
select is(
  pg_temp.each(pg_temp.who('admin'), format($q$update public.connection_sync_log set outbox_event_id = %L, status = 'pending', attempts = 99 where id = %L$q$,
                                            pg_temp.fx('evtB'), pg_temp.fx('logA'))),
  pg_temp.same(pg_temp.who('admin'), '42501:-:new row violates row-level security policy for table "connection_sync_log"'),
  'L2: A''s sync log entry pointed at B''s queued event, by every rank that may re-queue it: refused 42501');
select is(
  -- the replay (ConnectionsService.replaySync)
  pg_temp.each(array['own', 'adm', 'bothAdm'], format($q$update public.connection_sync_log set status = 'pending', attempts = 0, next_attempt_at = null,
     last_error = null, updated_at = now() where id = %L and organization_id = %L and status in ('error', 'dead') returning id$q$, pg_temp.fx('logA'), :orgA),
     null, format('select status || %L || attempts from public.connection_sync_log where id = %L', '/', pg_temp.fx('logA')))
  -- the drainer's writes (service role): the pending upsert and the terminal update
  || ' / ' || pg_temp.attempt('service_role', null, format($q$insert into public.connection_sync_log (connection_id, organization_id, outbox_event_id, topic, status, attempts, updated_at)
     values (%L, %L, %L, 'receipt.posted', 'pending', 9, now())
     on conflict (connection_id, outbox_event_id) do update set status = excluded.status, attempts = excluded.attempts$q$,
     :connA, :orgA, pg_temp.fx('evtA')))
  || ' / ' || pg_temp.attempt('service_role', null, format($q$update public.connection_sync_log set status = 'success', completed_at = now(), external_id = 'B465-X'
     where id = %L$q$, pg_temp.fx('logA'))),
  'own=ok:1:pending/0, adm=ok:1:pending/0, bothAdm=ok:1:pending/0 / ok:1 / ok:1',
  'L3: the replay of a failed entry of A by its admins, and the drainer''s writes as the service role: as before');

-- ══ P. The bodies the lines rely on ═══════════════════════════════════════
select is(
  (select string_agg(p.oid::regprocedure::text || '|' || md5(p.prosrc) || '|' || p.prosecdef::text || '|' || p.provolatile::text
                     || '|' || coalesce(array_to_string(p.proconfig, ','), '-') || '|' || pg_get_userbyid(p.proowner)
                     || '|' || has_function_privilege('anon', p.oid, 'execute')::text
                     || '|' || has_function_privilege('authenticated', p.oid, 'execute')::text
                     || '|' || has_function_privilege('service_role', p.oid, 'execute')::text, E'\n' order by p.proname collate "C")
     from pg_proc p
    where p.oid in (to_regprocedure('public.connection_in_org(uuid,uuid)'), to_regprocedure('public.outbox_event_in_org(uuid,uuid)'),
                    to_regprocedure('public.connection_secret_is_own(uuid,uuid,uuid,text)'), to_regprocedure('public.tg_org_connection_secret_set()'))),
  'connection_in_org(uuid,uuid)|' || '6de7a0eb1d52ef74' || '8362d1342b974cfc' || '|true|s|search_path=public|postgres|false|true|true' || E'\n'
  || 'connection_secret_is_own(uuid,uuid,uuid,text)|' || 'eb1edddd77a27e42' || 'abeec353c0cfb18e' || '|true|s|search_path=public|postgres|false|false|true' || E'\n'
  || 'outbox_event_in_org(uuid,uuid)|' || '209e415ef3a2fde8' || 'bfc5aff89fb8b49c' || '|true|s|search_path=public|postgres|false|true|true' || E'\n'
  || 'tg_org_connection_secret_set()|' || '6a7866aa1b9f1b3b' || '69142c80ed52d1e2' || '|false|v|search_path=public|postgres|false|false|false',
  'P1: the helpers are SECURITY DEFINER and stable with search_path public, owned by postgres (connection_in_org and outbox_event_in_org executable by authenticated and service_role, connection_secret_is_own by service_role only); the trigger function is SECURITY INVOKER and executable by no API role');
select is(
  (select string_agg(p.oid::regprocedure::text || '|' || md5(p.prosrc) || '|' || p.prosecdef::text
                     || '|' || coalesce(array_to_string(p.proconfig, ','), '-') || '|' || pg_get_userbyid(p.proowner)
                     || '|' || has_function_privilege('anon', p.oid, 'execute')::text
                     || '|' || has_function_privilege('authenticated', p.oid, 'execute')::text
                     || '|' || has_function_privilege('service_role', p.oid, 'execute')::text, E'\n' order by p.proname collate "C")
     from pg_proc p
    where p.oid in ('public.connector_secret_get(uuid)'::regprocedure, 'public.connector_secret_delete(uuid)'::regprocedure)),
  'connector_secret_delete(uuid)|' || '463cebb31da386d0' || '6a3a3768694d9d77' || '|true|search_path=public, vault|postgres|false|false|true' || E'\n'
  || 'connector_secret_get(uuid)|' || 'ddae4dc1c3abac5b' || '4de5b005e11a9f67' || '|true|search_path=public, vault|postgres|false|false|true',
  'P2: connector_secret_get and connector_secret_delete are the bodies S8 and S9 prove, SECURITY DEFINER with search_path public, vault, owned by postgres, executable by service_role only');
select is(
  (select string_agg(t.tgname || ':' || t.tgtype::text || ':' || t.tgenabled::text || ':' || pg_get_triggerdef(t.oid), E'\n' order by t.tgname)
     from pg_trigger t where t.tgfoid = to_regprocedure('public.tg_org_connection_secret_set()')),
  'trg_zz_org_connections_secret_insert:7:O:CREATE TRIGGER trg_zz_org_connections_secret_insert BEFORE INSERT ON public.org_connections'
  || ' FOR EACH ROW WHEN ((new.secret_id IS NOT NULL)) EXECUTE FUNCTION tg_org_connection_secret_set()' || E'\n'
  || 'trg_zz_org_connections_secret_update:19:O:CREATE TRIGGER trg_zz_org_connections_secret_update BEFORE UPDATE ON public.org_connections'
  || ' FOR EACH ROW WHEN (((new.secret_id IS DISTINCT FROM old.secret_id) AND (new.secret_id IS NOT NULL))) EXECUTE FUNCTION tg_org_connection_secret_set()',
  'P3: the stored-secret guard is bound twice on org_connections and nowhere else: BEFORE INSERT when secret_id is set, BEFORE UPDATE when it changes to a secret');
create temp table p_rules (tbl text primary key, v text);
-- Deparsed as the migration's preflight does it: search_path pinned inside
-- a block that is always undone (variables keep their values).
do $p4$
declare t text; v text;
begin
  foreach t in array array['public.connection_mappings', 'public.connection_sync_log'] loop
    v := null;
    begin
      perform set_config('search_path', 'public, extensions', true);
      select string_agg(pol.polname || '|' || pol.polcmd::text || '|' || pol.polpermissive::text || '|'
                        || (select string_agg(case x when 0 then 'public' else x::regrole::text end, ',' order by 1) from unnest(pol.polroles) x)
                        || '|' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '-')
                        || '|' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '-'), E'\n' order by pol.polname)
        into v from pg_policy pol where pol.polrelid = to_regclass(t) and pol.polcmd in ('a', 'w', '*');
      raise exception using errcode = 'XX465', message = 'undo';
    exception when sqlstate 'XX465' then
      null;
    end;
    insert into p_rules values (t, md5(coalesce(v, '')));
  end loop;
end $p4$;
select is(
  (select string_agg(tbl || '=' || v, ', ' order by tbl) from p_rules),
  'public.connection_mappings=' || 'd5dd21530640dd1d' || '83afa52b9e67f42a' || ', public.connection_sync_log=' || '6dc621dbbe341739' || '48c34cd994360e62',
  'P4: the mapping and sync log write rules are the ones M and L prove (md5 of their deparse)');
select is(
  (select md5(p.prosrc) || '|' || (select string_agg(t.tgrelid::regclass::text, ',' order by t.tgrelid::regclass::text collate "C")
                                     from pg_trigger t where t.tgfoid = p.oid)
     from pg_proc p where p.oid = to_regprocedure('public.tg_organization_id_fixed()')),
  '9054291fa6f24646' || 'ece8de5570134e38' || '|api_keys,bins,categories,charters,connection_mappings,connection_sync_log,customers,'
  || 'integration_endpoints,locations,org_connections,outbox_events,public_request_links,suppliers,warehouses',
  'P5: tg_organization_id_fixed and its fourteen bindings are unchanged');

-- ══ Z. Nothing left changed ═══════════════════════════════════════════════
select is(pg_temp.state(), (select v from snap),
  'Z1: the refused writes and the undone attempts left every connection, mapping, sync log entry and queued event of both organizations, and the fixture''s Vault secrets, as they were');

select * from finish();
rollback;
