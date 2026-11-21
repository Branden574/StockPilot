-- 0472_security_events.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- One shared record of security events: what the app refused, allowed or
-- flagged, by category, with a country and city when known. The sign-in
-- alerts, the admin security pages and the scheduled reports read it; the
-- detectors write it through one function. The number is a placeholder: it is
-- fixed at push time to the next free number, and nothing in this file names
-- it.
--
-- WHAT IT ADDS (tier A: a new table, three indexes, one policy, two functions
-- and grants; additive only)
--   1. public.security_events. One row stands for one kind of event from one
--      source in one UTC minute, with a count. It holds a category, an
--      outcome, a short reason code, a coarse source (web, phone, api, email,
--      edge), the organization when the event is about one, a country and
--      city, and a keyed hash of the caller's address.
--      It never holds a network address, an email, an account, a path or a
--      user agent, and has no column for one. The hash is made by the app with
--      a key that changes every UTC day, and is cleared after 24 hours (2
--      below), so it groups events from one source within a day and nothing
--      else.
--   2. public.record_security_events(jsonb): the only way a row is written.
--      SECURITY DEFINER, service_role only. It checks every field against the
--      table's own rules and skips an element that fails one, so a caller
--      cannot make it raise with bad input. Three rules live here because the
--      rows they need are here:
--        - repeats: a wrong password or wrong code from a source that already
--          has four or more password events in the last ten minutes is stored
--          as repeated_wrong_password or repeated_wrong_code;
--        - the minute cap: at most 200 rows for one minute. Past it, an event
--          that would need a new row is counted on an overflow row (reason
--          over_minute_cap, with no organization, place or hash), one per
--          category, outcome and source;
--        - one row per minute and kind: a repeat adds to event_count.
--   3. public.purge_security_events(): deletes rows older than 90 days (at
--      most 20,000 a call) and clears source_hash on rows older than 24 hours.
--      SECURITY DEFINER, service_role only; a scheduled job calls it.
--
-- WHO CAN READ AND WRITE
--   - RLS is on. The one policy lets an organization's admins and owners
--     (has_org_role(organization_id, 'admin')) read their organization's rows.
--     A row with no organization passes for nobody.
--   - authenticated may SELECT every column except source_hash and dedupe_key
--     (a column grant: a read names its columns). anon and PUBLIC get nothing.
--   - service_role may SELECT. INSERT, UPDATE and DELETE are revoked from it
--     too: rows are written by record_security_events and removed by
--     purge_security_events, both owned by the migration role.
--   Explicit for all three API roles (apps/web/src/test/migration-grants.ts),
--   right with and without Supabase's default grants.
--
-- NOTHING EXISTING CHANGES. No row, table, function, policy, trigger or grant
-- that exists today is altered, and nothing is backfilled.
--
-- ROLLBACK
--   Nothing reads the table until the app code that follows this migration.
--   Leave it in place. If it ever has to go:
--     drop function public.purge_security_events();
--     drop function public.record_security_events(jsonb);
--     drop table public.security_events;
-- ─────────────────────────────────────────────────────────────────────────────

-- LOCKS: the foreign key takes SHARE ROW EXCLUSIVE on public.organizations to
-- commit; it waits behind any open transaction on that table. lock_timeout
-- 900ms ends such a wait with 55P03 and nothing applied; the push can be run
-- again once that transaction has finished.
set lock_timeout = '900ms';

create table public.security_events (
  id               uuid        primary key default gen_random_uuid(),
  -- The start of the UTC minute the events happened in.
  minute           timestamptz not null,
  category         text        not null,
  outcome          text        not null,
  reason           text        not null,
  source           text        not null,
  organization_id  uuid        references public.organizations(id) on delete cascade,
  country          text,
  city             text,
  source_hash      text,
  event_count      integer     not null default 1,
  last_seen_at     timestamptz not null default now(),
  dedupe_key       text        not null,
  constraint security_events_minute_is_a_minute
    check (minute = date_trunc('minute', minute, 'UTC')),
  constraint security_events_category
    check (category in ('password_guessing', 'exploit', 'bots', 'phishing', 'malware')),
  constraint security_events_outcome
    check (outcome in ('blocked', 'allowed', 'flagged')),
  -- A reason is a short lower-case code, as the code spells it.
  constraint security_events_reason
    check (reason ~ '^[a-z][a-z0-9_]{0,47}$'),
  constraint security_events_source
    check (source in ('web', 'phone', 'api', 'email', 'edge')),
  constraint security_events_country
    check (country is null or country ~ '^[A-Z]{2}$'),
  constraint security_events_city
    check (city is null or (char_length(city) between 1 and 80 and city !~ '[[:cntrl:]]')),
  constraint security_events_source_hash
    check (source_hash is null or source_hash ~ '^[0-9a-f]{32}$'),
  constraint security_events_count_positive
    check (event_count >= 1),
  constraint security_events_dedupe_key
    check (dedupe_key ~ '^[0-9a-f]{32}$'),
  constraint security_events_minute_dedupe_key unique (minute, dedupe_key)
);

-- An organization's newest rows; also serves the cascade from organizations.
create index security_events_organization_minute_idx
  on public.security_events (organization_id, minute desc)
  where organization_id is not null;

-- The repeats rule and the 24-hour clearing read rows by their source.
create index security_events_source_hash_minute_idx
  on public.security_events (source_hash, minute)
  where source_hash is not null;

comment on table public.security_events is
  'Security events by minute: category, outcome, reason code, coarse source, organization when known, country and city, a count. Never an address, an email or an account. Written only by record_security_events(jsonb); rows older than 90 days are removed by purge_security_events().';
comment on column public.security_events.source_hash is
  'A keyed hash of the caller''s address, made by the app with a key that changes every UTC day. Groups events from one source within a day. Cleared after 24 hours. Not readable by authenticated.';

alter table public.security_events enable row level security;

create policy security_events_admin_read on public.security_events
  for select to authenticated
  using ( ( select public.has_org_role(security_events.organization_id, 'admin') ) );

-- Supabase's default privileges give anon, authenticated and service_role
-- every privilege on a new public table; the change Supabase set for
-- 2026-10-30 (0402's note) takes SELECT, INSERT, UPDATE and DELETE out of
-- them. Everything is revoked from all of them here, then granted back by
-- name, so the table ends the same under either set of defaults.
revoke all on table public.security_events from public, anon, authenticated, service_role;
grant select on table public.security_events to service_role;
grant select (id, minute, category, outcome, reason, source, organization_id,
              country, city, event_count, last_seen_at)
  on table public.security_events to authenticated;

-- ── The writer ───────────────────────────────────────────────────────────────
create function public.record_security_events(p_events jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now      timestamptz := pg_catalog.clock_timestamp();
  v_el       jsonb;
  v_text     text;
  v_category text;
  v_outcome  text;
  v_reason   text;
  v_source   text;
  v_org      uuid;
  v_country  text;
  v_city     text;
  v_hash     text;
  v_count    integer;
  v_at       timestamptz;
  v_minute   timestamptz;
  v_key      text;
  v_recent   bigint;
  v_rows     bigint;
  v_stored   integer := 0;
begin
  if p_events is null or pg_catalog.jsonb_typeof(p_events) <> 'array' then
    return 0;
  end if;

  -- Every cast below follows a pattern check on the text, so no element can
  -- make this raise: an element that fails a rule is skipped.
  for v_el in
    select t.e from pg_catalog.jsonb_array_elements(p_events) as t(e) limit 200
  loop
    if pg_catalog.jsonb_typeof(v_el) <> 'object' then
      continue;
    end if;

    v_category := v_el ->> 'category';
    v_outcome  := v_el ->> 'outcome';
    v_reason   := v_el ->> 'reason';
    v_source   := v_el ->> 'source';
    if v_category is null
       or v_category not in ('password_guessing', 'exploit', 'bots', 'phishing', 'malware') then
      continue;
    end if;
    if v_outcome is null or v_outcome not in ('blocked', 'allowed', 'flagged') then
      continue;
    end if;
    if v_reason is null or v_reason !~ '^[a-z][a-z0-9_]{0,47}$' then
      continue;
    end if;
    if v_source is null or v_source not in ('web', 'phone', 'api', 'email', 'edge') then
      continue;
    end if;

    -- The organization, when it is a uuid of an organization that exists. One
    -- deleted between this read and the insert below fails the foreign key
    -- and the whole call with it; the caller drops the batch.
    v_org := null;
    v_text := pg_catalog.lower(v_el ->> 'organization_id');
    if v_text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select o.id into v_org from public.organizations o where o.id = v_text::uuid;
    end if;

    v_country := v_el ->> 'country';
    if v_country is null or v_country !~ '^[A-Z]{2}$' then
      v_country := null;
    end if;

    v_city := pg_catalog.btrim(v_el ->> 'city');
    if v_city is null
       or pg_catalog.char_length(v_city) not between 1 and 80
       or v_city ~ '[[:cntrl:]]' then
      v_city := null;
    end if;

    v_hash := v_el ->> 'source_hash';
    if v_hash is null or v_hash !~ '^[0-9a-f]{32}$' then
      v_hash := null;
    end if;

    v_count := 1;
    v_text := v_el ->> 'count';
    if v_text ~ '^[0-9]{1,6}$' and v_text::integer >= 1 then
      v_count := v_text::integer;
    end if;

    -- When it happened: milliseconds since 1970, within the last 26 hours
    -- (a scheduled reader reports the hour before); anything else is now.
    v_at := v_now;
    v_text := v_el ->> 'at_ms';
    if v_text ~ '^[0-9]{12,14}$' then
      v_at := pg_catalog.to_timestamp(v_text::numeric / 1000.0);
      if v_at > v_now + interval '1 minute' or v_at < v_now - interval '26 hours' then
        v_at := v_now;
      end if;
    end if;
    v_minute := pg_catalog.date_trunc('minute', v_at, 'UTC');

    -- Repeats from one source: with this one, five or more password events in
    -- ten minutes.
    if v_category = 'password_guessing'
       and v_reason in ('wrong_password', 'wrong_code')
       and v_hash is not null then
      select coalesce(sum(s.event_count), 0) into v_recent
        from public.security_events s
       where s.source_hash = v_hash
         and s.category = 'password_guessing'
         and s.minute > v_minute - interval '10 minutes'
         and s.minute <= v_minute;
      if v_recent + v_count >= 5 then
        v_reason := 'repeated_' || v_reason;
      end if;
    end if;

    v_key := pg_catalog.md5(pg_catalog.concat_ws(pg_catalog.chr(31),
      v_category, v_outcome, v_reason, v_source,
      coalesce(v_org::text, ''), coalesce(v_country, ''), coalesce(v_city, ''),
      coalesce(v_hash, '')));

    -- The minute cap: a new row past 200 in its minute is counted on the
    -- overflow row of its category, outcome and source instead.
    if not exists (select 1 from public.security_events s
                    where s.minute = v_minute and s.dedupe_key = v_key) then
      select count(*) into v_rows from public.security_events s where s.minute = v_minute;
      if v_rows >= 200 then
        v_reason  := 'over_minute_cap';
        v_org     := null;
        v_country := null;
        v_city    := null;
        v_hash    := null;
        v_key := pg_catalog.md5(pg_catalog.concat_ws(pg_catalog.chr(31),
          v_category, v_outcome, v_reason, v_source, '', '', '', ''));
      end if;
    end if;

    insert into public.security_events as s
      (minute, category, outcome, reason, source, organization_id, country, city,
       source_hash, event_count, last_seen_at, dedupe_key)
    values
      (v_minute, v_category, v_outcome, v_reason, v_source, v_org, v_country, v_city,
       v_hash, v_count, v_at, v_key)
    on conflict on constraint security_events_minute_dedupe_key do update
      set event_count  = least(s.event_count::bigint + excluded.event_count, 2000000000)::integer,
          last_seen_at = greatest(s.last_seen_at, excluded.last_seen_at);

    v_stored := v_stored + 1;
  end loop;

  return v_stored;
end;
$$;

-- Supabase's default privileges grant EXECUTE on a new public function to
-- anon, authenticated and service_role, and Postgres grants it to PUBLIC.
revoke all on function public.record_security_events(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.record_security_events(jsonb) to service_role;

comment on function public.record_security_events(jsonb) is
  'Stores security events (an array of objects: category, outcome, reason, source, and optionally organization_id, country, city, source_hash, count, at_ms). Skips an element that fails a rule; never raises for bad input. Applies the repeats rule and the 200-rows-a-minute cap. Returns how many elements were stored. service_role only.';

-- ── Retention ────────────────────────────────────────────────────────────────
create function public.purge_security_events()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
  v_cleared integer;
begin
  with doomed as (
    select s.id
      from public.security_events s
     where s.minute < pg_catalog.now() - interval '90 days'
     order by s.minute
     limit 20000
  )
  delete from public.security_events s using doomed d where s.id = d.id;
  get diagnostics v_deleted = row_count;

  update public.security_events s
     set source_hash = null
   where s.source_hash is not null
     and s.minute < pg_catalog.now() - interval '24 hours';
  get diagnostics v_cleared = row_count;

  return pg_catalog.jsonb_build_object('deleted', v_deleted, 'hashes_cleared', v_cleared);
end;
$$;

revoke all on function public.purge_security_events() from public, anon, authenticated, service_role;
grant execute on function public.purge_security_events() to service_role;

comment on function public.purge_security_events() is
  'Deletes security_events rows older than 90 days (at most 20,000 a call) and clears source_hash on rows older than 24 hours. Returns {deleted, hashes_cleared}. service_role only; called by a scheduled job.';

reset lock_timeout;
