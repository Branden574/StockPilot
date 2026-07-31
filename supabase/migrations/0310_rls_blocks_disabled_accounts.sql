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
-- So all thirteen STABLE membership helpers are guarded below.
-- rls_orgs_with_permission is the fourteenth and is deliberately NOT given its
-- own check: its body already calls has_permission, so it inherits the guard,
-- and a second probe would be pure cost. Its pgTAP assertion proves the
-- inheritance rather than trusting it.
--
-- The five VOLATILE SECURITY DEFINER RPCs that are granted to `authenticated`
-- (assign_cycle_count, assign_picking, force_reassign_cycle_count,
-- set_default_bin) all route through is_org_member / has_org_role /
-- has_permission and therefore inherit this too. transfer_org_ownership does not
-- route through them, but it is granted to service_role only, so it is not
-- reachable by a disabled user's token.
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
--   down to 12.9 s on that pathological scan, and no measurable change on the
--   shapes the application actually issues (UPDATE by primary key 3.8 ms vs
--   4.0 ms; paged SELECT 124 ms vs 123 ms).
--
-- The duplication is deliberate and is fenced by tests, not by discipline: the
-- pgTAP file asserts EVERY helper in both groups individually, active and
-- disabled, so the two forms cannot drift apart without the suite going red.
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

grant execute on function public.account_is_disabled(uuid) to authenticated, anon, service_role;

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
