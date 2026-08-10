-- supabase/tests/0321_movement_read_scope_and_attribution.test.sql
-- Proves migration 0321 — Wave C1's three policy changes — in BOTH directions
-- for every one of them: the attack is refused AND the legitimate caller still
-- works. The second half is the part that prevents an outage, so it is not
-- optional here; several assertions exist only to prove a negative was not
-- vacuous.
--
-- HOW THE ROLES ARE SIMULATED
--   House convention (0142/0201/0310): `set local role` into the real Postgres
--   role PostgREST switches to, plus request.jwt.claim.sub so auth.uid()
--   resolves. The default role for the rest of the file is the test's
--   superuser, which bypasses RLS — that is what makes the "control" assertions
--   below possible.
--
-- THE VACUITY PROBLEM, AND HOW THIS FILE AVOIDS IT
--   A cross-boundary RLS test whose target id is looked up INLINE while the
--   attacker role is active proves nothing: the lookup is itself RLS-blinded,
--   returns no row, and the "attacker sees 0 rows" assertion passes even if the
--   policy is wide open. So every target id here is resolved from the
--   PRIVILEGED (superuser) connection with \gset BEFORE any role switch, by a
--   real property lookup rather than by restating the literal, and each is
--   paired with a control assertion that the row genuinely EXISTS. The two
--   throws_ok cases get the same treatment from the other side: each is
--   followed by a privileged count proving the forged row is absent, and by a
--   sibling lives_ok proving the same actor CAN write the legal version — so a
--   refusal can never be credited to a missing role or a typo'd fixture.
--
-- FIXTURES
--   Org A: two warehouses (A1, A2), one item and one movement in each.
--   Org B: one warehouse, one item, one movement, one charter.
--   Six users, each isolating one branch of the policies:
--     u_staff  org A staff,   assigned warehouse A1 ONLY. No activity_logs:read
--              (staff holds it in no default set) -> the ordinary member.
--     u_mgr    org A manager. Holds activity_logs:read by DEFAULT (0207)
--              -> the privileged reader that must not be narrowed.
--     u_aud    org A viewer + a user_permission_overrides GRANT of
--              activity_logs:read and ZERO warehouse assignments -> the
--              Auditor preset (lib/auditor-preset.ts). Proves the privileged
--              branch is permission-driven, not role-driven, and does not
--              secretly depend on warehouse access.
--     u_lone   org A staff with NO assignments -> the empty-set edge.
--     u_badmin org B admin -> the MED-12 attacker.
--     u_aadmin org A admin -> the MED-12 legitimate writer.
--   `all_warehouses` is left at its false default on every membership: the
--   trg_warehouses_all_warehouse_access trigger would otherwise auto-assign
--   EVERY warehouse to a member and silently destroy the whole point of the
--   warehouse-scoping assertions.
--
-- Run via `supabase test db` after `supabase db reset`. Wrapped in
-- begin/rollback -- nothing leaks.

begin;

select plan(24);

\set orgA     '\'03210000-0000-0000-0000-000000000001\''
\set orgB     '\'03210000-0000-0000-0000-000000000002\''
\set whA1     '\'03210000-0000-0000-0000-0000000000b1\''
\set whA2     '\'03210000-0000-0000-0000-0000000000b2\''
\set whB1     '\'03210000-0000-0000-0000-0000000000b3\''
\set u_staff  '\'03210000-0000-0000-0000-0000000000a1\''
\set u_mgr    '\'03210000-0000-0000-0000-0000000000a2\''
\set u_aud    '\'03210000-0000-0000-0000-0000000000a3\''
\set u_lone   '\'03210000-0000-0000-0000-0000000000a4\''
\set u_badmin '\'03210000-0000-0000-0000-0000000000a5\''
\set u_aadmin '\'03210000-0000-0000-0000-0000000000a6\''
\set itemA1   '\'03210000-0000-0000-0000-0000000000c1\''
\set itemA2   '\'03210000-0000-0000-0000-0000000000c2\''
\set itemB1   '\'03210000-0000-0000-0000-0000000000c3\''
\set mvA1     '\'03210000-0000-0000-0000-0000000000d1\''
\set mvA2     '\'03210000-0000-0000-0000-0000000000d2\''
\set mvB1     '\'03210000-0000-0000-0000-0000000000d3\''
\set chA      '\'03210000-0000-0000-0000-0000000000f1\''
\set chB      '\'03210000-0000-0000-0000-0000000000f2\''

-- ── Fixtures (superuser: RLS bypassed) ───────────────────────────────────────

insert into auth.users (id, email, raw_user_meta_data) values
  (:u_staff,  'staff@wc0321.test',  '{"full_name":"Scoped Staff"}'::jsonb),
  (:u_mgr,    'mgr@wc0321.test',    '{"full_name":"Org A Manager"}'::jsonb),
  (:u_aud,    'aud@wc0321.test',    '{"full_name":"Granted Auditor"}'::jsonb),
  (:u_lone,   'lone@wc0321.test',   '{"full_name":"Unassigned Staff"}'::jsonb),
  (:u_badmin, 'badmin@wc0321.test', '{"full_name":"Org B Admin"}'::jsonb),
  (:u_aadmin, 'aadmin@wc0321.test', '{"full_name":"Org A Admin"}'::jsonb)
on conflict (id) do nothing;

insert into public.organizations (id, name, slug, timezone, currency, plan) values
  (:orgA, 'WC0321 Org A', 'wc0321-org-a', 'UTC', 'USD', 'pro'),
  (:orgB, 'WC0321 Org B', 'wc0321-org-b', 'UTC', 'USD', 'pro');

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :u_staff,  'staff',   now()),
  (:orgA, :u_mgr,    'manager', now()),
  (:orgA, :u_aud,    'viewer',  now()),
  (:orgA, :u_lone,   'staff',   now()),
  (:orgA, :u_aadmin, 'admin',   now()),
  (:orgB, :u_badmin, 'admin',   now());

insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA1, :orgA, 'WC0321 A1', 'WCA1', 'active'),
  (:whA2, :orgA, 'WC0321 A2', 'WCA2', 'active'),
  (:whB1, :orgB, 'WC0321 B1', 'WCB1', 'active');

-- The ordinary member holds warehouse A1 and nothing else. u_aud and u_lone get
-- NO row at all, on purpose.
insert into public.user_warehouse_assignments
  (organization_id, user_id, warehouse_id, charter_id, is_primary) values
  (:orgA, :u_staff, :whA1, null, true);

-- The auditor's org-wide read comes from a GRANT, not from a role: viewer holds
-- activity_logs:read in no default set (only admin and manager do, per 0207).
insert into public.user_permission_overrides
  (organization_id, user_id, permission, granted) values
  (:orgA, :u_aud, 'activity_logs:read', true);

insert into public.charters (id, organization_id, name) values
  (:chA, :orgA, 'WC0321 Charter A'),
  (:chB, :orgB, 'WC0321 Charter B');

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type) values
  (:itemA1, :orgA, :whA1, 'WC0321-A1', 'Item in warehouse A1', 100, 'active', 'none'),
  (:itemA2, :orgA, :whA2, 'WC0321-A2', 'Item in warehouse A2', 100, 'active', 'none'),
  (:itemB1, :orgB, :whB1, 'WC0321-B1', 'Item in org B',        100, 'active', 'none');

insert into public.stock_movements
  (id, organization_id, item_id, movement_type, quantity_change,
   previous_quantity, new_quantity, user_id, reason) values
  (:mvA1, :orgA, :itemA1, 'adjust',  5,  95, 100, :u_mgr, 'wc0321 own warehouse'),
  (:mvA2, :orgA, :itemA2, 'adjust', -7, 107, 100, :u_mgr, 'wc0321 sibling warehouse'),
  (:mvB1, :orgB, :itemB1, 'adjust',  3,  97, 100, :u_badmin, 'wc0321 other org');

-- ── PRIVILEGED TARGET RESOLUTION (\gset, before any role switch) ─────────────
-- Resolved by PROPERTY (which warehouse the movement's item lives in), not by
-- restating the literal id, so these queries would also catch a fixture that
-- silently failed to link up. They run as superuser, so RLS cannot blind them.

select m.id as sibling_mv_id
  from public.stock_movements m
  join public.inventory_items i on i.id = m.item_id
 where i.warehouse_id = :whA2
   and m.organization_id = :orgA \gset

select m.id as foreign_mv_id
  from public.stock_movements m
  join public.inventory_items i on i.id = m.item_id
 where i.warehouse_id = :whB1
   and m.organization_id = :orgB \gset

-- ═══════════════════════════════════════════════════════════════════════════
-- PART A — HI-7: stock_movements SELECT is warehouse-scoped for ordinary
-- members and stays org-wide for activity_logs:read holders.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1-2. CONTROLS. Both target rows exist and are reachable when RLS is not in
-- the way. Without these, assertions 4 and 5 could pass on an empty table.
select is(
  (select count(*) from public.stock_movements where id = :'sibling_mv_id'::uuid),
  1::bigint,
  'CONTROL: the sibling-warehouse movement exists (superuser, RLS bypassed) — assertion 4 is not vacuous'
);
select is(
  (select count(*) from public.stock_movements where id = :'foreign_mv_id'::uuid),
  1::bigint,
  'CONTROL: the other org''s movement exists (superuser, RLS bypassed) — assertion 5 is not vacuous'
);

-- ── The ordinary member: org A staff, warehouse A1 only ─────────────────────
set local "request.jwt.claim.sub" to '03210000-0000-0000-0000-0000000000a1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- 3. LEGITIMATE CASE WORKS. This is the no-outage half: warehouse-scoping must
-- not cost a member the movements they are entitled to.
select is(
  (select count(*) from public.stock_movements where id = :mvA1),
  1::bigint,
  'LEGIT: a warehouse-scoped staff member still reads movements from their OWN warehouse'
);

-- 4. THE HI-7 ATTACK, BLOCKED. Same org, sibling warehouse, no
-- activity_logs:read. Before 0321 this returned the row.
select is(
  (select count(*) from public.stock_movements where id = :'sibling_mv_id'::uuid),
  0::bigint,
  'HI-7 BLOCKED: a warehouse-scoped staff member cannot read another warehouse''s movement'
);

-- 5. The 0229 membership conjunct survived the rewrite: another org is still
-- invisible.
select is(
  (select count(*) from public.stock_movements where id = :'foreign_mv_id'::uuid),
  0::bigint,
  'CONJUNCT 1 INTACT: a staff member cannot read a movement from an org they are not a member of'
);

-- 6. Nothing else leaked either — exactly one of the three fixture rows is
-- visible, so the block is not an artifact of the id filter.
select is(
  (select count(*) from public.stock_movements
    where id in (:mvA1, :mvA2, :mvB1)),
  1::bigint,
  'HI-7 BLOCKED: of three fixture movements the scoped staff member sees exactly the one in their warehouse'
);

-- 7. NEGATIVE CONTROL for 4/6: this member's membership and warehouse set are
-- healthy, so the refusals above are the warehouse boundary doing its job and
-- not a broken fixture or a failed membership lookup.
select is(
  (select count(*) from public.my_warehouse_ids()),
  1::bigint,
  'CONTROL: the scoped member''s my_warehouse_ids() holds exactly one warehouse — the block is warehouse scope, not a dead membership'
);

reset role;

-- ── The privileged reader by ROLE: org A manager ─────────────────────────────
set local "request.jwt.claim.sub" to '03210000-0000-0000-0000-0000000000a2';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- 8-9. CROSS-WAREHOUSE READ PRESERVED. Manager holds activity_logs:read by
-- default (0207), which is exactly what /dashboard/movements and the mobile
-- movements tab gate on. Narrowing this would have broken the ledger, the CSV
-- export and the report_*/dashboard_* RPCs for every manager and admin.
select is(
  (select count(*) from public.stock_movements where id = :'sibling_mv_id'::uuid),
  1::bigint,
  'LEGIT: a manager (activity_logs:read by default) still reads ACROSS warehouses'
);
select is(
  (select count(*) from public.stock_movements where id in (:mvA1, :mvA2)),
  2::bigint,
  'LEGIT: a manager reads the whole org''s ledger, both warehouses'
);

reset role;

-- ── The privileged reader by GRANT: org A viewer, zero assignments ───────────
set local "request.jwt.claim.sub" to '03210000-0000-0000-0000-0000000000a3';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- 10. The Auditor preset. A viewer with NO warehouse assignments whatsoever
-- reads org-wide because the permission was granted — proving the privileged
-- branch resolves the configurable permission and does not fall back on
-- warehouse access.
select is(
  (select count(*) from public.stock_movements where id in (:mvA1, :mvA2)),
  2::bigint,
  'LEGIT: a viewer GRANTED activity_logs:read reads org-wide despite zero warehouse assignments (Auditor preset)'
);

-- 11. ...but the grant is per-org: it does not reach across the tenant line.
select is(
  (select count(*) from public.stock_movements where id = :'foreign_mv_id'::uuid),
  0::bigint,
  'BLOCKED: the activity_logs:read grant is org-scoped — it does not expose another tenant'
);

reset role;

-- ── The empty-set edge: staff with no assignments ────────────────────────────
set local "request.jwt.claim.sub" to '03210000-0000-0000-0000-0000000000a4';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- 12. Matches what the app already renders for this user: MovementsService
-- returns [] when access.readableIds is empty.
select is(
  (select count(*) from public.stock_movements where id in (:mvA1, :mvA2, :mvB1)),
  0::bigint,
  'HI-7: a staff member with no warehouse assignments and no activity_logs:read reads no movements at all'
);

reset role;

-- 13-14. THE OUTAGE GUARD (0318's Group 2 lesson). RLS predicates evaluate with
-- the QUERYING role's privileges, so stock_movements_select breaks for every
-- caller the moment `authenticated` loses EXECUTE on either helper it names. A
-- future blanket-revoke sweep must fail here, in CI.
select ok(
  has_function_privilege('authenticated', 'public.my_warehouse_ids()', 'EXECUTE'),
  'authenticated RETAINS EXECUTE on my_warehouse_ids() — stock_movements_select depends on it'
);
select ok(
  has_function_privilege('authenticated', 'public.rls_orgs_with_permission(text)', 'EXECUTE'),
  'authenticated RETAINS EXECUTE on rls_orgs_with_permission(text) — the privileged read branch depends on it'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- PART B — MED-10: stock_movements_insert pins user_id to auth.uid().
-- ═══════════════════════════════════════════════════════════════════════════

set local "request.jwt.claim.sub" to '03210000-0000-0000-0000-0000000000a1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- 15. LEGITIMATE CASE WORKS — attributing a movement to yourself, which is
-- what every app writer and every SECURITY INVOKER RPC actually does.
select lives_ok(
  $$insert into public.stock_movements
      (organization_id, item_id, movement_type, quantity_change,
       previous_quantity, new_quantity, user_id)
    values ('03210000-0000-0000-0000-000000000001', '03210000-0000-0000-0000-0000000000c1',
            'adjust', 1, 100, 101, '03210000-0000-0000-0000-0000000000a1')$$,
  'LEGIT: a member may insert a movement attributed to THEMSELVES'
);

-- 16. LEGITIMATE CASE WORKS — the nullable actor. Most historical rows carry no
-- actor at all, and forbidding NULL would break every writer that omits it.
select lives_ok(
  $$insert into public.stock_movements
      (organization_id, item_id, movement_type, quantity_change,
       previous_quantity, new_quantity, user_id)
    values ('03210000-0000-0000-0000-000000000001', '03210000-0000-0000-0000-0000000000c1',
            'adjust', 1, 101, 102, null)$$,
  'LEGIT: a NULL user_id is still accepted (system-written rows)'
);

-- 17. THE MED-10 ATTACK, BLOCKED. Forging a colleague's identity into the
-- append-only audit trail. Before 0321 this insert succeeded.
select throws_ok(
  $$insert into public.stock_movements
      (organization_id, item_id, movement_type, quantity_change,
       previous_quantity, new_quantity, user_id, reason)
    values ('03210000-0000-0000-0000-000000000001', '03210000-0000-0000-0000-0000000000c1',
            'adjust', 1, 102, 103, '03210000-0000-0000-0000-0000000000a2',
            'wc0321 forged attribution')$$,
  '42501', null,
  'MED-10 BLOCKED: a member cannot attribute a movement to a COLLEAGUE'
);

-- throws_ok runs its statement in a savepoint; re-assert the session role.
set local "request.jwt.claim.sub" to '03210000-0000-0000-0000-0000000000a1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- 18. THE REAL WRITE PATH STILL WORKS. adjust_stock is SECURITY INVOKER, so
-- this insert is subject to the policy just rewritten — and it is the function
-- post_receipt_v2, reverse_receipt and the app's adjust flows all route
-- through. If the pin had been written as `user_id = auth.uid()` without the
-- NULL branch, or against the wrong uid source, this is what would have gone
-- down in production.
select lives_ok(
  $$select public.adjust_stock(
      '03210000-0000-0000-0000-0000000000c1'::uuid,
      2, 'add', null, 'wc0321 rpc path', null)$$,
  'LEGIT: adjust_stock (SECURITY INVOKER, RLS applies) still writes its movement'
);

reset role;

-- 19. CONTROL for 17: the forged row is genuinely absent. Asserted as superuser
-- so RLS cannot manufacture a false pass. Matched on the attempt's own distinct
-- `reason` string as well as the colleague's uid — the fixture movement mvA1 is
-- ALSO attributed to u_mgr on this item (it has to be: a legitimately
-- pre-existing colleague-authored row is what the ledger normally looks like),
-- so a uid-only count would have found that row and reported a false failure.
select is(
  (select count(*) from public.stock_movements
    where organization_id = :orgA
      and item_id = :itemA1
      and user_id = :u_mgr
      and reason = 'wc0321 forged attribution'),
  0::bigint,
  'CONTROL: no movement attributed to the colleague exists — assertion 17 refused a real write, it did not pass vacuously'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- PART C — MED-12: warehouse_charters.organization_id must match its charter.
-- ═══════════════════════════════════════════════════════════════════════════

set local "request.jwt.claim.sub" to '03210000-0000-0000-0000-0000000000a5';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- 20. THE MED-12 ATTACK, BLOCKED. Org B's admin stamps org A's id onto a row
-- built from org B's own warehouse and charter. Every pre-0321 conjunct passes
-- (they only ever asked about the charter's org and the warehouse's org), and
-- the row would then satisfy wc_select for org A's members.
select throws_ok(
  $$insert into public.warehouse_charters (organization_id, warehouse_id, charter_id)
    values ('03210000-0000-0000-0000-000000000001',
            '03210000-0000-0000-0000-0000000000b3',
            '03210000-0000-0000-0000-0000000000f2')$$,
  '42501', null,
  'MED-12 BLOCKED: an admin cannot stamp ANOTHER org''s organization_id onto a warehouse_charters row'
);

set local "request.jwt.claim.sub" to '03210000-0000-0000-0000-0000000000a5';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- 21. LEGITIMATE CASE WORKS, and it is also the negative control for 20: the
-- SAME actor, warehouse and charter succeed once the org stamp is honest. So 20
-- was refused by the new conjunct and not because u_badmin lacks admin rights,
-- or because warehouse_in_org rejected the warehouse, or because of an FK.
select lives_ok(
  $$insert into public.warehouse_charters (organization_id, warehouse_id, charter_id)
    values ('03210000-0000-0000-0000-000000000002',
            '03210000-0000-0000-0000-0000000000b3',
            '03210000-0000-0000-0000-0000000000f2')$$,
  'LEGIT: the same admin CAN write the row with its own org''s id — proving assertion 20 failed on the org stamp alone'
);

-- 22. The UPDATE face of the same hole: re-stamping an existing, valid row.
-- USING still admits the row (the charter is org B's, and this admin owns org
-- B), so only WITH CHECK can stop the mutation.
select throws_ok(
  $$update public.warehouse_charters
      set organization_id = '03210000-0000-0000-0000-000000000001'
    where warehouse_id = '03210000-0000-0000-0000-0000000000b3'
      and charter_id = '03210000-0000-0000-0000-0000000000f2'$$,
  '42501', null,
  'MED-12 BLOCKED: an admin cannot RE-STAMP an existing row with another org''s id'
);

reset role;

-- ── The other org's admin, unaffected ───────────────────────────────────────
set local "request.jwt.claim.sub" to '03210000-0000-0000-0000-0000000000a6';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- 23. LEGITIMATE CASE WORKS for a second, independent org — the new conjunct is
-- a consistency test, not a hardcoded org.
select lives_ok(
  $$insert into public.warehouse_charters (organization_id, warehouse_id, charter_id)
    values ('03210000-0000-0000-0000-000000000001',
            '03210000-0000-0000-0000-0000000000b2',
            '03210000-0000-0000-0000-0000000000f1')$$,
  'LEGIT: org A''s admin maps org A''s warehouse to org A''s charter'
);

reset role;

-- 24. CONTROL for 20 and 22: not one surviving row disagrees with its charter's
-- org. Asserted as superuser over the whole table, so it also catches a row
-- planted by any path this file did not think of.
select is(
  (select count(*)
     from public.warehouse_charters wc
     join public.charters c on c.id = wc.charter_id
    where wc.organization_id <> c.organization_id),
  0::bigint,
  'CONTROL: no warehouse_charters row disagrees with its charter''s organization — the forged rows never landed'
);

select * from finish();
rollback;
