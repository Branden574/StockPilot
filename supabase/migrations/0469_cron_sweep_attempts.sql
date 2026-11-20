-- 0469_cron_sweep_attempts.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- When a scheduled job last TRIED each organization, so its sweep can go
-- least recently reached first. One table for every job that sweeps the
-- organizations; today the Exception Center sync ('exception_sync') and the
-- daily restore points ('restore_points'). The number is a placeholder: it is
-- fixed at push time to the next free number, and nothing in this file names
-- it.
--
-- WHY
--   Both jobs ordered organizations by their last SUCCESS:
--   exception_sync_state.last_synced_at (written only when a sync is
--   applied) and the newest automatic restore point. An organization the job
--   skips or fails keeps an old time, so it either waits behind every
--   organization that succeeds (exception sync's old tiers), or is tried
--   first on every run and, when it is slow, uses up the run (restore points).
--   A record of each attempt, written by the job as it starts the
--   organization, lets the sweep order by the later of the last success and
--   the last attempt, which sends every organization it reaches to the back of
--   the line, succeeded or not.
--
-- WHAT IT ADDS (tier B: a new table, an index and grants; additive only)
--   1. public.cron_sweep_attempts: one row per (job, organization): the time
--      the job last started it and how many attempts in a row ended without
--      success. It cascades with the organization; the index on
--      organization_id serves that cascade (the key leads with job).
--   2. RLS enabled with NO policy: no API role but service_role (which
--      bypasses RLS) can read or write a row. Only the crons, on the
--      service-role client, use it.
--   3. Explicit privileges (the D1 rule, apps/web/src/test/migration-grants.ts):
--      PUBLIC, anon and authenticated get nothing; service_role gets select,
--      insert, update and delete.
--   No existing row, table, function, policy, trigger or grant changes, and
--   nothing is backfilled: an organization with no row sorts by its last
--   success (or, for exception sync, never synced, by when it was created).
--
-- ROLLBACK
--   Leave the table in place: the crons read it for ordering and counting
--   only, and a failed read or write leaves each sweep running in
--   last-success order.
--   If it ever has to go: drop table public.cron_sweep_attempts;
-- ─────────────────────────────────────────────────────────────────────────────

-- LOCKS: the foreign key holds SHARE ROW EXCLUSIVE on public.organizations to
-- commit; it waits behind any open transaction on that table. lock_timeout
-- 900ms ends such a wait with 55P03 and nothing applied; the push can be run
-- again once that transaction has finished.
set lock_timeout = '900ms';

create table public.cron_sweep_attempts (
  job                   text        not null,
  organization_id       uuid        not null references public.organizations(id) on delete cascade,
  last_attempt_at       timestamptz not null,
  consecutive_failures  integer     not null default 0,
  primary key (job, organization_id),
  -- A job is a short lower-case name, as the code spells it.
  constraint cron_sweep_attempts_job_name check (job ~ '^[a-z][a-z0-9_]{0,62}$'),
  constraint cron_sweep_attempts_failures_not_negative check (consecutive_failures >= 0)
);

create index cron_sweep_attempts_organization_id_idx
  on public.cron_sweep_attempts (organization_id);

comment on table public.cron_sweep_attempts is
  'When a scheduled job (exception_sync, restore_points) last started each organization, and how many attempts in a row ended without success. Ordering and reporting only. service_role only (RLS on, no policy).';

alter table public.cron_sweep_attempts enable row level security;

-- Supabase's default privileges give anon, authenticated and service_role
-- every privilege on a new public table; the change Supabase set for
-- 2026-10-30 (0402's note) takes SELECT, INSERT, UPDATE and DELETE out of
-- them. PUBLIC, anon and authenticated lose everything here. service_role is
-- granted its four and not revoked, so it ends with them under either set of
-- defaults.
revoke all on table public.cron_sweep_attempts from public, anon, authenticated;
grant select, insert, update, delete on table public.cron_sweep_attempts to service_role;
