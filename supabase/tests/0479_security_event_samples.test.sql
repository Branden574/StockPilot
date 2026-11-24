-- supabase/tests/0479_security_event_samples.test.sql
-- Proves migration 0479: what scanners asked for, beside the security events
-- record.
--   public.security_event_samples                                  the table
--   public.record_security_event_samples(jsonb)                    the writer
--   public.purge_security_event_samples()                          retention
--   public.platform_security_event_samples(timestamptz, timestamptz, text, text, text, integer)
--                                                                  the console's read
--
-- WHAT IS WORTH PINNING
--   1. Shape: exactly the designed columns, none that could hold an
--      organization, an account, an address or a hash; the row key computed
--      by the database; two indexes and no more; no foreign key, no trigger.
--   2. The closed lists (category, reason, source, method) to the letter,
--      and that each is a subset of what the security events record
--      accepts.
--   3. Privileges for every role on every object: anon and authenticated
--      nothing; service_role SELECT on the table and EXECUTE on the three
--      functions; PUBLIC nothing. The grant is the whole control: no body
--      names a gate word, so INV-25 names every function if EXECUTE reached
--      authenticated (shown inside a savepoint), and even then the second
--      lock in each body refuses a member and a signed-out caller.
--   4. Every CHECK refuses a bad row even when the table's owner writes it,
--      and the writer applies the same text rules: every target and query
--      string the table refuses, the writer skips; every one it accepts,
--      the writer stores.
--   5. The writer never raises: inputs and elements of many wrong shapes are
--      skipped and counted; an unusable optional field is left empty or
--      defaulted; only the first 50 elements are read.
--   6. One row per hour and content: a repeat adds to the count and moves
--      the times; any other method, query string, country or hour is
--      another row.
--   7. The caps on new rows: 50 a kind and 300 in all an hour, then one
--      overflow row a kind that only counts; an existing row still adds.
--   8. The writer and the purge take their own advisory lock (4790001),
--      never the security events' (4720001); the read takes none. (Two
--      sessions: scripts/db-concurrency/0479_security_event_samples_race.sh.)
--   9. The purge: the events' 90 days, on the hour on either side of the
--      cutoff; oldest first; 5,000 a call.
--  10. The read: every number of a made-up record worked out by hand
--      (targets, their method and query string pairs, the overflow counts);
--      the order (most first, then the newest, then kind and path); the
--      filters; the window's edges; the limit and the caps on what it
--      returns; every refusal, never raised and never repeating the
--      argument; every time in UTC; read-only; the row ceiling.
--
-- now() is fixed for the whole transaction and the functions use it. Every
-- row is placed from H0, the start of the hour now() is in; h(n) is H0 plus
-- n hours. Every path, query string and value is made up. Wrapped in
-- begin/rollback: nothing leaks. Run via `supabase test db` after
-- `supabase db reset`.

begin;

select plan(121);

-- Every time below is compared as text; the read writes UTC whatever the
-- session says (0479/99), and so does this file.
set local timezone = 'UTC';

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- Every grant on a function other than its owner's, as role:privilege.
create function pg_temp.grants_of(p regprocedure) returns text[] language sql as $$
  select coalesce(array_agg(case when x.grantee = 0 then 'PUBLIC' else x.grantee::regrole::text end
                            || ':' || x.privilege_type order by 1), '{}'::text[])
    from pg_proc pr, aclexplode(coalesce(pr.proacl, acldefault('f', pr.proowner))) x
   where pr.oid = p and x.grantee <> pr.proowner;
$$;
-- Every grant on the table other than its owner's.
create function pg_temp.table_grants() returns text[] language sql as $$
  select coalesce(array_agg(case when x.grantee = 0 then 'PUBLIC' else x.grantee::regrole::text end
                            || ':' || x.privilege_type order by 1), '{}'::text[])
    from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x
   where c.oid = 'public.security_event_samples'::regclass and x.grantee <> c.relowner;
$$;

-- The SQLSTATE and message of a refused statement, or 'no error'.
create function pg_temp.refusal(p_sql text) returns text language plpgsql as $$
declare
  v_state text;
  v_msg   text;
begin
  execute p_sql;
  return 'no error';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  return v_state || '|' || v_msg;
end;
$$;
grant execute on function pg_temp.refusal(text) to anon, authenticated, service_role;

-- Runs a statement and undoes it: 'ok', or the SQLSTATE it raised.
create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin
  begin
    execute p_sql;
    raise exception 'pg_temp.try: undone';
  exception when others then
    if sqlerrm = 'pg_temp.try: undone' then
      return 'ok';
    end if;
    return sqlstate;
  end;
end;
$$;

-- security_invariants INV-25 over this file's functions: its conditions, its
-- strip pass and its gate words, word for word. The names it would report.
create function pg_temp.inv25_names() returns text language sql as $$
  select coalesce(string_agg(p.proname, ', ' order by p.proname), '')
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosecdef
     and p.prorettype <> 'trigger'::regtype
     and has_function_privilege('authenticated', p.oid, 'execute')
     and regexp_replace(p.prosrc, $re$/\*(?:[^*]|\*+[^*/])*\*+/|--[^\n\r]*|(')(?:[^']|'')*(')|("(?:[^"]|"")*")$re$, ' \1\2\3 ', 'g')
         !~* $re$\m(auth\.uid|has_org_role|has_permission|is_org_member)\M$re$
     and p.proname like '%security\_event\_samples';
$$;

create function pg_temp.keys_of(p jsonb) returns text[] language sql as $$
  select coalesce(array_agg(k order by k), '{}'::text[]) from jsonb_object_keys(p) k;
$$;
-- A constant of a body, as 'type := value'.
create function pg_temp.constant_of(p_fn regprocedure, p_name text) returns text language sql as $$
  select m[1] || ' := ' || m[2]
    from pg_proc p, regexp_match(p.prosrc, '\m' || p_name || '\s+constant\s+(\w+)\s+:=\s+([^;]+);') m
   where p.oid = p_fn;
$$;
-- The quoted values of a CHECK constraint, in its own order.
create function pg_temp.check_values(p_table regclass, p_name text) returns text language sql as $$
  select string_agg(m[1], ',' order by o)
    from pg_constraint c,
         regexp_matches(pg_get_constraintdef(c.oid), '''([A-Za-z_]+)''::text', 'g') with ordinality as x(m, o)
   where c.conrelid = p_table and c.conname = p_name;
$$;

-- H0 and h(n).
create temporary table clock as select date_trunc('hour', now(), 'UTC') as h0;
create function pg_temp.h(p_hours integer) returns timestamptz language sql stable as $$
  select c.h0 + make_interval(hours => p_hours) from pg_temp.clock c;
$$;
-- A time as its whole minutes after H0 (negative before it).
create function pg_temp.mins(p text) returns text language sql stable as $$
  select (floor(extract(epoch from (p::timestamptz - c.h0)) / 60))::integer::text from pg_temp.clock c;
$$;

-- One element of the writer's array. at_ms is left out when p_at is null.
create function pg_temp.el(p_reason text, p_target text, p_method text default 'GET', p_sample text default null,
                           p_country text default null, p_at timestamptz default null, p_count integer default null)
returns jsonb language sql stable as $$
  select jsonb_strip_nulls(jsonb_build_object(
           'category', 'exploit', 'reason', p_reason, 'source', 'web', 'method', p_method, 'target', p_target,
           'sample', p_sample, 'country', p_country,
           'at_ms', case when p_at is not null then floor(extract(epoch from p_at) * 1000)::bigint end,
           'count', p_count));
$$;

-- The three functions as the app calls them, as service_role.
create function pg_temp.rec(p jsonb) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  set local role service_role;
  v := public.record_security_event_samples(p);
  reset role;
  return v;
end;
$$;
-- The writer's answer for p, with what it wrote undone.
create function pg_temp.rec_undone(p jsonb) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  begin
    v := pg_temp.rec(p);
    raise exception 'pg_temp.rec_undone';
  exception when others then
    if sqlerrm <> 'pg_temp.rec_undone' then
      raise;
    end if;
  end;
  return v;
end;
$$;
create function pg_temp.purge() returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  set local role service_role;
  v := public.purge_security_event_samples();
  reset role;
  return v;
end;
$$;
create function pg_temp.rd(p_from timestamptz default null, p_to timestamptz default null, p_reason text default null,
                           p_category text default null, p_country text default null, p_limit integer default null)
returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  set local role service_role;
  v := public.platform_security_event_samples(p_from, p_to, p_reason, p_category, p_country, p_limit);
  reset role;
  return v;
end;
$$;

-- One row, written by the table's owner (no cap, no writer). Unnamed fields:
-- exploit, env_file, web, GET, '/example-probe/.env', in H0, count 1, seen at
-- the hour's start. A field given as JSON null is null.
create function pg_temp.raw(p jsonb) returns void language sql as $$
  insert into public.security_event_samples
    (hour, category, reason, source, country, method, target, sample, event_count, first_seen_at, last_seen_at)
  select x.hour,
         case when p ? 'category' then p ->> 'category' else 'exploit' end,
         case when p ? 'reason' then p ->> 'reason' else 'env_file' end,
         case when p ? 'source' then p ->> 'source' else 'web' end,
         p ->> 'country',
         case when p ? 'method' then p ->> 'method' else 'GET' end,
         case when p ? 'target' then p ->> 'target' else '/example-probe/.env' end,
         p ->> 'sample',
         coalesce((p ->> 'event_count')::integer, 1),
         coalesce((p ->> 'first_seen_at')::timestamptz, x.hour),
         coalesce((p ->> 'last_seen_at')::timestamptz, (p ->> 'first_seen_at')::timestamptz, x.hour)
    from (select coalesce((p ->> 'hour')::timestamptz, (select c.h0 from pg_temp.clock c)) as hour) x;
$$;
-- One row at h(p_hour) plus minutes for its first and last time.
create function pg_temp.at(p_hour integer, p_reason text, p_target text, p_method text, p_sample text, p_country text,
                           p_count integer, p_first_min integer, p_last_min integer)
returns void language sql as $$
  select pg_temp.raw(jsonb_build_object(
           'hour', pg_temp.h(p_hour), 'reason', p_reason, 'target', p_target, 'method', p_method,
           'sample', p_sample, 'country', p_country, 'event_count', p_count,
           'first_seen_at', pg_temp.h(p_hour) + make_interval(mins => p_first_min),
           'last_seen_at', pg_temp.h(p_hour) + make_interval(mins => p_last_min)));
$$;

-- The read's answer as lines. A time is written as minutes after H0; no
-- query string is '-'.
create function pg_temp.target_lines(p jsonb) returns text[] language sql stable as $$
  select coalesce(array_agg((e ->> 'reason') || '|' || (e ->> 'target') || '|' || (e ->> 'events') || '|'
                            || pg_temp.mins(e ->> 'first_seen_at') || '|' || pg_temp.mins(e ->> 'last_seen_at') || '|'
                            || (e ->> 'samples_truncated') order by o), '{}'::text[])
    from jsonb_array_elements(p -> 'targets') with ordinality as x(e, o);
$$;
create function pg_temp.pair_lines(p jsonb) returns text[] language sql stable as $$
  select coalesce(array_agg((e ->> 'target') || '|' || (s ->> 'method') || '|' || coalesce(s ->> 'sample', '-') || '|'
                            || (s ->> 'events') || '|' || pg_temp.mins(s ->> 'last_seen_at') order by o, so), '{}'::text[])
    from jsonb_array_elements(p -> 'targets') with ordinality as x(e, o),
         jsonb_array_elements(e -> 'samples') with ordinality as y(s, so);
$$;
create function pg_temp.more_lines(p jsonb) returns text[] language sql stable as $$
  select coalesce(array_agg((e ->> 'reason') || '|' || (e ->> 'events') || '|' || (e ->> 'hours') order by o), '{}'::text[])
    from jsonb_array_elements(p -> 'more_than_listed') with ordinality as x(e, o);
$$;
create function pg_temp.counts(p jsonb) returns text language sql stable as $$
  select (p ->> 'listed_targets') || '|' || (p ->> 'listed_events') || '|' || (p ->> 'targets_truncated');
$$;
-- This transaction's advisory locks on the two keys, as 'samples:n events:n'.
create function pg_temp.locks() returns text language sql as $$
  select 'samples:' || count(*) filter (where l.objid = 4790001) || ' events:' || count(*) filter (where l.objid = 4720001)
    from pg_locks l
   where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.classid = 0 and l.objsubid = 1;
$$;

-- Fixture strings for the text rules: what the table refuses and accepts, as
-- a target and as a query string.
create temporary table texts (col text, ok boolean, val text, o serial);
insert into texts (col, ok, val) values
  ('target', false, ''),
  ('target', false, '/' || repeat('a', 200)),
  ('target', false, 'example-probe/.env'),
  ('target', false, 'unreadable'),
  ('target', false, '/example-probe/a@b/.env'),
  ('target', false, '/example-probe/' || chr(10) || 'x'),
  ('target', false, '/example-probe/' || chr(9) || 'x'),
  ('target', false, '/example-probe/' || chr(127)),
  ('target', false, '/example-probe/' || chr(27) || '[0m'),
  ('target', false, '/example-probe/' || chr(8238) || 'vne.'),
  ('target', false, '/example-probe/' || chr(8203) || '.env'),
  ('target', false, '/example-probe/' || chr(65279)),
  ('target', false, '/example-probe/caf' || chr(233)),
  ('target', false, '/example-probe/' || chr(1072) || 'dmin'),
  ('target', false, '/example-probe/123456/.env'),
  ('target', false, '/example-probe/abcdefab-abcd-4abc-8abc-abcdefabcdef/.env'),
  ('target', false, '/example-probe/ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF'),
  ('target', true,  '/'),
  ('target', true,  '/' || repeat('a', 199)),
  ('target', true,  '(unreadable)'),
  ('target', true,  '/example-probe/settings'),
  ('target', true,  '/example-probe/<id>/.../.env'),
  ('target', true,  '/example-probe/12345/.env'),
  ('target', true,  $t$/example-probe/a b ~!#$%^&*()_+-=[]{}|;',.<>?`"\$t$),
  ('target', true,  '/example-probe/abcdefab-abcd-4abc-8abc-abcdefabcde'),
  ('sample', false, repeat('a', 301)),
  ('sample', false, 'a@b'),
  ('sample', false, 'x=' || chr(10)),
  ('sample', false, 'x=' || chr(8238)),
  ('sample', false, 'q=caf' || chr(233)),
  ('sample', false, 'id=123456'),
  ('sample', false, 'id=abcdefab-abcd-4abc-8abc-abcdefabcdef'),
  ('sample', false, chr(27) || '[0m'),
  ('sample', true,  'a=1'),
  ('sample', true,  repeat('a', 300)),
  ('sample', true,  'q=<removed>&page=2'),
  ('sample', true,  '?'),
  ('sample', true,  'x=12345');

-- The table is new; emptied anyway so every number counts from zero.
delete from public.security_event_samples;

-- ── 1. Shape ────────────────────────────────────────────────────────────────
select has_table('public', 'security_event_samples', '0479/1: the table exists');
select is(
  (select array_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':'
                    || coalesce(nullif(a.attgenerated::text, ''), '-') order by a.attnum)
     from pg_attribute a
    where a.attrelid = 'public.security_event_samples'::regclass and a.attnum > 0 and not a.attisdropped),
  array['id:uuid:true:-', 'hour:timestamp with time zone:true:-', 'category:text:true:-', 'reason:text:true:-',
        'source:text:true:-', 'country:text:false:-', 'method:text:false:-', 'target:text:true:-',
        'sample:text:false:-', 'event_count:integer:true:-', 'first_seen_at:timestamp with time zone:true:-',
        'last_seen_at:timestamp with time zone:true:-', 'dedupe_key:text:true:s'],
  '0479/2: exactly the designed columns, their types and nullability, the row key a stored generated column: none for an organization, an account, an address, a header or a hash');
select is(
  (select array[c.relrowsecurity, c.relforcerowsecurity] from pg_class c where c.oid = 'public.security_event_samples'::regclass)
  || array[(select count(*) = 0 from pg_policies where schemaname = 'public' and tablename = 'security_event_samples')],
  array[true, false, true],
  '0479/3: row security is on (not forced on the owner) and there is no policy');
select is(
  (select array_agg(conname::text order by conname) from pg_constraint
    where conrelid = 'public.security_event_samples'::regclass and contype = 'c'),
  array['security_event_samples_category', 'security_event_samples_count_positive', 'security_event_samples_country',
        'security_event_samples_hour_is_an_hour', 'security_event_samples_method', 'security_event_samples_overflow_row',
        'security_event_samples_reason', 'security_event_samples_sample', 'security_event_samples_seen',
        'security_event_samples_source', 'security_event_samples_target'],
  '0479/4: the eleven CHECK constraints are there by name');
select is(
  (select array_agg(pg_get_indexdef(i.indexrelid) order by pg_get_indexdef(i.indexrelid))
     from pg_index i where i.indrelid = 'public.security_event_samples'::regclass),
  array['CREATE UNIQUE INDEX security_event_samples_hour_dedupe_key ON public.security_event_samples USING btree (hour, dedupe_key)',
        'CREATE UNIQUE INDEX security_event_samples_pkey ON public.security_event_samples USING btree (id)'],
  '0479/5: two indexes and no more: the primary key and the unique (hour, dedupe_key) that all three functions read by');
select is(
  array[(select count(*)::int from pg_constraint where conrelid = 'public.security_event_samples'::regclass and contype = 'f'),
        (select count(*)::int from pg_constraint where confrelid = 'public.security_event_samples'::regclass),
        (select count(*)::int from pg_trigger where tgrelid = 'public.security_event_samples'::regclass)],
  array[0, 0, 0],
  '0479/6: no foreign key from or to the table and no trigger on it (creating it locked no other table)');
select is(
  array[pg_temp.check_values('public.security_event_samples', 'security_event_samples_category'),
        pg_temp.check_values('public.security_event_samples', 'security_event_samples_reason'),
        pg_temp.check_values('public.security_event_samples', 'security_event_samples_source'),
        pg_temp.check_values('public.security_event_samples', 'security_event_samples_method')],
  array['exploit', 'env_file,git_dir,wordpress,php_file,admin_tool,path_traversal', 'web',
        'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS'],
  '0479/7: the closed lists to the letter: category exploit; the six probe kinds (core SECURITY_PROBE_KINDS, in its order); source web; the seven methods the probe route answers');
select is(
  (select array[
     (select bool_and(v = any (string_to_array(pg_temp.check_values('public.security_events', 'security_events_category'), ',')))
        from unnest(string_to_array(pg_temp.check_values('public.security_event_samples', 'security_event_samples_category'), ',')) v),
     (select bool_and(v = any (string_to_array(pg_temp.check_values('public.security_events', 'security_events_source'), ',')))
        from unnest(string_to_array(pg_temp.check_values('public.security_event_samples', 'security_event_samples_source'), ',')) v),
     (select bool_and(v ~ '^[a-z][a-z0-9_]{0,47}$')
        from unnest(string_to_array(pg_temp.check_values('public.security_event_samples', 'security_event_samples_reason'), ',')) v)]),
  array[true, true, true],
  '0479/8: each list is a subset of what the security events record accepts (its category and source lists, its reason pattern)');
select is(
  (select array_agg(a.attname::text order by a.attname)
     from pg_attribute a
    where a.attrelid = 'public.security_event_samples'::regclass and a.attnum > 0 and not a.attisdropped
      and (select pg_get_expr(d.adbin, d.adrelid)
             from pg_attrdef d join pg_attribute k on k.attrelid = d.adrelid and k.attnum = d.adnum
            where d.adrelid = a.attrelid and k.attname = 'dedupe_key')
          ~ ('\m' || a.attname || '\M')),
  array['category', 'country', 'method', 'reason', 'sample', 'source', 'target'],
  '0479/9: the row key is made from exactly the seven columns that say what was asked for (not the hour, the counts or the times)');

-- ── 2. Privileges ───────────────────────────────────────────────────────────
select table_privs_are('public', 'security_event_samples', 'anon', array[]::text[],
  '0479/10: anon has no table privilege');
select table_privs_are('public', 'security_event_samples', 'authenticated', array[]::text[],
  '0479/11: authenticated has no table privilege');
select table_privs_are('public', 'security_event_samples', 'service_role', array['SELECT'],
  '0479/12: service_role has SELECT only');
select is(pg_temp.table_grants(), array['service_role:SELECT'],
  '0479/13: the table has exactly one grant beside its owner''s: SELECT to service_role (nothing to PUBLIC)');
select is(
  array[(select count(*)::int from pg_attribute
          where attrelid = 'public.security_event_samples'::regclass and attnum > 0 and attacl is not null),
        (select count(*)::int from information_schema.column_privileges
          where table_schema = 'public' and table_name = 'security_event_samples'
            and grantee in ('anon', 'authenticated', 'PUBLIC'))],
  array[0, 0],
  '0479/14: no column of the table has a grant of its own, and none reaches anon, authenticated or PUBLIC');
select is(
  array[array_to_string(pg_temp.grants_of('public.record_security_event_samples(jsonb)'), ' '),
        array_to_string(pg_temp.grants_of('public.purge_security_event_samples()'), ' '),
        array_to_string(pg_temp.grants_of('public.platform_security_event_samples(timestamptz, timestamptz, text, text, text, integer)'), ' ')],
  array['service_role:EXECUTE', 'service_role:EXECUTE', 'service_role:EXECUTE'],
  '0479/15: each function has exactly one grant: EXECUTE to service_role (nothing to PUBLIC)');
select is(
  (select array_agg(has_function_privilege(r.role, f.fn, 'execute') order by f.n, r.n)
     from unnest(array['public.record_security_event_samples(jsonb)',
                       'public.purge_security_event_samples()',
                       'public.platform_security_event_samples(timestamptz, timestamptz, text, text, text, integer)'])
            with ordinality as f(fn, n),
          unnest(array['anon', 'authenticated', 'service_role']) with ordinality as r(role, n)),
  array[false, false, true, false, false, true, false, false, true],
  '0479/16: anon and authenticated may execute none of the three; service_role all three');
select is(
  (select array_agg(p.proname || '(' || pg_get_function_arguments(p.oid) || ') ' || pg_get_function_result(p.oid)
                    order by p.proname)
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%security\_event\_samples'),
  array['platform_security_event_samples(p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_reason text DEFAULT NULL::text, p_category text DEFAULT NULL::text, p_country text DEFAULT NULL::text, p_limit integer DEFAULT NULL::integer) jsonb',
        'purge_security_event_samples() jsonb',
        'record_security_event_samples(p_samples jsonb) jsonb'],
  '0479/17: exactly the three functions, with the designed arguments and results');
select is(
  (select array_agg(p.proname || ':' || l.lanname || ':' || p.prosecdef::text || ':' || p.provolatile::text || ':'
                    || array_to_string(p.proconfig, ',') order by p.proname)
     from pg_proc p join pg_language l on l.oid = p.prolang
    where p.pronamespace = 'public'::regnamespace and p.proname like '%security\_event\_samples'),
  array['platform_security_event_samples:plpgsql:true:s:search_path="",statement_timeout=5s,TimeZone=UTC',
        'purge_security_event_samples:plpgsql:true:v:search_path="",lock_timeout=2s',
        'record_security_event_samples:plpgsql:true:v:search_path="",lock_timeout=2s'],
  '0479/18: all three plpgsql SECURITY DEFINER with an empty search_path; the read STABLE with a statement_timeout of 5 seconds and TimeZone UTC as its own settings; the writer and the purge give up a lock wait after 2 s');
select is(
  (select count(*)::int from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname like '%security\_event\_samples'
      and p.prosrc ~* '(auth\.uid|auth\.jwt|has_org_role|has_permission|is_org_member|organization)'),
  0,
  '0479/19: no body names an organization-membership helper, the signed-in account or an organization at all, not even in a comment or a string');
select is(pg_temp.inv25_names(), '',
  '0479/20: as granted, INV-25 has nothing to say about these functions (authenticated cannot execute them)');
select is(
  (select array_agg(p.proname || ':' || (p.prosrc ~ 'public\.security_events\M')::text || ':'
                    || (p.prosrc ~ 'pg_advisory\w*lock\w*\(\s*4720001')::text || ':' || regexp_count(p.prosrc, 'pg_advisory_xact_lock\(4790001\)')
                    order by p.proname)
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%security\_event\_samples'),
  array['platform_security_event_samples:false:false:0',
        'purge_security_event_samples:false:false:1',
        'record_security_event_samples:false:false:1'],
  '0479/21: no body reads the security events record or takes its lock; the writer and the purge each take the samples'' own lock once, the read none');
select is(
  (select array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text)
     from pg_proc p
    where p.prosrc like '%4790001%' and p.pronamespace::regnamespace::text not like 'pg\_temp%'),
  array['purge_security_event_samples()', 'record_security_event_samples(jsonb)'],
  '0479/22: no other function in the database names the samples'' lock key (this file''s own helpers left out)');
select is(
  (select array_agg(p.proname || ':' || (p.prosrc ~* '\m(insert|update|delete|merge|truncate)\M')::text order by p.proname)
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%security\_event\_samples'),
  array['platform_security_event_samples:false', 'purge_security_event_samples:true', 'record_security_event_samples:true'],
  '0479/23: the read holds no write statement (none of the five write verbs appears as a word)');
select is(
  array[pg_temp.constant_of('public.record_security_event_samples(jsonb)', 'c_kind_cap'),
        pg_temp.constant_of('public.record_security_event_samples(jsonb)', 'c_hour_cap'),
        pg_temp.constant_of('public.record_security_event_samples(jsonb)', 'c_batch'),
        pg_temp.constant_of('public.platform_security_event_samples(timestamptz, timestamptz, text, text, text, integer)', 'c_max_rows'),
        pg_temp.constant_of('public.platform_security_event_samples(timestamptz, timestamptz, text, text, text, integer)', 'c_longest'),
        pg_temp.constant_of('public.platform_security_event_samples(timestamptz, timestamptz, text, text, text, integer)', 'c_default_span'),
        pg_temp.constant_of('public.platform_security_event_samples(timestamptz, timestamptz, text, text, text, integer)', 'c_default_limit'),
        pg_temp.constant_of('public.platform_security_event_samples(timestamptz, timestamptz, text, text, text, integer)', 'c_most_targets'),
        pg_temp.constant_of('public.platform_security_event_samples(timestamptz, timestamptz, text, text, text, integer)', 'c_samples'),
        (select sum(regexp_count(p.prosrc, '\m(c_kind_cap|c_hour_cap|c_batch|c_max_rows|c_longest|c_default_span|c_default_limit|c_most_targets|c_samples)\s+constant'))::text
           from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%security\_event\_samples')],
  array['integer := 50', 'integer := 300', 'integer := 50', 'integer := 60000', 'interval := ''168 hours''',
        'interval := ''24 hours''', 'integer := 10', 'integer := 50', 'integer := 5', '9'],
  '0479/24: the bounds, each written once: 50 new rows a kind and 300 in all an hour, 50 elements a call; a read takes at most 60,000 rows and 7 days, 24 hours by default, 10 targets by default and 50 at most, 5 pairs a target');
select ok(
  (select prosrc like '%s.hour < pg_catalog.now() - interval ''90 days''%' from pg_proc
    where oid = 'public.purge_security_event_samples()'::regprocedure)
  and (select prosrc like '%limit 5000%' from pg_proc where oid = 'public.purge_security_event_samples()'::regprocedure),
  '0479/25: the purge keeps the security events'' own 90 days and takes 5,000 a call');

-- ── 3. Who may call ─────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0479000-0000-0000-0000-000000000001', 'role', 'authenticated', 'aal', 'aal2')::text, true);
select is(
  array[pg_temp.refusal($$ select public.record_security_event_samples('[]'::jsonb) $$),
        pg_temp.refusal($$ select public.purge_security_event_samples() $$),
        pg_temp.refusal($$ select public.platform_security_event_samples() $$),
        pg_temp.refusal($$ select count(*) from public.security_event_samples $$),
        pg_temp.refusal($$ insert into public.security_event_samples (hour, category, reason, source, method, target, first_seen_at, last_seen_at) values (date_trunc('hour', now(), 'UTC'), 'exploit', 'env_file', 'web', 'GET', '/example-probe/.env', date_trunc('hour', now(), 'UTC'), date_trunc('hour', now(), 'UTC')) $$)],
  array['42501|permission denied for function record_security_event_samples',
        '42501|permission denied for function purge_security_event_samples',
        '42501|permission denied for function platform_security_event_samples',
        '42501|permission denied for table security_event_samples',
        '42501|permission denied for table security_event_samples'],
  '0479/26: a signed-in member, even one holding the second step, can call none of the three and can neither read nor write the table');
reset role;
set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
select is(
  array[pg_temp.refusal($$ select public.record_security_event_samples('[]'::jsonb) $$),
        pg_temp.refusal($$ select public.purge_security_event_samples() $$),
        pg_temp.refusal($$ select public.platform_security_event_samples() $$),
        pg_temp.refusal($$ select count(*) from public.security_event_samples $$)],
  array['42501|permission denied for function record_security_event_samples',
        '42501|permission denied for function purge_security_event_samples',
        '42501|permission denied for function platform_security_event_samples',
        '42501|permission denied for table security_event_samples'],
  '0479/27: a signed-out caller can call none of the three and cannot read the table');
reset role;
select set_config('request.jwt.claims', '', true);

-- If a grant to the member roles ever slipped in: INV-25 names every
-- function, and the second lock in each body still refuses the call before
-- anything is read or written. Undone by the savepoint.
savepoint slipped_grant;
grant execute on function public.record_security_event_samples(jsonb) to authenticated, anon;
grant execute on function public.purge_security_event_samples() to authenticated, anon;
grant execute on function public.platform_security_event_samples(timestamptz, timestamptz, text, text, text, integer) to authenticated, anon;
select is(pg_temp.inv25_names(),
  'platform_security_event_samples, purge_security_event_samples, record_security_event_samples',
  '0479/28: with EXECUTE granted to authenticated, INV-25 names all three');
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0479000-0000-0000-0000-000000000001', 'role', 'authenticated', 'aal', 'aal2')::text, true);
select is(
  array[pg_temp.refusal($$ select public.record_security_event_samples('[]'::jsonb) $$),
        pg_temp.refusal($$ select public.record_security_event_samples(null) $$),
        pg_temp.refusal($$ select public.purge_security_event_samples() $$),
        pg_temp.refusal($$ select public.platform_security_event_samples() $$),
        pg_temp.refusal($$ select public.platform_security_event_samples('infinity', null) $$)],
  array_fill('42501|security_event_samples_not_allowed'::text, array[5]),
  '0479/29: and even then the second lock refuses a signed-in member on all three (also for an input the writer would skip and a window the read would refuse)');
reset role;
set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
select is(
  array[pg_temp.refusal($$ select public.record_security_event_samples('[]'::jsonb) $$),
        pg_temp.refusal($$ select public.purge_security_event_samples() $$),
        pg_temp.refusal($$ select public.platform_security_event_samples() $$)],
  array_fill('42501|security_event_samples_not_allowed'::text, array[3]),
  '0479/30: the second lock refuses a signed-out caller on all three as well');
reset role;
select set_config('request.jwt.claims', '', true);
rollback to savepoint slipped_grant;
select is(
  (select count(*)::int from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname like '%security\_event\_samples'
      and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))),
  0,
  '0479/31: the savepoint took the grants back');

set local role service_role;
select is(
  array[pg_temp.refusal($$ insert into public.security_event_samples (hour, category, reason, source, method, target, first_seen_at, last_seen_at) values (date_trunc('hour', now(), 'UTC'), 'exploit', 'env_file', 'web', 'GET', '/example-probe/.env', date_trunc('hour', now(), 'UTC'), date_trunc('hour', now(), 'UTC')) $$),
        pg_temp.refusal($$ update public.security_event_samples set event_count = 2 $$),
        pg_temp.refusal($$ delete from public.security_event_samples $$),
        pg_temp.refusal($$ select count(*) from public.security_event_samples $$),
        pg_temp.try($$ select public.record_security_event_samples('[]'::jsonb) $$),
        pg_temp.try($$ select public.purge_security_event_samples() $$),
        pg_temp.try($$ select public.platform_security_event_samples() $$)],
  array['42501|permission denied for table security_event_samples',
        '42501|permission denied for table security_event_samples',
        '42501|permission denied for table security_event_samples',
        'no error', 'ok', 'ok', 'ok'],
  '0479/32: service_role reads the table and calls all three, and cannot insert, update or delete a row directly');
reset role;

-- ── 4. The locks ────────────────────────────────────────────────────────────
select is(pg_temp.locks(), 'samples:0 events:0', '0479/33: before any call, neither lock is held');
savepoint lk;
select pg_temp.rec(jsonb_build_array(pg_temp.el('env_file', '/example-lock/.env')));
select is(pg_temp.locks(), 'samples:1 events:0',
  '0479/34: a writer call holds the samples'' advisory lock (4790001) to the end of its transaction, and never the events'' (4720001)');
rollback to savepoint lk;
savepoint lk;
select pg_temp.purge();
select is(pg_temp.locks(), 'samples:1 events:0', '0479/35: the purge takes the same lock, and not the events''');
rollback to savepoint lk;
savepoint lk;
select pg_temp.rd();
select is(pg_temp.locks(), 'samples:0 events:0', '0479/36: the read takes neither');
rollback to savepoint lk;
savepoint lk;
set local role service_role;
select public.record_security_events(jsonb_build_array(jsonb_build_object(
  'category', 'exploit', 'outcome', 'blocked', 'reason', 'env_file', 'source', 'web')));
reset role;
select is(pg_temp.locks(), 'samples:0 events:1',
  '0479/37: the security events'' writer takes its own lock and not the samples'': the two records never wait on each other');
rollback to savepoint lk;

-- ── 5. The table's own checks, written to as its owner ──────────────────────
select is(pg_temp.try($$ select pg_temp.raw('{}') $$), 'ok', '0479/38: a well-formed row is accepted');
select is(
  array[pg_temp.try(format('select pg_temp.raw(%L)', jsonb_build_object('hour', pg_temp.h(0) + interval '1 minute'))),
        pg_temp.try($$ select pg_temp.raw('{"category": "bots"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"reason": "wrong_password"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"reason": "Env_File"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"source": "phone"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"country": "usa"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"country": "us"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"method": "TRACE"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"method": "get"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"event_count": 0}') $$)],
  array_fill('23514'::text, array[10]),
  '0479/39: an hour that is not a whole hour, another category, a reason that is not a probe kind (even one the events record takes), another source, a country that is not two capitals, a method not on the list, and a count below one are each refused');
select is(
  (select array_agg(pg_temp.try(format('select pg_temp.raw(%L)', jsonb_build_object(t.col, t.val))) order by t.o)
     from pg_temp.texts t where not t.ok),
  array_fill('23514'::text, array[(select count(*)::int from pg_temp.texts where not ok)]),
  '0479/40: every target and query string of the refused list is refused: empty, too long, not a path, an @, a control, escape, bidirectional, invisible or other non-ASCII character, a run of six digits, an id');
select is(
  (select array_agg(pg_temp.try(format('select pg_temp.raw(%L)', jsonb_build_object(t.col, t.val))) order by t.o)
     from pg_temp.texts t where t.ok),
  array_fill('ok'::text, array[(select count(*)::int from pg_temp.texts where ok)]),
  '0479/41: every target and query string of the accepted list is accepted: a bare slash, 200 and 300 characters, (unreadable), the scrubber''s markers, five digits, every printable ASCII character but @');
select is(
  array[pg_temp.try($$ select pg_temp.raw('{"sample": ""}') $$),
        pg_temp.try($$ select pg_temp.raw('{"target": "(more than could be listed)"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"target": "(more than could be listed)", "method": null, "country": "US"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"target": "(more than could be listed)", "method": null, "sample": "a=1"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"method": null}') $$),
        pg_temp.try($$ select pg_temp.raw('{"target": "(more than could be listed)", "method": null}') $$)],
  array['23514', '23514', '23514', '23514', '23514', 'ok'],
  '0479/42: an empty query string is refused (none is null); an overflow row has no method, country or query string, and every other row has a method');
select is(
  array[pg_temp.try(format('select pg_temp.raw(%L)', jsonb_build_object('first_seen_at', pg_temp.h(0) - interval '1 second'))),
        pg_temp.try(format('select pg_temp.raw(%L)', jsonb_build_object('first_seen_at', pg_temp.h(0), 'last_seen_at', pg_temp.h(1)))),
        pg_temp.try(format('select pg_temp.raw(%L)', jsonb_build_object('first_seen_at', pg_temp.h(0) + interval '10 minutes', 'last_seen_at', pg_temp.h(0) + interval '5 minutes'))),
        pg_temp.try(format('select pg_temp.raw(%L)', jsonb_build_object('first_seen_at', pg_temp.h(0), 'last_seen_at', pg_temp.h(1) - interval '1 microsecond')))],
  array['23514', '23514', '23514', 'ok'],
  '0479/43: both times fall inside the row''s hour, the first not after the last');
select is(
  array[pg_temp.try($$ insert into public.security_event_samples (hour, category, reason, source, method, target, first_seen_at, last_seen_at, dedupe_key) values (date_trunc('hour', now(), 'UTC'), 'exploit', 'env_file', 'web', 'GET', '/example-probe/.env', date_trunc('hour', now(), 'UTC'), date_trunc('hour', now(), 'UTC'), md5('x')) $$),
        pg_temp.try($$ select pg_temp.raw('{}'), pg_temp.raw('{}') $$),
        pg_temp.try(format('select pg_temp.raw(%L), pg_temp.raw(%L)', '{}', jsonb_build_object('hour', pg_temp.h(-1)))),
        pg_temp.try($$ select pg_temp.raw('{}'), pg_temp.raw('{"sample": "a=1"}'), pg_temp.raw('{"method": "POST"}'), pg_temp.raw('{"country": "US"}'), pg_temp.raw('{"target": "/example-probe/.env2"}'), pg_temp.raw('{"reason": "git_dir"}') $$)],
  array['428C9', '23505', 'ok', 'ok'],
  '0479/44: the row key cannot be written; two rows with the same content in one hour are refused; the same content in another hour, or another query string, method, country, path or kind in the same hour, is another row');
select pg_temp.raw(jsonb_build_object('country', 'US', 'sample', 'a=1', 'method', 'POST', 'target', '/example-probe/key/.env'));
select pg_temp.raw('{"target": "(more than could be listed)", "method": null}');
select is(
  (select array_agg(s.dedupe_key = md5(s.category || chr(31) || s.reason || chr(31) || s.source || chr(31)
                                       || coalesce(s.country, '') || chr(31) || coalesce(s.method, '') || chr(31)
                                       || s.target || chr(31) || coalesce(s.sample, '')) order by s.target)
     from public.security_event_samples s),
  array[true, true],
  '0479/45: the row key is the md5 of the seven columns joined by the unit separator (the writer finds a row by the same key)');
delete from public.security_event_samples;

-- ── 6. The writer never raises ──────────────────────────────────────────────
select is(
  array[pg_temp.rec(null), pg_temp.rec('null'::jsonb), pg_temp.rec('{}'::jsonb), pg_temp.rec('"a string"'::jsonb),
        pg_temp.rec('42'::jsonb), pg_temp.rec('true'::jsonb)],
  array_fill('{"stored": 0, "skipped": 0, "not_read": 0, "not_a_list": true, "overflowed": 0}'::jsonb, array[6]),
  '0479/46: an input that is not a list (none, JSON null, an object, a string, a number, a boolean) stores nothing, raises nothing and says so');
select is(pg_temp.rec('[]'::jsonb), '{"stored": 0, "skipped": 0, "not_read": 0, "not_a_list": false, "overflowed": 0}'::jsonb,
  '0479/47: an empty list stores nothing');
select is(
  pg_temp.rec(jsonb_build_array(
    'a string'::text, 42, null::text, true, '[]'::jsonb,
    jsonb_build_array(pg_temp.el('env_file', '/example-bad/1')),
    '{}'::jsonb,
    pg_temp.el('env_file', '/example-bad/2') - 'category',
    pg_temp.el('env_file', '/example-bad/3') - 'reason',
    pg_temp.el('env_file', '/example-bad/4') - 'source',
    pg_temp.el('env_file', '/example-bad/5') - 'method',
    pg_temp.el('env_file', '/example-bad/6') - 'target',
    pg_temp.el('env_file', '/example-bad/7') || '{"category": 1}',
    pg_temp.el('env_file', '/example-bad/8') || '{"reason": true}',
    pg_temp.el('env_file', '/example-bad/9') || '{"source": {"web": 1}}',
    pg_temp.el('env_file', '/example-bad/10') || '{"method": ["GET"]}',
    pg_temp.el('env_file', '/example-bad/11') || '{"category": null}',
    pg_temp.el('env_file', '/example-bad/12') || '{"target": {"path": "/example-bad/12"}}',
    pg_temp.el('env_file', '/example-bad/13') || '{"target": 13}',
    pg_temp.el('env_file', '/example-bad/14') || '{"category": "bots"}',
    pg_temp.el('env_file', '/example-bad/15') || '{"category": "EXPLOIT"}',
    pg_temp.el('wrong_password', '/example-bad/16'),
    pg_temp.el('Env_File', '/example-bad/17'),
    pg_temp.el('env_file ', '/example-bad/18'),
    pg_temp.el('env_file', '/example-bad/19') || '{"source": "phone"}',
    pg_temp.el('env_file', '/example-bad/20', 'get'),
    pg_temp.el('env_file', '/example-bad/21', 'TRACE'),
    pg_temp.el('env_file', '/example-bad/22', ''),
    pg_temp.el('env_file', ''),
    pg_temp.el('env_file', '/' || repeat('x', 10000)),
    pg_temp.el('env_file', '(more than could be listed)'),
    pg_temp.el('env_file', 'unreadable'),
    pg_temp.el('env_file', '/example-bad/33') || '{"sample": 5}',
    pg_temp.el('env_file', '/example-bad/34') || '{"sample": {"a": 1}}',
    pg_temp.el('env_file', '/example-bad/35') || '{"sample": ["a=1"]}',
    pg_temp.el('env_file', '/example-bad/36') || '{"sample": true}',
    pg_temp.el('env_file', '/example-bad/37', 'GET', repeat('s', 301)),
    pg_temp.el('env_file', '/example-bad/38', 'GET', repeat('s', 10000)),
    pg_temp.el('env_file', '/example-bad/a@b'),
    pg_temp.el('env_file', '/example-bad/' || chr(8238)),
    pg_temp.el('env_file', '/example-bad/41', 'GET', 'x=' || chr(10)),
    pg_temp.el('env_file', '/example-bad/42', 'GET', 'id=00000000-0000-4000-8000-000000000000'),
    pg_temp.el('env_file', '/example-bad/43', 'GET', 'q=caf' || chr(233)),
    pg_temp.el('env_file', '/example-bad/123456'))),
  '{"stored": 0, "skipped": 44, "not_read": 0, "not_a_list": false, "overflowed": 0}'::jsonb,
  '0479/48: forty-four elements of wrong shapes are each skipped and counted, never raised: not an object; a required field missing, null or not a string; a category, kind, source or method not on its list (case and spaces count); a target or query string the table refuses, the overflow row''s word and a text of 10,000 characters among them; a query string that is not a string');
select is((select count(*)::int from public.security_event_samples), 0, '0479/49: and nothing of them is stored');
select is(
  (select array_agg(pg_temp.try(format('select pg_temp.raw(%L)', jsonb_build_object(t.col, t.val))) || '/'
                    || (pg_temp.rec_undone(jsonb_build_array(
                          case when t.col = 'target' then pg_temp.el('env_file', t.val)
                               else pg_temp.el('env_file', '/example-probe/.env', 'GET', t.val) end)) ->> 'skipped')
                    order by t.o)
     from pg_temp.texts t),
  (select array_agg(case when t.ok then 'ok/0' else '23514/1' end order by t.o) from pg_temp.texts t),
  '0479/50: the writer''s text rules are the table''s: every target and query string the table refuses, the writer skips; every one it accepts, the writer stores');
select is(
  pg_temp.rec(jsonb_build_array(
    pg_temp.el('git_dir', '/example-opt/1') || '{"country": "usa", "count": "0", "at_ms": "yesterday"}',
    pg_temp.el('git_dir', '/example-opt/2') || '{"country": "us", "count": -5, "at_ms": 12}',
    pg_temp.el('git_dir', '/example-opt/3') || '{"country": 12, "count": 1234567}'
      || jsonb_build_object('at_ms', floor(extract(epoch from now() - interval '27 hours') * 1000)::bigint),
    pg_temp.el('git_dir', '/example-opt/4') || '{"country": ["US"], "count": "many"}'
      || jsonb_build_object('at_ms', floor(extract(epoch from now() + interval '2 minutes') * 1000)::bigint),
    pg_temp.el('git_dir', '/example-opt/5') || '{"count": 2.5, "at_ms": {"t": 1}}')),
  '{"stored": 5, "skipped": 0, "not_read": 0, "not_a_list": false, "overflowed": 0}'::jsonb,
  '0479/51: elements whose country, count or time cannot be used are still stored');
select is(
  (select array_agg(s.target || ':' || coalesce(s.country, '-') || ':' || s.event_count || ':'
                    || (s.hour = pg_temp.h(0))::text || ':' || (s.first_seen_at = now() and s.last_seen_at = now())::text
                    order by s.target)
     from public.security_event_samples s),
  array['/example-opt/1:-:1:true:true', '/example-opt/2:-:1:true:true', '/example-opt/3:-:1:true:true',
        '/example-opt/4:-:1:true:true', '/example-opt/5:-:1:true:true'],
  '0479/52: each with no country, a count of 1, and now as its time (a time more than 26 hours old or more than a minute ahead is now)');
delete from public.security_event_samples;
savepoint batch;
select is(
  pg_temp.rec((select jsonb_agg(pg_temp.el('php_file', '/example-batch/' || i || '.php') order by i)
                 from generate_series(1, 120) i)),
  '{"stored": 50, "skipped": 0, "not_read": 70, "not_a_list": false, "overflowed": 0}'::jsonb,
  '0479/53: of a list of 120 elements, the first 50 are read and the other 70 are counted as not read');
select is(
  (select array[count(*)::int, min(substring(target from '/example-batch/([0-9]+)')::int),
                max(substring(target from '/example-batch/([0-9]+)')::int)]
     from public.security_event_samples),
  array[50, 1, 50],
  '0479/54: they are the first 50 in the list''s order');
rollback to savepoint batch;
select is(
  pg_temp.rec((select jsonb_agg(pg_temp.el(k, '/example-kinds/' || k, m) order by k, m)
                 from unnest(array['env_file', 'git_dir', 'wordpress', 'php_file', 'admin_tool', 'path_traversal']) k,
                      unnest(array['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) m)),
  '{"stored": 42, "skipped": 0, "not_read": 0, "not_a_list": false, "overflowed": 0}'::jsonb,
  '0479/55: every probe kind with every method is stored (the writer''s lists are the table''s)');
select is(
  (select array[count(distinct reason)::int, count(distinct method)::int, count(*)::int]
     from public.security_event_samples),
  array[6, 7, 42],
  '0479/56: as 42 rows: six kinds by seven methods');
delete from public.security_event_samples;

-- ── 7. One row per hour and content ─────────────────────────────────────────
select is(
  pg_temp.rec(jsonb_build_array(
    pg_temp.el('php_file', '/example-dup/index.php', 'GET', null, 'US', pg_temp.h(-1) + interval '10 minutes'),
    pg_temp.el('php_file', '/example-dup/index.php', 'GET', null, 'US', pg_temp.h(-1) + interval '10 minutes'))),
  '{"stored": 2, "skipped": 0, "not_read": 0, "not_a_list": false, "overflowed": 0}'::jsonb,
  '0479/57: the same request twice in one call: both stored');
select is(
  (select array_agg(s.event_count || ':' || pg_temp.mins(s.first_seen_at::text) || ':' || pg_temp.mins(s.last_seen_at::text)
                    || ':' || pg_temp.mins(s.hour::text))
     from public.security_event_samples s),
  array['2:-50:-50:-60'],
  '0479/58: on one row of its hour, counted twice, first and last seen at its time');
select pg_temp.rec(jsonb_build_array(
  pg_temp.el('php_file', '/example-dup/index.php', 'GET', null, 'US', pg_temp.h(-1) + interval '5 minutes', 3)));
select pg_temp.rec(jsonb_build_array(
  pg_temp.el('php_file', '/example-dup/index.php', 'GET', '', 'US', pg_temp.h(-1) + interval '50 minutes')));
select is(
  (select array_agg(s.event_count || ':' || pg_temp.mins(s.first_seen_at::text) || ':' || pg_temp.mins(s.last_seen_at::text))
     from public.security_event_samples s),
  array['6:-55:-10'],
  '0479/59: a repeat adds its count (3) and an earlier time moves the first time back; an empty query string is none, so a later repeat with one is the same row and moves the last time on');
select is(
  pg_temp.rec(jsonb_build_array(
    pg_temp.el('php_file', '/example-dup/index.php', 'POST', null, 'US', pg_temp.h(-1) + interval '20 minutes'),
    pg_temp.el('php_file', '/example-dup/index.php', 'GET', 'a=1', 'US', pg_temp.h(-1) + interval '20 minutes'),
    pg_temp.el('php_file', '/example-dup/index.php', 'GET', null, 'DE', pg_temp.h(-1) + interval '20 minutes'),
    pg_temp.el('php_file', '/example-dup/index.php', 'GET', null, 'usa', pg_temp.h(-1) + interval '20 minutes'),
    pg_temp.el('php_file', '/example-dup/index.php', 'GET', null, null, pg_temp.h(-1) + interval '21 minutes'),
    pg_temp.el('php_file', '/example-dup/index.php', 'GET', null, 'US', pg_temp.h(-2) + interval '20 minutes'),
    pg_temp.el('git_dir', '/example-dup/index.php', 'GET', null, 'US', pg_temp.h(-1) + interval '20 minutes'))),
  '{"stored": 7, "skipped": 0, "not_read": 0, "not_a_list": false, "overflowed": 0}'::jsonb,
  '0479/60: seven more requests that differ in one thing each are stored');
select is(
  (select array_agg(pg_temp.mins(s.hour::text) || ':' || s.reason || ':' || s.method || ':' || coalesce(s.sample, '-') || ':'
                    || coalesce(s.country, '-') || ':' || s.event_count
                    order by s.hour, s.reason, s.method, s.sample nulls first, s.country nulls first)
     from public.security_event_samples s),
  array['-120:php_file:GET:-:US:1',
        '-60:git_dir:GET:-:US:1',
        '-60:php_file:GET:-:-:2',
        '-60:php_file:GET:-:DE:1',
        '-60:php_file:GET:-:US:6',
        '-60:php_file:GET:a=1:US:1',
        '-60:php_file:POST:-:US:1'],
  '0479/61: another method, query string, country, kind or hour is another row; an unusable country is none, the same as no country');
update public.security_event_samples set event_count = 1999999998
 where reason = 'php_file' and method = 'POST';
select pg_temp.rec(jsonb_build_array(
  pg_temp.el('php_file', '/example-dup/index.php', 'POST', null, 'US', pg_temp.h(-1) + interval '30 minutes', 5)));
select is(
  (select event_count from public.security_event_samples where reason = 'php_file' and method = 'POST'),
  2000000000,
  '0479/62: a count stops at two billion');
select is(
  (select bool_and(s.dedupe_key = md5(s.category || chr(31) || s.reason || chr(31) || s.source || chr(31)
                                      || coalesce(s.country, '') || chr(31) || coalesce(s.method, '') || chr(31)
                                      || s.target || chr(31) || coalesce(s.sample, '')))
          and count(*) = 7
     from public.security_event_samples s),
  true,
  '0479/63: every row the writer made carries the key of its content');
delete from public.security_event_samples;

-- ── 8. The caps ─────────────────────────────────────────────────────────────
-- In h(-1): 60 new paths of one kind, in two calls (50 a call).
select is(
  array[pg_temp.rec((select jsonb_agg(pg_temp.el('env_file', '/example-cap/' || i || '.env', 'GET', null, 'US',
                                                  pg_temp.h(-1) + interval '5 minutes') order by i)
                       from generate_series(1, 50) i)),
        pg_temp.rec((select jsonb_agg(pg_temp.el('env_file', '/example-cap/' || i || '.env', 'POST', 'q=1', 'DE',
                                                  pg_temp.h(-1) + make_interval(mins => i - 40)) order by i)
                       from generate_series(51, 60) i))],
  array['{"stored": 50, "skipped": 0, "not_read": 0, "not_a_list": false, "overflowed": 0}'::jsonb,
        '{"stored": 0, "skipped": 0, "not_read": 0, "not_a_list": false, "overflowed": 10}'::jsonb],
  '0479/64: fifty new paths of one kind in an hour are listed; the next ten are counted on the overflow row');
select is(
  (select array_agg(s.target || ':' || s.category || ':' || s.reason || ':' || s.source || ':' || coalesce(s.method, '-') || ':'
                    || coalesce(s.country, '-') || ':' || coalesce(s.sample, '-') || ':' || s.event_count || ':'
                    || pg_temp.mins(s.first_seen_at::text) || ':' || pg_temp.mins(s.last_seen_at::text))
     from public.security_event_samples s where s.target !~ '^/example-cap/'),
  array['(more than could be listed):exploit:env_file:web:-:-:-:10:-49:-40'],
  '0479/65: one overflow row for the kind and hour: no method, country or query string, a count of 10, first and last seen at the first and last of them');
select is(
  (select count(*)::int from public.security_event_samples where target ~ '^/example-cap/'),
  50,
  '0479/66: fifty listed rows of the kind');
select is(
  pg_temp.rec((select jsonb_agg(pg_temp.el('git_dir', '/example-cap/' || i || '/.git/config', 'GET', null, null,
                                            pg_temp.h(-1) + interval '5 minutes') order by i)
                 from generate_series(1, 5) i)),
  '{"stored": 5, "skipped": 0, "not_read": 0, "not_a_list": false, "overflowed": 0}'::jsonb,
  '0479/67: another kind in the same hour is not held back by the first one''s cap');
select is(
  array[pg_temp.rec(jsonb_build_array(pg_temp.el('env_file', '/example-cap/1.env', 'GET', null, 'US',
                                                   pg_temp.h(-1) + interval '6 minutes', 4))),
        pg_temp.rec((select jsonb_agg(pg_temp.el('env_file', '/example-cap/more-' || i || '.env', 'GET', null, 'US',
                                                  pg_temp.h(-1) + interval '7 minutes') order by i)
                       from generate_series(1, 3) i))],
  array['{"stored": 1, "skipped": 0, "not_read": 0, "not_a_list": false, "overflowed": 0}'::jsonb,
        '{"stored": 0, "skipped": 0, "not_read": 0, "not_a_list": false, "overflowed": 3}'::jsonb],
  '0479/68: at the cap a request for a listed path still adds to its row; new paths still go to the overflow row');
select is(
  (select array_agg(s.target || ':' || s.event_count order by s.target)
     from public.security_event_samples s where s.target in ('/example-cap/1.env', '(more than could be listed)')),
  array['(more than could be listed):13', '/example-cap/1.env:5'],
  '0479/69: the listed row''s count went from 1 to 5, and the one overflow row''s from 10 to 13');
select is(
  pg_temp.rec((select jsonb_agg(pg_temp.el('env_file', '/example-cap/' || i || '.env', 'GET', null, 'US',
                                            pg_temp.h(-2) + interval '5 minutes') order by i)
                 from generate_series(1, 5) i)),
  '{"stored": 5, "skipped": 0, "not_read": 0, "not_a_list": false, "overflowed": 0}'::jsonb,
  '0479/70: the cap is for one hour: the kind''s new paths in the hour before are listed');
-- h(-1) now holds 55 listed rows (50 env_file, 5 git_dir) and one overflow
-- row. 240 more listed rows of a third kind, written by the owner, bring the
-- listed rows to 295.
select pg_temp.raw(jsonb_build_object('hour', pg_temp.h(-1), 'reason', 'wordpress',
                                      'target', '/example-hour/' || i || '/wp-login.php'))
  from generate_series(1, 240) i;
select is(
  array[pg_temp.rec((select jsonb_agg(pg_temp.el('admin_tool', '/example-hour/' || i || '/phpmyadmin', 'GET', null, null,
                                                  pg_temp.h(-1) + interval '8 minutes') order by i)
                       from generate_series(1, 8) i)),
        pg_temp.rec(jsonb_build_array(pg_temp.el('php_file', '/example-hour/index.php', 'GET', null, null,
                                                   pg_temp.h(-1) + interval '9 minutes'))),
        pg_temp.rec(jsonb_build_array(pg_temp.el('git_dir', '/example-cap/1/.git/config', 'GET', null, null,
                                                   pg_temp.h(-1) + interval '9 minutes')))],
  array['{"stored": 5, "skipped": 0, "not_read": 0, "not_a_list": false, "overflowed": 3}'::jsonb,
        '{"stored": 0, "skipped": 0, "not_read": 0, "not_a_list": false, "overflowed": 1}'::jsonb,
        '{"stored": 1, "skipped": 0, "not_read": 0, "not_a_list": false, "overflowed": 0}'::jsonb],
  '0479/71: at 295 listed rows, a kind with none of its own gets the last five; then the hour is full for every kind; an existing row still adds (overflow rows are not counted against the caps)');
select is(
  (select array[count(*) filter (where target <> '(more than could be listed)')::int,
                count(*) filter (where target = '(more than could be listed)')::int]
     from public.security_event_samples where hour = pg_temp.h(-1)),
  array[300, 3],
  '0479/72: the hour holds 300 listed rows and an overflow row for each of the three kinds that passed a cap');
select is(
  (select array_agg(reason || ':' || event_count order by reason)
     from public.security_event_samples where hour = pg_temp.h(-1) and target = '(more than could be listed)'),
  array['admin_tool:3', 'env_file:13', 'php_file:1'],
  '0479/73: each overflow row counts what its kind could not list');
select is(
  pg_temp.rec(jsonb_build_array(
    pg_temp.el('admin_tool', '/example-hour/1/phpmyadmin', 'GET', null, null, pg_temp.h(-1) + interval '10 minutes'),
    pg_temp.el('admin_tool', '/example-hour/new/phpmyadmin', 'GET', null, null, pg_temp.h(-1) + interval '10 minutes'),
    pg_temp.el('admin_tool', '/example-hour/new/phpmyadmin', 'TRACE', null, null, pg_temp.h(-1) + interval '10 minutes'),
    '"not an object"'::jsonb,
    pg_temp.el('admin_tool', '/example-hour/new/phpmyadmin', 'GET', null, null, pg_temp.h(-3) + interval '10 minutes'))),
  '{"stored": 2, "skipped": 2, "not_read": 0, "not_a_list": false, "overflowed": 1}'::jsonb,
  '0479/74: the answer''s counts add up to the elements read: stored, counted on an overflow row, skipped');
delete from public.security_event_samples;

-- ── 9. Retention ────────────────────────────────────────────────────────────
-- A: the first whole hour that begins at or after now() minus 90 days; B,
-- the hour before it, begins before that.
create temporary table cutoff as
  select case when date_trunc('hour', now() - interval '90 days', 'UTC') = now() - interval '90 days'
              then now() - interval '90 days'
              else date_trunc('hour', now() - interval '90 days', 'UTC') + interval '1 hour' end as a;
select pg_temp.raw(jsonb_build_object('hour', (select a from cutoff) - interval '1 hour', 'target', '/example-purge/b'));
select pg_temp.raw(jsonb_build_object('hour', (select a from cutoff), 'target', '/example-purge/a'));
select pg_temp.raw(jsonb_build_object('hour', pg_temp.h(0), 'target', '/example-purge/now'));
select pg_temp.raw(jsonb_build_object('hour', (select a from cutoff) - interval '10 hours', 'target', '/example-purge/old/' || i))
  from generate_series(1, 5000) i;
select is(
  array[pg_temp.purge(), pg_temp.purge(), pg_temp.purge()],
  array['{"deleted": 5000}'::jsonb, '{"deleted": 1}'::jsonb, '{"deleted": 0}'::jsonb],
  '0479/75: the purge takes at most 5,000 rows a call, the oldest first, until none is left to take');
select is(
  (select array_agg(target order by target) from public.security_event_samples),
  array['/example-purge/a', '/example-purge/now'],
  '0479/76: a row whose hour began before now() minus 90 days is gone; the next hour''s row and today''s are kept');
delete from public.security_event_samples;

-- ── 10. The read ────────────────────────────────────────────────────────────
-- The made-up record, by hand (hour, kind, path, method, query string,
-- country, count, first and last minute in the hour):
--   h(-3): env_file  /example-a/.env               GET  -           US  5  +1 +10
--          env_file  /example-a/.env               GET  v=1         US  2  +2 +20
--          env_file  /example-a/.env               POST -           DE  1  +3 +3
--          env_file  /example-b/.env               GET  -           US  8  +4 +5
--          git_dir   /example-c/.git/config        GET  -           NL  8  +6 +40
--          wordpress /example-d/wp-login.php       POST log=<removed> US 3 +7 +7
--          env_file  overflow 12 (+8 +50); git_dir overflow 4 (+9 +9)
--   h(-2): env_file  /example-a/.env               GET  -           US  4  +1 +50
--          php_file  /example-e/index.php          HEAD -           -   2  +5 +6
--          env_file  overflow 1 (+2 +2)
--   h(-30): env_file /example-old/.env             GET  -           US 100 +0 +0
--   h(0):  admin_tool /example-f/phpmyadmin        GET  -           US  1  +0 +0
--   h(-35): three paths with 2 each, all last seen at +30 (ties)
--   h(-37): /example-g/.env with six methods (1 to 6), /example-h/.env with
--          three query strings of 1 each, all last seen at +10
--   h(-40): sixty paths of env_file, path n with a count of n
-- (The last three are outside the default window; h(-40) is the oldest hour.)
-- In [h(-3), h(-1)): /example-a/.env 5+2+1+4 = 12, first h(-3)+1 (-179),
-- last h(-2)+50 (-70); its pairs GET - 5+4 = 9 (last -70), GET v=1 2 (-160),
-- POST - 1 (-177). /example-c and /example-b both 8: c was seen last later
-- (-140 against -175), so c first. Overflow: env_file 12+1 = 13 in 2 hours,
-- git_dir 4 in 1. Five targets, 12+8+8+3+2 = 33 events.
select pg_temp.at(-3, 'env_file', '/example-a/.env', 'GET', null, 'US', 5, 1, 10);
select pg_temp.at(-3, 'env_file', '/example-a/.env', 'GET', 'v=1', 'US', 2, 2, 20);
select pg_temp.at(-3, 'env_file', '/example-a/.env', 'POST', null, 'DE', 1, 3, 3);
select pg_temp.at(-3, 'env_file', '/example-b/.env', 'GET', null, 'US', 8, 4, 5);
select pg_temp.at(-3, 'git_dir', '/example-c/.git/config', 'GET', null, 'NL', 8, 6, 40);
select pg_temp.at(-3, 'wordpress', '/example-d/wp-login.php', 'POST', 'log=<removed>', 'US', 3, 7, 7);
select pg_temp.at(-3, 'env_file', '(more than could be listed)', null, null, null, 12, 8, 50);
select pg_temp.at(-3, 'git_dir', '(more than could be listed)', null, null, null, 4, 9, 9);
select pg_temp.at(-2, 'env_file', '/example-a/.env', 'GET', null, 'US', 4, 1, 50);
select pg_temp.at(-2, 'php_file', '/example-e/index.php', 'HEAD', null, null, 2, 5, 6);
select pg_temp.at(-2, 'env_file', '(more than could be listed)', null, null, null, 1, 2, 2);
select pg_temp.at(-30, 'env_file', '/example-old/.env', 'GET', null, 'US', 100, 0, 0);
select pg_temp.at(0, 'admin_tool', '/example-f/phpmyadmin', 'GET', null, 'US', 1, 0, 0);
select pg_temp.at(-35, 'wordpress', '/example-y/xmlrpc.php', 'GET', null, 'US', 2, 30, 30);
select pg_temp.at(-35, 'env_file', '/example-z/.env', 'GET', null, 'US', 2, 30, 30);
select pg_temp.at(-35, 'env_file', '/example-x/.env', 'GET', null, 'US', 2, 30, 30);
select pg_temp.at(-37, 'env_file', '/example-g/.env', m, null, 'US', n::integer, 10, 10)
  from unnest(array['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) with ordinality as x(m, n);
select pg_temp.at(-37, 'env_file', '/example-h/.env', 'GET', q, 'US', 1, 10, 10)
  from unnest(array['b=2', null, 'a=1']) q;
select pg_temp.raw(jsonb_build_object('hour', pg_temp.h(-40), 'target', '/example-n/' || i || '.env', 'event_count', i,
                                      'first_seen_at', pg_temp.h(-40) + make_interval(secs => i)))
  from generate_series(1, 60) i;

create temporary table ans as
  select pg_temp.rd(pg_temp.h(-3), pg_temp.h(-1)) as a,
         pg_temp.rd(pg_temp.h(-3), pg_temp.h(-1), 'env_file') as by_kind,
         pg_temp.rd(pg_temp.h(-3), pg_temp.h(-1), null, null, 'US') as us,
         pg_temp.rd(pg_temp.h(-3), pg_temp.h(-1), null, 'exploit') as exploit,
         pg_temp.rd(pg_temp.h(-3), pg_temp.h(-1), null, 'bots') as bots,
         pg_temp.rd(pg_temp.h(-3), pg_temp.h(-1), 'wrong_password') as other_reason,
         pg_temp.rd(pg_temp.h(-2), pg_temp.h(-1)) as late,
         pg_temp.rd(pg_temp.h(-3), pg_temp.h(-2)) as early,
         pg_temp.rd() as dflt,
         pg_temp.rd(pg_temp.h(-35), pg_temp.h(-34)) as ties,
         pg_temp.rd(pg_temp.h(-37), pg_temp.h(-36)) as pairs,
         pg_temp.rd(pg_temp.h(-12), pg_temp.h(-11)) as empty;

select is(pg_temp.keys_of((select a from ans)),
  array['generated_at', 'listed_events', 'listed_targets', 'more_than_listed', 'oldest_hour', 'refused', 'targets',
        'targets_truncated', 'window', 'window_shortened'],
  '0479/77: the answer has exactly its ten keys');
select is(
  (select array[a -> 'window', a -> 'window_shortened', a -> 'refused', a -> 'generated_at', a -> 'oldest_hour'] from ans),
  array[jsonb_build_object('from', pg_temp.h(-3), 'to', pg_temp.h(-1), 'asked_from', pg_temp.h(-3)),
        'false'::jsonb, 'null'::jsonb, to_jsonb(now()), to_jsonb(pg_temp.h(-40))],
  '0479/78: the window read is the window asked for, not shortened; nothing refused; made now; the oldest hour on record (one outside the window)');
select is(
  (select jsonb_build_array(to_jsonb(pg_temp.keys_of(a -> 'targets' -> 0)),
                            to_jsonb(pg_temp.keys_of(a -> 'targets' -> 0 -> 'samples' -> 0)),
                            to_jsonb(pg_temp.keys_of(a -> 'more_than_listed' -> 0))) from ans),
  '[["events", "first_seen_at", "last_seen_at", "reason", "samples", "samples_truncated", "target"],
    ["events", "last_seen_at", "method", "sample"],
    ["events", "hours", "reason"]]'::jsonb,
  '0479/79: a target, a pair and an overflow line have exactly their keys (no row id, key, country or hour)');
select is(pg_temp.target_lines((select a from ans)),
  array['env_file|/example-a/.env|12|-179|-70|false',
        'git_dir|/example-c/.git/config|8|-174|-140|false',
        'env_file|/example-b/.env|8|-176|-175|false',
        'wordpress|/example-d/wp-login.php|3|-173|-173|false',
        'php_file|/example-e/index.php|2|-115|-114|false'],
  '0479/80: the targets as worked out by hand: counts summed over hours, methods, query strings and countries; most first, and of two with 8 the one seen last more recently first');
select is(pg_temp.pair_lines((select a from ans)),
  array['/example-a/.env|GET|-|9|-70', '/example-a/.env|GET|v=1|2|-160', '/example-a/.env|POST|-|1|-177',
        '/example-c/.git/config|GET|-|8|-140', '/example-b/.env|GET|-|8|-175',
        '/example-d/wp-login.php|POST|log=<removed>|3|-173', '/example-e/index.php|HEAD|-|2|-114'],
  '0479/81: each target''s method and query string pairs, summed over hours and countries, most first');
select is(
  (select jsonb_build_array(to_jsonb(pg_temp.more_lines(a)), pg_temp.counts(a)) from ans),
  '[["env_file|13|2", "git_dir|4|1"], "5|33|false"]'::jsonb,
  '0479/82: the overflow rows count per kind, over the hours they are in, and are never a target; five targets, 33 events');
select is(
  (select jsonb_build_array(to_jsonb(pg_temp.target_lines(by_kind)), to_jsonb(pg_temp.more_lines(by_kind)),
                            pg_temp.counts(by_kind)) from ans),
  '[["env_file|/example-a/.env|12|-179|-70|false", "env_file|/example-b/.env|8|-176|-175|false"],
    ["env_file|13|2"], "2|20|false"]'::jsonb,
  '0479/83: for one kind: its targets and its overflow only');
select is(
  (select jsonb_build_array(to_jsonb(pg_temp.target_lines(us)), to_jsonb(pg_temp.more_lines(us)), pg_temp.counts(us))
     from ans),
  '[["env_file|/example-a/.env|11|-179|-70|false", "env_file|/example-b/.env|8|-176|-175|false",
     "wordpress|/example-d/wp-login.php|3|-173|-173|false"],
    ["env_file|13|2", "git_dir|4|1"], "3|22|false"]'::jsonb,
  '0479/84: for one country: the rows from it only (the target''s other country and the paths of other countries and of none are left out); the overflow counts are for every country (an overflow row has none)');
select is(pg_temp.pair_lines((select us from ans)),
  array['/example-a/.env|GET|-|9|-70', '/example-a/.env|GET|v=1|2|-160', '/example-b/.env|GET|-|8|-175',
        '/example-d/wp-login.php|POST|log=<removed>|3|-173'],
  '0479/85: and its pairs are of that country''s rows');
select is(
  (select array[exploit = a, bots - 'generated_at' = other_reason - 'generated_at'] from ans)
  || (select array[bots -> 'targets' = '[]'::jsonb and bots -> 'more_than_listed' = '[]'::jsonb
                   and pg_temp.counts(bots) = '0|0|false'] from ans),
  array[true, true, true],
  '0479/86: the category exploit is every row; another category, and a reason code that is no probe kind, are answered with nothing listed (not refused)');
select is(
  (select jsonb_build_array(to_jsonb(pg_temp.target_lines(late)), to_jsonb(pg_temp.more_lines(late)),
                            pg_temp.counts(late)) from ans),
  '[["env_file|/example-a/.env|4|-119|-70|false", "php_file|/example-e/index.php|2|-115|-114|false"],
    ["env_file|1|1"], "2|6|false"]'::jsonb,
  '0479/87: a row is in the window when its hour starts at or after the start: [h(-2), h(-1)) holds h(-2) only');
select is(
  (select jsonb_build_array(to_jsonb(pg_temp.target_lines(early)), to_jsonb(pg_temp.more_lines(early))) from ans),
  '[["git_dir|/example-c/.git/config|8|-174|-140|false", "env_file|/example-a/.env|8|-179|-160|false",
     "env_file|/example-b/.env|8|-176|-175|false", "wordpress|/example-d/wp-login.php|3|-173|-173|false"],
    ["env_file|12|1", "git_dir|4|1"]]'::jsonb,
  '0479/88: and before the end: [h(-3), h(-2)) leaves h(-2) out; three targets of 8, the most recently seen first');
select is(
  (select array[dflt -> 'window', to_jsonb(pg_temp.target_lines(dflt))] from ans),
  array[jsonb_build_object('from', pg_temp.h(-23), 'to', pg_temp.h(1), 'asked_from', pg_temp.h(-23)),
        to_jsonb(array['env_file|/example-a/.env|12|-179|-70|false',
                       'git_dir|/example-c/.git/config|8|-174|-140|false',
                       'env_file|/example-b/.env|8|-176|-175|false',
                       'wordpress|/example-d/wp-login.php|3|-173|-173|false',
                       'php_file|/example-e/index.php|2|-115|-114|false',
                       'admin_tool|/example-f/phpmyadmin|1|0|0|false'])],
  '0479/89: with no argument: the 24 hours up to the end of the hour running now (its rows included, those of older hours not)');
select is(pg_temp.target_lines((select ties from ans)),
  array['env_file|/example-x/.env|2|-2070|-2070|false', 'env_file|/example-z/.env|2|-2070|-2070|false',
        'wordpress|/example-y/xmlrpc.php|2|-2070|-2070|false'],
  '0479/90: equal counts seen last at the same time: by kind, then by path');
select is(
  (select jsonb_build_array(to_jsonb(pg_temp.target_lines(pairs)), to_jsonb(pg_temp.pair_lines(pairs))) from ans),
  '[["env_file|/example-g/.env|21|-2210|-2210|true", "env_file|/example-h/.env|3|-2210|-2210|false"],
    ["/example-g/.env|DELETE|-|6|-2210", "/example-g/.env|PATCH|-|5|-2210", "/example-g/.env|PUT|-|4|-2210",
     "/example-g/.env|POST|-|3|-2210", "/example-g/.env|HEAD|-|2|-2210",
     "/example-h/.env|GET|-|1|-2210", "/example-h/.env|GET|a=1|1|-2210", "/example-h/.env|GET|b=2|1|-2210"]]'::jsonb,
  '0479/91: at most five pairs a target, the most first, and samples_truncated says when one was left out; equal pairs: no query string first, then by query string');
select is(
  (select array_agg(v order by u.o, w.k)
     from unnest(array[1, 3, 0, -5, 1000]) with ordinality as u(n, o),
          lateral (select pg_temp.rd(pg_temp.h(-40), pg_temp.h(-39), null, null, null, u.n) as r) q,
          lateral unnest(array[jsonb_array_length(q.r -> 'targets'), (q.r -> 'targets' -> 0 ->> 'events')::int,
                               (q.r -> 'targets' -> -1 ->> 'events')::int]) with ordinality as w(v, k))
  || array[jsonb_array_length(pg_temp.rd(pg_temp.h(-40), pg_temp.h(-39)) -> 'targets')],
  array[1, 60, 60, 3, 60, 58, 1, 60, 60, 1, 60, 60, 50, 60, 11, 10],
  '0479/92: the limit: 1 and 3 give that many; 0 and -5 give one; 1,000 gives the most, 50; none gives 10');
select is(
  (select array[pg_temp.counts(pg_temp.rd(pg_temp.h(-40), pg_temp.h(-39), null, null, null, 1000)),
                pg_temp.counts(pg_temp.rd(pg_temp.h(-40), pg_temp.h(-39), null, null, null, 60)),
                pg_temp.counts(pg_temp.rd(pg_temp.h(-40), pg_temp.h(-39), null, null, null, 2))]),
  array['60|1830|true', '60|1830|true', '60|1830|true'],
  '0479/93: listed_targets and listed_events count every target of the window, and targets_truncated says when some were left out');
select is(
  (select array[e -> 'targets', e -> 'more_than_listed', to_jsonb(pg_temp.counts(e)), e -> 'window_shortened'] from ans, lateral (select empty as e) x),
  array['[]'::jsonb, '[]'::jsonb, '"0|0|false"'::jsonb, 'false'::jsonb],
  '0479/94: an hour with nothing in it: empty lists and zeros');

-- The refusals.
create temporary table refusals as
  select r.o, r.word, pg_temp.rd(r.f, r.t, r.reason, r.category, r.country) as ans
    from (values
      (1, 'not_a_time', pg_temp.h(-3), 'infinity'::timestamptz, null::text, null::text, null::text),
      (2, 'not_a_time', '-infinity'::timestamptz, pg_temp.h(-1), null, null, null),
      (3, 'not_whole_hours', pg_temp.h(-3) + interval '1 second', pg_temp.h(-1), null, null, null),
      (4, 'not_whole_hours', pg_temp.h(-3), pg_temp.h(-1) + interval '30 minutes', null, null, null),
      (5, 'to_in_the_future', pg_temp.h(-3), pg_temp.h(2), null, null, null),
      (6, 'from_not_before_to', pg_temp.h(-1), pg_temp.h(-1), null, null, null),
      (7, 'from_not_before_to', pg_temp.h(-1), pg_temp.h(-3), null, null, null),
      (8, 'longer_than_7_days', pg_temp.h(-168), pg_temp.h(1), null, null, null),
      (9, 'not_a_reason', pg_temp.h(-3), pg_temp.h(-1), 'Example Argument Text', null, null),
      (10, 'not_a_reason', pg_temp.h(-3), pg_temp.h(-1), '', null, null),
      (11, 'not_a_reason', pg_temp.h(-3), pg_temp.h(-1), repeat('x', 49), null, null),
      (12, 'not_a_category', pg_temp.h(-3), pg_temp.h(-1), null, 'example_argument_text', null),
      (13, 'not_a_category', pg_temp.h(-3), pg_temp.h(-1), null, '', null),
      (14, 'not_a_country', pg_temp.h(-3), pg_temp.h(-1), null, null, 'usa'),
      (15, 'not_a_country', pg_temp.h(-3), pg_temp.h(-1), null, null, 'us'))
      as r(o, word, f, t, reason, category, country);
select is(
  (select array_agg(ans ->> 'refused' order by o) from refusals),
  (select array_agg(word order by o) from refusals),
  '0479/95: each window or filter the read will not take is answered with its own fixed word, never raised: not a time, not on whole hours, ending after the hour running now, out of order, longer than 7 days, a reason, category or country that is not one');
select is(
  (select array[bool_and(pg_temp.keys_of(ans) = array['generated_at', 'refused', 'window']),
                bool_and(ans -> 'window' = 'null'::jsonb),
                bool_and(ans ->> 'generated_at' = to_jsonb(now()) #>> '{}'),
                bool_and(ans::text !~* 'example|argument|usa|infinity|xxxx')]
     from refusals),
  array[true, true, true, true],
  '0479/96: a refusal has exactly three keys, no window, the time it was made, and never repeats the argument');
select is(
  (select array[pg_temp.rd(pg_temp.h(-167), pg_temp.h(1)) ->> 'refused', pg_temp.rd(pg_temp.h(-167), pg_temp.h(1)) -> 'window' ->> 'from',
                pg_temp.rd(pg_temp.h(-1), pg_temp.h(0)) ->> 'refused',
                pg_temp.rd(pg_temp.h(0), pg_temp.h(1)) -> 'targets' -> 0 ->> 'target',
                pg_temp.rd(pg_temp.h(-3), pg_temp.h(-1), repeat('x', 48)) ->> 'refused',
                pg_temp.rd(pg_temp.h(-3), pg_temp.h(-1), 'env_file', 'exploit', 'US') -> 'targets' -> 0 ->> 'events']),
  array[null, to_jsonb(pg_temp.h(-167)) #>> '{}', null, '/example-f/phpmyadmin', null, '11'],
  '0479/97: exactly 7 days is read; a window may end at the end of the hour running now; a 48-character code is a reason; the filters together');
select is(
  (select array_agg(pg_temp.refusal(format('select public.platform_security_event_samples(%L, %L, %L, %L, %L, %s)',
                                           f, t, r, c, k, coalesce(l::text, 'null'))) order by o)
     from (values (1, null::timestamptz, null::timestamptz, null::text, null::text, null::text, -2147483648),
                  (2, 'infinity', '-infinity', 'x', 'y', 'z', 2147483647),
                  (3, now(), now(), repeat('x', 10000), repeat('y', 10000), repeat('z', 10000), 0)) as v(o, f, t, r, c, k, l)),
  array['no error', 'no error', 'no error'],
  '0479/98: no argument makes the read raise');
savepoint tz;
set local timezone = 'Pacific/Auckland';
select is(pg_temp.rd(pg_temp.h(-3), pg_temp.h(-1))::text, (select a::text from ans),
  '0479/99: every time is written in UTC whatever the session''s time zone is (the answer is the same text)');
rollback to savepoint tz;
select is(
  (select array[(a -> 'window' ->> 'from') like '%+00:00', (a -> 'targets' -> 0 ->> 'last_seen_at') like '%+00:00'] from ans),
  array[true, true],
  '0479/100: written with +00:00');
create temporary table before_read as
  select md5(string_agg(s::text, ',' order by s.id)) as m, count(*) as n from public.security_event_samples s;
select pg_temp.rd(pg_temp.h(-40), pg_temp.h(1)) is not null as read_once;
select is(
  (select array[md5(string_agg(s::text, ',' order by s.id)), count(*)::text] from public.security_event_samples s),
  (select array[m, n::text] from before_read),
  '0479/101: the read changes nothing');

-- ── 11. The row ceiling ─────────────────────────────────────────────────────
-- 30,000 rows in each of h(-4) and h(-3): the window [h(-4), h(-2)) holds
-- 60,000 rows, exactly the ceiling, and is read as asked.
delete from public.security_event_samples;
insert into public.security_event_samples (hour, category, reason, source, method, target, first_seen_at, last_seen_at)
  select pg_temp.h(h), 'exploit', 'env_file', 'web', 'GET', '/example-ceiling/' || h || '/' || i, pg_temp.h(h), pg_temp.h(h)
    from generate_series(-4, -3) h, generate_series(1, 30000) i;
select is(
  (select array[r -> 'window_shortened', r -> 'window' -> 'from', to_jsonb(pg_temp.counts(r))]
     from (select pg_temp.rd(pg_temp.h(-4), pg_temp.h(-2)) as r) x),
  array['false'::jsonb, to_jsonb(pg_temp.h(-4)), '"60000|60000|true"'::jsonb],
  '0479/102: a window that holds exactly the ceiling (60,000 rows) is read as asked');
select pg_temp.raw(jsonb_build_object('hour', pg_temp.h(-4), 'target', '/example-ceiling/one-more'));
create temporary table shortened as
  select pg_temp.rd(pg_temp.h(-4), pg_temp.h(-2)) as r,
         pg_temp.rd(pg_temp.h(-3), pg_temp.h(-2)) as from_read,
         pg_temp.rd(pg_temp.h(-4), pg_temp.h(-2), 'git_dir') as filtered;
select is(
  (select array[r -> 'window_shortened', r -> 'window', to_jsonb(pg_temp.counts(r))] from shortened),
  array['true'::jsonb, jsonb_build_object('from', pg_temp.h(-3), 'to', pg_temp.h(-2), 'asked_from', pg_temp.h(-4)),
        '"30000|30000|true"'::jsonb],
  '0479/103: one row more, and it is read from the hour after the one the ceiling is passed in, and says so');
select is(
  (select r - 'window' - 'window_shortened' = from_read - 'window' - 'window_shortened' from shortened),
  true,
  '0479/104: and everything else in it is the answer for the window read');
select is(
  (select array[filtered -> 'window_shortened', filtered -> 'window' -> 'from'] from shortened),
  array['true'::jsonb, to_jsonb(pg_temp.h(-3))],
  '0479/105: the ceiling counts the rows read, whatever the filters keep');
insert into public.security_event_samples (hour, category, reason, source, method, target, first_seen_at, last_seen_at)
  select pg_temp.h(-3), 'exploit', 'env_file', 'web', 'GET', '/example-ceiling/more/' || i, pg_temp.h(-3), pg_temp.h(-3)
    from generate_series(1, 30001) i;
select is(
  (select array[r ->> 'refused', pg_temp.keys_of(r)::text] from (select pg_temp.rd(pg_temp.h(-4), pg_temp.h(-2)) as r) x),
  array['too_many_rows_in_one_hour', '{generated_at,refused,window}'],
  '0479/106: a newest hour that alone holds more than the ceiling is refused with its own word');

-- ── 12. What the writer and the read do with the made-up text ───────────────
delete from public.security_event_samples;
select pg_temp.rec(jsonb_build_array(
  pg_temp.el('path_traversal', '/example-probe/../settings', 'GET', 'file=<removed>', 'US', pg_temp.h(-1) + interval '1 minute'),
  pg_temp.el('path_traversal', '/example-probe/../settings', 'GET', $s$a="b"&c=\d$s$, 'US', pg_temp.h(-1) + interval '2 minutes'),
  pg_temp.el('php_file', '(unreadable)', 'OPTIONS', null, null, pg_temp.h(-1) + interval '3 minutes')));
select is(
  (select array[x ->> 'target', x -> 'samples' -> 0 ->> 'sample', x -> 'samples' -> 1 ->> 'sample']
     from jsonb_array_elements(pg_temp.rd(pg_temp.h(-1), pg_temp.h(0)) -> 'targets') x
    where x ->> 'reason' = 'path_traversal'),
  array['/example-probe/../settings', $s$a="b"&c=\d$s$, 'file=<removed>'],
  '0479/107: the text comes back exactly as stored, as JSON strings (quotes and backslashes escaped by JSON, nothing else changed)');
select is(
  (select array[x ->> 'reason', x ->> 'target', x -> 'samples' -> 0 ->> 'method']
     from jsonb_array_elements(pg_temp.rd(pg_temp.h(-1), pg_temp.h(0)) -> 'targets') x
    where x ->> 'target' = '(unreadable)'),
  array['php_file', '(unreadable)', 'OPTIONS'],
  '0479/108: a path the app could not read is kept as (unreadable)');

-- ── 13. More shapes the writer refuses, one at a time ───────────────────────
select is(
  (select array_agg((pg_temp.rec_undone(jsonb_build_array(e)) ->> 'skipped') order by o)
     from unnest(array[
       pg_temp.el('env_file', '/example-one/1') || '{"category": ""}',
       pg_temp.el('env_file', '/example-one/2') || '{"source": "WEB"}',
       pg_temp.el('env_file', '/example-one/3') || '{"source": "edge"}',
       pg_temp.el('env_file', '/example-one/4', 'GET '),
       pg_temp.el('env_file', '/example-one/5', 'CONNECT'),
       pg_temp.el('', '/example-one/6'),
       pg_temp.el('over_minute_cap', '/example-one/7'),
       pg_temp.el('env_file', ' /example-one/8'),
       pg_temp.el('env_file', '/example-one/' || chr(0x2066)),
       pg_temp.el('env_file', '/example-one/9', 'GET', chr(8203)),
       pg_temp.el('env_file', '/example-one/10', 'GET', 'q=' || chr(13)),
       pg_temp.el('env_file', '/example-one/11', 'GET', 'q=a' || chr(160) || 'b'),
       pg_temp.el('env_file', '(unreadable) ')]) with ordinality as x(e, o)),
  array_fill('1'::text, array[13]),
  '0479/109: and each of these alone is skipped too: an empty category, a source in capitals or not web, a method with a space or not on the list, an empty or other kind, a target that does not start with a slash or is not the exact word, an isolate, a zero-width space, a carriage return, a no-break space');
select is(
  (select array_agg((pg_temp.rec_undone(jsonb_build_array(e)) ->> 'stored') order by o)
     from unnest(array[
       pg_temp.el('env_file', '/example-one/ok-1', 'GET', '', 'ZZ'),
       pg_temp.el('env_file', '/example-one/ok-2') || '{"sample": null}',
       pg_temp.el('env_file', '/example-one/ok-3') || '{"extra": "ignored", "organization_id": "00000000-0000-4000-8000-000000000000"}']) with ordinality as x(e, o)),
  array['1', '1', '1'],
  '0479/110: these are stored: an empty or null query string (as none), any two capitals as a country, and fields the writer does not know (ignored)');
select is(
  (select array[count(*)::int] from public.security_event_samples where target like '/example-one/%'),
  array[0],
  '0479/111: (those were undone)');

-- ── 14. The writer and the read under made-up ids ───────────────────────────
-- A field named like an organization is never stored anywhere: the table has
-- no column for it and the writer reads only its own fields.
select pg_temp.rec(jsonb_build_array(
  pg_temp.el('env_file', '/example-org/.env') || '{"organization_id": "00000000-0000-4000-8000-0000000000aa", "user_id": "00000000-0000-4000-8000-0000000000bb", "ip": "192.0.2.1"}'));
select is(
  (select count(*)::int from public.security_event_samples s
    where s::text like '%00000000-0000-4000-8000-0000000000aa%' or s::text like '%0000000000bb%' or s::text like '%192.0.2.1%'),
  0,
  '0479/112: an organization, an account or an address sent beside a sample is stored nowhere');
select is(
  (select count(*)::int from public.security_event_samples where target = '/example-org/.env'),
  1,
  '0479/113: while the sample itself is stored');

-- ── 15. The overflow row and the read ───────────────────────────────────────
delete from public.security_event_samples;
select pg_temp.rec((select jsonb_agg(pg_temp.el('wordpress', '/example-flood/' || i || '/wp-login.php', 'POST', null, 'US',
                                              pg_temp.h(-1) + interval '15 minutes') order by i)
                      from generate_series(1, 50) i));
select pg_temp.rec((select jsonb_agg(pg_temp.el('wordpress', '/example-flood/' || i || '/wp-login.php', 'POST', null, 'US',
                                              pg_temp.h(-1) + interval '16 minutes', 2) order by i)
                      from generate_series(51, 70) i));
select is(
  (select array[jsonb_array_length(r -> 'targets'), (r ->> 'listed_targets')::int, (r ->> 'listed_events')::int]
          || array[(r -> 'more_than_listed' -> 0 ->> 'events')::int, (r -> 'more_than_listed' -> 0 ->> 'hours')::int]
     from (select pg_temp.rd(pg_temp.h(-1), pg_temp.h(0), 'wordpress', null, null, 50) as r) x),
  array[50, 50, 50, 40, 1],
  '0479/114: after a flood of one kind, the read lists its first 50 paths and says 40 more requests (twenty paths, two each) could not be listed');
select is(
  (select count(*)::int from jsonb_array_elements(pg_temp.rd(pg_temp.h(-1), pg_temp.h(0), null, null, null, 50) -> 'targets') x
    where x ->> 'target' = '(more than could be listed)'),
  0,
  '0479/115: the overflow row is never listed as a target');
select is(
  (select array[(r -> 'more_than_listed' -> 0 ->> 'events')::int, jsonb_array_length(r -> 'targets')]
     from (select pg_temp.rd(pg_temp.h(-1), pg_temp.h(0), 'wordpress', null, 'DE') as r) x),
  array[40, 0],
  '0479/116: and its count is given under any country filter, with no listed path from that country');

-- ── 16. Size of an answer ───────────────────────────────────────────────────
-- 50 targets of 200 characters with 6 pairs of 300 characters each: the
-- answer holds 50 targets and 250 pairs, never more.
delete from public.security_event_samples;
select pg_temp.raw(jsonb_build_object('hour', pg_temp.h(-1), 'target', '/' || i || repeat('t', 197 - length(i::text)) || 'x',
                                      'method', m, 'sample', repeat('s', 299) || i % 10))
  from generate_series(1, 60) i, unnest(array['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) m;
select is(
  (select array[jsonb_array_length(r -> 'targets'),
                (select sum(jsonb_array_length(t -> 'samples'))::int from jsonb_array_elements(r -> 'targets') t),
                (select count(*)::int from jsonb_array_elements(r -> 'targets') t where (t ->> 'samples_truncated')::boolean),
                (r ->> 'listed_targets')::int]
     from (select pg_temp.rd(pg_temp.h(-1), pg_temp.h(0), null, null, null, 1000) as r) x),
  array[50, 250, 50, 60],
  '0479/117: at its largest an answer holds 50 targets and 250 pairs');
select cmp_ok(
  (select length(pg_temp.rd(pg_temp.h(-1), pg_temp.h(0), null, null, null, 1000)::text)), '<', 120000,
  '0479/118: and is under 120,000 characters');

-- ── 17. Counted as the table counts ─────────────────────────────────────────
select is(
  (select (pg_temp.rd(pg_temp.h(-1), pg_temp.h(0)) ->> 'listed_events')::bigint),
  (select sum(event_count)::bigint from public.security_event_samples where hour = pg_temp.h(-1)),
  '0479/119: listed_events is the sum of the window''s listed rows');

-- ── 18. Comments ────────────────────────────────────────────────────────────
select ok(
  obj_description('public.security_event_samples'::regclass, 'pg_class') like '%text only%'
  and col_description('public.security_event_samples'::regclass, 8) like '%text only%'
  and col_description('public.security_event_samples'::regclass, 9) like '%text only%',
  '0479/120: the table and its two text columns say the text is shown as text only');
select ok(
  (select bool_and(obj_description(p.oid, 'pg_proc') like '%service_role only%')
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%security\_event\_samples'),
  '0479/121: each function says it is service_role only');

select * from finish();
rollback;
