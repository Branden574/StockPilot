-- 0311_restrict_disable_reason_visibility.sql
-- Closes the confidentiality leak 0308 opened: an ordinary colleague could read
-- a disabled coworker's INTERNAL disable reason and the god-admin's identity.
--
-- ── THE LEAK (reproduced on the local stack before this was written) ────────
-- 0003_rls.sql's `user_profiles_select_orgmates` lets ANY authenticated user
-- SELECT the FULL row of anyone who shares an organization with them. That was
-- fine while the row held only name/avatar/email. 0308 added disabled_at,
-- disabled_reason and disabled_by to that same row, and RLS is row-level: a
-- policy that grants the row grants every column in it.
--
-- Reproduced as a plain `staff` member reading a `manager` colleague's row:
--
--   set local role to 'authenticated';           -- sub = the ordinary colleague
--   select disabled_reason, disabled_by from public.user_profiles where id = <peer>;
--   -->  "Suspected account compromise — notes: credential stuffing from
--        203.0.113.44, pending SOC review, do not notify subject"
--        | 0311beef-...-a3
--
-- That is a direct violation of the feature's brief on two counts: the internal
-- reason must never be shown to the disabled user (and a colleague is strictly
-- worse), and the God Admin identity must not be revealed. `select *` returned
-- it too, which is what PostgREST serves for `/user_profiles?select=*`.
--
-- ── WHY COLUMN PRIVILEGES, NOT A NARROWER POLICY ───────────────────────────
-- RLS cannot express this. A policy decides WHICH ROWS you may see, never which
-- columns of them, so no edit to user_profiles_select_orgmates can hide two
-- columns of a row it is otherwise correct to return. Column-level GRANTs are
-- the only mechanism in Postgres that does this, and they sit BELOW RLS: the
-- privilege check fires before any policy is evaluated, so this holds even for
-- the user's OWN row via user_profiles_select_self.
--
-- Editing the shared policy would also have been the more dangerous change —
-- recurring bug #24: `alter policy ... with check` REPLACES rather than adds.
-- 0309 declined to narrow this same policy for the same reason.
--
-- ── THE TRAP: A BARE COLUMN REVOKE HERE IS A NO-OP ─────────────────────────
-- This was measured on the local stack, not assumed. The obvious spelling
--
--     revoke select (disabled_reason, disabled_by) on public.user_profiles
--       from authenticated;
--
-- reports REVOKE, changes NOTHING, and the column stays readable:
-- information_schema.column_privileges still showed all 16 columns held, and
-- the select above still returned the reason. Postgres treats a table-level
-- SELECT grant and per-column grants as SEPARATE privileges; a column revoke
-- cannot subtract from a table-level grant, and `authenticated` holds one here
-- (Supabase's default privileges grant it on every table in public).
--
-- So the table-level grant must be DROPPED and the keep-list re-granted
-- explicitly. That is what makes this effective, and it is why the column list
-- below is spelled out in full rather than expressed as a two-column revoke.
--
-- ── WHAT MUST KEEP WORKING: disabled_at ────────────────────────────────────
-- disabled_at is deliberately RETAINED for `authenticated`, and that is
-- load-bearing rather than incidental. Every one of the five enforcement
-- funnels reads it with the USER's OWN client, never the admin client — traced
-- before choosing the keep list:
--
--   1. loadSessionAndContext  (lib/auth/session.ts:87)          createClient()
--   2. withApiContext, Bearer (lib/auth/api-context.ts:232)     bearer createClient
--      withApiContext, cookie (lib/auth/api-context.ts:298)     createClient()
--   3. resolvePortalContext   (server/services/portal.ts:125)   createClient()
--        — createAdminClient() appears at portal.ts:145 but only AFTER the
--          status read; the status read itself is the user-authed client.
--   4. the QuickBooks / Sage Intacct OAuth callbacks             createClient()
--   5. changePasswordAction   (server/actions/auth.ts:470)       createClient()
--
-- All five go through loadAccountStatus / the session select, and both ask for
-- ACCOUNT_STATUS_COLUMNS = 'disabled_at' (lib/auth/account-status.ts:73) —
-- disabled_at ONLY. Neither reads disabled_reason or disabled_by. Revoking
-- disabled_at would make every one of those reads a permission error, and since
-- that guard now fails CLOSED (an unreadable status DENIES, by design), it would
-- lock every user out of the entire product. It stays granted.
--
-- Nothing in the app reads disabled_reason or disabled_by on a user-authed
-- client: the only readers are the platform console's service-role paths
-- (server/services/platform/*), which createAdminClient() and are unaffected —
-- service_role's grants are not touched below.
--
-- ── WHY THE WRITE PRIVILEGES ARE LEFT ALONE ────────────────────────────────
-- Only SELECT is narrowed. INSERT/UPDATE on these columns stay exactly as they
-- were because 0309 already pins them: tg_pin_user_profile_disable_flags
-- silently REVERTS any write from a role outside its allowlist. Converting that
-- into a hard permission error would change 0309's deliberate silent-revert
-- posture and break its test plan, which asserts the revert. Read and write are
-- guarded by the mechanism suited to each.
--
-- ── MAINTENANCE LANDMINE — READ BEFORE ADDING A COLUMN ─────────────────────
-- Dropping the table-level grant means `authenticated` and `anon` now hold
-- SELECT on an ENUMERATED list. A column added to user_profiles later will NOT
-- be readable by either role until it is added to that list. This fails CLOSED
-- on purpose — a new column is invisible until someone decides it should be
-- visible, which is the safe default for a table that now carries operator-only
-- fields. The 0311 pgTAP asserts the exact expected column set, so adding a
-- column turns into a red test that names the decision instead of a production
-- read that silently returns nothing. `select *` on this table ERRORS for these
-- roles (verified), so a wildcard read is a hard failure, never a quiet one.

-- ── LOCK POSTURE — READ BEFORE PUSHING THIS TO PROD ────────────────────────
-- GRANT and REVOKE on a table acquire AccessExclusiveLock on it, held for the
-- whole transaction, and this migration is one transaction. As of this branch
-- EVERY authenticated request in the product reads user_profiles (session.ts,
-- api-context.ts:160, account-status.ts) — the table moved from cold to the
-- single hottest read path. Postgres lock requests are FIFO, so if any open
-- transaction is holding even an AccessShareLock when this runs, the
-- AccessExclusive request queues AND every subsequent reader queues behind IT.
-- The work itself is instant (the row count is tiny); the exposure is purely
-- the lock wait, and it would present as a site-wide stall rather than a slow
-- migration. Same precedent and same value as 0295, 0298 and 0303.
--
-- ON lock_timeout FAILURE ("canceling statement due to lock timeout", SQLSTATE
-- 55P03): nothing was applied — one transaction, so the revoke and the re-grant
-- roll back together and `authenticated` keeps the blanket grant it had before.
-- Re-run `supabase db push --linked` during a quiet window. There is no
-- half-applied state to clean up, and no window in which the keep-list is
-- granted without the blanket grant having been dropped.
set lock_timeout = '5s';

-- ── authenticated ──────────────────────────────────────────────────────────
revoke select on public.user_profiles from authenticated;
grant select (
  id,
  email,
  full_name,
  avatar_url,
  default_organization_id,
  created_at,
  updated_at,
  email_digest_optin,
  digest_section_low_stock,
  digest_section_open_pos,
  digest_section_cycle_counts,
  deleted_at,
  onboarding_dismissed_at,
  disabled_at
) on public.user_profiles to authenticated;

-- ── anon ───────────────────────────────────────────────────────────────────
-- anon held the same blanket grant. No anonymous path reads this table today,
-- but the grant existed, and an unauthenticated reader of an operator's notes
-- would be strictly worse than an authenticated one. Narrowed identically
-- rather than revoked outright, so this migration changes exactly one thing
-- about anon's reach: the two operator-only columns.
revoke select on public.user_profiles from anon;
grant select (
  id,
  email,
  full_name,
  avatar_url,
  default_organization_id,
  created_at,
  updated_at,
  email_digest_optin,
  digest_section_low_stock,
  digest_section_open_pos,
  digest_section_cycle_counts,
  deleted_at,
  onboarding_dismissed_at,
  disabled_at
) on public.user_profiles to anon;

-- service_role is deliberately untouched. The platform console reads these two
-- columns through createAdminClient() and must keep full visibility.

comment on column public.user_profiles.disabled_reason is
  'Operator-supplied reason (category, plus notes when the category is other). '
  'Service-role visible only — never shown to the disabled user. SELECT is '
  'revoked from authenticated and anon at the COLUMN level by 0311; RLS cannot '
  'express this because a row policy grants every column of the row it returns.';
comment on column public.user_profiles.disabled_by is
  'auth uid of the platform admin who disabled the account. Attribution also '
  'lands in platform_admin_audit with the actor email. SELECT is revoked from '
  'authenticated and anon at the COLUMN level by 0311 — the God Admin identity '
  'must not be revealed to org members.';

reset lock_timeout;
