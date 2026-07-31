-- 0310_rls_blocks_disabled_accounts.sql
-- Makes the account disable flag (0308) authoritative at the DATABASE, so a
-- disabled user is refused by RLS itself rather than only by the Next.js
-- request chokepoints.
--
-- ── THE HOLE THIS CLOSES ────────────────────────────────────────────────────
-- 0308 added user_profiles.disabled_at and 0309 pinned it against self-clearing,
-- but NO policy anywhere consulted it. Every membership gate keyed on
-- organization_members.accepted_at alone. PostgREST is not the Next.js server:
-- it validates the JWT signature locally and never asks GoTrue whether the
-- session was revoked. So for as long as an already-issued access token stayed
-- signature-valid, a disabled user could talk straight to /rest/v1 and RLS would
-- authorize the full CRUD surface of the product.
--
-- The window is the access-token TTL. supabase/config.toml sets
-- `jwt_expiry = 3600` for the LOCAL stack; the hosted project's value is
-- configured in the dashboard and is NOT asserted here.
--
-- The design doc previously called this residual exposure "read-only, because
-- all mobile writes go through Bearer /api/v1". That reasoning describes OUR
-- client. It does not bind an attacker holding the token, who can issue any verb
-- PostgREST exposes. The exposure was read AND write.
--
-- ── WHY THE FIX GOES IN THE HELPERS ─────────────────────────────────────────
-- There are 261 policies in this schema. Editing each one would be 261 chances
-- to miss one, and recurring bug #24 (`alter policy ... with check` REPLACES
-- rather than adds) makes bulk policy surgery genuinely dangerous. Every policy
-- instead reaches membership through a small set of SECURITY DEFINER helpers, so
-- the check goes inside those helpers and all 261 inherit it untouched.
--
-- ── WHICH HELPERS, AND WHY IT IS NOT JUST TWO ───────────────────────────────
-- The adversarial finding named is_org_member and has_org_role. Those two carry
-- the most policies (72 and 133 as counted from pg_policies), but stopping there
-- would have shipped a fix with two large holes still open:
--
--   * has_permission (43 policies) is an INDEPENDENT membership gate. It reads
--     organization_members directly; it does not call the other two.
--   * inventory_items_select — the read path on the largest table in the product
--     — references NONE of those three. It is gated entirely by
--     rls_inv_read_full_warehouse_ids / rls_inv_read_assigned_warehouse_ids /
--     rls_inv_read_warehouse_charter_ids / rls_cat_unrestricted_org_ids /
--     rls_cat_allowed_category_ids. A disabled user would have kept READ on
--     every item.
--   * user_can_access_warehouse is the SOLE gate on all four verbs of `rentals`
--     and `rental_lines` (8 policies). A disabled user would have kept full CRUD
--     there.
--
--   * user_can_access_inventory is the SOLE gate on the picking RPCs (see the
--     RPC note below). It reads organization_members directly and reaches no
--     other helper.
--   * user_can_see_item_category likewise reads organization_members directly.
--     The `has_org_role` inside it is a COMMENT, not a call.
--
-- So all fifteen STABLE membership helpers are guarded below.
-- rls_orgs_with_permission is the sixteenth and is deliberately NOT given its
-- own check: its body already calls has_permission, so it inherits the guard,
-- and a second probe would be pure cost. Its pgTAP assertion proves the
-- inheritance rather than trusting it.
--
-- The RULE that decides which of the two treatments a function gets: a function
-- whose OWN BODY reads a membership table is guarded here; a function that only
-- delegates to one of these helpers inherits the guard and is pinned by a test
-- instead. Nothing is left to a caller's discretion to AND correctly.
--
-- ── THE VOLATILE RPCs — AN EARLIER VERSION OF THIS NOTE WAS WRONG ───────────
-- It read: "The five VOLATILE SECURITY DEFINER RPCs that are granted to
-- `authenticated` (assign_cycle_count, assign_picking, force_reassign_cycle_count,
-- set_default_bin) all route through is_org_member / has_org_role /
-- has_permission and therefore inherit this too."
--
-- That sentence named four functions while claiming five, and its conclusion was
-- false. Those four do gate on has_org_role unconditionally and do inherit. But
-- FOUR MORE picking RPCs are granted to `authenticated` and reach
-- user_can_access_inventory as their only guarded gate:
--
--   * claim_picking's ONLY authorization check is
--     user_can_access_inventory(auth.uid(), warehouse_id, null, 'write').
--     Unguarded, a disabled admin claimed orders and PERSISTED
--     assigned_picker_id as themselves.
--   * release_picking checks user_can_access_inventory, then
--     `assigned_picker_id = v_user OR has_org_role(...)`. A self-release
--     satisfies the left arm, so has_org_role is never evaluated.
--   * partial_pick_line and complete_picking check
--     `not has_org_role(...) AND assigned_picker_id <> v_user`. Once the row
--     names the caller as the picker, a FAILING has_org_role is NOT sufficient
--     to refuse — the conjunction short-circuits and the RPC proceeds. A
--     disabled picker therefore wrote quantity_picked. The on_hand draw-down
--     itself was stopped one layer deeper, by adjust_stock's own
--     has_org_role(...,'staff') check, which this migration does guard — but
--     the claim lock and the line write both landed.
--
-- transfer_org_ownership does not route through any of them, but it is granted
-- to service_role only, so it is not reachable by a disabled user's token.
--
-- ── SERVICE ROLE ────────────────────────────────────────────────────────────
-- service_role carries no request.jwt.claim.sub, so auth.uid() is null there and
-- account_is_disabled(null) is FALSE by construction. That is load-bearing: the
-- disable/re-enable service writes user_profiles through createAdminClient WHILE
-- the user is disabled, and a guard that caught service_role would make the
-- disable irreversible.
--
-- ── PERFORMANCE, AND WHY THE CHECK IS WRITTEN TWO DIFFERENT WAYS ────────────
-- This repo has explicit do-not-regress performance rules, and an RLS check paid
-- per row is exactly the platform-wide tax those rules exist to prevent. The
-- helpers below split into two groups that behave very differently, and this was
-- MEASURED, not assumed (500k-row inventory_items, authenticated role, EXPLAIN
-- (ANALYZE, BUFFERS); full numbers in .superpowers/sdd/bypass-closure-report.md).
--
-- GROUP A — helpers taking no row-dependent argument (all the rls_* readers).
--   The planner hoists these into a one-time InitPlan: the EXPLAIN shows
--   `loops=1`. They call account_is_disabled() directly, which is the clearest
--   form, and it costs nothing measurable — the paged inventory SELECT was
--   124.2 ms before and 122.7 ms after.
--
-- GROUP B — helpers correlated on a column, i.e. has_org_role(organization_id,
--   ...), has_permission(organization_id, ...) and
--   user_can_access_warehouse(auth.uid(), warehouse_id, ...). The planner CANNOT
--   hoist these; they become SubPlans re-executed once per candidate row. On the
--   500k-row scan they run 500,000 times each.
--
--   Calling account_is_disabled() from inside Group B cost 3 extra buffers per
--   invocation — SubPlan 13 went from 500,012 to 2,000,012 buffer hits and the
--   bulk UPDATE went from 10.2 s to 33.5 s, a 3.3x regression. The cost is the
--   nested SECURITY DEFINER call itself (a separate plan, executor startup and
--   privilege switch per row), NOT the index probe.
--
--   Group B therefore inlines the same predicate as a NOT EXISTS against the
--   partial index below, which keeps it in the helper's own plan: 33.5 s back
--   down to 12.9 s on that pathological scan, and no measurable change on
--   UPDATE by primary key (3.8 ms vs 4.0 ms).
--
-- ── WHAT GROUP B ACTUALLY COSTS ON READS — RE-MEASURED 2026-07-31 ───────────
-- An earlier version of this header said the residual regression was confined
-- to "a pathological bulk UPDATE" and that there was "no measurable change on
-- the shapes the application actually issues", citing a paged inventory SELECT.
-- That was true of inventory_items, whose SELECT policy runs entirely through
-- the Group A rls_* helpers (hoisted, loops=1) — but it is NOT true of the
-- class. ~70 other SELECT policies gate on a ROW-CORRELATED helper instead:
-- item_stock_levels_select is `(select is_org_member(item_stock_levels.
-- organization_id))`, activity_logs_select is `(select has_org_role(
-- activity_logs.organization_id,'manager'))`, and the same shape covers
-- purchase_order_items, order_request_lines, cycle_count_lines,
-- stock_reservations and ~65 more. Those pay the disable probe once per
-- candidate row on READS, exactly as the bulk UPDATE does on writes.
--
-- Re-measured on the local stack: 500,002 item_stock_levels rows in one org;
-- user_profiles at 10,001 rows of which 1,112 disabled (so the partial index is
-- populated, not empty); role `authenticated` with request.jwt.claim.sub set;
-- `explain (analyze, costs off, timing off)`. The two helper sets were swapped
-- back and forth between EVERY single run — 8 interleaved pre/post pairs —
-- because measuring one block then the other on this stack produces drift of
-- the same magnitude as the effect being measured.
--
--   select count(*) from public.item_stock_levels;   -- SubPlan, loops=500,002
--     pre-0310 helpers   median 3,556 ms
--     0310 helpers       median 4,555 ms        -->  +28%
--     (paired deltas across the 8 pairs: +24% .. +49%, median +33%)
--
-- Isolating the helper with a direct row-correlated call on the same fixture:
--   has_org_role(isl.organization_id,'staff')   3,458 ms -> 4,551 ms  (+32%)
--   is_org_member(isl.organization_id)          1,465 ms -> 2,845 ms  (+94%)
-- Both are the SAME absolute cost — about 2.2-2.8 us per invocation, the
-- Index Only Scan on user_profiles_disabled_at_idx (Heap Fetches: 0). It reads
-- as +32% or +94% purely because is_org_member's body is the cheaper of the two
-- to begin with. Percentages here are a property of the helper, not of the
-- guard.
--
-- SO: the honest characterisation is that ANY large scan through a Group B
-- helper — a full item_stock_levels rollup, an activity_logs export, a wide
-- purchase_order_items report — costs roughly +28% more, on reads as well as
-- writes. It is the same band as the bulk-UPDATE figure, not a separate
-- pathological case. Paged application queries are unaffected only because they
-- scan a page; a query that scans the table pays per row.
--
-- The duplication is deliberate and is fenced by tests, not by discipline: the
-- pgTAP file asserts EVERY helper in both groups individually, active and
-- disabled, so the two forms cannot drift apart without the suite going red.
--
-- ── LOCK POSTURE ────────────────────────────────────────────────────────────
-- `create index` below takes ShareLock on user_profiles, which blocks writes,
-- and as of this branch EVERY authenticated request in the product reads
-- user_profiles (session.ts, api-context.ts, account-status.ts). Postgres lock
-- requests are FIFO, so a blocked ShareLock request queues every subsequent
-- reader behind it and a few seconds of blocking becomes a site-wide stall.
-- `set lock_timeout` (precedent: 0295, 0298, 0303) makes the push fail fast and
-- be retried instead.
--
-- ON lock_timeout FAILURE ("canceling statement due to lock timeout", SQLSTATE
-- 55P03): nothing was applied — the whole migration is one transaction. Re-run
-- `supabase db push --linked` during a quiet window; there is no cleanup to do.
set lock_timeout = '5s';
--
-- The partial index indexes ONLY disabled profiles, so in a healthy org it is
-- empty or near-empty and the per-row probe is a root-page hit on a fully cached
-- relation rather than a lookup into the whole user_profiles table.

-- ── 1) The check, as one STABLE SECURITY DEFINER helper ─────────────────────
-- SECURITY DEFINER because user_profiles is RLS-protected and this must be able
-- to answer for the caller regardless of which row they can see.
--
-- Takes the user id as a PARAMETER rather than reading auth.uid() internally,
-- because user_can_access_warehouse is itself parameterised by user id: it is
-- called as user_can_access_warehouse(auth.uid(), ...) from policies, but the
-- honest answer to "can this user reach this warehouse" is NO for a disabled
-- user whoever is asking.
--
-- Deliberately NOT STRICT. A null id must answer FALSE (active), not NULL:
-- `not null` is null, which a WHERE clause discards, and that would silently
-- turn "unknown caller" into "denied" in some contexts and "allowed" in others.
-- exists() always returns a real boolean, so null in gives false out.
--
-- A MISSING profile row also reads active, matching isAccountDisabled() in
-- @stockpilot/core: absence of a profile is an onboarding state, not a disable.
create or replace function public.account_is_disabled(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.user_profiles up
    where up.id = p_user_id
      and up.disabled_at is not null
  );
$$;

comment on function public.account_is_disabled(uuid) is
  'True when the platform has disabled this account (user_profiles.disabled_at). '
  'Null or unknown id reads FALSE (active), which is what keeps service_role — '
  'whose auth.uid() is null — outside the guard so re-enable stays possible. '
  'STABLE so the planner can hoist it to a one-time InitPlan where the calling '
  'helper is not row-correlated.';

-- ── WHO MAY CALL IT DIRECTLY: service_role, and nobody else ────────────────
-- A bare `grant execute ... to authenticated, anon, service_role` (the first
-- cut) leaves PUBLIC holding EXECUTE as well, because Postgres grants EXECUTE
-- to PUBLIC on every new function and a later GRANT does not subtract it. The
-- resulting ACL was `=X/postgres,postgres=X,anon=X,authenticated=X,
-- service_role=X`, and this function is SECURITY DEFINER over an RLS-protected,
-- column-restricted table. Probed on the local stack: as role `anon`,
-- `select count(*) from public.user_profiles where id = '<uuid>'` returns 0
-- (every user_profiles policy is `to authenticated`) but
-- `select public.account_is_disabled('<uuid>')` returned true — i.e. anyone
-- holding NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, which ships in every web bundle
-- and mobile binary, could POST /rest/v1/rpc/account_is_disabled with a user id
-- and read that person's disable timeline with no credential at all. User ids
-- are not secret: they appear in audit-trail cells, notification payloads, the
-- eviction channel name `user:{id}:sessions` and any row carrying created_by.
--
-- Nothing needs the grant. The Group A helpers call this function as the
-- DEFINER (they are themselves SECURITY DEFINER, owned by postgres, so the
-- nested call is checked against postgres, not against the request role), and
-- the Group B helpers do not call it at all — they inline the predicate. No
-- policy references it directly, and no application path RPCs it. `authenticated`
-- is revoked too, not just anon: the same call from any signed-in user answers
-- for uuids in orgs they have no membership in, which is a cross-tenant read
-- that RLS otherwise refuses. service_role is kept for operator SQL, matching
-- 0308's treatment of its own helper.
--
-- The pgTAP file proves BOTH halves: that the direct call is refused for anon
-- and authenticated, AND that every guarded helper still answers correctly for
-- an authenticated caller afterwards — the inheritance is asserted, not assumed.
revoke all on function public.account_is_disabled(uuid) from public, anon, authenticated;
grant execute on function public.account_is_disabled(uuid) to service_role;

-- Partial index: only disabled profiles are indexed, so the per-row probe in the
-- row-correlated helpers touches a tiny, fully cached relation instead of the
-- whole user_profiles PK index. This is what keeps the UPDATE path cheap.
create index if not exists user_profiles_disabled_at_idx
  on public.user_profiles (id)
  where disabled_at is not null;

-- ── 2) The three helpers named in the finding — GROUP B (row-correlated) ────
-- Each body is 0177's (impersonation-aware) definition with the disable check
-- added as an inlined NOT EXISTS. 0177's expiry semantics are restated verbatim
-- — dropping them here would silently reopen the impersonation hole 0177 closed.
--
-- These read `up.id = m.user_id` rather than auth.uid() only because the
-- surrounding predicate has already fixed m.user_id = auth.uid(); it keeps the
-- probe on a column the row already carries.
create or replace function public.is_org_member(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1 from public.organization_members m
    where m.organization_id = org_id
      and m.user_id = auth.uid()
      and m.accepted_at is not null
      and (m.impersonation_expires_at is null or m.impersonation_expires_at > now())
      and not exists (
        select 1 from public.user_profiles up
        where up.id = m.user_id and up.disabled_at is not null
      )
  );
$$;

create or replace function public.user_org_role(org_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select m.role
  from public.organization_members m
  where m.organization_id = org_id
    and m.user_id = auth.uid()
    and m.accepted_at is not null
    and (m.impersonation_expires_at is null or m.impersonation_expires_at > now())
    and not exists (
      select 1 from public.user_profiles up
      where up.id = m.user_id and up.disabled_at is not null
    )
  limit 1;
$$;

create or replace function public.has_org_role(org_id uuid, min_role text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with role_rank(role, rank) as (
    values
      ('owner',   100),
      ('admin',    80),
      ('manager',  60),
      ('staff',    40),
      ('viewer',   20)
  ),
  user_role as (
    select rr.rank
    from public.organization_members m
    join role_rank rr on rr.role = m.role
    where m.organization_id = org_id
      and m.user_id = auth.uid()
      and m.accepted_at is not null
      and (m.impersonation_expires_at is null or m.impersonation_expires_at > now())
      and not exists (
        select 1 from public.user_profiles up
        where up.id = m.user_id and up.disabled_at is not null
      )
    limit 1
  )
  select coalesce((select rank from user_role), 0)
       >= coalesce((select rank from role_rank where role = min_role), 999);
$$;

-- ── 3) The independent permission gate — GROUP B (row-correlated) ───────────
-- has_permission does NOT call has_org_role; it reads organization_members
-- itself, so guarding the other two would have left its 43 policies open.
create or replace function public.has_permission(org_id uuid, perm text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with usr as (
    select m.role
    from public.organization_members m
    where m.organization_id = org_id
      and m.user_id = auth.uid()
      and m.accepted_at is not null
      and (m.impersonation_expires_at is null or m.impersonation_expires_at > now())
      and not exists (
        select 1 from public.user_profiles up
        where up.id = m.user_id and up.disabled_at is not null
      )
    limit 1
  )
  select case
    when not exists (select 1 from usr) then false
    when (select role from usr) = 'owner' then true
    else coalesce(
      ( select upo.granted
          from public.user_permission_overrides upo
         where upo.organization_id = org_id
           and upo.user_id = auth.uid()
           and upo.permission = perm ),
      ( select rpo.granted
          from public.role_permission_overrides rpo
         where rpo.organization_id = org_id
           and rpo.role = (select role from usr)
           and rpo.permission = perm ),
      ( select true
          from public.role_default_permissions rdp
         where rdp.role = (select role from usr)
           and rdp.permission = perm ),
      false
    )
  end
$$;

-- ── 4) The inventory READ path ──────────────────────────────────────────────
-- inventory_items_select references none of the helpers above. Without these
-- four, a disabled user keeps SELECT on every item in the product.
create or replace function public.rls_inv_read_full_warehouse_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select w.id
  from public.warehouses w
  join public.organization_members m
    on m.organization_id = w.organization_id
  where m.user_id = auth.uid()
    and m.accepted_at is not null
    and (m.impersonation_expires_at is null or m.impersonation_expires_at > now())
    and m.role in ('owner', 'admin', 'manager')
    and not public.account_is_disabled(auth.uid())
  union
  select uwa.warehouse_id
  from public.user_warehouse_assignments uwa
  join public.warehouses w
    on w.id = uwa.warehouse_id
  join public.organization_members m
    on m.organization_id = w.organization_id
   and m.user_id = uwa.user_id
  where uwa.user_id = auth.uid()
    and uwa.charter_id is null
    and m.accepted_at is not null
    and (m.impersonation_expires_at is null or m.impersonation_expires_at > now())
    and not public.account_is_disabled(auth.uid());
$$;

create or replace function public.rls_inv_read_assigned_warehouse_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select distinct uwa.warehouse_id
  from public.user_warehouse_assignments uwa
  join public.warehouses w
    on w.id = uwa.warehouse_id
  join public.organization_members m
    on m.organization_id = w.organization_id
   and m.user_id = uwa.user_id
  where uwa.user_id = auth.uid()
    and m.accepted_at is not null
    and (m.impersonation_expires_at is null or m.impersonation_expires_at > now())
    and not public.account_is_disabled(auth.uid());
$$;

create or replace function public.rls_inv_read_warehouse_charter_ids()
returns table(warehouse_id uuid, charter_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select uwa.warehouse_id, uwa.charter_id
  from public.user_warehouse_assignments uwa
  join public.warehouses w
    on w.id = uwa.warehouse_id
  join public.organization_members m
    on m.organization_id = w.organization_id
   and m.user_id = uwa.user_id
  where uwa.user_id = auth.uid()
    and uwa.charter_id is not null
    and m.accepted_at is not null
    and (m.impersonation_expires_at is null or m.impersonation_expires_at > now())
    and not public.account_is_disabled(auth.uid());
$$;

-- ── 5) The category-visibility path (second conjunct of inventory_items_select)
create or replace function public.rls_cat_unrestricted_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.organization_id
  from public.organization_members m
  where m.user_id = auth.uid()
    and m.accepted_at is not null
    and (m.impersonation_expires_at is null or m.impersonation_expires_at > now())
    and not public.account_is_disabled(auth.uid())
    and (
      m.role in ('owner', 'admin', 'manager', 'staff')
      or (
        m.role = 'viewer'
        and not exists (
          select 1
          from public.user_category_assignments uca
          where uca.user_id = m.user_id
            and uca.organization_id = m.organization_id
        )
      )
    );
$$;

create or replace function public.rls_cat_allowed_category_ids()
returns table(organization_id uuid, category_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select uca.organization_id, uca.category_id
  from public.user_category_assignments uca
  join public.organization_members m
    on m.organization_id = uca.organization_id
   and m.user_id = uca.user_id
  where uca.user_id = auth.uid()
    and m.role = 'viewer'
    and m.accepted_at is not null
    and (m.impersonation_expires_at is null or m.impersonation_expires_at > now())
    and not public.account_is_disabled(auth.uid());
$$;

-- ── 6) The org-list helpers ─────────────────────────────────────────────────
create or replace function public.rls_member_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.organization_id
  from public.organization_members m
  where m.user_id = auth.uid()
    and m.accepted_at is not null
    and (m.impersonation_expires_at is null or m.impersonation_expires_at > now())
    and not public.account_is_disabled(auth.uid());
$$;

create or replace function public.rls_manager_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.organization_id
  from public.organization_members m
  where m.user_id = auth.uid()
    and m.accepted_at is not null
    and (m.impersonation_expires_at is null or m.impersonation_expires_at > now())
    and m.role in ('owner', 'admin', 'manager')
    and not public.account_is_disabled(auth.uid());
$$;

create or replace function public.my_warehouse_ids()
returns table(warehouse_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  with my_role as (
    select organization_id, role
    from public.organization_members
    where user_id = auth.uid()
      and accepted_at is not null
      and not public.account_is_disabled(auth.uid())
  )
  -- super_admin / manager: every warehouse in their org(s)
  select w.id
  from public.warehouses w
  join my_role mr on mr.organization_id = w.organization_id
  where mr.role in ('owner', 'admin', 'manager')
  union
  -- staff / viewer: only assigned warehouses
  select uwa.warehouse_id
  from public.user_warehouse_assignments uwa
  join my_role mr on mr.organization_id = uwa.organization_id
  where uwa.user_id = auth.uid()
    and mr.role in ('staff', 'viewer');
$$;

-- ── 7) The warehouse-access gate — GROUP B (row-correlated) ─────────────────
-- SOLE gate on all four verbs of `rentals` and `rental_lines`. Guarded on
-- p_user_id, not auth.uid(): the question this answers is about the SUBJECT
-- user, and a disabled subject has no warehouse access regardless of caller.
create or replace function public.user_can_access_warehouse(
  p_user_id uuid,
  p_warehouse_id uuid,
  p_op text default 'read'
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with wh as (
    select organization_id from public.warehouses where id = p_warehouse_id
  ),
  member as (
    select m.role
    from public.organization_members m, wh
    where m.user_id = p_user_id
      and m.organization_id = wh.organization_id
      and m.accepted_at is not null
      and not exists (
        select 1 from public.user_profiles up
        where up.id = p_user_id and up.disabled_at is not null
      )
    limit 1
  )
  select case
    -- super admin + manager: full access
    when (select role from member) in ('owner', 'admin', 'manager') then true
    -- staff/viewer: must be assigned, and viewer can only read
    when (select role from member) = 'staff' and exists (
      select 1 from public.user_warehouse_assignments
      where user_id = p_user_id and warehouse_id = p_warehouse_id
    ) then true
    when (select role from member) = 'viewer' and p_op = 'read' and exists (
      select 1 from public.user_warehouse_assignments
      where user_id = p_user_id and warehouse_id = p_warehouse_id
    ) then true
    else false
  end;
$$;

-- ── 8) The inventory-access gate — GROUP B (row-correlated) ─────────────────
-- The gate the picking RPCs actually run on. It is referenced by NO live policy
-- today (0229 replaced inventory_items_select with the hashed-set helpers), so
-- its whole remaining job is authorizing claim_picking, release_picking,
-- partial_pick_line, complete_picking, assign_picking, assign_cycle_count and
-- force_reassign_cycle_count. For the first four it is the only guarded gate
-- they reach — see the RPC note in this file's header.
--
-- Guarded on p_user_id rather than auth.uid(), exactly like
-- user_can_access_warehouse above: the question is about the SUBJECT user, and
-- a disabled subject has no inventory access no matter who is asking. That also
-- keeps assign_picking honest, which calls this helper to validate a TARGET.
--
-- Written as an inlined NOT EXISTS rather than a nested account_is_disabled()
-- call because this helper takes a row-correlated warehouse id — it is GROUP B,
-- and a nested SECURITY DEFINER call costs a separate plan per candidate row.
--
-- The guard sits in the `member` CTE, which closes BOTH branches at once: the
-- manager+ branch selects from `member` directly, and the assignment branch
-- joins it (`join member on true`), so an empty `member` makes both false.
create or replace function public.user_can_access_inventory(
  p_user_id      uuid,
  p_warehouse_id uuid,
  p_charter_id   uuid,
  p_op           text default 'read'
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with wh as (
    select organization_id from public.warehouses where id = p_warehouse_id
  ),
  member as (
    select m.role
    from public.organization_members m
    join wh on wh.organization_id = m.organization_id
    where m.user_id = p_user_id
      and m.accepted_at is not null
      and not exists (
        select 1 from public.user_profiles up
        where up.id = p_user_id and up.disabled_at is not null
      )
  )
  select
    -- Manager+ has full access
    exists (select 1 from member where role in ('owner', 'admin', 'manager'))
    or exists (
      select 1
      from public.user_warehouse_assignments uwa
      join member on true
      where uwa.user_id = p_user_id
        and uwa.warehouse_id = p_warehouse_id
        and (
              uwa.charter_id is null
           or p_charter_id is null
           or uwa.charter_id = p_charter_id
        )
        and (p_op = 'read' or member.role <> 'viewer')
    );
$$;

-- ── 9) The category-visibility gate — GROUP B (row-correlated) ──────────────
-- Reads organization_members directly and calls NO helper: the `has_org_role`
-- appearing in its body is prose in a comment, which is exactly how it was
-- missed. Its single live use, categories_select, ANDs it with the guarded
-- is_org_member, so it was never a live bypass — but that safety lives in the
-- CALLER, and the next policy to reach for this helper alone would have made
-- one. Guarding the helper itself is what closes the class rather than relying
-- on every future policy author to remember the conjunction.
--
-- The guard goes in the role lookup: with no role resolved, v_role is null and
-- the function already returns false on its own first branch.
create or replace function public.user_can_see_item_category(
  p_user_id uuid,
  p_org_id uuid,
  p_category_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  -- Resolve the user's role IN THIS SPECIFIC ORG.
  -- accepted_at IS NOT NULL excludes pending invites — same gate
  -- has_org_role uses (migration 0001).
  select role::text into v_role
  from public.organization_members
  where user_id = p_user_id
    and organization_id = p_org_id
    and accepted_at is not null
    and not exists (
      select 1 from public.user_profiles up
      where up.id = p_user_id and up.disabled_at is not null
    )
  limit 1;

  if v_role is null then
    return false;
  end if;

  if v_role in ('owner','admin','manager','staff') then
    return true;
  end if;

  -- viewer branch
  if v_role = 'viewer' then
    -- Unrestricted if zero assignments IN THIS ORG.
    if not exists (
      select 1 from public.user_category_assignments
      where user_id = p_user_id
        and organization_id = p_org_id
    ) then
      return true;
    end if;

    -- Restricted: null-category items are never visible.
    if p_category_id is null then
      return false;
    end if;

    return exists (
      select 1 from public.user_category_assignments
      where user_id = p_user_id
        and organization_id = p_org_id
        and category_id = p_category_id
    );
  end if;

  return false;
end;
$$;

-- ── 10) The self-scoped write class that reaches NO membership helper ───────
-- Guarding the fifteen helpers closes every policy that gates on membership.
-- It does NOT close the policies whose whole predicate is `<col> = auth.uid()`,
-- because those never call a helper at all. Enumerated from pg_policies, the
-- writable self-scoped set is: user_profiles_update_self, saved_views_owner_
-- insert/update/delete, notification_preferences_self, push_tokens_self,
-- notifications_update_own and user_onboarding_insert/update.
--
-- Most of them are genuinely private and are LEFT ALONE on purpose. A disabled
-- user toggling their own digest opt-in (notification_preferences), registering
-- or dropping their own device token (push_tokens), marking their own
-- notification read (notifications_update_own) or advancing their own product
-- tour (user_onboarding) changes nothing any other person can see, and all four
-- carry a WITH CHECK of `user_id = auth.uid()` so they cannot be aimed at
-- somebody else's row. Freezing them would buy no confidentiality or integrity
-- and would add four more policies to keep in sync.
--
-- user_profiles is handled in 0309 (the trigger now drops the whole update for
-- a disabled row, not just the three disable columns) — full_name and avatar_url
-- render into every colleague's UI, so that one is not self-scoped in effect.
--
-- saved_views is the other one that is not self-scoped in effect: 0037 added
-- `is_shared`, and saved_views_visible_to_org_or_owner shows an is_shared row to
-- the WHOLE org. A disabled user could plant an org-visible view — or flip an
-- existing one to shared — with a still-valid access token. The three write
-- policies are restated below (dropped and recreated in full, never
-- `alter policy ... with check`, which REPLACES rather than adds — recurring
-- bug #24) with is_org_member(organization_id) added.
--
-- is_org_member rather than account_is_disabled(auth.uid()): it is already
-- guarded above, `authenticated` holds EXECUTE on it (account_is_disabled is
-- revoked from that role just above, so a policy could not call it), and it
-- simultaneously fixes the missing org constraint — the previous WITH CHECK was
-- a bare `user_id = auth.uid()`, so an owner could file a row against ANY
-- organization_id, including one they have no membership in.
drop policy if exists "saved_views_owner_insert" on public.saved_views;
create policy "saved_views_owner_insert" on public.saved_views
  for insert
  with check (user_id = auth.uid() and public.is_org_member(organization_id));

-- 0046 added the WITH CHECK half here (an owner could otherwise reassign
-- user_id/organization_id to a victim). Both halves keep it and gain the guard.
drop policy if exists "saved_views_owner_update" on public.saved_views;
create policy "saved_views_owner_update" on public.saved_views
  for update
  using (user_id = auth.uid() and public.is_org_member(organization_id))
  with check (user_id = auth.uid() and public.is_org_member(organization_id));

drop policy if exists "saved_views_owner_delete" on public.saved_views;
create policy "saved_views_owner_delete" on public.saved_views
  for delete
  using (user_id = auth.uid() and public.is_org_member(organization_id));

-- saved_views_visible_to_org_or_owner (SELECT) is deliberately untouched: a
-- disabled user reading back their own list is harmless, and narrowing it would
-- also hide a disabled colleague's shared views from the ACTIVE members who
-- have been using them.

reset lock_timeout;
