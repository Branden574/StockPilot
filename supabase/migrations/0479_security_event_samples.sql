-- 0479_security_event_samples.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- What a scanner asked for: for the requests the app refused as a probe of a
-- file or a tool no page has (the six probe kinds of
-- apps/web/src/lib/security/probe-paths.ts: a settings file, source control
-- files, WordPress pages, a PHP script, an admin tool, a file outside the
-- site), the path asked for and its query string, each scrubbed by the app
-- before it is sent here, counted by hour. The platform console shows them
-- beside the security events record (0472) as text only. Nothing writes or
-- reads them until the app code that follows this migration. The advisory
-- lock key below (4790001) carries this file's number.
--
-- WHAT IT ADDS (tier A: one new table with its primary key and one unique
-- constraint, three functions and their grants. No foreign key, no policy, no
-- trigger, no stored row; no existing table, function, policy or grant
-- changes, and no lock is taken on any table that exists.)
--   1. public.security_event_samples. One row stands for one scrubbed path
--      (target), asked for with one method and one scrubbed query string
--      (sample, or none), from one country (or none), as one probe kind, in
--      one UTC hour, with a count and the first and last time it was seen.
--      It has no column for an organization, an account, an address, a
--      header, a body or a source hash. Its text columns refuse, as a second
--      lock behind the app's scrubber, anything that is not printable ASCII
--      (so every control, invisible, bidirectional and non-ASCII character),
--      an '@' (or one percent-encoded, once or more), a run of six digits, an
--      IPv4 address, a run of 24 or more characters of the base64 and hex
--      alphabet (the scrubber's own long-value rule) and an id (with its
--      dashes, or 32 hex characters without them).
--      Its category, reason and source are a documented subset of 0472's:
--      category exploit, source web, and a reason that is one of the six
--      probe kinds. The probe route is the one place that samples, and a
--      closed list of reasons keeps the rows an hour bounded (below).
--   2. public.record_security_event_samples(jsonb): the way the app writes
--      rows. SECURITY DEFINER, service_role only. An element whose fields do
--      not meet the table's rules is skipped and counted in the answer; no
--      input makes it raise. Rules that live here because the rows they need
--      are here:
--        - one row per hour and content: a repeat adds to event_count and
--          moves last_seen_at (and first_seen_at, for an earlier time in the
--          same hour);
--        - the caps on NEW rows: in one hour, at most 50 for each probe kind
--          and at most 300 in all. Past a cap, an element that would need a
--          new row is counted on its kind's overflow row for the hour instead
--          (target '(more than could be listed)', no method, country or
--          sample). An existing row still adds to its count. So an hour
--          holds at most 300 listed rows and one overflow row for each kind
--          (306 today), and one kind cannot crowd the others out.
--      It takes its own advisory lock (4790001), never the events' (4720001),
--      so a flood of samples never makes the security events record drop a
--      batch. A call that waits 2 s for its turn ends with 55P03 and its
--      caller drops the batch, as the events' writer does.
--   3. public.purge_security_event_samples(): deletes rows whose hour began
--      more than 90 days ago (the events' own retention), at most 5,000 a
--      call, under the same lock; the scheduled retention job calls it until
--      the count comes back under 5,000.
--   4. public.platform_security_event_samples(...): the console's read. For
--      whole UTC hours (at most 7 days), optionally one probe kind (reason),
--      one category and one country: the targets asked for most, with
--      their counts summed over the hours, each with its most frequent
--      method and query string pairs; and, per kind, what the overflow rows
--      counted. A hard limit on what it returns, a row ceiling on what it
--      reads, a statement timeout of its own. STABLE. Never raises for an
--      argument: a window it will not read is answered with a fixed word.
--
-- WHO CAN READ AND WRITE
--   - RLS is on with NO policy, and anon and authenticated have no privilege
--     on the table or on any of the three functions: no member and no
--     signed-out caller reads or writes a row, directly or through them.
--   - service_role may EXECUTE the three functions and nothing else: no
--     API role reads a row except through platform_security_event_samples
--     (bounded), writes one except through record_security_event_samples, or
--     removes one except through purge_security_event_samples. Nothing needs
--     the table directly: no view, rule, trigger, foreign key or publication
--     names it, and the app calls the three functions.
--   - The grant is the gate (0477, 0478): no body here names auth.uid,
--     has_org_role, has_permission or is_org_member, so if EXECUTE ever
--     reached authenticated, security_invariants INV-25 would name the
--     function. A second lock that names no gate: each body first reads the
--     role setting (0413's form) and refuses with 42501
--     (security_event_samples_not_allowed) when it is authenticated or anon.
--   Explicit for all three API roles and PUBLIC (apps/web/src/test/
--   migration-grants.ts), the same with and without Supabase's default
--   grants.
--
-- THE TEXT IS THE ATTACKER'S. target and sample are written by whoever sent
-- the request, scrubbed by the app. They are never a link, never markup and
-- never run: the console shows them as text nodes only.
-- ─────────────────────────────────────────────────────────────────────────────

-- LOCKS: none on any table that exists. The table has no foreign key, so
-- creating it locks nothing but itself, its index and its toast table; the
-- function bodies are plpgsql, which Postgres does not resolve when they are
-- created; no policy is created, so supautils takes nothing on the auth,
-- storage and realtime tables (0418's note). The preflight reads the
-- catalogs only. lock_timeout 900ms bounds anything unforeseen; it is not
-- reset at the end of the file, so the push's own last write, made in the
-- same transaction, has the same limit.
set lock_timeout = '900ms';

-- ── Preflight ────────────────────────────────────────────────────────────────
-- Reads the catalogs only. Refuses to run (55000, hint
-- security_event_samples_preflight, nothing applied) when a name this file
-- creates is taken (the file already ran, or was half applied by hand), or
-- when another function already names the advisory lock key the writer and
-- the purge take.
do $preflight$
declare
  v_bad text := '';
begin
  if exists (select 1 from pg_catalog.pg_class c
              where c.relnamespace = 'public'::regnamespace
                and c.relname in ('security_event_samples', 'security_event_samples_pkey',
                                  'security_event_samples_hour_dedupe_key'))
     or exists (select 1 from pg_catalog.pg_type t
                 where t.typnamespace = 'public'::regnamespace
                   and t.typname in ('security_event_samples', '_security_event_samples')) then
    v_bad := v_bad || ' a table, index or type name this file creates is taken (or this file already ran);';
  end if;

  if exists (select 1 from pg_catalog.pg_proc p
              where p.pronamespace = 'public'::regnamespace
                and p.proname in ('record_security_event_samples', 'purge_security_event_samples',
                                  'platform_security_event_samples')) then
    v_bad := v_bad || ' a function name this file creates is taken (or this file already ran);';
  end if;

  if exists (select 1 from pg_catalog.pg_proc p where p.prosrc like '%4790001%') then
    v_bad := v_bad || ' another function already names the advisory lock key 4790001;';
  end if;

  if v_bad <> '' then
    raise exception 'security_event_samples_preflight:%', v_bad
      using errcode = '55000', hint = 'security_event_samples_preflight';
  end if;
end
$preflight$;

-- ── The table ────────────────────────────────────────────────────────────────
create table public.security_event_samples (
  id             uuid        primary key default gen_random_uuid(),
  -- The start of the UTC hour the requests were made in.
  hour           timestamptz not null,
  -- A documented subset of security_events' own sets (0472): the probe
  -- route records exploit / blocked / <kind> from the web, and it is the one
  -- place that samples. A new kind is added here, in the writer below, and
  -- in core's SECURITY_PROBE_KINDS in the same release.
  category       text        not null,
  reason         text        not null,
  source         text        not null,
  -- Two capital letters, or none. Never a city.
  country        text,
  -- The method of the request; none only on an overflow row.
  method         text,
  -- The path asked for, scrubbed by the app: starts with '/', or is
  -- '(unreadable)' (the app could not decode it), or is
  -- '(more than could be listed)' on an overflow row (written here only).
  target         text        not null,
  -- The query string, scrubbed by the app and cut to 300 characters; none
  -- when there was none.
  sample         text,
  event_count    integer     not null default 1,
  first_seen_at  timestamptz not null,
  last_seen_at   timestamptz not null,
  -- What makes two requests in one hour the same row: everything else but
  -- the counts and the times. Computed by the database, never written.
  dedupe_key     text        not null generated always as (pg_catalog.md5(
                   category || pg_catalog.chr(31) || reason || pg_catalog.chr(31) || source
                   || pg_catalog.chr(31) || coalesce(country, '') || pg_catalog.chr(31) || coalesce(method, '')
                   || pg_catalog.chr(31) || target || pg_catalog.chr(31) || coalesce(sample, ''))) stored,
  constraint security_event_samples_hour_is_an_hour
    check (hour = date_trunc('hour', hour, 'UTC')),
  constraint security_event_samples_category
    check (category in ('exploit')),
  constraint security_event_samples_reason
    check (reason in ('env_file', 'git_dir', 'wordpress', 'php_file', 'admin_tool', 'path_traversal')),
  constraint security_event_samples_source
    check (source in ('web')),
  constraint security_event_samples_country
    check (country is null or country ~ '^[A-Z]{2}$'),
  constraint security_event_samples_method
    check (method is null or method in ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS')),
  -- The scrubber's promises, checked again: 1 to 200 characters, every one
  -- printable ASCII (a space to a tilde: no control, invisible,
  -- bidirectional or other non-ASCII character); no '@', and none
  -- percent-encoded once or more ('%40', '%2540', ...), so no email address;
  -- no run of six digits; no IPv4 address (four dot-separated groups of one
  -- to three digits); no run of 24 or more characters of the base64 and hex
  -- alphabet (letters, digits, + / _ = -: the scrubber's long-value rule,
  -- so no token, key or long id); no id, with its dashes or as 32 hex
  -- characters without them; and the shape of a path or one of the two
  -- fixed words. Every scrubber marker (<email>, <id>, <number>,
  -- <long value>, <token>, <removed>, <address>) and both fixed words pass.
  -- record_security_event_samples applies the same rule before it writes.
  constraint security_event_samples_target
    check (char_length(target) between 1 and 200
           and target !~ '[^ -~]'
           and target !~ '@'
           and target !~ '%(25)*40'
           and target !~ '[0-9]{6}'
           and target !~ '[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}'
           and target !~ '[A-Za-z0-9+/_=-]{24}'
           and target !~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
           and target !~* '[0-9a-f]{32}'
           and (target ~ '^/' or target in ('(unreadable)', '(more than could be listed)'))),
  -- The same promises for the query string, at most 300 characters.
  constraint security_event_samples_sample
    check (sample is null or (
           char_length(sample) between 1 and 300
           and sample !~ '[^ -~]'
           and sample !~ '@'
           and sample !~ '%(25)*40'
           and sample !~ '[0-9]{6}'
           and sample !~ '[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}'
           and sample !~ '[A-Za-z0-9+/_=-]{24}'
           and sample !~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
           and sample !~* '[0-9a-f]{32}')),
  -- An overflow row only counts: no method, no country, no sample. Every
  -- other row has a method.
  constraint security_event_samples_overflow_row
    check (case when target = '(more than could be listed)'
                then method is null and country is null and sample is null
                else method is not null end),
  constraint security_event_samples_count_positive
    check (event_count >= 1),
  -- Both times fall inside the row's hour, first before last.
  constraint security_event_samples_seen
    check (first_seen_at >= hour and last_seen_at >= first_seen_at
           and last_seen_at < hour + interval '1 hour'),
  -- Serves all three functions: the writer finds a row by hour and key and
  -- counts an hour's rows; the purge and the read take a range of hours.
  constraint security_event_samples_hour_dedupe_key unique (hour, dedupe_key)
);

comment on table public.security_event_samples is
  'What scanners asked for: for requests refused as a probe (category exploit, source web, reason one of the six probe kinds), the scrubbed path (target), the method and the scrubbed query string (sample), with a country and a count, by UTC hour. No column for an organization, an account, an address, a header, a body or a source hash. Attacker-chosen text: shown as text only, never as a link or markup. No API role reads a row except through platform_security_event_samples (bounded), or writes one except through record_security_event_samples(jsonb) (at most 50 new rows a kind and 300 in all an hour, then one overflow row a kind); rows whose hour began more than 90 days ago are removed by purge_security_event_samples(). The platform console reads it through platform_security_event_samples.';
comment on column public.security_event_samples.target is
  'The path asked for, scrubbed by the app (printable ASCII; no @, plain or percent-encoded; no run of six digits; no IPv4 address; no run of 24 base64 or hex characters; no id), 1 to 200 characters: starts with /, or is (unreadable), or (more than could be listed) on an overflow row. Written by whoever sent the request: text only.';
comment on column public.security_event_samples.sample is
  'The query string asked for, scrubbed by the app under the same rules as target, at most 300 characters; null when there was none. Written by whoever sent the request: text only.';

-- RLS on and no policy, and no table privilege for any API role: no API
-- role reads a row directly (service_role bypasses row security, so the
-- missing grant is what keeps it out).
alter table public.security_event_samples enable row level security;

-- Supabase's default privileges have given anon, authenticated and
-- service_role every privilege on a new public table; the change Supabase
-- set for 2026-10-30 (0402's note) takes SELECT, INSERT, UPDATE and DELETE
-- out of them. Everything is revoked from all of them here and nothing is
-- granted back, so the table ends the same under either set of defaults:
-- the three functions below are the only way in.
revoke all on table public.security_event_samples from public, anon, authenticated, service_role;

-- ── The writer ───────────────────────────────────────────────────────────────
create function public.record_security_event_samples(p_samples jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  -- THE BOUNDS OF ONE HOUR. Written here and nowhere else.
  -- New rows an hour for one probe kind (reason).
  c_kind_cap      constant integer := 50;
  -- New rows an hour in all.
  c_hour_cap      constant integer := 300;
  -- Elements read from one call's array.
  c_batch         constant integer := 50;
  -- The target of an overflow row.
  c_overflow      constant text := '(more than could be listed)';
  v_now           timestamptz := pg_catalog.now();
  v_el            jsonb;
  v_text          text;
  v_category      text;
  v_reason        text;
  v_source        text;
  v_method        text;
  v_target        text;
  v_sample        text;
  v_country       text;
  v_count         integer;
  v_at            timestamptz;
  v_hour          timestamptz;
  v_key           text;
  v_hour_rows     bigint;
  v_kind_rows     bigint;
  v_stored        integer := 0;
  v_overflowed    integer := 0;
  v_skipped       integer := 0;
  v_not_read      integer := 0;
begin
  -- The grant is the gate: service_role only. This second lock names no
  -- gate: the role setting names the caller inside this body too (0413).
  if coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon') then
    raise exception 'security_event_samples_not_allowed' using errcode = '42501';
  end if;

  if p_samples is null or pg_catalog.jsonb_typeof(p_samples) <> 'array' then
    return pg_catalog.jsonb_build_object('stored', 0, 'overflowed', 0, 'skipped', 0, 'not_read', 0,
                                         'not_a_list', true);
  end if;
  v_not_read := greatest(pg_catalog.jsonb_array_length(p_samples) - c_batch, 0);

  -- One call at a time (purge_security_event_samples takes the same lock),
  -- so the caps below count exactly. Its own key: never 4720001, the
  -- security events' writer's, so the two records never wait on each other.
  -- A call that waits 2 s for its turn ends with 55P03 (the function's
  -- lock_timeout); its caller drops the batch.
  perform pg_catalog.pg_advisory_xact_lock(4790001);

  -- Every value below is tested on its JSON type and its text before it is
  -- used, so no element can make this raise.
  for v_el in
    select t.e from pg_catalog.jsonb_array_elements(p_samples) with ordinality as t(e, n)
     order by t.n limit c_batch
  loop
    if pg_catalog.jsonb_typeof(v_el) <> 'object'
       or coalesce(pg_catalog.jsonb_typeof(v_el -> 'category'), '') <> 'string'
       or coalesce(pg_catalog.jsonb_typeof(v_el -> 'reason'), '') <> 'string'
       or coalesce(pg_catalog.jsonb_typeof(v_el -> 'source'), '') <> 'string'
       or coalesce(pg_catalog.jsonb_typeof(v_el -> 'method'), '') <> 'string'
       or coalesce(pg_catalog.jsonb_typeof(v_el -> 'target'), '') <> 'string'
       or coalesce(pg_catalog.jsonb_typeof(v_el -> 'sample'), 'null') not in ('null', 'string') then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    v_category := v_el ->> 'category';
    v_reason   := v_el ->> 'reason';
    v_source   := v_el ->> 'source';
    v_method   := v_el ->> 'method';
    v_target   := v_el ->> 'target';
    v_sample   := nullif(v_el ->> 'sample', '');

    -- The table's own rules (security_event_samples_category, _reason,
    -- _source, _method), word for word.
    if v_category not in ('exploit')
       or v_reason not in ('env_file', 'git_dir', 'wordpress', 'php_file', 'admin_tool', 'path_traversal')
       or v_source not in ('web')
       or v_method not in ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS') then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- The target: the table's own rule (security_event_samples_target), word
    -- for word, except that the overflow row's word is refused (it is
    -- written here only). The length is tested first, on its own, so no
    -- pattern runs over a long text.
    if pg_catalog.char_length(v_target) not between 1 and 200 then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    if v_target ~ '[^ -~]'
       or v_target ~ '@'
       or v_target ~ '%(25)*40'
       or v_target ~ '[0-9]{6}'
       or v_target ~ '[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}'
       or v_target ~ '[A-Za-z0-9+/_=-]{24}'
       or v_target ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
       or v_target ~* '[0-9a-f]{32}'
       or not (v_target ~ '^/' or v_target = '(unreadable)') then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- The sample: the table's own rule (security_event_samples_sample), word
    -- for word. An empty one is none; one that fails the rule refuses the
    -- whole element (nothing of a request the scrubber got wrong is kept).
    if v_sample is not null then
      if pg_catalog.char_length(v_sample) > 300 then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      if v_sample ~ '[^ -~]'
         or v_sample ~ '@'
         or v_sample ~ '%(25)*40'
         or v_sample ~ '[0-9]{6}'
         or v_sample ~ '[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}'
         or v_sample ~ '[A-Za-z0-9+/_=-]{24}'
         or v_sample ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
         or v_sample ~* '[0-9a-f]{32}' then
        v_skipped := v_skipped + 1;
        continue;
      end if;
    end if;

    -- The country: two capital letters, or none (the element is still
    -- stored).
    v_country := null;
    if coalesce(pg_catalog.jsonb_typeof(v_el -> 'country'), '') = 'string'
       and (v_el ->> 'country') ~ '^[A-Z]{2}$' then
      v_country := v_el ->> 'country';
    end if;

    -- A count of 1 to 999999, as a number or as digits; anything else is 1.
    v_count := 1;
    v_text := v_el ->> 'count';
    if v_text ~ '^[0-9]{1,6}$' then
      v_count := greatest(v_text::integer, 1);
    end if;

    -- When it happened: milliseconds since 1970, within the last 26 hours
    -- (as the security events' writer takes them); anything else is now.
    v_at := v_now;
    v_text := v_el ->> 'at_ms';
    if v_text ~ '^[0-9]{12,14}$' then
      v_at := pg_catalog.to_timestamp(v_text::numeric / 1000.0);
      if v_at > v_now + interval '1 minute' or v_at < v_now - interval '26 hours' then
        v_at := v_now;
      end if;
    end if;
    v_hour := pg_catalog.date_trunc('hour', v_at, 'UTC');

    -- The row it belongs to, when it has one: its count and times move, at a
    -- cap or not. The key is the table's dedupe_key, written the same way.
    v_key := pg_catalog.md5(
      v_category || pg_catalog.chr(31) || v_reason || pg_catalog.chr(31) || v_source
      || pg_catalog.chr(31) || coalesce(v_country, '') || pg_catalog.chr(31) || v_method
      || pg_catalog.chr(31) || v_target || pg_catalog.chr(31) || coalesce(v_sample, ''));
    update public.security_event_samples s
       set event_count   = least(s.event_count::bigint + v_count, 2000000000)::integer,
           first_seen_at = least(s.first_seen_at, v_at),
           last_seen_at  = greatest(s.last_seen_at, v_at)
     where s.hour = v_hour and s.dedupe_key = v_key;
    if found then
      v_stored := v_stored + 1;
      continue;
    end if;

    -- A new row: the caps. The listed rows of the hour (overflow rows are
    -- not counted), in all and of this kind.
    select pg_catalog.count(*), pg_catalog.count(*) filter (where s.reason = v_reason)
      into v_hour_rows, v_kind_rows
      from public.security_event_samples s
     where s.hour = v_hour and s.target <> c_overflow;

    if v_kind_rows >= c_kind_cap or v_hour_rows >= c_hour_cap then
      -- Past a cap: counted on the kind's overflow row for the hour.
      insert into public.security_event_samples as s
        (hour, category, reason, source, country, method, target, sample,
         event_count, first_seen_at, last_seen_at)
      values
        (v_hour, v_category, v_reason, v_source, null, null, c_overflow, null,
         v_count, v_at, v_at)
      on conflict on constraint security_event_samples_hour_dedupe_key do update
        set event_count   = least(s.event_count::bigint + excluded.event_count, 2000000000)::integer,
            first_seen_at = least(s.first_seen_at, excluded.first_seen_at),
            last_seen_at  = greatest(s.last_seen_at, excluded.last_seen_at);
      v_overflowed := v_overflowed + 1;
    else
      -- The update above found no row and this call holds the one writer
      -- lock, so this inserts; ON CONFLICT only keeps it from raising if
      -- that ever stopped being true.
      insert into public.security_event_samples as s
        (hour, category, reason, source, country, method, target, sample,
         event_count, first_seen_at, last_seen_at)
      values
        (v_hour, v_category, v_reason, v_source, v_country, v_method, v_target, v_sample,
         v_count, v_at, v_at)
      on conflict on constraint security_event_samples_hour_dedupe_key do update
        set event_count   = least(s.event_count::bigint + excluded.event_count, 2000000000)::integer,
            first_seen_at = least(s.first_seen_at, excluded.first_seen_at),
            last_seen_at  = greatest(s.last_seen_at, excluded.last_seen_at);
      v_stored := v_stored + 1;
    end if;
  end loop;

  return pg_catalog.jsonb_build_object('stored', v_stored, 'overflowed', v_overflowed, 'skipped', v_skipped,
                                       'not_read', v_not_read, 'not_a_list', false);
end;
$$;

-- Supabase's default privileges grant EXECUTE on a new public function to
-- anon, authenticated and service_role, and Postgres grants it to PUBLIC.
revoke all on function public.record_security_event_samples(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.record_security_event_samples(jsonb) to service_role;

comment on function public.record_security_event_samples(jsonb) is
  'Stores scrubbed request samples: an array, of which the first 50 elements are read, of objects with category (exploit), reason (one of the six probe kinds), source (web), method (GET, HEAD, POST, PUT, PATCH, DELETE or OPTIONS), target (the scrubbed path, under the table''s rule) and optionally sample (the scrubbed query string, under the same rule; empty or null is none), country (two capital letters, else none), count (1 to 999999, else 1) and at_ms (within the last 26 hours, else now). An element that fails a rule is skipped; never raises for bad input. A repeat in the same hour adds to its row. At most 50 new rows a kind and 300 in all an hour; past a cap the element is counted on its kind''s overflow row (target (more than could be listed)). One call at a time under its own advisory lock (4790001); a call that waits 2 s ends with 55P03. Returns {stored, overflowed, skipped, not_read, not_a_list}. service_role only.';

-- ── Retention ────────────────────────────────────────────────────────────────
create function public.purge_security_event_samples()
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_deleted integer;
begin
  -- The grant is the gate: service_role only (the second lock, as above).
  if coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon') then
    raise exception 'security_event_samples_not_allowed' using errcode = '42501';
  end if;

  -- The writer's lock: a purge and a write never hold each other's rows.
  perform pg_catalog.pg_advisory_xact_lock(4790001);

  -- The events' own retention (purge_security_events, 0472): a row goes
  -- once its hour began more than 90 days ago. Oldest first, at most 5,000.
  with doomed as (
    select s.id
      from public.security_event_samples s
     where s.hour < pg_catalog.now() - interval '90 days'
     order by s.hour
     limit 5000
  )
  delete from public.security_event_samples s using doomed d where s.id = d.id;
  get diagnostics v_deleted = row_count;

  return pg_catalog.jsonb_build_object('deleted', v_deleted);
end;
$$;

revoke all on function public.purge_security_event_samples() from public, anon, authenticated, service_role;
grant execute on function public.purge_security_event_samples() to service_role;

comment on function public.purge_security_event_samples() is
  'Deletes security_event_samples rows whose hour began more than 90 days ago (the security events'' own retention), oldest first, at most 5,000 a call, under the writer''s advisory lock (a wait of 2 s ends with 55P03). Returns {deleted}; the scheduled job calls it until that is under 5,000. service_role only.';

-- ── The console's read ───────────────────────────────────────────────────────
create function public.platform_security_event_samples(
  p_from     timestamptz default null,
  p_to       timestamptz default null,
  p_reason   text        default null,
  p_category text        default null,
  p_country  text        default null,
  p_limit    integer     default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
set timezone = 'UTC'
as $$
declare
  -- THE BOUNDS OF ONE READ. Written here and nowhere else.
  -- The most rows of the table one answer reads. A window that holds more
  -- is read from a later whole hour that keeps it to this many, and the
  -- answer says so. The writer's caps hold an hour to 306 rows, so 7 days
  -- of them (51,408) are read whole; the ceiling binds only on rows that
  -- came another way.
  c_max_rows      constant integer  := 60000;
  -- The longest window, in whole hours.
  c_longest       constant interval := '168 hours';
  -- The window when no start is given: the 24 hours up to its end.
  c_default_span  constant interval := '24 hours';
  -- Targets returned: this many when none is asked for, never more than
  -- the most.
  c_default_limit constant integer  := 10;
  c_most_targets  constant integer  := 50;
  -- Method and query string pairs returned for one target.
  c_samples       constant integer  := 5;
  -- The target of an overflow row (the writer's word).
  c_overflow      constant text     := '(more than could be listed)';
  -- No window starts or ends before this: a time before it is not a time
  -- the record holds, and stepping back from it can never leave the range
  -- of a timestamp.
  c_earliest      constant timestamptz := '2000-01-01 00:00:00+00';
  v_now          timestamptz := pg_catalog.now();
  v_this_hour    timestamptz := pg_catalog.date_trunc('hour', pg_catalog.now(), 'UTC');
  v_to           timestamptz;
  v_asked_from   timestamptz;
  v_from         timestamptz;
  v_hour         timestamptz;
  v_rows         bigint := 0;
  v_n            bigint;
  v_shortened    boolean := false;
  v_limit        integer;
  v_result       jsonb;
begin
  -- The grant is the gate: service_role only. This second lock names no
  -- gate: the role setting names the caller inside this body too (0413).
  if coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon') then
    raise exception 'security_event_samples_not_allowed' using errcode = '42501';
  end if;

  -- The window asked for, in whole UTC hours: up to p_to (default: the end
  -- of the hour that is running now), from p_from (default: 24 hours before
  -- the end). A window or a filter that cannot be read is answered, not
  -- raised, and the answer holds a fixed word, never the argument.
  -- A time that is not finite, or before 2000, is not_a_time; the end is
  -- tested before the default start is counted back from it, so no
  -- argument takes a time out of range.
  v_to         := coalesce(p_to, v_this_hour + interval '1 hour');
  if not pg_catalog.isfinite(v_to) or v_to < c_earliest then
    return pg_catalog.jsonb_build_object('window', null, 'refused', 'not_a_time', 'generated_at', v_now);
  end if;
  v_asked_from := coalesce(p_from, v_to - c_default_span);
  if not pg_catalog.isfinite(v_asked_from) or v_asked_from < c_earliest then
    return pg_catalog.jsonb_build_object('window', null, 'refused', 'not_a_time', 'generated_at', v_now);
  end if;
  if v_to <> pg_catalog.date_trunc('hour', v_to, 'UTC')
     or v_asked_from <> pg_catalog.date_trunc('hour', v_asked_from, 'UTC') then
    return pg_catalog.jsonb_build_object('window', null, 'refused', 'not_whole_hours', 'generated_at', v_now);
  end if;
  if v_to > v_this_hour + interval '1 hour' then
    return pg_catalog.jsonb_build_object('window', null, 'refused', 'to_in_the_future', 'generated_at', v_now);
  end if;
  if v_asked_from >= v_to then
    return pg_catalog.jsonb_build_object('window', null, 'refused', 'from_not_before_to', 'generated_at', v_now);
  end if;
  if v_to - v_asked_from > c_longest then
    return pg_catalog.jsonb_build_object('window', null, 'refused', 'longer_than_7_days', 'generated_at', v_now);
  end if;
  if p_reason is not null and p_reason !~ '^[a-z][a-z0-9_]{0,47}$' then
    return pg_catalog.jsonb_build_object('window', null, 'refused', 'not_a_reason', 'generated_at', v_now);
  end if;
  if p_category is not null
     and p_category not in ('password_guessing', 'exploit', 'bots', 'phishing', 'malware') then
    return pg_catalog.jsonb_build_object('window', null, 'refused', 'not_a_category', 'generated_at', v_now);
  end if;
  if p_country is not null and p_country !~ '^[A-Z]{2}$' then
    return pg_catalog.jsonb_build_object('window', null, 'refused', 'not_a_country', 'generated_at', v_now);
  end if;
  v_limit := least(greatest(coalesce(p_limit, c_default_limit), 1), c_most_targets);

  -- The row ceiling. The hours are counted newest first, each by its own
  -- probe of the index on hour that stops at what is left of the ceiling,
  -- so at most the ceiling and one row are counted whatever the table
  -- holds. When the ceiling is passed inside an hour, the window is read
  -- from the hour after it.
  v_from := v_asked_from;
  v_hour := v_to - interval '1 hour';
  while v_hour >= v_asked_from loop
    select pg_catalog.count(*) into v_n
      from (select 1 from public.security_event_samples s
             where s.hour = v_hour
             limit c_max_rows - v_rows + 1) q;
    v_rows := v_rows + v_n;
    if v_rows > c_max_rows then
      v_from := v_hour + interval '1 hour';
      v_shortened := true;
      exit;
    end if;
    v_hour := v_hour - interval '1 hour';
  end loop;
  if v_from >= v_to then
    -- The newest hour alone holds more than the ceiling.
    return pg_catalog.jsonb_build_object('window', null, 'refused', 'too_many_rows_in_one_hour', 'generated_at', v_now);
  end if;

  -- The rows of the window read, with the filters. A row is in the window
  -- when its hour starts at or after the start and before the end. The
  -- country filter applies to the listed rows only: an overflow row has no
  -- country, so what it counted is given for the kind in every country.
  with r as (
    select s.hour, s.reason, s.country, s.method, s.target, s.sample, s.event_count,
           s.first_seen_at, s.last_seen_at, (s.target = c_overflow) as over
      from public.security_event_samples s
     where s.hour >= v_from
       and s.hour < v_to
       and (p_reason is null or s.reason = p_reason)
       and (p_category is null or s.category = p_category)
  ),
  listed as (
    select r.* from r where not r.over and (p_country is null or r.country = p_country)
  ),
  -- A target: one path of one kind, its counts summed over hours, methods,
  -- query strings and countries.
  t as (
    select l.reason, l.target,
           pg_catalog.sum(l.event_count)::bigint as events,
           pg_catalog.min(l.first_seen_at) as first_seen_at,
           pg_catalog.max(l.last_seen_at) as last_seen_at
      from listed l
     group by l.reason, l.target
  ),
  -- Most first; equal counts, the newest first; then by kind and path.
  t_ranked as (
    select t.*, pg_catalog.row_number() over (order by t.events desc, t.last_seen_at desc, t.reason, t.target) as n
      from t
  ),
  kept as (
    select * from t_ranked where n <= v_limit
  ),
  -- For each kept target, its method and query string pairs, ranked the
  -- same way (no query string first among equals).
  pairs as (
    select l.reason, l.target, l.method, l.sample,
           pg_catalog.sum(l.event_count)::bigint as events,
           pg_catalog.max(l.last_seen_at) as last_seen_at
      from listed l
      join kept k on k.reason = l.reason and k.target = l.target
     group by l.reason, l.target, l.method, l.sample
  ),
  pairs_ranked as (
    select p.*,
           pg_catalog.row_number() over (partition by p.reason, p.target
                                         order by p.events desc, p.last_seen_at desc, p.method,
                                                  p.sample nulls first) as n
      from pairs p
  ),
  pairs_json as (
    select x.reason, x.target,
           pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'method', x.method, 'sample', x.sample, 'events', x.events, 'last_seen_at', x.last_seen_at)
             order by x.n) filter (where x.n <= c_samples) as samples,
           pg_catalog.count(*) > c_samples as truncated
      from pairs_ranked x
     group by x.reason, x.target
  ),
  -- What the overflow rows counted, per kind.
  more as (
    select r.reason, pg_catalog.sum(r.event_count)::bigint as events,
           pg_catalog.count(distinct r.hour)::integer as hours
      from r
     where r.over
     group by r.reason
  )
  select pg_catalog.jsonb_build_object(
           'targets', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                                   'reason', k.reason, 'target', k.target, 'events', k.events,
                                   'first_seen_at', k.first_seen_at, 'last_seen_at', k.last_seen_at,
                                   'samples', pj.samples, 'samples_truncated', pj.truncated)
                                   order by k.n)
                                  from kept k
                                  join pairs_json pj on pj.reason = k.reason and pj.target = k.target),
                               '[]'::jsonb),
           'targets_truncated', (select pg_catalog.count(*) > v_limit from t),
           'listed_targets', (select pg_catalog.count(*) from t),
           'listed_events', (select coalesce(pg_catalog.sum(t.events), 0) from t),
           'more_than_listed', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                                            'reason', m.reason, 'events', m.events, 'hours', m.hours)
                                            order by m.reason)
                                           from more m),
                                        '[]'::jsonb))
    into v_result;

  return v_result || pg_catalog.jsonb_build_object(
    'window', pg_catalog.jsonb_build_object('from', v_from, 'to', v_to, 'asked_from', v_asked_from),
    'window_shortened', v_shortened,
    'refused', null,
    'generated_at', v_now,
    'oldest_hour', (select pg_catalog.min(s.hour) from public.security_event_samples s));
end;
$$;

revoke all on function public.platform_security_event_samples(timestamptz, timestamptz, text, text, text, integer) from public, anon, authenticated, service_role;
grant execute on function public.platform_security_event_samples(timestamptz, timestamptz, text, text, text, integer) to service_role;

comment on function public.platform_security_event_samples(timestamptz, timestamptz, text, text, text, integer) is
  'For the platform console: what scanners asked for in a window of whole UTC hours, from p_from (default: 24 hours before the end) up to, not including, p_to (default: the end of the hour running now), at most 7 days; optionally one reason (probe kind), one category and one country. Keys: window (from, to, asked_from), window_shortened, refused (null), generated_at, oldest_hour (the earliest hour on record); targets, at most p_limit (default 10, at most 50): reason, target, events (summed over the window), first_seen_at, last_seen_at, samples (at most 5 pairs of method, sample, events, last_seen_at) and samples_truncated, listed most first and, for equal counts, the newest first; targets_truncated, listed_targets, listed_events; more_than_listed (reason, events, hours: what the overflow rows counted, for every country). A window that holds more than 60,000 rows is read from a later whole hour (window_shortened). A window that is not a time (not finite, or before 2000), not on whole hours, ends after the hour running now, is out of order or longer than 7 days, a reason that is not a reason code, a category or a country that is not one, and one hour alone over the ceiling, answer window null and refused with a fixed word (not_a_time, not_whole_hours, to_in_the_future, from_not_before_to, longer_than_7_days, not_a_reason, not_a_category, not_a_country, too_many_rows_in_one_hour); no argument makes it raise. Returns no row id or key. Read-only. service_role only: the grant is the whole control; called as authenticated or anon it raises 42501.';

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- Nothing depends on these objects but the app code that follows this
-- migration, which treats a missing function as "could not record" or
-- "could not check". To remove them (an ACCESS EXCLUSIVE lock on the new
-- table only; no other table is locked; the rows go with it):
--   drop function if exists public.platform_security_event_samples(timestamptz, timestamptz, text, text, text, integer);
--   drop function if exists public.purge_security_event_samples();
--   drop function if exists public.record_security_event_samples(jsonb);
--   drop table if exists public.security_event_samples;
