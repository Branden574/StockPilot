-- 0352_member_last_seen.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Closes the blind spot 0351 documented: someone who only READS and then signs
-- out leaves nothing behind. Their session rows are deleted with the sign-out,
-- reading writes no audit row, and what remains is when their login STARTED,
-- which the console has to hedge as "Signed in ...".
--
-- The fix is a fourth signal that the app reports about itself: a per-person,
-- per-organization "last seen" stamp, written when a person opens the app,
-- comes back to it, or moves around in it.
--
-- WHY ITS OWN TABLE AND NOT A COLUMN ON organization_members
--   organization_members is the authorization table. It carries role-change
--   and impersonation semantics, policies, and readers all over the product.
--   A write every few minutes per active person does not belong on it: every
--   existing trigger, policy and realtime consumer would have to be re-proven
--   against a new UPDATE pattern. A two-column side table touches none of
--   that. It hangs off the membership pair, so removing a member removes
--   their activity with no code.
--
-- WHY A CLIENT BEACON AND NOT A STAMP IN THE REQUEST PATH
--   Stamping inside withContext / withApiContext would put a write behind
--   every authenticated request. The beacon fires from the browser and the
--   mobile app on PERSON-driven moments only (open, return to the tab or the
--   app, navigate), throttled on the client and again here. That has a useful
--   side effect: a tab left open on an unattended screen stops stamping,
--   which the hourly session renewal cannot tell apart from a person.
--
-- WHAT IT MEASURES
--   "This person had StockPilot open, in this organization, at about this
--   time." Accurate to the throttle below. It starts collecting the day this
--   ships; it knows nothing about the past, so 0351's three signals stay.
--
-- SECURITY MODEL
--   member_activity: RLS enabled, NO policies, table privileges revoked from
--   anon and authenticated. Nothing reads or writes it except the two
--   functions below.
--
--   touch_member_last_seen(uuid): SECURITY DEFINER, EXECUTE for authenticated
--   only. It carries its own gate: the row it writes is selected FROM
--   organization_members for auth.uid(), so a caller can only ever stamp
--   themselves, only in an organization they are a real, accepted member of
--   (an impersonation grant does not count: a platform admin acting as a
--   tenant must not appear in that tenant's activity), and only while their
--   account is not disabled. Any other input is a silent no-op, never an
--   error: a beacon must not be able to tell a caller which organizations
--   exist.
--
--   platform_member_activity(uuid, uuid[]) is dropped and recreated because
--   its result gains a column, which CREATE OR REPLACE cannot do. Its posture
--   is restated in full: service_role ONLY, revoke from public, anon AND
--   authenticated. A function recreated without its revoke is open to every
--   signed-in user through the public default ACL; INV-25 is the tripwire.
--   The old result shape is a strict subset of the new one, so the web code
--   deployed before this migration keeps working across the gap.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. The table ─────────────────────────────────────────────────────────────

create table public.member_activity (
  organization_id uuid        not null,
  user_id         uuid        not null,
  last_seen_at    timestamptz not null default now(),
  primary key (organization_id, user_id),
  foreign key (organization_id, user_id)
    references public.organization_members (organization_id, user_id)
    on delete cascade
);

comment on table public.member_activity is
  'When each member last had StockPilot open in each organization. Written only by touch_member_last_seen(); read only by platform_member_activity(). No policies on purpose.';

alter table public.member_activity enable row level security;

revoke all on table public.member_activity from public, anon, authenticated;

-- ── 2. The beacon ────────────────────────────────────────────────────────────
--
-- The five-minute floor lives HERE as well as in the clients, because the
-- clients are many (tabs, devices, old bundles) and this is one place.

create or replace function public.touch_member_last_seen(p_org_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.member_activity (organization_id, user_id, last_seen_at)
  select om.organization_id, om.user_id, now()
    from public.organization_members om
    join public.user_profiles up on up.id = om.user_id
   where om.organization_id = p_org_id
     and om.user_id = auth.uid()
     and om.accepted_at is not null
     and om.impersonation_expires_at is null
     and up.disabled_at is null
  on conflict (organization_id, user_id) do update
     set last_seen_at = excluded.last_seen_at
   where public.member_activity.last_seen_at < excluded.last_seen_at - interval '5 minutes';
$$;

revoke execute on function public.touch_member_last_seen(uuid) from public, anon;
grant execute on function public.touch_member_last_seen(uuid) to authenticated;

comment on function public.touch_member_last_seen(uuid) is
  'Stamps the caller as seen in one organization, at most once per five minutes. Self only (auth.uid()), real accepted members only, never an impersonation grant, never a disabled account. Anything else is a silent no-op.';

-- ── 3. platform_member_activity gains last_seen_at ───────────────────────────

drop function public.platform_member_activity(uuid, uuid[]);

create function public.platform_member_activity(p_org_id uuid, p_user_ids uuid[])
returns table (
  user_id         uuid,
  last_sign_in_at timestamptz,
  last_session_at timestamptz,
  last_action_at  timestamptz,
  last_seen_at    timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.id,
         u.last_sign_in_at,
         s.last_session_at,
         a.last_action_at,
         ma.last_seen_at
    from auth.users u
    join public.organization_members om
      on om.user_id = u.id
     and om.organization_id = p_org_id
     and om.accepted_at is not null
     and om.impersonation_expires_at is null
    left join public.member_activity ma
      on ma.organization_id = om.organization_id
     and ma.user_id = om.user_id
    left join lateral (
      select max(greatest(se.refreshed_at at time zone 'utc', se.created_at)) as last_session_at
        from auth.sessions se
       where se.user_id = u.id
    ) s on true
    left join lateral (
      select max(al.created_at) as last_action_at
        from public.audit_logs al
       where al.organization_id = p_org_id
         and al.user_id = u.id
         and al.event <> 'user.signed_in'
         and (al.user_agent ilike 'Mozilla/%'
              or al.user_agent ilike 'StockPilot/%'
              or al.user_agent ilike 'okhttp/%')
    ) a on true
   where u.id = any(p_user_ids);
$$;

revoke execute on function public.platform_member_activity(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.platform_member_activity(uuid, uuid[]) to service_role;

comment on function public.platform_member_activity(uuid, uuid[]) is
  'Last sign-in, last session renewal, last audit event written from a person''s own client, and last time the app reported them present, for the real accepted members of one organization. For the platform super-admin console. service_role only. Read-only.';
