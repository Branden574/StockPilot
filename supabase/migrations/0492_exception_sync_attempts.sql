-- 0492_exception_sync_attempts.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- When the Exception Center sync cron last TRIED each organization, so its
-- sweep can go least recently tried first. The number is a placeholder: it is
-- fixed at push time to the next free number, and nothing in this file names
-- it.
--
-- WHY
--   The cron (apps/web/src/app/api/cron/exception-occurrences/route.ts) orders
--   organizations by exception_sync_state.last_synced_at. That column is
--   written only by exceptions_sync, when a sync is applied. An organization
--   the sync skips (no owner or admin, a lock that is busy, a failure) keeps
--   an old time and looks the same as one that has been failing for hours, so
--   once a run cannot reach every organization, the ones that are not applied
--   wait behind every organization that is, run after run. A record of each
--   attempt, written by the cron before it starts the organization, lets the
--   sweep order by the later of the last sync and the last attempt, which
--   moves every organization it reaches to the back of the line, applied or
--   not.
--
-- WHAT IT ADDS (tier B: a new table and its grants; additive only)
--   1. public.exception_sync_attempts: one row per organization, the time the
--      cron last started it and how many attempts in a row ended without a
--      sync (failed, or no owner or admin to act as). It cascades with the
--      organization.
--   2. RLS enabled with NO policy: no API role but service_role (which
--      bypasses RLS) can read or write a row. Only the cron, on the
--      service-role client, uses it.
--   3. Explicit privileges (the D1 rule, apps/web/src/test/migration-grants.ts):
--      PUBLIC, anon and authenticated get nothing; service_role gets select,
--      insert, update and delete.
--   No existing row, table, function, policy, trigger or grant changes, and
--   nothing is backfilled: an organization with no row sorts by its last sync,
--   or, never synced, by when it was created.
--
-- ROLLBACK
--   Leave the table in place: the cron reads it for ordering only, and a
--   failed read or write leaves the sweep running in last-sync order.
--   If it ever has to go: drop table public.exception_sync_attempts;
-- ─────────────────────────────────────────────────────────────────────────────

-- LOCKS: the foreign key holds SHARE ROW EXCLUSIVE on public.organizations to
-- commit; it waits behind any open transaction on that table. lock_timeout
-- 900ms ends such a wait with 55P03 and nothing applied; the push can be run
-- again once that transaction has finished.
set lock_timeout = '900ms';

create table public.exception_sync_attempts (
  organization_id       uuid        primary key references public.organizations(id) on delete cascade,
  last_attempt_at       timestamptz not null,
  consecutive_failures  integer     not null default 0,
  constraint exception_sync_attempts_failures_not_negative check (consecutive_failures >= 0)
);

comment on table public.exception_sync_attempts is
  'When the Exception Center sync cron last started each organization, and how many attempts in a row ended without a sync. Ordering and reporting only. service_role only (RLS on, no policy).';

alter table public.exception_sync_attempts enable row level security;

-- Supabase's default privileges give anon, authenticated and service_role
-- every privilege on a new public table; the change Supabase set for
-- 2026-10-30 (0402's note) takes SELECT, INSERT, UPDATE and DELETE out of
-- them. PUBLIC, anon and authenticated lose everything here. service_role is
-- granted its four and not revoked, so it ends with them under either set of
-- defaults.
revoke all on table public.exception_sync_attempts from public, anon, authenticated;
grant select, insert, update, delete on table public.exception_sync_attempts to service_role;
