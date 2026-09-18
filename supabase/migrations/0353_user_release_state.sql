-- 0353_user_release_state.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Per-person state for product releases ("What's New"): notification DISMISSED,
-- release OPENED, release READ. Three different facts. A single "has seen" flag
-- cannot tell "closed the popup" from "read the notes", and treating a closed
-- popup as read is how release notes go unread forever.
--
-- WHY A TABLE AND NOT user_onboarding.viewed_announcements
--   That jsonb map is load-bearing for the mobile app and has the wrong
--   semantics for this:
--     - it is first-write-wins (computeSeenViewedMap never overwrites a key, and
--       a test pins that), so dismissed -> opened -> read could never progress;
--     - every close on a phone posts all:true, which stamps the ENTIRE registry
--       as seen. If the web's unread state were derived from it, one tap on an
--       old phone build would mark every release read on the web;
--     - it is written by read-modify-write of the whole map from JS, so two tabs,
--       or the web and a phone, drop each other's keys.
--   Here each transition is ONE row and ONE statement.
--
-- WHAT IS NOT STORED, ON PURPOSE
--   "Notification shown", "refresh required" and "current version loaded" are
--   facts about one browser tab and the bundle it happens to be running. They
--   are wrong the instant they are shared, so they live in that tab's memory.
--
-- REVISION
--   A release carries a revision: its announcement identity. Fixing a typo does
--   not bump it, so nobody is told twice. A deliberate re-announcement does, and
--   record_release_state() then CLEARS the stamps taken against the older
--   revision in the same statement. A stale tab still reporting against the old
--   revision is ignored.
--
-- SECURITY MODEL
--   Own-row RLS, the 0259 shape: select / insert / update where
--   user_id = auth.uid(); no delete policy; delete and truncate revoked. Like
--   user_onboarding (see 0310's note) it carries no disabled-account guard:
--   nothing here is visible to anyone else, and a disabled account cannot reach
--   the API that calls it. record_release_state() is SECURITY INVOKER: it has no
--   privilege of its own, so those policies are what authorize every write it
--   makes, and a caller can only ever stamp themselves.
--
-- BACKFILL
--   The six announcements that shipped before this table keep their ids as
--   releases. Anyone who already saw one in the old modal has it marked read
--   here, at the time they saw it, so launch day re-announces nothing. Insert
--   only, on conflict do nothing.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. The table ─────────────────────────────────────────────────────────────

create table public.user_release_state (
  user_id      uuid        not null references auth.users(id) on delete cascade,
  release_id   text        not null,
  revision     int         not null default 1,
  dismissed_at timestamptz,
  opened_at    timestamptz,
  read_at      timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (user_id, release_id),
  constraint user_release_state_release_id_shape
    check (release_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(release_id) between 3 and 80),
  constraint user_release_state_revision_positive check (revision >= 1),
  -- Reading implies having opened it. Keeps "opened" honest if a future writer
  -- sets read_at alone.
  constraint user_release_state_read_implies_opened check (read_at is null or opened_at is not null)
);

comment on table public.user_release_state is
  'Per-person state for product releases: notification dismissed, release opened, release read, each against a release revision. Own-row RLS. Written through record_release_state().';

alter table public.user_release_state enable row level security;

create policy user_release_state_select on public.user_release_state
  for select to authenticated using (user_id = (select auth.uid()));
create policy user_release_state_insert on public.user_release_state
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy user_release_state_update on public.user_release_state
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on table public.user_release_state from anon;
revoke delete, truncate, references, trigger on table public.user_release_state from authenticated;

create trigger user_release_state_touch_updated_at
  before update on public.user_release_state
  for each row execute function public.tg_set_updated_at();

-- ── 2. The one writer ────────────────────────────────────────────────────────

create or replace function public.record_release_state(
  p_release_id text,
  p_revision   int,
  p_action     text
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_action not in ('dismiss', 'open', 'read') then
    raise exception 'unknown action' using errcode = '22023';
  end if;

  insert into public.user_release_state as s
    (user_id, release_id, revision, dismissed_at, opened_at, read_at)
  values (
    auth.uid(),
    p_release_id,
    p_revision,
    case when p_action = 'dismiss' then v_now end,
    case when p_action in ('open', 'read') then v_now end,
    case when p_action = 'read' then v_now end
  )
  on conflict (user_id, release_id) do update set
    revision     = excluded.revision,
    dismissed_at = case when excluded.revision > s.revision then excluded.dismissed_at
                        else coalesce(s.dismissed_at, excluded.dismissed_at) end,
    opened_at    = case when excluded.revision > s.revision then excluded.opened_at
                        else coalesce(s.opened_at, excluded.opened_at) end,
    read_at      = case when excluded.revision > s.revision then excluded.read_at
                        else coalesce(s.read_at, excluded.read_at) end
  where excluded.revision >= s.revision;

  -- Mobile builds already in the field decide what to show from the legacy
  -- viewed_announcements map. Reading a release on the web stamps it there too,
  -- so the phone does not announce what was just read. SQL-side merge of ONE
  -- key, and only when absent: the map's first-write-wins rule is kept.
  if p_action = 'read' then
    insert into public.user_onboarding as o (user_id, viewed_announcements)
    values (auth.uid(), jsonb_build_object(p_release_id, jsonb_build_object('at', v_now, 'outcome', 'seen')))
    on conflict (user_id) do update
       set viewed_announcements = o.viewed_announcements || excluded.viewed_announcements
     where not (o.viewed_announcements ? p_release_id);
  end if;
end;
$$;

revoke execute on function public.record_release_state(text, int, text) from public, anon;
grant execute on function public.record_release_state(text, int, text) to authenticated;

comment on function public.record_release_state(text, int, text) is
  'Records dismiss / open / read for the caller against one release revision. SECURITY INVOKER: own-row RLS authorizes every write. First write wins within a revision; a newer revision clears older stamps; an older one is ignored. Reading also stamps the legacy viewed_announcements key for mobile.';

-- ── 3. Backfill: nobody is re-told what they already saw ─────────────────────
--
-- viewed_announcements is a jsonb map each person can write for their own row
-- (own-row RLS, no column guard), and it has held several shapes over time. So
-- the "at" inside it is UNTRUSTED TEXT. A pattern check is not enough: a value
-- like '2026-13-45T25:61' looks like a timestamp and still fails the cast, and
-- one failed cast aborts the whole migration. The cast therefore runs inside a
-- handler that turns any failure into NULL, and the caller falls back to the
-- row's own updated_at. The helper is session-local and dropped below.

create function pg_temp.release_backfill_ts(p_text text)
returns timestamptz
language plpgsql
immutable
as $$
begin
  return p_text::timestamptz;
exception when others then
  return null;
end;
$$;

insert into public.user_release_state (user_id, release_id, revision, opened_at, read_at)
select o.user_id,
       legacy.id,
       1,
       seen.at,
       seen.at
  from public.user_onboarding o
 cross join (values
   ('maintenance-requests-2026-08'),
   ('support-feedback-2026-07'),
   ('onboarding-tours-2026-07'),
   ('schedule-reminders-2026-07'),
   ('order-numbers-2026-07'),
   ('backorders-2026-07')
 ) as legacy(id)
 cross join lateral (
   select coalesce(
            case when jsonb_typeof(o.viewed_announcements -> legacy.id) = 'object'
                 then pg_temp.release_backfill_ts(o.viewed_announcements -> legacy.id ->> 'at')
            end,
            o.updated_at,
            now()
          ) as at
 ) seen
 where jsonb_typeof(o.viewed_announcements) = 'object'
   and o.viewed_announcements ? legacy.id
on conflict (user_id, release_id) do nothing;

drop function pg_temp.release_backfill_ts(text);
