-- 0229_inventory_select_rls_hashed_sets.sql
-- ─────────────────────────────────────────────────────────────────────
-- Kill the measured 100× RLS penalty on inventory_items SELECT
-- (24 ms as postgres vs 2,472 ms as authenticated on a 45k-item org).
--
-- WHY THE OLD POLICY WAS SLOW
-- ---------------------------
-- The live SELECT policy (0129, recreated verbatim in 0140) was:
--
--   using ( public.user_can_access_inventory(auth.uid(), warehouse_id, charter_id, 'read')
--       and public.user_can_see_item_category(auth.uid(), organization_id, category_id) )
--
-- Both functions take PER-ROW columns as arguments, so the planner
-- cannot hoist them into an InitPlan: each function body (a multi-join
-- SECURITY DEFINER query / plpgsql branch tree) re-executes for EVERY
-- candidate row. 45k rows × 2 function calls × internal lookups ≈ 2.5 s.
-- The same disease (in milder form) affected stock_movements_select:
-- `(SELECT public.is_org_member(organization_id))` is a CORRELATED
-- subplan — the (SELECT ...) wrapper only creates an InitPlan when the
-- expression references NO outer columns. With organization_id inside,
-- it still runs once per row (measured 11.9 s over 1.2 M movements).
--
-- THE FIX
-- -------
-- Restructure each policy so the USER-scoped work is computed ONCE per
-- statement and the per-row work is a hashed-subplan membership probe:
--
--   column IN (SELECT set_returning_helper())
--
-- The subquery references no outer columns, so Postgres materializes the
-- helper's result into an in-memory hash table on first evaluation and
-- every row costs one hash probe. The helpers below return exactly the
-- sets the old functions tested row-by-row, derived clause-for-clause
-- from user_can_access_inventory (0008) and user_can_see_item_category
-- (0129). The old functions are NOT dropped: user_can_see_item_category
-- still backs categories_select (0129) and both are mirrored in app code
-- (apps/web/src/lib/auth/access-predicate.ts).
--
-- SEMANTIC EQUIVALENCE (proven row-set-identical in tests/0229_*.test.sql)
-- ------------------------------------------------------------------------
-- Warehouse/charter part — user_can_access_inventory(uid, wh, ch, 'read'):
--   old: role owner/admin/manager in the WAREHOUSE's org (accepted) → true;
--        else needs an accepted membership in the warehouse's org AND a
--        user_warehouse_assignments row for (user, warehouse) where
--        (uwa.charter_id IS NULL OR item.charter_id IS NULL OR match);
--        wh NULL → the internal `wh` CTE is empty → false for EVERYONE.
--   new: warehouse_id IN full-access set  (manager+ orgs' warehouses ∪
--                                          NULL-charter assignments)
--        OR (charter_id IS NULL AND warehouse_id IN any-assignment set)
--        OR (warehouse_id, charter_id) IN charter-scoped assignment pairs.
--        wh NULL → every disjunct is NULL/false → invisible (identical).
-- Category part — user_can_see_item_category(uid, org, cat):
--   old: role in THAT org (accepted); owner/admin/manager/staff → true;
--        viewer w/ zero user_category_assignments rows in the org → true;
--        viewer w/ rows → cat NULL → false, else cat must be assigned;
--        no membership → false.
--   new: organization_id IN unrestricted-org set (owner/admin/manager/
--        staff, or viewer with zero assignments in that org)
--        OR (organization_id, category_id) IN the viewer's assigned pairs.
--        cat NULL in a restricted org → NULL/false → hidden (identical).
--
-- ONE DELIBERATE TIGHTENING (the only semantic delta, tested explicitly)
-- ----------------------------------------------------------------------
-- 0177 made is_org_member / user_org_role / has_org_role self-enforce
-- "act as" impersonation expiry ("the sweep becomes pure cleanup, not the
-- security boundary") but MISSED user_can_access_inventory and
-- user_can_see_item_category — so an EXPIRED impersonation membership
-- kept full inventory_items read access until the cron sweep deleted the
-- row (every other surface already denies it: writes go through
-- has_org_role/has_permission, categories_select through is_org_member).
-- The helper sets below carry the same
-- `impersonation_expires_at IS NULL OR > now()` guard as 0177's helpers,
-- closing that gap. Real memberships (NULL expiry) are unaffected.
-- ─────────────────────────────────────────────────────────────────────

set check_function_bodies = off;

-- ─────────────────────────────────────────────────────────────────────
-- 1) Warehouse/charter helper sets (from user_can_access_inventory 0008)
--    SECURITY DEFINER: they read organization_members,
--    user_warehouse_assignments and warehouses, which are not generally
--    readable by the calling user — same posture as the functions they
--    replace. STABLE so one statement evaluates them once.
-- ─────────────────────────────────────────────────────────────────────

-- Warehouses where the caller can read EVERY item regardless of charter:
--   • owner/admin/manager (accepted, unexpired) → all org warehouses
--   • an assignment row with charter_id IS NULL = "all charters here"
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
    and (m.impersonation_expires_at is null or m.impersonation_expires_at > now());
$$;

comment on function public.rls_inv_read_full_warehouse_ids() is
  'RLS helper (0229): warehouses where auth.uid() may read items of ANY charter — manager+ orgs'' warehouses plus NULL-charter assignments. Mirrors user_can_access_inventory(…,''read'') minus the charter-scoped branch.';

-- Warehouses where the caller has ANY assignment (charter-scoped or not).
-- Grants read of GENERIC stock (item.charter_id IS NULL) at that
-- warehouse — the `p_charter_id is null` arm of the old function.
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
    and (m.impersonation_expires_at is null or m.impersonation_expires_at > now());
$$;

comment on function public.rls_inv_read_assigned_warehouse_ids() is
  'RLS helper (0229): warehouses where auth.uid() holds any assignment (membership-verified). Generic (NULL-charter) items at these warehouses are readable.';

-- Charter-scoped assignment pairs: (warehouse, charter) combinations the
-- caller is explicitly assigned to.
create or replace function public.rls_inv_read_warehouse_charter_ids()
returns table (warehouse_id uuid, charter_id uuid)
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
    and (m.impersonation_expires_at is null or m.impersonation_expires_at > now());
$$;

comment on function public.rls_inv_read_warehouse_charter_ids() is
  'RLS helper (0229): the caller''s charter-scoped (warehouse_id, charter_id) assignment pairs (membership-verified).';

-- ─────────────────────────────────────────────────────────────────────
-- 2) Category-visibility helper sets (from user_can_see_item_category 0129)
-- ─────────────────────────────────────────────────────────────────────

-- Orgs where the category filter passes for EVERY category value
-- (including NULL): owner/admin/manager/staff, or a viewer with zero
-- user_category_assignments rows in that org (the "unrestricted viewer"
-- back-compat default from 0128).
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

comment on function public.rls_cat_unrestricted_org_ids() is
  'RLS helper (0229): orgs where auth.uid() sees every item category (owner/admin/manager/staff, or viewer with zero category assignments). Mirrors the always-true branches of user_can_see_item_category.';

-- The restricted viewer's per-org category whitelist. Restricted to
-- role = viewer exactly: for the four elevated roles the org is already
-- in the unrestricted set, and any OTHER state (pending invite, no
-- membership) must stay invisible — user_can_see_item_category returns
-- false there even when stale assignment rows exist.
create or replace function public.rls_cat_allowed_category_ids()
returns table (organization_id uuid, category_id uuid)
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
    and (m.impersonation_expires_at is null or m.impersonation_expires_at > now());
$$;

comment on function public.rls_cat_allowed_category_ids() is
  'RLS helper (0229): the restricted viewer''s (organization_id, category_id) whitelist from user_category_assignments (membership-verified).';

-- ─────────────────────────────────────────────────────────────────────
-- 3) Org-membership set (is_org_member 0177, as a set)
-- ─────────────────────────────────────────────────────────────────────

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
    and (m.impersonation_expires_at is null or m.impersonation_expires_at > now());
$$;

comment on function public.rls_member_org_ids() is
  'RLS helper (0229): every org where auth.uid() is an accepted, unexpired member — the set form of is_org_member() (0177) for hashed IN probes.';

-- ─────────────────────────────────────────────────────────────────────
-- 4) Privileges: policy expressions execute as the querying user, so
--    authenticated needs EXECUTE; nobody else does (service_role and
--    postgres bypass RLS entirely).
-- ─────────────────────────────────────────────────────────────────────

revoke all on function public.rls_inv_read_full_warehouse_ids()     from public, anon;
revoke all on function public.rls_inv_read_assigned_warehouse_ids() from public, anon;
revoke all on function public.rls_inv_read_warehouse_charter_ids()  from public, anon;
revoke all on function public.rls_cat_unrestricted_org_ids()        from public, anon;
revoke all on function public.rls_cat_allowed_category_ids()        from public, anon;
revoke all on function public.rls_member_org_ids()                  from public, anon;

grant execute on function public.rls_inv_read_full_warehouse_ids()     to authenticated;
grant execute on function public.rls_inv_read_assigned_warehouse_ids() to authenticated;
grant execute on function public.rls_inv_read_warehouse_charter_ids()  to authenticated;
grant execute on function public.rls_cat_unrestricted_org_ids()        to authenticated;
grant execute on function public.rls_cat_allowed_category_ids()        to authenticated;
grant execute on function public.rls_member_org_ids()                  to authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 5) inventory_items SELECT policy: per-row work becomes hash probes
--    against the once-evaluated sets above. Dropped + recreated inside
--    this file's single transaction — no gap.
-- ─────────────────────────────────────────────────────────────────────

drop policy if exists inventory_items_select on public.inventory_items;
create policy inventory_items_select on public.inventory_items
  for select to authenticated
  using (
    (
      warehouse_id in (select public.rls_inv_read_full_warehouse_ids())
      or (
        charter_id is null
        and warehouse_id in (select public.rls_inv_read_assigned_warehouse_ids())
      )
      or (warehouse_id, charter_id) in
           (select * from public.rls_inv_read_warehouse_charter_ids())
    )
    and (
      organization_id in (select public.rls_cat_unrestricted_org_ids())
      or (organization_id, category_id) in
           (select * from public.rls_cat_allowed_category_ids())
    )
  );

-- ─────────────────────────────────────────────────────────────────────
-- 6) stock_movements SELECT policy: same treatment. The 0140 version
--    `(SELECT is_org_member(organization_id))` was still per-row (the
--    wrapper only becomes an InitPlan when it references no outer
--    columns). Identical row set: org ∈ {accepted, unexpired member
--    orgs} ⇔ is_org_member(org).
-- ─────────────────────────────────────────────────────────────────────

drop policy if exists stock_movements_select on public.stock_movements;
create policy stock_movements_select on public.stock_movements
  for select to authenticated
  using (organization_id in (select public.rls_member_org_ids()));
