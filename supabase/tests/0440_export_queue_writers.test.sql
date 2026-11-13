-- supabase/tests/0440_export_queue_writers.test.sql
-- Class guard (docket S67): who may write the connector tables. The export
-- queue is the service role's alone (publish_outbox_service_role_only); the
-- other tables still carry member write rules that a separate change
-- replaces, and they are listed below by name, so a new one fails here and
-- the list can be emptied when that change lands. The tables:
--   outbox_events          the export queue the connector drain reads
--   connection_sync_log    the drain's delivery ledger
--   connection_mappings    the drain's StockPilot-to-provider id map
--   integration_deliveries the webhook delivery queue
--   org_connections        an organization's connections to providers
--   integration_endpoints  an organization's webhook endpoints
--   carrier_shipments      shipments bought through the carrier connection
--
-- G0. Vacuity: the seven tables exist, and the body scan finds the queue's
--     own writer (publish_outbox) when it ignores grants, so the scan reads
--     real code.
-- G1. No function outside the system schemas whose body inserts into,
--     updates, deletes from or merges into one of the tables is executable
--     by anon or authenticated (directly or through PUBLIC). Trigger
--     functions are left out: they cannot be called through /rpc.
-- G2. No VOLATILE function executable by anon or authenticated names one of
--     the tables at all (the net for a write G1's pattern does not read,
--     such as one built as dynamic SQL from the table's name).
-- G3. No INSERT, UPDATE, DELETE or ALL rule on the tables applies to anon,
--     authenticated or PUBLIC, except the rules in the allowlist below, each
--     with its reason.
-- G4. Every allowlist entry is still such a rule, so the list cannot rot:
--     when a later change drops or replaces one, this fails until the list
--     follows.
-- G5. Row security is on for all seven.
-- G6. No trigger function outside the system schemas names outbox_events at
--     all (a plain write, dynamic SQL built from the name, a quoted
--     identifier), names publish_outbox, or names any other function whose
--     body names outbox_events (one level of indirection). G1 leaves trigger
--     functions out, since they cannot be called through /rpc; a trigger on
--     a table members write would still put rows in the queue on their
--     behalf.
-- G7. The functions whose body writes outbox_events, whoever may execute
--     them, are exactly publish_outbox, so a new writer (a definer helper
--     among them) shows up here as a changed list.
-- C1-C3. Controls: planted probes, always undone, that each detector must
--     report (each control reads only its probes' lines, so it stays true on
--     a day the guard itself is red): a definer function granted to authenticated that inserts into
--     outbox_events and an invoker one that deletes from connection_sync_log
--     (G1), a function that builds its write from the table's name (G2), and
--     an insert rule for authenticated on outbox_events and an update rule
--     for PUBLIC on integration_deliveries (G3).
-- C5. Control: a trigger function that inserts into outbox_events and one
--     that calls publish_outbox, planted and undone, are both reported by
--     G6.
-- C6. Control: trigger functions that write the queue through dynamic SQL
--     built from the table's name, through a quoted identifier, and by
--     calling a planted helper function that writes it, planted and undone,
--     are each reported by G6.
-- C7. Control: with that helper planted, G7's list changes.
--
-- Catalog only: no fixtures, no roles switched. begin/rollback.

begin;

select plan(15);

-- == The tables, the allowlist, the detectors ===============================
create temporary table s67_q (tbl text) on commit drop;
insert into s67_q values ('outbox_events'), ('connection_sync_log'), ('connection_mappings'), ('integration_deliveries'),
  ('org_connections'), ('integration_endpoints'), ('carrier_shipments');

-- Member write rules that are allowed for now, each with its reason. Keep
-- the reason: an entry without one is a finding in itself.
create temporary table s67_rule_allow (tbl text, polname text, why text not null) on commit drop;
insert into s67_rule_allow values
  ('connection_mappings', 'connection_mappings_write',
   'A manager writes the provider id map (0146); a separate change replaces this rule.'),
  ('connection_sync_log', 'connection_sync_log_admin_replay',
   'An admin sets a sync row back to pending to have it sent again (0152); a separate change replaces this rule.'),
  ('org_connections', 'org_connections_write',
   'An admin writes the organization''s connection rows (0146); a separate change replaces this rule.'),
  ('integration_endpoints', 'integration_endpoints_admin_all',
   'An admin writes the organization''s webhook endpoints (0169); a separate change replaces this rule.'),
  ('carrier_shipments', 'carrier_shipments_write',
   'A manager writes shipment rows of the carrier connection (0149); a separate change replaces this rule.');

-- Each detector returns one line per finding; list() joins them ('none' for
-- no line), optionally only the lines that contain p_like.
create function pg_temp.list(p_sql text, p_like text default null) returns text language plpgsql as $$
declare v text;
begin
  execute format('select coalesce(string_agg(x, %L order by x collate "C"), %L) from (%s) t(x) where %L is null or position(%L in x) > 0',
                 ', ', 'none', p_sql, p_like, p_like) into v;
  return v;
end $$;

-- G1's detector: '<schema>.<function>(<args>)' for every non-trigger function
-- outside the system schemas whose body writes one of the tables, executable
-- by anon or authenticated when p_api (PUBLIC reaches both).
create function pg_temp.q_writers(p_api boolean) returns setof text language sql stable as $$
  select format('%I.%I(%s)', n.nspname, p.proname, oidvectortypes(p.proargtypes))
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
     and p.prokind in ('f', 'p')
     and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
     and p.prosrc ~* '(insert\s+into|update|delete\s+from|merge\s+into)\s+(only\s+)?(public\.)?(outbox_events|connection_sync_log|connection_mappings|integration_deliveries|org_connections|integration_endpoints|carrier_shipments)\M'
     and (not p_api
          or has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute'))
$$;

-- G2's detector: VOLATILE non-trigger functions executable by anon or
-- authenticated whose body names one of the tables anywhere.
create function pg_temp.q_namers() returns setof text language sql stable as $$
  select format('%I.%I(%s)', n.nspname, p.proname, oidvectortypes(p.proargtypes))
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
     and p.prokind in ('f', 'p')
     and p.provolatile = 'v'
     and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
     and p.prosrc ~* '(outbox_events|connection_sync_log|connection_mappings|integration_deliveries|org_connections|integration_endpoints|carrier_shipments)'
     and (has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute'))
$$;

-- G3's detector: '<table>.<rule>' for every INSERT, UPDATE, DELETE or ALL
-- rule on the tables that applies to anon, authenticated or PUBLIC, the
-- allowlist left out when p_allow.
create function pg_temp.q_rules(p_allow boolean) returns setof text language sql stable as $$
  select c.relname || '.' || pol.polname
    from pg_policy pol
    join pg_class c on c.oid = pol.polrelid
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
   where c.relname in (select tbl from s67_q)
     and pol.polcmd in ('a', 'w', 'd', '*')
     and pol.polroles && array[0::oid, 'anon'::regrole::oid, 'authenticated'::regrole::oid]
     and not (p_allow and exists (select 1 from s67_rule_allow a where a.tbl = c.relname and a.polname = pol.polname))
$$;

-- Functions other than trigger functions, outside the system schemas, whose
-- body names outbox_events: the queue's writers and readers.
create function pg_temp.q_queue_fns() returns table (sig text, fname text) language sql stable as $$
  select format('%I.%I(%s)', n.nspname, p.proname, oidvectortypes(p.proargtypes)), p.proname::text
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
     and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
     and p.prosrc ~* 'outbox_events'
$$;

-- G6's detector: '<schema>.<function>(<args>)' for every trigger or event
-- trigger function outside the system schemas whose body names
-- outbox_events anywhere, names publish_outbox, or names a function of
-- q_queue_fns(), whoever may execute it.
create function pg_temp.q_trigger_writers() returns setof text language sql stable as $$
  select format('%I.%I(%s)', n.nspname, p.proname, oidvectortypes(p.proargtypes))
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
     and p.prorettype in ('trigger'::regtype, 'event_trigger'::regtype)
     and (p.prosrc ~* 'outbox_events'
          or p.prosrc ~* 'publish_outbox'
          or exists (select 1 from pg_temp.q_queue_fns() q
                      where position(lower(q.fname) in lower(p.prosrc)) > 0))
$$;

-- G7's detector: every function outside the system schemas, of any kind,
-- whose body writes outbox_events (a plain or quoted name), whoever may
-- execute it.
create function pg_temp.q_queue_writers() returns setof text language sql stable as $$
  select format('%I.%I(%s)', n.nspname, p.proname, oidvectortypes(p.proargtypes))
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
     and p.prosrc ~* '(insert\s+into|update|delete\s+from|merge\s+into)\s+(only\s+)?("?public"?\.)?"?outbox_events\M'
$$;

-- p_sql (DDL as the superuser) then p_check, ALWAYS undone: p_check's value.
create function pg_temp.planted(p_sql text, p_check text) returns text language plpgsql as $$
declare v text;
begin
  begin
    execute p_sql;
    execute p_check into v;
    raise exception using errcode = 'XX567', message = 'undo';
  exception when sqlstate 'XX567' then
    null;
  end;
  return v;
end $$;

-- == The guard ==============================================================
select is(
  (select count(*)::int from s67_q where to_regclass('public.' || tbl) is not null)::text
  || ' / ' || pg_temp.list('select pg_temp.q_writers(false)', 'publish_outbox'),
  '7 / public.publish_outbox(uuid, text, text, uuid, jsonb, text)',
  'G0: the seven connector tables exist, and the body scan finds publish_outbox when it ignores grants');

select is(pg_temp.list('select pg_temp.q_writers(true)'), 'none',
  'G1: no function anon or authenticated may execute writes a connector table');

select is(pg_temp.list('select pg_temp.q_namers()'), 'none',
  'G2: no VOLATILE function anon or authenticated may execute names a connector table');

select is(pg_temp.list('select pg_temp.q_rules(true)'), 'none',
  'G3: no member write rule on a connector table outside the allowlist');

select is(
  (select coalesce(string_agg(a.tbl || '.' || a.polname, ', ' order by a.tbl, a.polname), 'none')
     from s67_rule_allow a
    where a.tbl || '.' || a.polname not in (select pg_temp.q_rules(false))
       or coalesce(btrim(a.why), '') = ''),
  'none',
  'G4: every allowlist entry is still a member write rule on its table, and has a reason');

select is(
  (select string_agg(c.relname || '=' || c.relrowsecurity, ',' order by c.relname)
     from pg_class c where c.oid in (select to_regclass('public.' || tbl) from s67_q)),
  'carrier_shipments=true,connection_mappings=true,connection_sync_log=true,integration_deliveries=true,integration_endpoints=true,org_connections=true,outbox_events=true',
  'G5: row security is on for every connector table');

select is(pg_temp.list('select pg_temp.q_trigger_writers()'), 'none',
  'G6: no trigger function names outbox_events, publish_outbox or another function that names the queue');

select is(pg_temp.list('select pg_temp.q_queue_writers()'), 'public.publish_outbox(uuid, text, text, uuid, jsonb, text)',
  'G7: the functions that write outbox_events, whoever may execute them, are exactly publish_outbox');

-- == Controls: each detector still reports a planted probe ==================
select is(
  pg_temp.planted($p$
create function public._s67_probe_queue_insert(p_org uuid) returns void
  language sql security definer set search_path = public
  as $f$ insert into public.outbox_events (organization_id, topic, aggregate_type, payload) values (p_org, 'x', 'x', '{}') $f$;
revoke all on function public._s67_probe_queue_insert(uuid) from public, anon;
grant execute on function public._s67_probe_queue_insert(uuid) to authenticated;
create function public._s67_probe_ledger_delete() returns void
  language sql set search_path = public
  as $f$ delete from connection_sync_log where false $f$;
revoke all on function public._s67_probe_ledger_delete() from public, authenticated;
grant execute on function public._s67_probe_ledger_delete() to anon$p$,
    $q$select pg_temp.list('select pg_temp.q_writers(true)', '_s67_probe')$q$),
  'public._s67_probe_ledger_delete(), public._s67_probe_queue_insert(uuid)',
  'C1: G1 reports a definer function for authenticated that inserts into the queue and an invoker one for anon that deletes from the ledger');

select is(
  pg_temp.planted($p$
create function public._s67_probe_dynamic() returns void
  language plpgsql security definer set search_path = public
  as $f$ begin execute format('delete from %I.%I where false', 'public', 'connection_mappings'); end $f$;
revoke all on function public._s67_probe_dynamic() from public, anon;
grant execute on function public._s67_probe_dynamic() to authenticated$p$,
    $q$select pg_temp.list('select pg_temp.q_namers()', '_s67_probe') || ' | '
         || pg_temp.list('select pg_temp.q_writers(true)', '_s67_probe')$q$),
  'public._s67_probe_dynamic() | none',
  'C2: G2 reports a function that builds its write from the table''s name, which G1''s pattern does not read');

select is(
  pg_temp.planted($p$
create policy s67_probe_insert on public.outbox_events for insert to authenticated with check (true);
create policy s67_probe_update on public.integration_deliveries for update using (true)$p$,
    $q$select pg_temp.list('select pg_temp.q_rules(true)', 's67_probe')$q$),
  'integration_deliveries.s67_probe_update, outbox_events.s67_probe_insert',
  'C3: G3 reports an insert rule for authenticated on the queue and an update rule for PUBLIC on the webhook deliveries');

select is(
  pg_temp.planted($p$
create function public._s67_probe_trigger_insert() returns trigger
  language plpgsql security definer set search_path = public
  as $f$ begin insert into public.outbox_events (organization_id, topic, aggregate_type, payload)
               values (new.organization_id, 'x', 'x', '{}'); return new; end $f$;
create function public._s67_probe_trigger_publish() returns trigger
  language plpgsql security definer set search_path = public
  as $f$ begin perform public.publish_outbox(new.organization_id, 'x', 'x', null, '{}'::jsonb, null); return new; end $f$$p$,
    $q$select pg_temp.list('select pg_temp.q_trigger_writers()', '_s67_probe')$q$),
  'public._s67_probe_trigger_insert(), public._s67_probe_trigger_publish()',
  'C5: G6 reports a trigger function that inserts into the queue and one that calls publish_outbox');

select is(
  pg_temp.planted($p$
create function public._s67_probe_trg_format() returns trigger
  language plpgsql security definer set search_path = public
  as $f$ begin execute format('insert into %I.%I (organization_id, topic, aggregate_type, payload) values ($1, ''x'', ''x'', ''{}'')',
                              'public', 'outbox_events') using new.organization_id; return new; end $f$;
create function public._s67_probe_trg_quoted() returns trigger
  language plpgsql security definer set search_path = public
  as $f$ begin insert into public."outbox_events" (organization_id, topic, aggregate_type, payload)
               values (new.organization_id, 'x', 'x', '{}'); return new; end $f$;
create function public._s67_probe_helper_write(p_org uuid) returns void
  language sql security definer set search_path = public
  as $f$ insert into public.outbox_events (organization_id, topic, aggregate_type, payload) values (p_org, 'x', 'x', '{}') $f$;
revoke all on function public._s67_probe_helper_write(uuid) from public, anon, authenticated;
create function public._s67_probe_trg_helper() returns trigger
  language plpgsql security definer set search_path = public
  as $f$ begin perform public._s67_probe_helper_write(new.organization_id); return new; end $f$$p$,
    $q$select pg_temp.list('select pg_temp.q_trigger_writers()', '_s67_probe')$q$),
  'public._s67_probe_trg_format(), public._s67_probe_trg_helper(), public._s67_probe_trg_quoted()',
  'C6: G6 reports a trigger function that writes the queue through dynamic SQL, one through a quoted identifier, and one through a helper function');

select is(
  pg_temp.planted($p$
create function public._s67_probe_helper_write(p_org uuid) returns void
  language sql security definer set search_path = public
  as $f$ insert into public.outbox_events (organization_id, topic, aggregate_type, payload) values (p_org, 'x', 'x', '{}') $f$;
revoke all on function public._s67_probe_helper_write(uuid) from public, anon, authenticated$p$,
    $q$select pg_temp.list('select pg_temp.q_queue_writers()')$q$),
  'public._s67_probe_helper_write(uuid), public.publish_outbox(uuid, text, text, uuid, jsonb, text)',
  'C7: a new function that writes the queue, even one no API role may execute, changes G7''s list');

-- The controls left nothing behind.
select is(
  (select count(*)::int from pg_proc where proname like '\_s67\_probe%')
  + (select count(*)::int from pg_policy where polname like 's67\_probe%'),
  0,
  'C4: the planted probes are gone');

select * from finish();
rollback;
