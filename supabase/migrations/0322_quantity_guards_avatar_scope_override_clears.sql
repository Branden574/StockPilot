-- 0322_quantity_guards_avatar_scope_override_clears.sql
-- ============================================================================
-- Security Wave C2 — four findings (MED-11, MED-13, MED-14, MED-16) plus one
-- opportunistic grant-hygiene close. Three CHECK constraints, five policy
-- rewrites, one revoke. No function body is changed.
--
-- WHY `drop policy` + `create policy` AND NEVER `alter policy` (pattern #24)
-- -------------------------------------------------------------------------
-- `alter policy ... using (X)` REPLACES the entire clause; it does not add X
-- to it. That idiom has already silently dropped a guard in this codebase, so
-- every policy below is stated WHOLE. Each surviving conjunct is reproduced
-- from the live definition (dumped from pg_policies against a freshly
-- `supabase db reset` local database) and labelled with the migration it came
-- from, so a reviewer can diff conjunct COUNTS rather than trust prose.
--
-- WHY EVERY OUTER-TABLE COLUMN IS QUALIFIED (pattern #25)
-- ------------------------------------------------------
-- An unqualified column inside a policy's EXISTS subquery resolves to the
-- SUBQUERY's table when a same-named column exists there, turning the guard
-- into a `col = col` tautology. That shipped a real cross-tenant write hole
-- once. Every reference to a policy's own table below is written
-- `<table>.<col>`, and every subquery table is aliased.
--
-- FUNCTION PRIVILEGES THIS FILE DEPENDS ON (the 0318 outage hazard)
-- ----------------------------------------------------------------
-- RLS predicates are evaluated with the QUERYING role's privileges, so any
-- helper a policy names must stay EXECUTE-able by `authenticated` or every
-- read/write through that policy fails closed. This file creates NO function,
-- so there is no new PUBLIC/anon default grant to revoke (the 0318 trap does
-- not apply to sections 1-4). Section 5 revokes PUBLIC/anon from an EXISTING
-- helper and deliberately KEEPS authenticated, because 0321's
-- stock_movements_select calls it. supabase/tests/0322_*.test.sql asserts both
-- directions of that grant: a future "revoke everything" sweep must fail in
-- CI, not in production.
--
-- The helpers named by policies below, and where their authenticated grant
-- comes from:
--   public.has_org_role(uuid, text)              0003 / 0310
--   public.has_permission(uuid, text)            0207 / 0310
--   public.location_in_org(uuid, uuid)           0202
--   public.is_org_member(uuid)                   0003 / 0310
--   public.rls_member_org_ids()                  0229
--   public.rls_orgs_with_permission(text)        0279
--   public.my_warehouse_ids()                    0007 (section 5 preserves it)
-- ============================================================================


-- ═══════════════════════════════════════════════════════════════════════════
-- 1) MED-11 — quantity columns had no non-negative constraint and are
--    staff-writable straight through PostgREST.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE HOLE
--   `authenticated` holds INSERT/UPDATE on public.inventory_items and
--   public.item_stock_levels, and the write policies gate only the ROLE
--   (has_org_role 'staff') and FK-org consistency — never the VALUE. So any
--   staff member can
--     PATCH /rest/v1/inventory_items?id=eq.<id>  {"quantity_on_hand": -5000}
--   and the database accepts it. Negative on-hand poisons every downstream
--   read: valuation (unit_cost * quantity_on_hand), the low-stock index, the
--   reorder cron, Σ-levels reconciliation in post_cycle_count, and CSV/PDF
--   exports. numeric(14,4) has no natural floor, so nothing stopped it.
--
-- WHICH COLUMNS ARE CONSTRAINED, AND WHY NOT ALL OF THEM
--   The two columns the finding names are inventory_items.quantity_on_hand
--   (0002:95) and item_stock_levels.quantity (0002:149). They are NOT
--   equally safe to constrain, and the difference was established by RUNNING
--   the RPCs against a local database with a trial constraint in place, not by
--   reading them:
--
--   * inventory_items.quantity_on_hand — SAFE, constrained below.
--     All five writers were audited and none can produce a negative value:
--       - adjust_stock            computes v_new and RAISES 'insufficient_stock'
--                                 (P0001) BEFORE the UPDATE, so its own guard
--                                 still fires first. Verified: with the
--                                 constraint installed, an over-draw still
--                                 fails with `insufficient_stock`, NOT with a
--                                 check violation, and a legitimate decrement
--                                 to exactly 0 still succeeds.
--       - assemble_bundle         `if quantity_on_hand < v_needed then raise
--                                 insufficient_stock`.
--       - distribute_bundle       clamps: `v_have := greatest(0,
--                                 quantity_on_hand)`, `v_draw := least(
--                                 v_needed, v_have)`, `v_new := v_prev -
--                                 v_draw`, so v_new >= 0 even with
--                                 p_allow_shortage. The phantom branch clamps
--                                 identically.
--       - post_cycle_count        writes `expected_quantity + v_diff`, which
--                                 reduces to counted_quantity. cycle_count_lines
--                                 has NO check constraint on counted_quantity,
--                                 so a staff PATCH of counted_quantity = -5
--                                 followed by a post is a SECOND route to
--                                 negative on-hand. This constraint closes that
--                                 route too, and refuses nothing legitimate — a
--                                 real physical count is never negative.
--       - process_return_disposition  `if v_new < 0 then raise
--                                 insufficient_stock`.
--     Zero is legitimate and common (sold out) and `>= 0` admits it.
--
--   * item_stock_levels.quantity — DELIBERATELY NOT CONSTRAINED. A CHECK here
--     would break TWO live paths, both reproduced locally:
--       (a) transfer_stock writes the negative FIRST and inspects it second:
--             update item_stock_levels set quantity = quantity - p_quantity
--               ... returning quantity into v_from_qty;
--             if v_from_qty < 0 then raise exception 'insufficient_stock';
--           Its own comment says "create the row at 0 first so the guard can
--           fire". A row constraint is evaluated at the UPDATE, i.e. BEFORE the
--           PL/pgSQL `if`, so an over-draw stops reporting `insufficient_stock`
--           (P0001) and starts reporting a check violation (23514). Both abort,
--           but the app's error mapping and the operator-facing message change.
--       (b) adjust_stock with an EXPLICIT p_location_id and a negative
--           p_quantity_change does
--             insert ... values (..., p_quantity_change)
--             on conflict (item_id, location_id) do update
--               set quantity = item_stock_levels.quantity + excluded.quantity
--           with NO per-location guard of any kind. Verified locally: drawing
--           -8 against a location holding 0 SUCCEEDS TODAY and commits
--           `quantity = -8.0000` (on-hand stays >= 0, so adjust_stock's only
--           guard does not fire). A CHECK turns that currently-succeeding call
--           into a hard failure. That is an outage, not a fix.
--     Per the "do not constrain a column whose legitimate flow can transiently
--     go negative" rule, this column is left alone and carried as an explicit
--     follow-up. Closing it properly means fixing the two RPCs first —
--     transfer_stock must test the source level BEFORE writing, and adjust_stock
--     must guard its explicit-location branch the way apply_level_delta already
--     guards the auto-allocated one (`insufficient_placed_stock`). Only then can
--     a constraint be added without changing behaviour. Tightening the WRITE
--     POLICY instead is not an alternative: adjust_stock, transfer_stock and
--     apply_level_delta are all SECURITY INVOKER (verified via pg_proc.prosecdef
--     = false), so RLS applies to THEIR writes too and a `quantity >= 0` WITH
--     CHECK would break them in exactly the same way as the constraint.
--
--   reorder_point and reorder_quantity (0002:96-97) are the remaining quantity
--   columns on inventory_items and are the safe rest of the set: no RPC does
--   arithmetic on either, they are plain user-entered settings, and the app
--   already validates them non-negative (z.number().nonnegative() in
--   actions/sage50-import.ts, clampNonNegative in lib/sage50.ts). A negative
--   reorder_point silently disables low-stock alerting for that item, which is
--   the same class of corruption reached the same way, so they are included.
--
-- WHY `not valid`, WHICH IS THE IMPORTANT PART OF THIS SECTION
--   The mandatory pre-check was run against a freshly reset LOCAL database and
--   returned 0 violations on every column — but it also returned
--   `count(*) = 0` for inventory_items and item_stock_levels THEMSELVES. The
--   local seed contains no inventory at all, so "zero violations locally" is
--   vacuous and proves nothing whatsoever about production, which holds real
--   stock (L4L alone has hundreds of items). Two mechanisms above could have
--   written a negative value to production over the life of this schema: a
--   direct PostgREST PATCH (the finding), and a posted cycle count with a
--   negative counted_quantity.
--
--   A VALIDATING constraint would therefore be a coin-flip on deploy: if even
--   one legacy row is negative, `alter table ... add constraint` takes an
--   ACCESS EXCLUSIVE lock, scans the table, fails, and the whole migration
--   aborts — which in this repo means pending migrations and crashed pages.
--   `not valid` enforces the invariant on every NEW insert and update (the
--   entire attack surface) while leaving pre-existing rows unscanned, so the
--   deploy cannot fail on legacy data. Validating later is a separate,
--   deliberate step the owner takes AFTER checking production with the
--   detection queries below:
--
--     select id, organization_id, sku, quantity_on_hand
--       from public.inventory_items where quantity_on_hand < 0;
--     select id, organization_id, sku, reorder_point, reorder_quantity
--       from public.inventory_items
--      where reorder_point < 0 or reorder_quantity < 0;
--     -- and, for the deferred column:
--     select s.id, s.organization_id, s.item_id, s.location_id, s.quantity
--       from public.item_stock_levels s where s.quantity < 0;
--
--   If those return no rows, promote each constraint with:
--     alter table public.inventory_items
--       validate constraint inventory_items_quantity_on_hand_nonneg;
--   `validate constraint` takes only a SHARE UPDATE EXCLUSIVE lock, so it does
--   not block reads or writes.

alter table public.inventory_items
  add constraint inventory_items_quantity_on_hand_nonneg
  check (quantity_on_hand >= 0) not valid;

alter table public.inventory_items
  add constraint inventory_items_reorder_point_nonneg
  check (reorder_point >= 0) not valid;

alter table public.inventory_items
  add constraint inventory_items_reorder_quantity_nonneg
  check (reorder_quantity >= 0) not valid;

comment on constraint inventory_items_quantity_on_hand_nonneg on public.inventory_items is
  'MED-11 (0322). Blocks a direct PostgREST PATCH of a negative on-hand, and a posted cycle count carrying a negative counted_quantity. NOT VALID on purpose: legacy production rows are unscanned so the deploy cannot fail: promote with `validate constraint` after checking `where quantity_on_hand < 0`. Every RPC writer guards this value itself, so no legitimate flow is refused. item_stock_levels.quantity is deliberately NOT constrained: transfer_stock and adjust_stock both write a negative there transiently or persistently. See the 0322 header.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2) MED-13 — `user-avatars` SELECT policy is unscoped, so one .list() call
--    enumerates every avatar path on the platform.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE HOLE, REPRODUCED
--   The live policy (0105) is, in full:
--     to authenticated using (bucket_id = 'user-avatars')
--   Bucket membership is the WHOLE predicate. Avatar object names are
--   `{user_id}/{uuid}.{ext}` (avatar-uploader.tsx:65), so the object list IS a
--   directory of platform user ids. Confirmed end-to-end against the local
--   stack with a minted `authenticated` JWT for a user in one org:
--     POST /storage/v1/object/list/user-avatars  {"prefix":"","limit":100}
--       -> 200, returned BOTH planted user folders, across orgs
--     POST /storage/v1/object/list/user-avatars  {"prefix":"<other user id>"}
--       -> 200, returned that user's exact filename
--   Filename in hand, the object is then fetchable by anyone, because the
--   bucket is public. So the leak is: enumerate every user id that has ever
--   uploaded an avatar, tenant boundaries ignored, plus their photos.
--
-- WHY THE BUCKET STAYS PUBLIC (`public = true` is NOT changed here)
--   Because every consumer in both apps reads avatars from an UNAUTHENTICATED
--   public URL, and there is no signed-URL plumbing anywhere to fall back on:
--     * the stored value is a full public URL, not a path — user_profiles
--       .avatar_url holds `${SUPABASE_URL}/storage/v1/object/public/
--       user-avatars/${userId}/...` (actions/profile.ts:107, :193)
--     * web renders it through Radix `AvatarImage`, i.e. a plain <img src>
--       (components/ui/avatar.tsx), in the topbar, team manager, audit log,
--       warehouse detail and procedure comments; the uploader uses next/image,
--       so the Vercel image optimizer fetches it server-side with no Supabase
--       credentials
--     * mobile renders it through React Native <Image source={{uri}}> in five
--       screens, and use-profile.ts:36 states the contract out loud: "no
--       signing needed"
--     * `createSignedUrl` appears nowhere in the repo for this bucket
--   Flipping the bucket private would blank every avatar in both apps until all
--   of that is rewritten, and would strand the URLs already persisted in
--   user_profiles.avatar_url. That is a migration of its own, not a security
--   fix, so the bucket stays public and the POLICY is what gets scoped.
--
-- WHY SCOPING THE POLICY IS BOTH SUFFICIENT AND SAFE
--   These are different code paths in Supabase Storage, and only one of them
--   consults storage.objects RLS:
--     * GET /object/public/{bucket}/{path} — serves from a public bucket
--       WITHOUT evaluating the SELECT policy. Verified locally: with the 0105
--       policy in place (which grants SELECT to `authenticated` only, and there
--       is no anon SELECT policy at all), an unauthenticated GET with no
--       Authorization header whatsoever returned 200. This is also proved by
--       production itself — if that route evaluated RLS, every avatar in both
--       apps would already be broken today, since browsers and RN send no
--       Supabase credentials.
--     * POST /object/list/{bucket} and the authenticated/signed routes DO
--       evaluate it. That is the enumeration vector above, and the only thing
--       this section changes.
--   So narrowing SELECT cannot blank an avatar: no render path reads it. And
--   nothing legitimate is lost, because the repo contains NO storage `.list()`
--   call for any bucket (searched for `storage...list(` across apps/) and no
--   flow that reads another user's avatar object through an RLS-checked route.
--   The one authenticated object operation the app does perform is
--   `.remove([key])` on the user's OWN key (actions/profile.ts:137), guarded by
--   avatarStorageKey() which refuses any prefix other than the caller's own id
--   — so it satisfies the new predicate by construction.
--
-- THE PREDICATE, AND WHY IT IS THIS ONE
--   `(storage.foldername(name))[1]::uuid = auth.uid()` is not invented here: it
--   is character-for-character the predicate the three WRITE policies on this
--   bucket already use (0026, re-created with a disabled guard in 0312). Using
--   the same rule for reads gives the bucket ONE ownership law instead of
--   three-plus-an-exception, which is what let this drift in the first place.
--   Paths are user-scoped, not org-scoped, so the owning USER is the correct
--   boundary and it is strictly tighter than "same org".
--
--   auth.uid() is wrapped in a scalar subquery to make it an InitPlan rather
--   than a per-row call, matching 0312's shape on the sibling policies.
--
--   The `disabled_at` guard that 0312 added to the WRITE policies is
--   deliberately NOT added here: a disabled account cannot hold a session at
--   all (0310), object DOWNLOADS bypass this policy anyway per the above, and
--   adding it would widen this migration's diff into 0312's subject. Its
--   absence is now asserted as intentional in the 0312 test rather than as
--   "untouched".
--
-- Conjunct count: 1 -> 2. Role list unchanged ({authenticated}); this section
-- does not widen who may attempt a read, only what they may see.

drop policy if exists "user-avatars authenticated read" on storage.objects;
create policy "user-avatars authenticated read" on storage.objects
  for select to authenticated
  using (
    -- CONJUNCT 1 of 2 — RESTATED VERBATIM from 0105. The entire previous
    -- policy.
    bucket_id = 'user-avatars'

    -- CONJUNCT 2 of 2 — NEW (MED-13). Folder ownership, identical to the
    -- predicate in "user-avatars own write/update/delete". `name` is
    -- storage.objects' own column and is unambiguous here (there is no
    -- subquery for it to be captured by), but it is the object name, not the
    -- bucket, so the [1] element is the owning user id.
    and (storage.foldername(name))[1]::uuid = ( select auth.uid() )
  );


-- ═══════════════════════════════════════════════════════════════════════════
-- 3) MED-14 — clearing a permission override skipped anti-escalation.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE HOLE
--   0215 encoded "you may only GRANT a permission you hold yourself" into the
--   INSERT and UPDATE policies of both override tables, as:
--       granted = false or has_permission(organization_id, permission)
--   i.e. writing a RESTRICTION is always allowed, writing a GRANT requires the
--   writer to hold it. It never touched DELETE, which stayed at 0207's
--   role-only rule:
--       using ( has_org_role(organization_id, 'admin') )
--
--   But DELETE is the mirror image of INSERT, and the exemption inverts with
--   it. Deleting a `granted = true` row REMOVES a grant — a de-escalation,
--   always safe. Deleting a `granted = false` row REMOVES A RESTRICTION, and
--   the subject reverts to their role default — an ESCALATION, achieved with
--       DELETE /rest/v1/user_permission_overrides?user_id=eq.<self>
--              &permission=eq.billing:manage
--   So the exact restriction an owner applies to hold an admin back is the one
--   that admin can delete off themselves. The same DELETE also reaches the
--   role table, letting an admin lift a restriction from their whole role at
--   once. The app half of the same hole (assertCanGrant only inspected
--   `granted === true`, so the `granted === null` clear branch was ungated) is
--   fixed in apps/web/src/server/actions/permissions.ts in this change.
--
-- THE FIX — THE SAME RULE 0215 WROTE, WITH THE POLARITY DELETE NEEDS
--   `granted = true or has_permission(org, permission)`. This is not a second
--   anti-escalation rule; it is 0215's rule read from the delete side. Both
--   tables declare `granted boolean not null`, so `granted = true` is a total
--   test with no NULL third case to leak through.
--
--   has_permission(org, perm) resolves for the WRITER (it reads auth.uid()
--   internally) and short-circuits to TRUE for role = 'owner' (0207, preserved
--   by 0310). That is what keeps the owner-lockout escape hatch open: an owner
--   can always delete any override, including a restriction they themselves
--   applied, so a bad state is always fixable from the top. An admin can still
--   delete any restriction covering a permission they legitimately hold — the
--   only thing they lose is the ability to lift a restriction on a permission
--   they do not have, which is precisely the finding.
--
--   No recursion risk: has_permission is SECURITY DEFINER and therefore reads
--   both override tables with RLS bypassed, which is why 0215 can already call
--   it from these same tables' INSERT/UPDATE policies.
--
-- BLAST RADIUS — NONE IN THE APP
--   The only DELETE against either table anywhere in apps/ is the
--   `granted === null` branch of actions/permissions.ts (lines 96-101 and
--   220-225). Nothing calls those actions with null: the permission matrix UI
--   deliberately always persists an explicit true/false and says so in
--   comments ("ALWAYS persist the explicit choice — never clear the row",
--   role-permission-matrix.tsx), because Realtime does not deliver DELETE
--   events reliably. So this policy change is invisible to every existing
--   surface and only refuses the crafted request.
--
-- Conjunct count, both policies: 1 -> 2.

drop policy if exists role_permission_overrides_delete on public.role_permission_overrides;
create policy role_permission_overrides_delete on public.role_permission_overrides
  for delete to authenticated
  using (
    -- CONJUNCT 1 of 2 — RESTATED VERBATIM from 0207 (admin floor).
    ( select public.has_org_role(role_permission_overrides.organization_id, 'admin') )

    -- CONJUNCT 2 of 2 — NEW (MED-14). Removing a GRANT is always allowed;
    -- removing a RESTRICTION requires holding the permission yourself.
    and (
      role_permission_overrides.granted = true
      or ( select public.has_permission(
             role_permission_overrides.organization_id,
             role_permission_overrides.permission) )
    )
  );

drop policy if exists user_permission_overrides_delete on public.user_permission_overrides;
create policy user_permission_overrides_delete on public.user_permission_overrides
  for delete to authenticated
  using (
    -- CONJUNCT 1 of 2 — RESTATED VERBATIM from 0207 (admin floor).
    ( select public.has_org_role(user_permission_overrides.organization_id, 'admin') )

    -- CONJUNCT 2 of 2 — NEW (MED-14). Mirror of 0215's INSERT/UPDATE rule.
    and (
      user_permission_overrides.granted = true
      or ( select public.has_permission(
             user_permission_overrides.organization_id,
             user_permission_overrides.permission) )
    )
  );


-- ═══════════════════════════════════════════════════════════════════════════
-- 4) MED-16 — warehouse scope and read permission were enforced only in the
--    app, not in RLS. purchase_orders is closed here; item_stock_levels is
--    deliberately NOT, for the reason recorded below.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE HOLE (purchase_orders)
--   The live SELECT policy (0140) is, in full:
--     using ((select public.is_org_member(organization_id)))
--   Org membership is the whole predicate. Meanwhile the app enforces two
--   further rules that the database knows nothing about:
--     * PERMISSION. purchase_orders:read gates the entire
--       /dashboard/purchase-orders tree (layout.tsx:26), PurchaseOrdersService
--       .get (:422), the CSV/PDF/attachment-zip routes and the public API key
--       scope.
--     * WAREHOUSE. PurchaseOrdersService.list/overdueCount/warehouseScope all
--       call getWarehouseAccess() and narrow through the destination-location
--       embed, `.in('destination.warehouse_id', access.readableIds)`, returning
--       [] outright for a member with no assignments.
--   Neither survives a raw token. `GET /rest/v1/purchase_orders?select=*`
--   returns every PO in the org — supplier, totals, notes, dates — to any
--   member, including one whose purchase_orders:read was explicitly revoked and
--   one assigned to a single warehouse. The mobile client demonstrates the gap
--   from the inside: src/screens/purchase-orders.tsx:66 and
--   app/(drawer)/(tabs)/receive.tsx:59 both read this table with NO warehouse
--   filter at all, so today a warehouse-scoped user already sees org-wide POs
--   there while the web hides them. This migration makes the database the
--   authority, which closes the token path and makes the two clients agree.
--
-- WHY THE WAREHOUSE TEST GOES THROUGH destination_location_id
--   purchase_orders has NO warehouse_id column — verified against the live
--   table (19 columns; no migration ever adds one). A PO's warehouse is a
--   property of its destination location, so the test is an EXISTS against
--   locations on that FK. This is the same shape the purchase_orders_stats and
--   purchase_orders_page RPCs already use (0227:152-160, :280-288), so the
--   policy and those RPCs now state one rule.
--
--   Two app-code sites select or filter a nonexistent purchase_orders
--   .warehouse_id (api/search/route.ts:57,63 and services/movements.ts:1034).
--   Those are pre-existing latent bugs — PostgREST 400s that are swallowed —
--   NOT a model for this policy, and they are listed as follow-ups. They are
--   unaffected by this change because they are already broken.
--
-- THE NULL CASE, WHICH IS THE OUTAGE THIS POLICY HAD TO AVOID
--   destination_location_id is NULLABLE and is `on delete set null`, and a PO
--   can legitimately be created with no destination at all (the create schema
--   has `destinationLocationId: z.string().uuid().nullable().optional()`).
--   locations.warehouse_id is nullable too — an org-level Site has none, and
--   `locations.kind IS NULL` + site-ish type IS the Site encoding in this
--   schema, never to be backfilled. So a large number of real POs have NO
--   derivable warehouse: the known production example is L4L's DC4, the
--   destination on ~35 POs.
--
--   A bare `exists (... l.warehouse_id in (select my_warehouse_ids()))` would
--   evaluate to FALSE for every one of those rows and hide them from EVERYONE,
--   managers and owners included — a production outage on the customer's PO
--   list. Both null cases are therefore explicit disjuncts that keep the row
--   visible to org members holding the read permission, which is exactly the
--   behaviour those rows have today for an all-access caller. This is the
--   deliberate loose end of the fix: a PO with no destination is not
--   warehouse-scopable, so it cannot be warehouse-scoped. It is not
--   attacker-controlled — it is a property of the PO, not of the request.
--
-- WHY REQUIRING purchase_orders:read CANNOT LOCK ANYONE OUT
--   Every role holds it by default: admin, manager, staff and viewer all have
--   a role_default_permissions row (owner short-circuits to true inside
--   has_permission). So the conjunct is satisfied for every member of every org
--   unless an admin has deliberately revoked it — and in that case the app
--   already refuses the page, so the database agreeing is the whole point.
--   rls_orgs_with_permission (0279) resolves the CONFIGURABLE permission
--   through the full chain (owner short-circuit, user override, role override,
--   role default), so this is precisely the set of orgs where
--   can(ctx,'purchase_orders:read') is true.
--
-- COST
--   The privileged disjunct is checked first and OR short-circuits, so
--   managers, admins and owners never evaluate the EXISTS. Warehouse-scoped
--   members pay one PK-index probe on locations per row. my_warehouse_ids()
--   takes no argument, so the subquery is uncorrelated and hash-materialized
--   ONCE per statement rather than per row — the posture 0229 established on
--   this hot path.
--
-- Conjunct count: 1 -> 3. The WRITE policy is NOT touched (it already carries
-- the manager/permission floor plus the 0203-0208 FK-org checks).

drop policy if exists purchase_orders_select on public.purchase_orders;
create policy purchase_orders_select on public.purchase_orders
  for select to authenticated
  using (
    -- CONJUNCT 1 of 3 — RESTATED VERBATIM from 0140. The entire previous
    -- policy. Carries the accepted-membership, unexpired-impersonation (0177)
    -- and not-disabled (0310) guards, so nothing below repeats them.
    ( select public.is_org_member(purchase_orders.organization_id) )

    -- CONJUNCT 2 of 3 — NEW (MED-16). The read permission the app already
    -- requires on every PO surface.
    and purchase_orders.organization_id in
          (select public.rls_orgs_with_permission('purchase_orders:read'))

    -- CONJUNCT 3 of 3 — NEW (MED-16). Warehouse scope for warehouse-scoped
    -- members only.
    and (
      -- (a) All-access roles. has_org_role is a rank FLOOR, so this is
      --     owner + admin + manager — exactly getWarehouseAccess()'s
      --     hasAllAccess set (isManagerOrAbove). Unnarrowed, as today.
      ( select public.has_org_role(purchase_orders.organization_id, 'manager') )

      -- (b) No destination at all: nothing to scope by. Stays visible, as it
      --     is today for every all-access caller.
      or purchase_orders.destination_location_id is null

      -- (c) The destination's warehouse must be one of the caller's — or the
      --     destination is an org-level location with no warehouse, which is
      --     also unscopable. `l.id` and
      --     `purchase_orders.destination_location_id` are both qualified
      --     (pattern #25): an unqualified `warehouse_id` here would read the
      --     subquery's own column on both sides of the comparison and become a
      --     tautology.
      --
      --     my_warehouse_ids() is the DB twin of getWarehouseAccess(): manager+
      --     get every warehouse in the org, staff/viewer get their
      --     user_warehouse_assignments rows. The 0280 "all warehouses" flag
      --     needs no special case here because 0280 MATERIALISES it as one
      --     assignment row per warehouse ("warehouse scoping is enforced by
      --     the EXISTENCE of user_warehouse_assignments rows"), so those
      --     members already resolve to every warehouse through this function.
      or exists (
        select 1
        from public.locations l
        where l.id = purchase_orders.destination_location_id
          and (
            l.warehouse_id is null
            or l.warehouse_id in (select mw.warehouse_id from public.my_warehouse_ids() mw)
          )
      )
    )
  );

comment on table public.purchase_orders is
  'SELECT (0322) requires org membership AND purchase_orders:read AND either manager+ or the destination location living in one of the caller''s warehouses. POs with no destination_location_id, or whose destination is an org-level location with no warehouse_id, are not warehouse-scopable and stay visible to any member holding the read permission.';

-- ── item_stock_levels: DEFERRED, and why ────────────────────────────────────
-- item_stock_levels_select is still `(select is_org_member(organization_id))`
-- after this migration. That is a decision, not an oversight, and it is NOT
-- because the leak is small — a raw token does return every per-location
-- holding in the org. It is because narrowing this particular policy would
-- silently CORRUPT STOCK, which is strictly worse than the disclosure:
--
--   * public.post_cycle_count(uuid) is SECURITY INVOKER (verified:
--     pg_proc.prosecdef = false) and derives the stock delta it writes from
--       select coalesce(sum(quantity),0) from public.item_stock_levels
--        where item_id = v_line.item_id
--     i.e. from Σ over ALL of an item's holdings, so that Σ item_stock_levels
--     stays equal to quantity_on_hand. RLS applies to that sum. If the policy
--     hides even one holding from the counting user, the sum comes back short,
--     the reconciliation delta is computed against the wrong base, and the RPC
--     writes a WRONG quantity — with no error raised anywhere. A cycle count
--     is the one operation whose entire purpose is to make the number correct.
--   * public.apply_level_delta(uuid, numeric, text) is SECURITY INVOKER too
--     and SELECTS the holdings it will draw down. Hidden rows there mean the
--     draw-down skips real stock and raises `insufficient_placed_stock` on a
--     legitimate pick — the exact class of bug 0292 was written to fix.
--   * Both failure modes bite hardest on the NULL-warehouse holdings that this
--     schema creates on purpose: apply_level_delta's own warehouseless branch
--     allocates into `organization_id = v_org and warehouse_id is null`
--     locations, and `locations.kind IS NULL` Sites are never to be given a
--     kind. A warehouse-derived predicate cannot see any of it.
--   * Perf is the secondary reason. 0310 measured this policy against 500,002
--     rows in a single org and explicitly warns about "a full
--     item_stock_levels rollup"; a per-row EXISTS against locations lands on
--     that path. Note also that the biggest reader — the inventory list and
--     full-dataset loaders in server/loaders/inventory-list.ts:546,841 — uses
--     createAdminClient(), so RLS would not narrow the largest surface anyway.
--
-- PREREQUISITE for a future migration to close it: make the Σ and the
-- draw-down selection independent of the caller's read scope — either convert
-- post_cycle_count and apply_level_delta to SECURITY DEFINER with their own
-- explicit org checks, or route both reads through a SECURITY DEFINER helper.
-- Once the sum is provably complete regardless of who is asking, the SELECT
-- policy can take the same shape as purchase_orders_select above (via
-- location_id -> locations.warehouse_id, with the same NULL-warehouse
-- disjunct). Attempting it before that is a silent-corruption risk.


-- ═══════════════════════════════════════════════════════════════════════════
-- 5) Grant hygiene — my_warehouse_ids() still carried PUBLIC + anon EXECUTE.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Postgres grants EXECUTE TO PUBLIC on every new function by default, and this
-- project additionally runs Supabase's `alter default privileges ... grant
-- execute on functions to anon, authenticated, service_role`, so the function
-- carries BOTH a PUBLIC entry and a direct anon entry. Verified on the live
-- ACL: PUBLIC=X, anon=X, authenticated=X, postgres=X, service_role=X.
-- Revoking from PUBLIC alone would NOT close anon; both grantees are named.
--
-- my_warehouse_ids() is SECURITY DEFINER, so an anon caller would execute it
-- with the owner's rights. It is INERT for anon in practice — every branch
-- filters on `user_id = auth.uid()`, which is null for an unauthenticated
-- caller, so it returns zero rows rather than leaking warehouse ids. That is
-- why it was outside 0318's deliberate scope. It is closed now anyway: PUBLIC
-- EXECUTE on a SECURITY DEFINER function is a standing liability that survives
-- any future edit to the body, and PostgREST exposes it at
-- POST /rest/v1/rpc/my_warehouse_ids to anyone holding the publishable key.
--
-- `authenticated` MUST KEEP EXECUTE — this is the 0318 outage hazard, and this
-- function is now load-bearing in TWO policies: 0321's stock_movements_select
-- and section 4's purchase_orders_select above. RLS predicates evaluate with
-- the QUERYING role's privileges, so revoking authenticated here would take
-- down the movements ledger and the PO list for every warehouse-scoped member.
-- The explicit re-grants below are not decoration: they state the intended end
-- state, so this migration is correct even on a database where a surviving
-- role's privilege happened to be PUBLIC-derived rather than direct.
-- supabase/tests/0322_*.test.sql asserts BOTH directions.

revoke execute on function public.my_warehouse_ids() from public, anon;
grant  execute on function public.my_warehouse_ids() to authenticated;
grant  execute on function public.my_warehouse_ids() to service_role;

comment on function public.my_warehouse_ids() is
  'Canonical warehouse-access set for auth.uid(): manager+ get every warehouse in their org(s), staff/viewer get their user_warehouse_assignments rows (0280 all-warehouse access is materialised as assignment rows, so it needs no special case). SECURITY DEFINER. EXECUTE: authenticated + service_role only (0322 revoked PUBLIC and anon). Do NOT revoke authenticated: stock_movements_select (0321) and purchase_orders_select (0322) call it, and RLS runs with the querying role''s privileges.';
