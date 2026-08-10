-- 0321_movement_read_scope_and_attribution.sql
-- ============================================================================
-- Security Wave C1 — three multi-tenant / integrity gaps, all in RLS policy
-- text. No table, column, function or grant is created or changed: every
-- statement below is `drop policy` + `create policy`.
--
-- WHY `drop`+`create` AND NEVER `alter policy` (recurring pattern #24)
-- -------------------------------------------------------------------
-- `alter policy ... with check (X)` REPLACES the entire clause; it does not
-- add X to it. Migrations 0203 and 0212 use `alter policy` and had to restate
-- every surviving conjunct by hand for exactly that reason. That idiom has
-- already cost this codebase a silently-dropped guard, so this file states
-- each policy WHOLE. Every conjunct in the live definition (dumped from
-- pg_policies against a freshly reset local database) is reproduced below and
-- labelled with the migration it came from, so a reviewer can diff conjunct
-- counts rather than trust prose.
--
-- WHY EVERY OUTER-TABLE COLUMN IS QUALIFIED (recurring pattern #25)
-- -----------------------------------------------------------------
-- An unqualified column inside a policy's EXISTS subquery resolves to the
-- SUBQUERY's table when a same-named column exists there, turning the guard
-- into a `col = col` tautology. That shipped a real cross-tenant write hole
-- once. Every reference to the policy's own table below is written
-- `stock_movements.<col>` / `warehouse_charters.<col>`, and every reference to
-- a subquery table is aliased.
--
-- FUNCTION PRIVILEGES THIS FILE DEPENDS ON (the 0318 outage hazard)
-- -----------------------------------------------------------------
-- RLS predicates are evaluated with the QUERYING role's privileges, so any
-- helper a policy names must stay EXECUTE-able by `authenticated` or every
-- read/write through that policy fails. This file introduces no new function
-- (so there is no new PUBLIC/anon default grant to revoke — the 0318 trap does
-- not apply) but it does newly name two existing helpers inside
-- stock_movements_select:
--
--   public.rls_orgs_with_permission(text)  authenticated=X  (granted in 0279)
--   public.my_warehouse_ids()              authenticated=X  (granted in 0007)
--
-- supabase/tests/0321_*.test.sql asserts both grants, in the same spirit as
-- 0318's Group 2 assertions: a future "revoke everything" sweep over either
-- helper would take down the movements ledger for every warehouse-scoped
-- member, and that must fail in CI, not in production.
-- ============================================================================


-- ═══════════════════════════════════════════════════════════════════════════
-- 1) HI-7 (High) — stock_movements SELECT was org-scoped only.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE HOLE
--   The live policy (0229) is, in full:
--
--     using (organization_id in (select public.rls_member_org_ids()))
--
--   That is the whole predicate. It asks one question — "are you a member of
--   this org?" — and asks nothing about WHICH warehouse the movement belongs
--   to, and nothing about any read permission. So a staff or viewer member
--   assigned to a single warehouse could read the entire organization's
--   movement ledger: every other warehouse's quantities, reasons, PO
--   references and timestamps. The actor's identity rides along, because both
--   the web ledger and the mobile screen embed
--   `actor:user_profiles!user_id (full_name, email)` on the row, so the leak
--   includes a colleague's email address per movement.
--
--   The APP layer already scopes this correctly and has for a long time:
--   MovementsService.list/count/exportRows all call getWarehouseAccess() and
--   add `.in('item.warehouse_id', access.readableIds)` for a non-manager, and
--   InventoryService.itemHistory raises ForbiddenError outright. That app-layer
--   check is the only thing that was enforcing the boundary — and PostgREST is
--   not the Next.js server. A warehouse-scoped member holding a valid access
--   token can GET /rest/v1/stock_movements?select=* directly and RLS would
--   have authorized all of it. This migration moves the boundary into the
--   database, where the token cannot route around it.
--
-- THE SHAPE OF THE FIX, AND WHY IT IS ONE POLICY AND NOT TWO
--   Two classes of reader must keep working, and they need different rules:
--
--     * the PRIVILEGED reader — `activity_logs:read`. This is a legitimate
--       cross-warehouse read: /dashboard/movements gates on
--       can(ctx,'activity_logs:read'), the mobile movements tab gates on the
--       same permission, and the Auditor preset (lib/auditor-preset.ts) exists
--       precisely so a read-only viewer can be granted org-wide visibility.
--       Narrowing this class would break the audit surface, so it is preserved
--       exactly: org-wide, no warehouse filter.
--
--     * the ORDINARY member — no such permission. Scoped to the warehouses
--       they actually hold, which is what the app already shows them.
--
--   Both fit in ONE policy as `membership AND (privileged OR warehouse-
--   scoped)`. No second SELECT policy is needed: two PERMISSIVE policies OR
--   together, which would mean the membership conjunct had to be duplicated
--   into both and could later drift between them. A single policy keeps the
--   invariant "org membership is required, always" un-duplicated.
--
-- WHY THE WAREHOUSE TEST GOES THROUGH inventory_items
--   stock_movements has NO warehouse_id column (verified against the live
--   table: organization_id, item_id, movement_type, quantities, from/to
--   location, reason, reference, user_id, notes, created_at, moved_quantity).
--   A movement's warehouse is a property of its item, and item_id is NOT NULL
--   with ON DELETE CASCADE, so every row has exactly one. Hence the EXISTS
--   against inventory_items on the item's PK.
--
--   `public.my_warehouse_ids()` is the canonical warehouse-access set and the
--   exact DB twin of getWarehouseAccess(): manager+ get every warehouse in
--   their org, staff/viewer get their user_warehouse_assignments rows. Reusing
--   it rather than re-deriving the rule keeps one source of truth. It takes no
--   argument, so the subquery is uncorrelated and Postgres hash-materializes
--   it ONCE per statement instead of per row — the posture 0229 established
--   after measuring an 11.9 s per-row policy on this table.
--
-- TWO CONSEQUENCES THAT ARE DELIBERATE, NOT ACCIDENTS
--   (a) NESTED RLS. `public.inventory_items` is a table, not a SECURITY
--       DEFINER helper, so inventory_items_select (0229) is ALSO applied
--       inside this EXISTS — verified empirically on the local image, not
--       assumed. The effective rule for an ordinary member is therefore the
--       stronger "you may read a movement when you may read its item AND its
--       warehouse is one of yours". That is a tightening BEYOND warehouse
--       scope: a viewer restricted to certain categories also stops seeing
--       other categories' movements. It is the correct invariant (the row
--       describes an item they are not allowed to look at) and it matches
--       what the app already renders, because every movement read in both
--       clients joins the item with an `!inner` embed and would drop the row
--       anyway. The explicit my_warehouse_ids() conjunct is kept even though
--       nested RLS makes it near-redundant today: it states the warehouse
--       boundary in the policy text where a reviewer can see it, and it holds
--       the line if inventory_items_select is ever loosened. There is no
--       recursion risk — inventory_items_select does not reference
--       stock_movements.
--
--   (b) A STAFF MEMBER WITH ZERO ASSIGNMENTS now reads zero movements
--       instead of the whole org's. That is not a new behaviour, it is the
--       app's behaviour finally being true at the database: MovementsService
--       returns [] for `access.readableIds.length === 0` today.
--
-- COST, AND WHERE IT LANDS
--   The privileged disjunct is a hashed org-id probe, so managers, admins,
--   owners and auditors — every reader who scans a large window (CSV export,
--   the report_* and dashboard_* SECURITY INVOKER RPCs) — pay one hash probe
--   per row and never evaluate the EXISTS at all, because OR short-circuits
--   once the left side is true. The per-row item lookup is therefore only
--   paid by warehouse-scoped members, whose surfaces are small and bounded
--   (item-detail history is 50 rows of ONE item id, so the lookup is a single
--   cached buffer). It is one PK index probe, not the multi-join
--   SECURITY DEFINER call per row that 0229 removed.
--
-- The three writes on this table are unaffected: there is no UPDATE or DELETE
-- policy (the ledger is append-only; note edits go through the SECURITY
-- DEFINER edit_movement_note RPC, which bypasses RLS), and INSERT is section 2.

drop policy if exists stock_movements_select on public.stock_movements;
create policy stock_movements_select on public.stock_movements
  for select to authenticated
  using (
    -- CONJUNCT 1 of 2 — RESTATED VERBATIM from 0229. The entire previous
    -- policy. Carries the accepted-membership, unexpired-impersonation (0177)
    -- and not-disabled (0310) guards, so nothing below has to repeat them:
    -- an expired "act as" grant or a disabled account fails here first.
    stock_movements.organization_id in (select public.rls_member_org_ids())

    -- CONJUNCT 2 of 2 — NEW (HI-7). Privileged cross-warehouse read, OR the
    -- caller's own warehouses.
    and (
      -- (a) The audit surface. rls_orgs_with_permission (0279) resolves the
      --     CONFIGURABLE permission — owner short-circuit, user override,
      --     role override, role default — so this is exactly the set of orgs
      --     where can(ctx,'activity_logs:read') is true for this caller,
      --     which is exactly what /dashboard/movements and the mobile
      --     movements tab gate on. Manager and admin hold it by default
      --     (0207), so they are unaffected by this migration.
      stock_movements.organization_id in
        (select public.rls_orgs_with_permission('activity_logs:read'))

      -- (b) Warehouse scope for everyone else. `i.id` and
      --     `stock_movements.item_id` are both qualified (pattern #25): an
      --     unqualified `item_id` here would resolve to nothing at all and an
      --     unqualified `warehouse_id` would silently read the subquery's own
      --     column on both sides of a comparison.
      or exists (
        select 1
        from public.inventory_items i
        where i.id = stock_movements.item_id
          and i.warehouse_id in
                (select mw.warehouse_id from public.my_warehouse_ids() mw)
      )
    )
  );

comment on table public.stock_movements is
  'Append-only stock ledger. SELECT (0321) requires org membership AND either activity_logs:read (org-wide, the audit surface) or the movement''s item living in one of the caller''s warehouses. INSERT (0321) additionally pins user_id to auth.uid(). No UPDATE/DELETE policy exists by design; notes are edited through the SECURITY DEFINER edit_movement_note RPC.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2) MED-10 — stock_movements_insert did not pin user_id.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE HOLE
--   The live WITH CHECK (0212) gates the ROLE and the two location FKs but
--   never looks at user_id, so any member who may write a movement at all
--   could attribute it to a colleague — `user_id: <someone else>` on a
--   POST to /rest/v1/stock_movements. The ledger is append-only and has no
--   UPDATE policy precisely so it can be trusted as an audit trail; an
--   unpinned actor column quietly removes that property. It is also the column
--   both clients render as "who did this" (the actor embed), so a forged row
--   accuses a real named colleague.
--
-- THE FIX AND WHY IT CANNOT CAUSE AN OUTAGE
--   `user_id is null or user_id = auth.uid()`. NULL is admitted because it is
--   legitimate and common: ~61% of production rows have no actor (system and
--   trigger-written history), the column is nullable with ON DELETE SET NULL,
--   and forbidding NULL would break every writer that omits it.
--
--   Every writer that DOES set it was checked, and all of them already write
--   the caller:
--     * App code on the user client (RLS applies) — InventoryService.create /
--       bulkCreate / bulkCreateSized and BooksImportService all write
--       `user_id: this.ctx.userId`, which is the session user, i.e. auth.uid().
--     * SECURITY INVOKER RPCs (RLS applies — these are the ones that would
--       have broken if the value were anything else): adjust_stock,
--       transfer_stock, post_cycle_count, assemble_bundle, distribute_bundle,
--       duplicate_inventory_item. Each was read out of pg_proc: all six write
--       `auth.uid()`, either directly or via a `v_user uuid := auth.uid()`
--       declaration. post_receipt_v2 and reverse_receipt are also SECURITY
--       INVOKER but insert nothing themselves — they route through
--       adjust_stock.
--     * SECURITY DEFINER RPCs (process_return_disposition,
--       refresh_org_daily_stats) and every createAdminClient() path run as
--       service_role/owner and bypass RLS entirely, so they are free to
--       attribute a row to whoever actually acted. This policy does not
--       constrain them, by design.
--   There is no live writer this rejects.
--
-- All three original conjuncts are restated below. Conjunct count: 3 -> 4.

drop policy if exists stock_movements_insert on public.stock_movements;
create policy stock_movements_insert on public.stock_movements
  for insert to authenticated
  with check (
    -- CONJUNCT 1 of 4 — RESTATED VERBATIM from 0212 (role floor / grantable
    -- permission). The `(select ...)` wrappers are 0212's, kept as-is: they
    -- make each call an InitPlan instead of a per-row invocation.
    (
      ( select public.has_org_role(stock_movements.organization_id, 'staff') )
      or ( select public.has_permission(stock_movements.organization_id, 'stock:adjust') )
    )

    -- CONJUNCT 2 of 4 — RESTATED VERBATIM from 0212 (FK-org consistency,
    -- from-side; part of the 0201-0206 write-RLS class).
    and ( select public.location_in_org(stock_movements.from_location_id, stock_movements.organization_id) )

    -- CONJUNCT 3 of 4 — RESTATED VERBATIM from 0212 (FK-org consistency,
    -- to-side).
    and ( select public.location_in_org(stock_movements.to_location_id, stock_movements.organization_id) )

    -- CONJUNCT 4 of 4 — NEW (MED-10). Attribution pin. auth.uid() is wrapped
    -- in a scalar subquery for the same InitPlan reason as the conjuncts
    -- above.
    and (
      stock_movements.user_id is null
      or stock_movements.user_id = ( select auth.uid() )
    )
  );


-- ═══════════════════════════════════════════════════════════════════════════
-- 3) MED-12 — warehouse_charters.organization_id was unconstrained on write.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE HOLE
--   wc_admin_write (0203) is FOR ALL and derives authority from the CHARTER's
--   organization: you may write the row if you are an admin of the org that
--   owns `charter_id`, and 0203 added a guard that `warehouse_id` belongs to
--   that same org. Nothing checks the row's OWN `organization_id` column,
--   which is NOT NULL and is the column the sibling read policy uses:
--
--     wc_select ... using (exists (select 1 from organization_members m
--       where m.user_id = auth.uid()
--         and m.organization_id = warehouse_charters.organization_id ...))
--
--   So an admin of org B could insert (organization_id = A, warehouse_id =
--   B's warehouse, charter_id = B's charter) and pass every existing conjunct.
--   The row then satisfies wc_select for org A's members, planting a
--   foreign warehouse/charter pair inside org A's tenant boundary. That pair
--   is not inert: warehouse_charters is the FK target of
--   inventory_items(warehouse_id, charter_id) and
--   user_warehouse_assignments(warehouse_id, charter_id), and app code reads
--   the table by organization_id to build charter pickers.
--
-- THE FIX
--   Require the row's organization_id to BE the charter's organization. Both
--   sides are explicitly qualified — `warehouse_charters.organization_id`
--   against `c.organization_id` — which is what keeps this from degenerating
--   into pattern #25's `organization_id = organization_id`.
--
--   Written as a THIRD top-level conjunct rather than folded into the existing
--   EXISTS, so the two 0203 conjuncts stay textually identical to the live
--   definition and the added guard is impossible to miss in review.
--
-- WITH CHECK ONLY — USING IS RESTATED UNCHANGED, ON PURPOSE
--   USING decides which EXISTING rows an admin may UPDATE or DELETE (and,
--   because the policy is FOR ALL, contributes a permissive SELECT branch).
--   WITH CHECK decides what a row may BECOME, which is the entire attack:
--   both the INSERT of a mis-stamped row and an UPDATE that re-stamps one are
--   refused by WITH CHECK. Adding the conjunct to USING as well would strand
--   any already-inconsistent row — no admin of either org could then delete
--   it, since the charter's org admin would fail the new USING test and the
--   stamped org's admin already fails the charter test. Cleanup must stay
--   possible, so USING is left exactly as 0203 wrote it. Operators can find
--   pre-existing damage with:
--     select wc.* from public.warehouse_charters wc
--       join public.charters c on c.id = wc.charter_id
--      where wc.organization_id <> c.organization_id;
--
-- Conjunct count: USING 1 -> 1 (verbatim), WITH CHECK 2 -> 3.

drop policy if exists wc_admin_write on public.warehouse_charters;
create policy wc_admin_write on public.warehouse_charters
  for all to authenticated
  using (
    -- RESTATED VERBATIM from the live definition (0093 base, unchanged by
    -- 0203, which only touched WITH CHECK).
    exists (
      select 1
      from public.charters c
      where c.id = warehouse_charters.charter_id
        and ( select public.has_org_role(c.organization_id, 'admin') )
    )
  )
  with check (
    -- CONJUNCT 1 of 3 — RESTATED VERBATIM (admin of the charter's org).
    exists (
      select 1
      from public.charters c
      where c.id = warehouse_charters.charter_id
        and ( select public.has_org_role(c.organization_id, 'admin') )
    )

    -- CONJUNCT 2 of 3 — RESTATED VERBATIM from 0203 (the warehouse FK must
    -- belong to the charter's org).
    and ( select public.warehouse_in_org(
            warehouse_charters.warehouse_id,
            (select c.organization_id from public.charters c where c.id = warehouse_charters.charter_id)
          ) )

    -- CONJUNCT 3 of 3 — NEW (MED-12). The row's own tenant stamp must agree
    -- with the charter it describes. NULL-safe by construction: charter_id is
    -- NOT NULL and FK-enforced, so the scalar subquery always finds a row when
    -- conjunct 1 passed.
    and warehouse_charters.organization_id = (
      select c.organization_id
      from public.charters c
      where c.id = warehouse_charters.charter_id
    )
  );
