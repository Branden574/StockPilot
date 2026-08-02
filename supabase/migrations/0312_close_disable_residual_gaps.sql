-- 0312_close_disable_residual_gaps.sql
-- Closes two residual gaps in the account-disable program (0308-0311), both
-- confirmed in the source by the owed re-review of that program (controller
-- verification, 2026-08-01). Neither gap is theoretical: both are a
-- still-valid, disabled user's access token reaching a database surface that
-- 0308-0311 did not touch.
--
-- ── GAP 1 — the avatar BUCKET, not the row, is the org-wide defacement path ──
-- 0309 froze user_profiles.full_name/avatar_url for a disabled row specifically
-- because those two columns render into every colleague's UI (team list, order
-- timeline actor, cycle-count assignee, movement actor, procedure author — see
-- 0309's header). But avatar_url is a URL into the `user-avatars` STORAGE
-- bucket, and 0026_avatar_logo_buckets.sql:54-77 defines three WRITE policies
-- on storage.objects — "user-avatars own write" (insert), "user-avatars own
-- update" (update), "user-avatars own delete" (delete) — each gated ONLY on
--   (storage.foldername(name))[1]::uuid = auth.uid()
-- with no reference to disabled_at. A disabled user's still-valid token can
-- therefore `upsert` a new image over their own key (or delete it) and the
-- org-wide picture changes with NO write to user_profiles at all — 0309's
-- freeze of the row is bypassed entirely by writing the object the URL points
-- at instead of the URL column itself.
--
-- Checked for a later restatement before touching anything (recurring bug #24:
-- `alter policy ... with check` REPLACES the whole predicate, so the LATEST
-- definition of each policy is the one that must be preserved verbatim):
--   * 0046_rls_with_check_hardening.sql only sets allowed_mime_types on the
--     bucket row; it does not touch these three policies.
--   * 0047_bucket_size_limits.sql only sets file_size_limit; same.
--   * 0105_user_avatars_restrict_read.sql restates the SELECT policy only
--     ("user-avatars public read" -> "user-avatars authenticated read"); it
--     does not mention own write/update/delete.
--   * 0140_rls_initplan_wrap.sql explicitly lists these three as an
--     INTENTIONAL SKIP ("storage.objects — ... 'user-avatars own
--     write/update/delete' — no helper function calls", line 119-120) because
--     they call auth.uid() directly rather than through a wrapped helper.
-- So 0026's text (reproduced above) is still the live definition, and it is
-- reproduced VERBATIM below with the disabled guard appended as a new AND
-- clause — the read/select policy ("user-avatars authenticated read") is not
-- touched.
--
-- WHY 0310's ENUMERATION MISSED THIS
-- 0310's header states it swept every membership helper found via pg_policies,
-- and the picture it drew — "there are 261 policies in this schema" — was
-- built by querying pg_policies FILTERED TO schemaname = 'public' (see 0310's
-- own audit queries and every existing pgTAP file's `where schemaname =
-- 'public'` predicate). storage.objects lives in schema `storage`, not
-- `public`, so these three policies were never in the candidate set that
-- review walked. This migration is schema-storage-aware on purpose.
--
-- Why the inlined disabled_at check rather than public.account_is_disabled():
-- 0310 revoked EXECUTE on account_is_disabled from `authenticated` (and anon)
-- deliberately, keeping it service_role-only — see 0310's "WHO MAY CALL IT
-- DIRECTLY" section. A storage.objects policy evaluates as the requesting
-- role, which for these three policies is `authenticated`, so calling
-- account_is_disabled from here would immediately fail with a permission
-- error for every avatar upload, not just a disabled user's. The inlined
-- `not exists (select 1 from public.user_profiles up where ...)` form used by
-- every Group B helper in 0310 (has_org_role, has_permission,
-- user_can_access_warehouse, user_can_access_inventory) is what is used here
-- too, for the same reason and at the same cost (a single indexed lookup via
-- user_profiles_disabled_at_idx, 0310).
--
-- Two facts make that subquery evaluable as `authenticated`, both re-verified
-- against the current migrations before relying on them:
--   1. user_profiles_select_self (0003_rls.sql:29-31) is
--        for select to authenticated using (id = auth.uid())
--      unconditional — a disabled user can still read their OWN row. Nothing
--      in 0309/0310/0311 narrows this policy.
--   2. 0311_restrict_disable_reason_visibility.sql:122-137 drops the blanket
--      table-level SELECT grant and re-grants an explicit column list to
--      `authenticated` that INCLUDES `disabled_at` (0311:136) — the migration's
--      own header says so is load-bearing, because every enforcement chokepoint
--      reads exactly that column with the user's own client. disabled_reason
--      and disabled_by are NOT in that list and are not read here either.
-- So `(select auth.uid())`'s own profile row, with its disabled_at column, is
-- readable by the same role evaluating this policy — the subquery cannot
-- itself be blocked by RLS or column privileges.
--
-- ── GAP 2 — an unauthenticated disabled-status oracle on two SUBJECT-scoped helpers ──
-- 0310 taught ~15 membership helpers to consult disabled_at, including
-- user_can_access_warehouse and user_can_access_inventory (0310 sections 7-8) —
-- both already refuse a disabled SUBJECT correctly. The residual gap is not
-- correctness, it is that both functions are directly callable, unauthenticated,
-- by anyone holding the public/anon key, which turns the correct boolean answer
-- into a per-uuid oracle:
--   * user_can_access_inventory(uuid, uuid, uuid, text) was granted
--     `to authenticated, anon, service_role` at 0008_warehouse_charters.sql:
--     175-176 and never revoked since — 0310's `create or replace function`
--     redefines the BODY but does not touch existing GRANTs.
--   * user_can_access_warehouse(uuid, uuid, text) was granted `to authenticated`
--     only at 0007_internal_company.sql:199, with no `revoke ... from public`,
--     so PUBLIC retains the implicit EXECUTE Postgres grants on every new
--     function by default — exactly the trap 0310's own header calls out
--     ("a bare grant ... leaves PUBLIC holding EXECUTE as well").
-- So `POST /rest/v1/rpc/user_can_access_inventory` (or `user_can_access_
-- warehouse`) with a victim uuid and any warehouse uuid answers true -> false
-- the moment that user is disabled, to anyone holding the publishable key, with
-- no session and no membership — the same class of leak 0310 itself closed for
-- account_is_disabled, left open one migration later on these two.
--
-- CALLER AUDIT (performed before writing this migration; see the report at
-- .superpowers/sdd/db-residual-gaps-report.md for the full grep output) —
-- every live reference to either helper across supabase/migrations/*.sql:
--   * user_can_access_inventory: the ONE place it was ever wired into a live
--     RLS policy (0008's inventory_items_select/insert/update/delete, restated
--     by 0129) was superseded by 0229_inventory_select_rls_hashed_sets.sql,
--     whose own header states inventory_items_select now runs entirely through
--     the hashed-set rls_inv_read_*/rls_cat_* helpers instead. Every remaining
--     call site (0236-0240, 0244, 0247, 0282, 0306, 0238) is `if not
--     public.user_can_access_inventory(...)` inside the BODY of a VOLATILE
--     SECURITY DEFINER picking RPC (claim_picking, release_picking,
--     partial_pick_line, complete_picking, assign_picking,
--     force_reassign_cycle_count, assign_cycle_count). A nested call from
--     inside a SECURITY DEFINER function is checked against the DEFINER (these
--     are all owned by postgres, the migration-applying role), not against the
--     invoking role — the exact inheritance 0310's own account_is_disabled
--     revoke depends on and proves in its pgTAP file. Revoking anon/PUBLIC
--     EXECUTE on the helper does not touch these RPCs' own `to authenticated`
--     grants.
--   * user_can_access_warehouse: gates `warehouses_select` (0007, restated
--     0140), `inventory_items_select/insert/update` (0007, restated 0203-0205,
--     0212, 0298), `schedule_events_select/insert/update/delete` (0033,
--     restated 0140, 0203), and all eight `rentals`/`rental_lines` policies
--     (0131). Every one of those `create policy` statements is `for ... to
--     authenticated` (grep-confirmed across 0007, 0033, 0131, 0140, 0203-0205,
--     0212, 0298 — no `to anon` or bare `for select`/`for all` without a roles
--     clause anywhere in this list). Because RLS evaluates a bucket-role-scoped
--     policy under the ROLE the policy is scoped to, `anon` never reaches these
--     predicates regardless of the helper's own ACL — the policy's `to
--     authenticated` clause is the actual gate, and this migration's function
--     revoke only removes a REDUNDANT path anon never needed and a genuine
--     unauthenticated oracle it did not need either.
-- grep across apps/web/src and apps/mobile/src for `.rpc('user_can_access_` /
-- `rpc("user_can_access_` found zero call sites — every reference in app code
-- is a code comment naming the RLS mechanism, never a direct RPC call. So no
-- client, web or mobile, ever calls these two functions directly, from any key.
--
-- This audit did NOT contradict any claim in the brief; nothing here stops the
-- planned revoke.
--
-- ── BACKWARD-COMPATIBILITY POSTURE ──────────────────────────────────────────
-- Both fixes are purely RESTRICTIVE and only against two populations that must
-- never have had this reach: disabled accounts (gap 1) and anon/PUBLIC (gap 2).
-- No active, non-disabled user's avatar upload/replace/delete changes at all
-- (the new AND clause is `not exists (... disabled_at is not null)`, which is
-- true — a no-op — for every active row). No `authenticated` or `service_role`
-- caller of either function loses anything; only `anon` and the bare PUBLIC
-- pseudo-role do, and the caller audit above shows nothing legitimate used that
-- reach. Safe to apply BEFORE any code deploy, and safe to apply independently
-- of it — no application code changes accompany this migration.
--
-- ── LOCK POSTURE ─────────────────────────────────────────────────────────────
-- Precedent: 0295, 0298, 0303, 0310, 0311. `drop policy` + `create policy` on
-- storage.objects and `revoke`/`grant` on a function both take locks (the
-- policy DDL takes a lock on storage.objects; storage.objects is read on every
-- avatar/logo render across the product). `set lock_timeout` makes a blocked
-- push fail fast and be retried in a quiet window rather than queuing every
-- reader behind it.
--
-- ON lock_timeout FAILURE ("canceling statement due to lock timeout", SQLSTATE
-- 55P03): nothing was applied — the whole migration is one transaction.
-- Re-run `supabase db push --linked` during a quiet window.
set lock_timeout = '5s';

-- ============================================================================
-- GAP 1 — user-avatars write policies gain a disabled-subject guard.
-- Original predicates reproduced VERBATIM from 0026 (confirmed still-current
-- above); only the new `and not exists (...)` clause is added. The read/select
-- policy ("user-avatars authenticated read", from 0105) is untouched.
-- ============================================================================

drop policy if exists "user-avatars own write" on storage.objects;
create policy "user-avatars own write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'user-avatars'
    and (storage.foldername(name))[1]::uuid = auth.uid()
    and not exists (
      select 1 from public.user_profiles up
      where up.id = (select auth.uid()) and up.disabled_at is not null
    )
  );

drop policy if exists "user-avatars own update" on storage.objects;
create policy "user-avatars own update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'user-avatars'
    and (storage.foldername(name))[1]::uuid = auth.uid()
    and not exists (
      select 1 from public.user_profiles up
      where up.id = (select auth.uid()) and up.disabled_at is not null
    )
  )
  with check (
    bucket_id = 'user-avatars'
    and (storage.foldername(name))[1]::uuid = auth.uid()
    and not exists (
      select 1 from public.user_profiles up
      where up.id = (select auth.uid()) and up.disabled_at is not null
    )
  );

drop policy if exists "user-avatars own delete" on storage.objects;
create policy "user-avatars own delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'user-avatars'
    and (storage.foldername(name))[1]::uuid = auth.uid()
    and not exists (
      select 1 from public.user_profiles up
      where up.id = (select auth.uid()) and up.disabled_at is not null
    )
  );

-- ============================================================================
-- GAP 2 — revoke the unauthenticated oracle on the two SUBJECT-parameterised
-- helpers; both already answer correctly for a disabled subject (0310), this
-- only removes who may ask the question directly. Precedent: 0128/0129 for
-- user_can_see_item_category, 0229/0230 for the rls_* set, 0310 for
-- account_is_disabled.
-- ============================================================================

revoke all on function public.user_can_access_inventory(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.user_can_access_inventory(uuid, uuid, uuid, text) to authenticated, service_role;

revoke all on function public.user_can_access_warehouse(uuid, uuid, text) from public, anon;
grant execute on function public.user_can_access_warehouse(uuid, uuid, text) to authenticated, service_role;

comment on function public.user_can_access_inventory(uuid, uuid, uuid, text) is
  'SUBJECT-scoped inventory access gate (0008), disabled-subject-aware since '
  '0310. EXECUTE revoked from public/anon by 0312 to close an unauthenticated '
  'per-uuid disable oracle — the picking RPCs that are its only live callers '
  'reach it as SECURITY DEFINER (checked against the definer, not the invoker) '
  'and are unaffected.';

comment on function public.user_can_access_warehouse(uuid, uuid, text) is
  'SUBJECT-scoped warehouse access gate (0007), disabled-subject-aware since '
  '0310. EXECUTE revoked from public/anon by 0312 to close an unauthenticated '
  'per-uuid disable oracle — every live policy that calls it is already scoped '
  'to `to authenticated`, so anon never reached these predicates through RLS '
  'either way.';

reset lock_timeout;
