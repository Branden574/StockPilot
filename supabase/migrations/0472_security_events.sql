-- 0472_security_events.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- One shared record of security events: what the app refused, allowed or
-- flagged, by category, with a country and city when known. The sign-in
-- alerts, the admin security pages and the scheduled reports read it; the
-- detectors write it through one function. The advisory lock key below
-- (4720001) carries this file's number.
--
-- WHAT IT ADDS (tier A: a new table, three indexes, five functions and grants.
-- No stored row and no existing function, policy, trigger or grant changes.
-- The one existing object touched is public.organizations, which gains the
-- foreign key's two internal triggers: deleting an organization also deletes
-- its event rows.)
--   1. public.security_events. One row stands for one kind of event from one
--      source in one UTC minute, with a count. It holds a category, an
--      outcome, a short reason code, a coarse source (web, phone, api, email,
--      edge), the organization when the event is about one, a country and
--      city, and a keyed hash of the caller's address.
--      It has no column for a network address, an email, an account, a path
--      or a user agent, and the one free-text column, city, refuses the shapes
--      those take (an '@', a slash, a colon, four or more digits, an id).
--      The hash is made by the app with a key that changes every UTC day. The
--      purge (3 below) clears it from rows older than 24 hours and, with it,
--      the row key that was derived from it, so after that nothing in a row
--      says which source it came from. Between purge runs a hash can be older
--      than 24 hours.
--   2. public.record_security_events(jsonb): the way the app writes rows.
--      SECURITY DEFINER, service_role only. The four required fields
--      (category, outcome, reason, source) must each be a JSON string that
--      meets the table's rule, or the element is skipped. An optional field
--      that fails its rule is left empty (organization, country, city, hash)
--      or defaulted (a count becomes 1, a time becomes now) and the event is
--      still stored. No input makes it raise. Three rules live here because
--      the rows they need are here:
--        - repeats: a wrong password or wrong code is stored as
--          repeated_wrong_password or repeated_wrong_code when the events of
--          its source in the ten minutes up to its own, counted with it,
--          reach five. A source is one address on one UTC day;
--        - the minute caps: in one minute, at most 200 ordinary rows with no
--          organization and at most 60 ordinary rows for each organization.
--          Past a cap, an event that would need a new row is counted on an
--          overflow row instead (reason over_minute_cap, no place and no
--          hash), one per category, outcome and source, which keeps its
--          organization: up to 75 more rows each. So a minute holds at most
--          275 rows with no organization and 135 for each organization, and
--          one organization's rows cannot be crowded out by events that are
--          not about it;
--        - one row per minute and kind: a repeat adds to event_count.
--      One call runs at a time (a transaction advisory lock), so two calls
--      never wait on each other's rows and the rules above are exact. A call
--      that waits two seconds for its turn gives up (55P03) and its caller
--      drops the batch.
--   3. public.purge_security_events(): deletes rows older than 90 days and
--      clears source_hash (and the row key derived from it) on rows older
--      than 24 hours, at most 5,000 of each a call; the scheduled job calls
--      it until both counts come back under 5,000. SECURITY DEFINER,
--      service_role only.
--   4. Two read functions for an organization's admins and owners:
--      public.security_events_for_organization(uuid, integer), the newest
--      rows, and public.security_event_totals_for_organization(uuid,
--      timestamptz, timestamptz), counts by category, outcome, reason, source
--      and country. Each calls public.security_events_reader_check(uuid)
--      before it reads anything. That check refuses with 42501 unless the
--      caller is an admin or owner of the organization (has_org_role), and
--      then applies the app's authenticator rule for a call made straight
--      to the API (0413's block): where the organization's policy asks
--      admins for an authenticator, or the caller has one, the session must
--      hold the second step. Neither function returns source_hash or the
--      row key. No API role may call the check itself.
--
-- WHO CAN READ AND WRITE
--   - RLS is on with NO policy, and anon and authenticated have no privilege
--     on the table: no API role reads it directly. An organization's admins
--     and owners read their own organization's rows through the two read
--     functions; a row with no organization is returned to no member.
--     (No policy is created, so this file takes none of the locks a CREATE
--     POLICY takes on this platform: 0418's note.)
--   - service_role may SELECT (the platform console reads every row through
--     it). INSERT, UPDATE and DELETE are revoked from it too: no API role
--     writes a row except through record_security_events, or removes one
--     except through purge_security_events. (The table's owner can, and a
--     deleted organization takes its rows with it.)
--   Explicit for all three API roles (apps/web/src/test/migration-grants.ts),
--   right with and without Supabase's default grants.
--
-- ROLLBACK
--   Nothing reads or writes the table until the app code that follows this
--   migration. Leave it in place. If it ever has to go:
--     drop function public.security_event_totals_for_organization(uuid, timestamptz, timestamptz);
--     drop function public.security_events_for_organization(uuid, integer);
--     drop function public.security_events_reader_check(uuid);
--     drop function public.purge_security_events();
--     drop function public.record_security_events(jsonb);
--     drop table public.security_events;
-- ─────────────────────────────────────────────────────────────────────────────

-- LOCKS: the foreign key takes SHARE ROW EXCLUSIVE on public.organizations,
-- held to commit; it waits behind any open write of an organization, an
-- ANALYZE or an autovacuum of that table. That is the only lock this file
-- takes on a table that exists: it creates no policy, so supautils takes
-- nothing on the auth, storage and realtime tables. lock_timeout 900ms ends
-- the wait with 55P03 and nothing applied; the push can be run again. It is
-- not reset at the end of the file, so the push's own last write, made in
-- the same transaction, has the same limit.
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
  -- A place name. The rule refuses the usual shapes of other things: control
  -- characters and the common invisible ones, the characters an address, an
  -- email, a path, a query or markup needs, four or more digits, and the
  -- start of an id. It is not a proof that the text is a place.
  -- record_security_events applies the same rule before it writes.
  constraint security_events_city
    check (city is null or (
      char_length(city) between 1 and 80
      and city !~ '[[:cntrl:]]'
      and city !~ '[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]'
      and city !~ '[@/\\:;<>(){}\[\]=?&%#"|$*+^~`]'
      and city !~ '[0-9].*[0-9].*[0-9].*[0-9]'
      and city !~ '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-'
    )),
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

-- The cap on rows with no organization counts them by minute.
create index security_events_no_organization_minute_idx
  on public.security_events (minute)
  where organization_id is null;

comment on table public.security_events is
  'Security events by minute: category, outcome, reason code, coarse source, organization when known, country and city, a count. No column for an address, an email or an account. No API role writes a row except through record_security_events(jsonb); rows older than 90 days are removed by purge_security_events(). Admins and owners read their organization''s rows through security_events_for_organization and security_event_totals_for_organization.';
comment on column public.security_events.source_hash is
  'A keyed hash of the caller''s address, made by the app with a key that changes every UTC day. Groups events from one source within a day. Cleared, with the row key derived from it, by the first purge after the row is 24 hours old. Returned by no read function.';

-- RLS on and no policy: no API role but service_role (which bypasses row
-- security) reads a row directly. Members read through the functions below.
alter table public.security_events enable row level security;

-- Supabase's default privileges give anon, authenticated and service_role
-- every privilege on a new public table; the change Supabase set for
-- 2026-10-30 (0402's note) takes SELECT, INSERT, UPDATE and DELETE out of
-- them. Everything is revoked from all of them here, then SELECT is granted
-- back to service_role by name, so the table ends the same under either set
-- of defaults.
revoke all on table public.security_events from public, anon, authenticated, service_role;
grant select on table public.security_events to service_role;

-- ── The writer ───────────────────────────────────────────────────────────────
create function public.record_security_events(p_events jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_now      timestamptz := pg_catalog.now();
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

  -- One call at a time (purge_security_events takes the same lock). Without
  -- it two calls that touch the same rows in opposite order wait on each
  -- other until one is ended as a deadlock, and the caps and the repeats rule
  -- below count only what has committed. A call that waits 2 s for its turn
  -- ends with 55P03 (the function's lock_timeout); its caller drops the batch.
  perform pg_catalog.pg_advisory_xact_lock(4720001);

  -- Every cast below is inside an IF on the text's pattern, so no element can
  -- make this raise.
  for v_el in
    select t.e from pg_catalog.jsonb_array_elements(p_events) as t(e) limit 200
  loop
    if pg_catalog.jsonb_typeof(v_el) <> 'object' then
      continue;
    end if;

    -- The four required fields: each a JSON string that meets the table's
    -- rule, or the element is skipped.
    if coalesce(pg_catalog.jsonb_typeof(v_el -> 'category'), '') <> 'string'
       or coalesce(pg_catalog.jsonb_typeof(v_el -> 'outcome'), '') <> 'string'
       or coalesce(pg_catalog.jsonb_typeof(v_el -> 'reason'), '') <> 'string'
       or coalesce(pg_catalog.jsonb_typeof(v_el -> 'source'), '') <> 'string' then
      continue;
    end if;
    v_category := v_el ->> 'category';
    v_outcome  := v_el ->> 'outcome';
    v_reason   := v_el ->> 'reason';
    v_source   := v_el ->> 'source';
    if v_category not in ('password_guessing', 'exploit', 'bots', 'phishing', 'malware') then
      continue;
    end if;
    if v_outcome not in ('blocked', 'allowed', 'flagged') then
      continue;
    end if;
    if v_reason !~ '^[a-z][a-z0-9_]{0,47}$' then
      continue;
    end if;
    if v_source not in ('web', 'phone', 'api', 'email', 'edge') then
      continue;
    end if;

    -- The organization, when it is the uuid of an organization that exists.
    -- FOR KEY SHARE is the lock the insert's own foreign key check takes a
    -- moment later: taken here, the organization cannot be deleted between
    -- this read and the insert. SKIP LOCKED: only a delete of the
    -- organization (or a change of its id) holds a lock that conflicts, so a
    -- skipped row is an organization being deleted. The event is then stored
    -- with no organization, and this call, which holds the one writer lock,
    -- never waits on that delete.
    v_org := null;
    if coalesce(pg_catalog.jsonb_typeof(v_el -> 'organization_id'), '') = 'string' then
      v_text := pg_catalog.lower(v_el ->> 'organization_id');
      if v_text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        select o.id into v_org from public.organizations o where o.id = v_text::uuid for key share skip locked;
      end if;
    end if;

    v_country := null;
    if coalesce(pg_catalog.jsonb_typeof(v_el -> 'country'), '') = 'string'
       and (v_el ->> 'country') ~ '^[A-Z]{2}$' then
      v_country := v_el ->> 'country';
    end if;

    -- The city: the table's own rule (security_events_city), word for word.
    v_city := null;
    if coalesce(pg_catalog.jsonb_typeof(v_el -> 'city'), '') = 'string' then
      v_city := pg_catalog.btrim(v_el ->> 'city');
      if pg_catalog.char_length(v_city) not between 1 and 80
         or v_city ~ '[[:cntrl:]]'
         or v_city ~ '[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]'
         or v_city ~ '[@/\\:;<>(){}\[\]=?&%#"|$*+^~`]'
         or v_city ~ '[0-9].*[0-9].*[0-9].*[0-9]'
         or v_city ~ '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-' then
        v_city := null;
      end if;
    end if;

    v_hash := null;
    if coalesce(pg_catalog.jsonb_typeof(v_el -> 'source_hash'), '') = 'string'
       and (v_el ->> 'source_hash') ~ '^[0-9a-f]{32}$' then
      v_hash := v_el ->> 'source_hash';
    end if;

    -- A count of 1 to 999999, as a number or as digits; anything else is 1.
    v_count := 1;
    v_text := v_el ->> 'count';
    if v_text ~ '^[0-9]{1,6}$' then
      v_count := greatest(v_text::integer, 1);
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

    -- Repeats from one source: counted with this element, five or more
    -- password events in the ten minutes up to its own.
    if v_category = 'password_guessing'
       and v_reason in ('wrong_password', 'wrong_code')
       and v_hash is not null then
      select coalesce(sum(s.event_count), 0) into v_recent
        from public.security_events s
       where s.source_hash = v_hash
         and s.category = 'password_guessing'
         and s.minute >= v_minute - interval '10 minutes'
         and s.minute <= v_minute;
      if v_recent + v_count >= 5 then
        v_reason := 'repeated_' || v_reason;
      end if;
    end if;

    v_key := pg_catalog.md5(pg_catalog.concat_ws(pg_catalog.chr(31),
      v_category, v_outcome, v_reason, v_source,
      coalesce(v_org::text, ''), coalesce(v_country, ''), coalesce(v_city, ''),
      coalesce(v_hash, '')));

    -- The minute caps: 200 ordinary rows with no organization, 60 for each
    -- organization. A new row past its cap is counted on the overflow row of
    -- its category, outcome and source instead, which keeps the organization
    -- (up to 75 overflow rows each; they are counted with the rest here,
    -- which changes nothing: they exist only once the cap is reached).
    if not exists (select 1 from public.security_events s
                    where s.minute = v_minute and s.dedupe_key = v_key) then
      if v_org is null then
        select count(*) into v_rows
          from public.security_events s
         where s.minute = v_minute and s.organization_id is null;
      else
        select count(*) into v_rows
          from public.security_events s
         where s.organization_id = v_org and s.minute = v_minute;
      end if;
      if (v_org is null and v_rows >= 200) or (v_org is not null and v_rows >= 60) then
        v_reason  := 'over_minute_cap';
        v_country := null;
        v_city    := null;
        v_hash    := null;
        v_key := pg_catalog.md5(pg_catalog.concat_ws(pg_catalog.chr(31),
          v_category, v_outcome, v_reason, v_source, coalesce(v_org::text, ''), '', '', ''));
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
  'Stores security events (an array of up to 200 objects: category, outcome, reason, source, and optionally organization_id, country, city, source_hash, count, at_ms). An element whose four required fields are not valid strings is skipped; an optional field that fails its rule is left empty or defaulted. Never raises for bad input. Applies the repeats rule and the minute caps (200 ordinary rows with no organization and 60 for each organization, then overflow rows). One call at a time; a call that waits 2 s ends with 55P03. Returns how many elements were stored. service_role only.';

-- ── Retention ────────────────────────────────────────────────────────────────
create function public.purge_security_events()
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_deleted integer;
  v_cleared integer;
begin
  -- The writer's lock: a purge and a write never hold each other's rows.
  perform pg_catalog.pg_advisory_xact_lock(4720001);

  with doomed as (
    select s.id
      from public.security_events s
     where s.minute < pg_catalog.now() - interval '90 days'
     order by s.minute
     limit 5000
  )
  delete from public.security_events s using doomed d where s.id = d.id;
  get diagnostics v_deleted = row_count;

  -- The hash goes, and with it the row key that was made from it: the key
  -- becomes one that says nothing about the source. (An event of the same
  -- kind reported late for such a minute then gets a row of its own.)
  with stale as (
    select s.id
      from public.security_events s
     where s.source_hash is not null
       and s.minute < pg_catalog.now() - interval '24 hours'
     limit 5000
  )
  update public.security_events s
     set source_hash = null,
         dedupe_key  = pg_catalog.md5(s.id::text)
    from stale t
   where s.id = t.id;
  get diagnostics v_cleared = row_count;

  return pg_catalog.jsonb_build_object('deleted', v_deleted, 'hashes_cleared', v_cleared);
end;
$$;

revoke all on function public.purge_security_events() from public, anon, authenticated, service_role;
grant execute on function public.purge_security_events() to service_role;

comment on function public.purge_security_events() is
  'Deletes security_events rows older than 90 days and clears source_hash (and the row key made from it) on rows older than 24 hours, at most 5,000 of each a call. Returns {deleted, hashes_cleared}; the scheduled job calls it until both are under 5,000. service_role only.';

-- ── Reading, for an organization's admins and owners ─────────────────────────
-- Each read function calls this check before it reads. has_org_role answers
-- for the signed-in account (auth.uid()): false for nobody signed in, for a
-- disabled account, for an invitation not accepted, for an act-as seat that
-- has expired and for a null organization. (A live act-as seat is an owner
-- seat and reads, as it does everywhere else.) Then the app's authenticator
-- rule, for a call made straight to the API with a password-only session
-- (0413's block; the caller is an admin or owner here, so both
-- 'admins_required' and 'all_required' ask them for one, and a policy value
-- this function does not know is read as the strictest).
create function public.security_events_reader_check(p_organization_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_policy   text;
  v_enrolled boolean;
begin
  if p_organization_id is null or v_uid is null
     or not coalesce(public.has_org_role(p_organization_id, 'admin'), false) then
    raise exception 'security_events_not_allowed' using errcode = '42501';
  end if;

  select o.mfa_policy::text into v_policy
    from public.organizations o where o.id = p_organization_id;
  v_enrolled := exists (select 1 from auth.mfa_factors f
                         where f.user_id = v_uid and f.status = 'verified');
  if coalesce(v_policy, '') <> 'optional' or v_enrolled then
    if not v_enrolled then
      raise exception 'mfa_required' using errcode = '42501', hint = 'mfa_required';
    end if;
    if coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then
      raise exception 'aal2_required' using errcode = '42501', hint = 'aal2_required';
    end if;
  end if;
end;
$$;

-- Called only from the two read functions below, which run as their owner.
revoke all on function public.security_events_reader_check(uuid) from public, anon, authenticated, service_role;

comment on function public.security_events_reader_check(uuid) is
  'The check both security-events read functions make first: 42501 unless the caller is an admin or owner of the organization, and, where the organization''s policy asks them for an authenticator or they have one, unless the session holds the second step (hint mfa_required or aal2_required). No API role may call it.';

-- The answer of a read function never includes source_hash or the row key.
create function public.security_events_for_organization(
  p_organization_id uuid,
  p_limit integer default 100
)
returns table (
  id            uuid,
  minute        timestamptz,
  category      text,
  outcome       text,
  reason        text,
  source        text,
  country       text,
  city          text,
  event_count   integer,
  last_seen_at  timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.security_events_reader_check(p_organization_id);

  return query
    select s.id, s.minute, s.category, s.outcome, s.reason, s.source,
           s.country, s.city, s.event_count, s.last_seen_at
      from public.security_events s
     where s.organization_id = p_organization_id
     order by s.minute desc, s.last_seen_at desc, s.id
     limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;

revoke all on function public.security_events_for_organization(uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.security_events_for_organization(uuid, integer) to authenticated;

comment on function public.security_events_for_organization(uuid, integer) is
  'The newest security_events rows of one organization (1 to 500, default 100), for its admins and owners only, with the second step held where it is owed: 42501 for anyone else. Never returns source_hash or the row key.';

create function public.security_event_totals_for_organization(
  p_organization_id uuid,
  p_from timestamptz default null,
  p_to   timestamptz default null
)
returns table (
  category  text,
  outcome   text,
  reason    text,
  source    text,
  country   text,
  events    bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_to   timestamptz;
  v_from timestamptz;
begin
  perform public.security_events_reader_check(p_organization_id);

  -- From p_from (default: 7 days before the end) up to, not including, p_to
  -- (default: now); never more than the 90 days rows are kept.
  v_to   := least(coalesce(p_to, pg_catalog.now()), pg_catalog.now() + interval '1 minute');
  v_from := greatest(coalesce(p_from, v_to - interval '7 days'), v_to - interval '90 days');

  return query
    select s.category, s.outcome, s.reason, s.source, s.country,
           sum(s.event_count)::bigint as events
      from public.security_events s
     where s.organization_id = p_organization_id
       and s.minute >= v_from
       and s.minute < v_to
     group by s.category, s.outcome, s.reason, s.source, s.country
     order by 6 desc, 1, 2, 3, 4, 5
     limit 5000;
end;
$$;

revoke all on function public.security_event_totals_for_organization(uuid, timestamptz, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.security_event_totals_for_organization(uuid, timestamptz, timestamptz) to authenticated;

comment on function public.security_event_totals_for_organization(uuid, timestamptz, timestamptz) is
  'Event counts of one organization by category, outcome, reason, source and country, from p_from (default 7 days before the end) up to p_to (default now), at most 90 days, for its admins and owners only, with the second step held where it is owed: 42501 for anyone else.';

