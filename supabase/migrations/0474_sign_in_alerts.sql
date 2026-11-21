-- 0474_sign_in_alerts.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- A record of each sign-in alert (a sign-in from a new device, a new country
-- or both), so the member can answer it ("this was me", "this was not me")
-- and an organization's owners and admins can see the alerts of their
-- members; and the countries each account has signed in from, so a new one
-- can be told apart. The app writes both tables with the service-role
-- client, as it writes user_login_devices (0168). This file's number is in
-- its name, its test's name and labels, and the manifest entry in
-- scripts/security-test.sh.
--
-- WHAT IT ADDS (tier A: two new tables, three indexes, three functions and
-- grants. No stored row and no existing function, policy, trigger or grant
-- changes. The one existing object touched is public.user_profiles, which
-- gains the internal triggers of the two foreign keys: deleting a profile,
-- which deleting an account does, also deletes that account's rows here.)
--   1. public.sign_in_alerts. One row per alert: the account, the Auth session
--      the sign-in made when it is known (a plain uuid, no foreign key), which
--      of new device and new country it was (at least one; a new country
--      always names the country), web or phone, the device twice in fixed
--      words, the device row it was about, the country and city when known,
--      the member's answer (open, was_me, not_me) and when it was given (the
--      table holds the two in step: an open alert has no time, an answered
--      one has one), and when the alert was made.
--      The device, twice: device_label is what the member sees, with a
--      phone's model and system version ("StockPilot app on iPhone 15 Pro
--      (iOS 18.1)"); device_family is what the organization sees, the short
--      words ("Chrome on macOS", "StockPilot app on iPhone"), as the
--      organization's activity names a device since 2026-11-02. Both take
--      letters, digits, spaces and ( ) + . - only, 1 to 120 characters, so a
--      user agent (it always has a slash), a link with its scheme (a colon
--      and slashes) or markup cannot be stored. A bare host name still fits:
--      the rule is not a proof that the words are the app's.
--      device_hash is the device_hash of the user_login_devices row the alert
--      was about, so a report that the sign-in was not the member's can
--      forget that device and make it new again. No read function returns
--      it.
--      It has no column for a network address, an email or a user agent. The
--      city follows the same rule, in the same text, as
--      security_events.city (0472), which refuses the usual shapes of an
--      address, an email, a path, a query, markup and an id. It is not a
--      proof that the text is a place.
--   2. public.user_sign_in_countries. One row per account and country: when
--      the account first and last signed in from it. Kept until the account
--      is deleted, as user_login_devices is.
--   3. public.my_sign_in_alerts(): the caller's own alerts of the last 30
--      days, newest first, at most 50.
--   4. public.sign_in_alerts_for_organization(uuid, integer): for an
--      organization's owners and admins, the alerts of the last 90 days of
--      the accounts that are its accepted members (an act-as seat is not a
--      member here), newest first, 1 to 500 (default 100), with each
--      member's name and email.
--      So a member sees 30 days of their own alerts, and the admins of their
--      organization see 90 days of the same member's.
--      An alert is about the account, not about one organization: a member
--      of organizations A and B shows in both lists, and B's admins see
--      the alerts that member had before joining B too, because a session
--      made then can reach B now. A member who leaves takes their alerts out
--      of the list; an account deleted takes them out of the table.
--   5. public.purge_sign_in_alerts(): deletes alerts older than 90 days, at
--      most 5,000 a call, and returns how many; a scheduled job will call it
--      until the count comes back under 5,000.
--   Active sessions reads through my_sign_in_alerts(), which goes by account
--   and returns each alert's session_id to match it with its session. The
--   index on session_id is there for a lookup of a session's alert by its
--   id, if the web code makes one.
--
-- WHO CAN READ AND WRITE
--   - RLS is on with NO policy on both tables, and anon and authenticated
--     have no privilege on either: no signed-in member reads or writes a row
--     directly. (No policy is created, so this file takes none of the locks
--     a CREATE POLICY takes on this platform: 0418's note.)
--   - A member reads their own alerts through my_sign_in_alerts(). It refuses
--     with 42501 (sign_in_alerts_not_allowed) when nobody is signed in and
--     when the account is disabled (user_profiles.disabled_at set, the mark
--     has_org_role reads since 0310). Then it applies the part of the app's
--     authenticator rule that needs no organization: an account that has a
--     verified authenticator owes the second step, so it refuses with 42501
--     (message and hint aal2_required) unless the session holds it. The
--     organization's policy is not consulted, because this read is about no
--     organization.
--   - An organization's owners and admins read its members' alerts through
--     sign_in_alerts_for_organization. It refuses with 42501 unless the
--     caller is an admin or owner of the organization (has_org_role, in its
--     own body) and then calls public.security_events_reader_check (0472),
--     which makes the same role check and applies the app's authenticator
--     rule for a call made straight to the API: where the organization's
--     policy asks admins for an authenticator, or the caller has one, the
--     session must hold the second step (hint mfa_required or
--     aal2_required). A live act-as seat is an owner seat and reads, as it
--     does everywhere else; its own account's alerts are not listed. Neither
--     read returns another account's session id, the device row or the
--     member's full device label.
--   - The organization read trusts organization_members: who may insert an
--     accepted membership row is decided by that table's own rules.
--   - service_role may SELECT, INSERT, UPDATE and DELETE both tables (the
--     app writes them with the admin client) and may call the purge. It may
--     not call the two read functions, which answer for a signed-in caller.
--   Explicit for all three API roles (apps/web/src/test/migration-grants.ts),
--   right with and without Supabase's default grants.
--
-- ROLLBACK
--   Nothing reads or writes either table until the app code that follows
--   this migration. Leave them in place. If they ever have to go, know that
--   each drop table also removes its foreign key's triggers from
--   public.user_profiles, which takes ACCESS EXCLUSIVE on that table until
--   commit: every read of a profile, so every signed-in request, waits
--   behind it. Run it in a quiet minute, as one transaction with a short
--   lock_timeout; if it gives up (55P03) nothing is dropped, and it can be
--   run again as it is:
--     begin;
--     set local lock_timeout = '900ms';
--     drop function if exists public.purge_sign_in_alerts();
--     drop function if exists public.sign_in_alerts_for_organization(uuid, integer);
--     drop function if exists public.my_sign_in_alerts();
--     drop table if exists public.user_sign_in_countries;
--     drop table if exists public.sign_in_alerts;
--     commit;
-- ─────────────────────────────────────────────────────────────────────────────

-- LOCKS: the two foreign keys take SHARE ROW EXCLUSIVE on public.user_profiles
-- (and ACCESS SHARE, which only an ACCESS EXCLUSIVE waits for), held to
-- commit. That is the only existing table this file locks: it creates no
-- policy and drops no trigger, so supautils takes nothing on the auth,
-- storage and realtime tables, and the functions take no table lock when
-- they are created (measured on a local stack: the whole file run inside
-- BEGIN ... ROLLBACK, then the session's relation locks listed).
-- Every write of a profile row waits on it: sign-up (the profile the trigger
-- on auth.users makes, in the sign-up's own transaction), profile and avatar
-- edits, notification preferences, onboarding, invitations, workspace
-- creation and switching, act-as, an email change, an account disabled,
-- enabled or deleted. They wait while the file holds the lock, until the
-- commit, and also while the file is still waiting for it, since they queue
-- behind its request: that wait is at most 900 ms. Reads of profiles and
-- inserts into tables that point at them (a sign-in's device row) do not
-- wait. The file itself waits behind any open write of a profile, an ANALYZE
-- or an autovacuum of that table; lock_timeout 900ms ends that wait with
-- 55P03 and nothing applied, and the push can be run again. It is not reset
-- at the end of the file, so the push's own last write, made in the same
-- transaction, has the same limit.
set lock_timeout = '900ms';

create table public.sign_in_alerts (
  id             uuid        primary key default gen_random_uuid(),
  user_id        uuid        not null references public.user_profiles(id) on delete cascade,
  -- The Auth session the sign-in made, when known. No foreign key: a key to
  -- an auth table would lock a sign-in table when this file is applied, and
  -- a session row goes when the session ends while the alert stays.
  session_id     uuid,
  new_device     boolean     not null,
  new_country    boolean     not null,
  client         text        not null,
  device_label   text        not null,
  device_family  text        not null,
  device_hash    text,
  country        text,
  city           text,
  status         text        not null default 'open',
  resolved_at    timestamptz,
  created_at     timestamptz not null default now(),
  constraint sign_in_alerts_new_device_or_country
    check (new_device or new_country),
  -- A new country is always a known one.
  constraint sign_in_alerts_new_country_named
    check (not new_country or country is not null),
  constraint sign_in_alerts_client
    check (client in ('web', 'phone')),
  -- Fixed words from the app's helpers: letters, digits, spaces and
  -- ( ) + . - only. Every label and family the app makes fits ("Unknown
  -- browser on Unknown OS", "StockPilot app on iPad Air (5th generation)
  -- (iPadOS 17.4.1)"); a user agent, a link with its scheme, markup and
  -- every control or invisible character do not.
  constraint sign_in_alerts_device_label
    check (device_label ~ '^[A-Za-z0-9 ()+.-]{1,120}$'),
  constraint sign_in_alerts_device_family
    check (device_family ~ '^[A-Za-z0-9 ()+.-]{1,120}$'),
  -- The shape of user_login_devices.device_hash: the first 40 hex digits of
  -- a SHA-256, in lower case (lib/auth/login-device.ts).
  constraint sign_in_alerts_device_hash
    check (device_hash is null or device_hash ~ '^[0-9a-f]{40}$'),
  constraint sign_in_alerts_country
    check (country is null or country ~ '^[A-Z]{2}$'),
  -- A place name: the rule of security_events_city (0472), the same text.
  -- It refuses the usual shapes of other things: control characters and the
  -- common invisible ones, the characters an address, an email, a path, a
  -- query or markup needs, four or more digits, and the start of an id. It
  -- is not a proof that the text is a place.
  constraint sign_in_alerts_city
    check (city is null or (
      char_length(city) between 1 and 80
      and city !~ '[[:cntrl:]]'
      and city !~ '[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]'
      and city !~ '[@/\\:;<>(){}\[\]=?&%#"|$*+^~`]'
      and city !~ '[0-9].*[0-9].*[0-9].*[0-9]'
      and city !~ '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-'
    )),
  constraint sign_in_alerts_status
    check (status in ('open', 'was_me', 'not_me')),
  -- An open alert has no answer time; an answered one has one.
  constraint sign_in_alerts_resolved_with_answer
    check ((status = 'open') = (resolved_at is null))
);

-- An account's newest alerts (both read functions); also serves the cascade
-- from user_profiles.
create index sign_in_alerts_user_created_idx
  on public.sign_in_alerts (user_id, created_at desc);

-- A session's alert by its id, for a lookup by session if the web code makes
-- one (Active sessions itself reads through my_sign_in_alerts()).
create index sign_in_alerts_session_idx
  on public.sign_in_alerts (session_id)
  where session_id is not null;

-- The purge reads the oldest rows first.
create index sign_in_alerts_created_idx
  on public.sign_in_alerts (created_at);

comment on table public.sign_in_alerts is
  'One row per sign-in alert (new device, new country or both): the account, the Auth session when known, web or phone, the device as the member sees it and as the organization sees it, the device row it was about, country and city when known, the member''s answer (open, was_me, not_me). No column for an address, an email or a user agent. Written by the app with the service-role client; read by the member through my_sign_in_alerts() and by an organization''s owners and admins through sign_in_alerts_for_organization; rows older than 90 days are removed by purge_sign_in_alerts().';
comment on column public.sign_in_alerts.session_id is
  'The Auth session the sign-in made, when known. A plain uuid with no foreign key: a key to an auth table would lock a sign-in table when applied, and the alert outlives the session. Returned to the member only, never to an organization''s admins.';
comment on column public.sign_in_alerts.device_label is
  'The device as the member sees it, in fixed words: "Chrome on macOS", or a phone with its model and system version, "StockPilot app on iPhone 15 Pro (iOS 18.1)". Letters, digits, spaces and ( ) + . - only, 1 to 120 characters; never the user agent. Returned by my_sign_in_alerts() only.';
comment on column public.sign_in_alerts.device_family is
  'The device as the organization sees it, the short fixed words: "Chrome on macOS", "StockPilot app on iPhone" (decision of 2026-11-02: the organization sees the family, the member the full label). Same character rule as device_label. Returned by sign_in_alerts_for_organization.';
comment on column public.sign_in_alerts.device_hash is
  'The device_hash of the user_login_devices row the alert was about (40 lower-case hex digits), so a report that the sign-in was not the member''s can forget that device. Returned by no read function.';
comment on column public.sign_in_alerts.resolved_at is
  'When the member answered the alert (was_me or not_me). The table holds it in step with status: empty while the alert is open, set once it is answered.';

create table public.user_sign_in_countries (
  user_id        uuid        not null references public.user_profiles(id) on delete cascade,
  country        text        not null,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  constraint user_sign_in_countries_pkey primary key (user_id, country),
  constraint user_sign_in_countries_country
    check (country ~ '^[A-Z]{2}$')
);

comment on table public.user_sign_in_countries is
  'The countries an account has signed in from (two capital letters), with when each was first and last seen, so a sign-in from a new country can be told apart. Written by the app with the service-role client; no API role reads it otherwise. Goes with the account.';

-- RLS on and no policy: no API role but service_role (which bypasses row
-- security) reads a row directly. Members read alerts through the functions
-- below; nobody reads the countries but the app.
alter table public.sign_in_alerts enable row level security;
alter table public.user_sign_in_countries enable row level security;

-- Supabase's default privileges give anon, authenticated and service_role
-- every privilege on a new public table; the change Supabase set for
-- 2026-10-30 (0402's note) takes SELECT, INSERT, UPDATE and DELETE out of
-- them. Everything is revoked from all of them here, then service_role gets
-- the four back by name, so both tables end the same under either set of
-- defaults.
revoke all on table public.sign_in_alerts from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.sign_in_alerts to service_role;
revoke all on table public.user_sign_in_countries from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.user_sign_in_countries to service_role;

-- ── The member's own alerts ──────────────────────────────────────────────────
create function public.my_sign_in_alerts()
returns table (
  id            uuid,
  session_id    uuid,
  new_device    boolean,
  new_country   boolean,
  client        text,
  device_label  text,
  country       text,
  city          text,
  status        text,
  created_at    timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
begin
  -- The gate, in this body (security_invariants INV-25 reads it here): the
  -- signed-in account, and only its own rows.
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'sign_in_alerts_not_allowed' using errcode = '42501';
  end if;
  -- A disabled account is closed (0310): the same mark has_org_role reads.
  -- Before the authenticator gate, so a disabled caller learns nothing from
  -- its hint.
  if exists (select 1 from public.user_profiles up
              where up.id = v_uid and up.disabled_at is not null) then
    raise exception 'sign_in_alerts_not_allowed' using errcode = '42501';
  end if;
  -- The part of the app's authenticator rule that needs no organization, for
  -- a call made straight to the API: an account with a verified
  -- authenticator reads only from a session that holds the second step. No
  -- organization's policy is read: this read is about no organization.
  if exists (select 1 from auth.mfa_factors f
              where f.user_id = v_uid and f.status = 'verified')
     and coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then
    raise exception 'aal2_required' using errcode = '42501', hint = 'aal2_required';
  end if;

  return query
    select a.id, a.session_id, a.new_device, a.new_country, a.client,
           a.device_label, a.country, a.city, a.status, a.created_at
      from public.sign_in_alerts a
     where a.user_id = v_uid
       and a.created_at >= pg_catalog.now() - interval '30 days'
     order by a.created_at desc, a.id
     limit 50;
end;
$$;

-- Supabase's default privileges grant EXECUTE on a new public function to
-- anon, authenticated and service_role, and Postgres grants it to PUBLIC.
revoke all on function public.my_sign_in_alerts() from public, anon, authenticated, service_role;
grant execute on function public.my_sign_in_alerts() to authenticated;

comment on function public.my_sign_in_alerts() is
  'The signed-in member''s own sign-in alerts of the last 30 days, newest first, at most 50, with the device as the member sees it: 42501 when nobody is signed in or the account is disabled, and 42501 aal2_required when the account has a verified authenticator and the session does not hold the second step (no organization''s policy is read).';

-- ── An organization's members' alerts, for its owners and admins ─────────────
-- Members are the accounts with an accepted membership of the organization
-- that is not an act-as seat (impersonation_expires_at set, live or
-- expired), as 0413 and the console's Users tab count them. A disabled
-- account is still a member and its alerts are listed.
create function public.sign_in_alerts_for_organization(
  p_organization_id uuid,
  p_limit integer default 100
)
returns table (
  id             uuid,
  user_id        uuid,
  full_name      text,
  email          text,
  new_device     boolean,
  new_country    boolean,
  client         text,
  device_family  text,
  country        text,
  city           text,
  status         text,
  resolved_at    timestamptz,
  created_at     timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- The role gate, in this body (security_invariants INV-25 reads it here);
  -- the check below repeats it and adds the authenticator rule.
  if p_organization_id is null
     or not coalesce(public.has_org_role(p_organization_id, 'admin'), false) then
    raise exception 'sign_in_alerts_not_allowed' using errcode = '42501';
  end if;
  perform public.security_events_reader_check(p_organization_id);

  return query
    select a.id, a.user_id, p.full_name, p.email::text, a.new_device, a.new_country,
           a.client, a.device_family, a.country, a.city, a.status, a.resolved_at,
           a.created_at
      from public.organization_members m
      join public.sign_in_alerts a on a.user_id = m.user_id
      join public.user_profiles p on p.id = a.user_id
     where m.organization_id = p_organization_id
       and m.accepted_at is not null
       and m.impersonation_expires_at is null
       and a.created_at >= pg_catalog.now() - interval '90 days'
     order by a.created_at desc, a.id
     limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;

revoke all on function public.sign_in_alerts_for_organization(uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.sign_in_alerts_for_organization(uuid, integer) to authenticated;

comment on function public.sign_in_alerts_for_organization(uuid, integer) is
  'The sign-in alerts of the last 90 days of an organization''s accepted members (not act-as seats), newest first, 1 to 500 (default 100), with each member''s name and email and the device as the organization sees it (device_family); for its admins and owners only, with the second step held where it is owed: 42501 for anyone else. A member of several organizations is listed in each. Never returns a session id, the device row or the full device label. Its work grows with the members times their alerts of 90 days, not with the limit: every such row is read and the newest are kept.';

-- ── Retention ────────────────────────────────────────────────────────────────
create function public.purge_sign_in_alerts()
returns integer
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_deleted integer;
begin
  -- The oldest first, through sign_in_alerts_created_idx. A row exactly 90
  -- days old stays: it is the last one the organization read still shows.
  with doomed as (
    select a.id
      from public.sign_in_alerts a
     where a.created_at < pg_catalog.now() - interval '90 days'
     order by a.created_at
     limit 5000
  )
  delete from public.sign_in_alerts a using doomed d where a.id = d.id;
  get diagnostics v_deleted = row_count;

  return v_deleted;
end;
$$;

revoke all on function public.purge_sign_in_alerts() from public, anon, authenticated, service_role;
grant execute on function public.purge_sign_in_alerts() to service_role;

comment on function public.purge_sign_in_alerts() is
  'Deletes sign_in_alerts rows older than 90 days, oldest first, at most 5,000 a call, and returns how many; a scheduled job will call it until the count is under 5,000. A lock wait ends after 2 s (55P03). service_role only.';
