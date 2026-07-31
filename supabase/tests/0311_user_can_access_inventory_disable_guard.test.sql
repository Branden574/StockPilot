-- supabase/tests/0311_user_can_access_inventory_disable_guard.test.sql
-- Proves the FOURTEENTH membership gate — user_can_access_inventory — refuses a
-- disabled account, and that the picking RPCs it solely gates refuse with it.
--
-- ── WHY THIS FILE EXISTS (the hole 0310 left) ───────────────────────────────
-- 0310 guarded thirteen STABLE membership helpers and asserted, in its own
-- header, that "the five VOLATILE SECURITY DEFINER RPCs that are granted to
-- `authenticated` ... all route through is_org_member / has_org_role /
-- has_permission and therefore inherit this too."
--
-- That sentence was wrong twice. There are EIGHT such RPCs, not five, and four
-- of them (claim_picking, release_picking, partial_pick_line, complete_picking)
-- reach NO guarded helper on the path that matters:
--
--   * claim_picking's ONLY authorization gate is
--     user_can_access_inventory(v_user, warehouse_id, null, 'write'). 0310 left
--     that helper unguarded, so a disabled admin got `true`, claim_picking
--     succeeded, and assigned_picker_id was PERSISTED as the disabled user.
--
--   * partial_pick_line and complete_picking do call has_org_role — but only as
--     the LEFT arm of `not has_org_role(...) and assigned_picker_id <> v_user`.
--     Once the row names you as the picker, a FAILING has_org_role is not
--     sufficient to stop you: the conjunction short-circuits false and the RPC
--     proceeds. So the claim above chains straight into real stock draw-down.
--
-- This file pins the whole chain, not just the helper: section 6 asserts that a
-- disabled user who is ALREADY the assigned picker still cannot move stock, and
-- proves it by reading on_hand back with RLS off.
--
-- ── ALSO PINNED HERE ────────────────────────────────────────────────────────
-- Section 10 pins the load-bearing TRANSITIVE path that 0310 relies on without
-- naming: 25 live policies gate on an inline
-- `exists (select 1 from organization_members m where m.user_id = auth.uid())`
-- rather than on any helper. Those close for a disabled user ONLY because that
-- inner read is itself subject to organization_members_select, which IS
-- is_org_member. Nothing documented or tested that dependency, so a future
-- policy edit could have silently reopened all 25 at once.
--
-- Section 11 pins user_can_see_item_category, the fifteenth membership reader.
-- It is now guarded in its own right; its single policy use (categories_select)
-- also ANDs the guarded is_org_member, and that conjunction is asserted so the
-- belt cannot be removed at the same time as the braces.
--
-- Wrapped in begin/rollback — nothing leaks. Namespace 03110000.

begin;

select plan(39);

\set org    '\'03110000-0000-0000-0000-000000000001\''
\set wh     '\'03110000-0000-0000-0000-000000000002\''
\set rack   '\'03110000-0000-0000-0000-000000000003\''
\set cat    '\'03110000-0000-0000-0000-000000000004\''
\set bin    '\'03110000-0000-0000-0000-000000000005\''

\set u_act  '\'03110000-0000-0000-0000-0000000000a1\''
\set u_dis  '\'03110000-0000-0000-0000-0000000000a2\''
\set u_peer '\'03110000-0000-0000-0000-0000000000a3\''

\set item_a '\'03110000-0000-0000-0000-0000000000b1\''
\set item_c '\'03110000-0000-0000-0000-0000000000b3\''

\set ord_a  '\'03110000-0000-0000-0000-0000000000c1\''
\set ord_b  '\'03110000-0000-0000-0000-0000000000c2\''
\set ord_c  '\'03110000-0000-0000-0000-0000000000c3\''
\set line_a '\'03110000-0000-0000-0000-0000000000d1\''
\set line_c '\'03110000-0000-0000-0000-0000000000d3\''

-- ── Fixtures ────────────────────────────────────────────────────────────────
insert into auth.users (id, email, raw_user_meta_data) values
  (:u_act,  'act@ad11.test',  '{"full_name":"Active Picker"}'::jsonb),
  (:u_dis,  'dis@ad11.test',  '{"full_name":"Disable Subject"}'::jsonb),
  (:u_peer, 'peer@ad11.test', '{"full_name":"Unaffected Peer"}'::jsonb)
on conflict (id) do nothing;

insert into public.organizations (id, name, slug, timezone, currency, plan)
values (:org, 'AD11 Org', 'ad11-org', 'UTC', 'USD', 'pro');

insert into public.warehouses (id, organization_id, name, code, status)
values (:wh, :org, 'AD11 WH', 'AD11', 'active');

insert into public.locations (id, organization_id, warehouse_id, name, type, kind)
values (:rack, :org, :wh, 'AD11-R1', 'shelf', 'rack');

insert into public.categories (id, organization_id, name)
values (:cat, :org, 'AD11 Category');

insert into public.bins (id, organization_id, warehouse_id, code, name, bin_type)
values (:bin, :org, :wh, 'AD11-BIN-1', 'AD11 Bin', 'storage');

-- The disable subject is an ADMIN, which is the exact shape that was proven
-- exploitable on a reset DB: admin takes user_can_access_inventory's manager+
-- branch, so it returns true with no warehouse assignment at all. The active
-- picker is deliberately a STAFF member with an assignment, so the ACTIVE
-- end-to-end run also covers the OTHER branch of the same helper.
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :u_act,  'staff',   now()),
  (:org, :u_dis,  'admin',   now()),
  (:org, :u_peer, 'staff',   now());

insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, charter_id)
values (:org, :u_act, :wh, null),
       (:org, :u_peer, :wh, null);

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
values
  (:item_a, :org, :wh, 'AD11-A', 'Item A', 10, 'active', 'none'),
  (:item_c, :org, :wh, 'AD11-C', 'Item C', 10, 'active', 'none');

-- Fully PLACED in the rack: complete_picking draws PLACED stock, so the
-- Unplaced level auto-seeded by trg_seed_initial_level is replaced.
delete from public.item_stock_levels where item_id in (:item_a, :item_c);
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
values (:org, :item_a, :rack, 10),
       (:org, :item_c, :rack, 10);

--   A: unclaimed, picked end-to-end by the ACTIVE staff user.
--   B: unclaimed, the disabled admin's claim attempt must bounce off it.
--   C: ALREADY assigned to the disabled admin — the chain case. This is the row
--      that makes a failing has_org_role insufficient.
insert into public.order_requests
  (id, organization_id, warehouse_id, status, requester_user_id, source, fulfillment_type,
   assigned_picker_id)
values
  (:ord_a, :org, :wh, 'pick_slip_generated', :u_act, 'internal', 'pickup', null),
  (:ord_b, :org, :wh, 'pick_slip_generated', :u_act, 'internal', 'pickup', null),
  (:ord_c, :org, :wh, 'pick_slip_generated', :u_act, 'internal', 'pickup', :u_dis);

insert into public.order_request_lines
  (id, order_request_id, item_id, quantity_requested, quantity_fulfilled, quantity_picked)
values
  (:line_a, :ord_a, :item_a, 10, 0, null),
  (:line_c, :ord_c, :item_c, 10, 0, null);

-- ── 1. Structure ────────────────────────────────────────────────────────────
-- Volatility is load-bearing: 0310's whole performance argument rests on the
-- planner being able to hoist a STABLE helper into a one-time InitPlan.
select has_function('public', 'user_can_access_inventory',
  array['uuid', 'uuid', 'uuid', 'text'], 'user_can_access_inventory exists');

select is(
  (select p.provolatile::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'user_can_access_inventory'),
  's', 'user_can_access_inventory is STABLE');

-- The guard must be INLINED, not a nested account_is_disabled() call: this
-- helper takes a row-correlated warehouse id, so it is 0310''s GROUP B and a
-- nested SECURITY DEFINER call costs a separate plan per row.
select matches(
  (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'user_can_access_inventory'),
  'disabled_at',
  'user_can_access_inventory inlines the disabled_at guard');

-- ── 2. ACTIVE staff picker: the helper answers yes on BOTH ops ──────────────
set local "request.jwt.claim.sub" to '03110000-0000-0000-0000-0000000000a1';
set local role to 'authenticated';

select ok(public.user_can_access_inventory(:u_act, :wh, null, 'read'),
  'ACTIVE staff: user_can_access_inventory read is true');
select ok(public.user_can_access_inventory(:u_act, :wh, null, 'write'),
  'ACTIVE staff: user_can_access_inventory write is true');

-- ── 3. ACTIVE picker: claim -> partial_pick -> complete still works ─────────
-- The regression this guards against is over-tightening: the fix must refuse a
-- disabled user WITHOUT breaking the ordinary picker, so the whole flow runs.
select lives_ok(
  $$select public.claim_picking('03110000-0000-0000-0000-0000000000c1'::uuid)$$,
  'ACTIVE: claim_picking succeeds');

select lives_ok(
  $$select public.partial_pick_line('03110000-0000-0000-0000-0000000000d1'::uuid, 10)$$,
  'ACTIVE: partial_pick_line succeeds');

select lives_ok(
  $$select public.complete_picking('03110000-0000-0000-0000-0000000000c1'::uuid)$$,
  'ACTIVE: complete_picking succeeds');

reset role;

select is((select assigned_picker_id from public.order_requests where id = :ord_a), :u_act::uuid,
  'ACTIVE: the claim persisted the active picker');
select is((select status from public.order_requests where id = :ord_a), 'picking_complete',
  'ACTIVE: the order reached picking_complete');
select is((select quantity_on_hand from public.inventory_items where id = :item_a), 0::numeric,
  'ACTIVE: complete_picking actually drew the stock');

-- ── 4. Disable the admin, exactly the way the service does ─────────────────
set local role to 'service_role';
update public.user_profiles
   set disabled_at = now(), disabled_reason = 'policy_violation'
 where id = :u_dis;
reset role;

-- ── 5. DISABLED: the helper itself refuses, for read AND write ─────────────
set local "request.jwt.claim.sub" to '03110000-0000-0000-0000-0000000000a2';
set local role to 'authenticated';

select ok(not public.user_can_access_inventory(:u_dis, :wh, null, 'read'),
  'DISABLED: user_can_access_inventory read is false');
select ok(not public.user_can_access_inventory(:u_dis, :wh, null, 'write'),
  'DISABLED: user_can_access_inventory write is false');

-- ── 6. DISABLED: claim_picking refuses, and persists NOTHING ───────────────
select throws_ok(
  $$select public.claim_picking('03110000-0000-0000-0000-0000000000c2'::uuid)$$,
  '42501', null,
  'DISABLED: claim_picking is refused');

-- ── 7. THE CHAIN: already the assigned picker, still cannot draw stock ─────
-- This is the assertion that a failing has_org_role does NOT cover. ord_c names
-- the disabled admin as assigned_picker_id, so the
-- `not has_org_role(...) and assigned_picker_id <> v_user` guard short-circuits
-- to false and lets them through. Only the user_can_access_inventory guard
-- stops the draw-down.
select throws_ok(
  $$select public.partial_pick_line('03110000-0000-0000-0000-0000000000d3'::uuid, 10)$$,
  '42501', null,
  'DISABLED + assigned picker: partial_pick_line is refused');

select throws_ok(
  $$select public.complete_picking('03110000-0000-0000-0000-0000000000c3'::uuid)$$,
  '42501', null,
  'DISABLED + assigned picker: complete_picking is refused');

select throws_ok(
  $$select public.release_picking('03110000-0000-0000-0000-0000000000c3'::uuid)$$,
  '42501', null,
  'DISABLED: release_picking is refused');

reset role;

-- Read back with RLS off: the refusals above must have changed NOTHING. Asserted
-- from outside the authenticated role because a disabled user cannot see these
-- rows either way, so an inside-the-role check would prove nothing.
select is((select assigned_picker_id from public.order_requests where id = :ord_b), null::uuid,
  'DISABLED: the refused claim persisted NO picker');
select is((select quantity_on_hand from public.inventory_items where id = :item_c), 10::numeric,
  'DISABLED: NO stock was drawn — on_hand is untouched');
select is((select quantity_picked from public.order_request_lines where id = :line_c), null::numeric,
  'DISABLED: the line was never picked');
select is((select status from public.order_requests where id = :ord_c), 'pick_slip_generated',
  'DISABLED: the order never advanced');

-- ── 8. An unrelated ACTIVE member of the SAME org is untouched ─────────────
set local "request.jwt.claim.sub" to '03110000-0000-0000-0000-0000000000a3';
set local role to 'authenticated';
select ok(public.user_can_access_inventory(:u_peer, :wh, null, 'write'),
  'PEER: an active colleague still passes user_can_access_inventory');
select lives_ok(
  $$select public.claim_picking('03110000-0000-0000-0000-0000000000c2'::uuid)$$,
  'PEER: an active colleague can still claim the order the disabled user could not');
reset role;
select is((select assigned_picker_id from public.order_requests where id = :ord_b), :u_peer::uuid,
  'PEER: the colleague''s claim actually persisted');

-- ── 9. service_role is outside the guard ──────────────────────────────────
-- Load-bearing: the disable/re-enable service writes user_profiles through
-- createAdminClient WHILE the user is disabled. A guard that caught service_role
-- would make the disable irreversible.
set local role to 'service_role';
select ok(public.user_can_access_inventory(:u_peer, :wh, null, 'write'),
  'SERVICE_ROLE: still resolves access for an ACTIVE subject');
select lives_ok(
  $$update public.user_profiles set disabled_reason = 'reviewed'
     where id = '03110000-0000-0000-0000-0000000000a2'$$,
  'SERVICE_ROLE: can still write the disabled user''s profile');
reset role;

-- ── 10. THE TRANSITIVE PATH the 25 inline-EXISTS policies depend on ────────
-- These policies never call a helper. They close for a disabled user only
-- because their inner read of organization_members is itself under
-- organization_members_select, which IS is_org_member — and is_org_member is
-- guarded. Assert the dependency structurally AND behaviourally, so removing
-- is_org_member from that one policy cannot silently reopen all 25.
select is(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'organization_members'
      and policyname = 'organization_members_select'
      and qual like '%is_org_member%'),
  1::bigint,
  'organization_members_select still gates on is_org_member — the path 25 inline policies close through');

select cmp_ok(
  (select count(*) from pg_policies
    where schemaname = 'public'
      and coalesce(qual, '') || coalesce(with_check, '') like '%organization_members%'
      and tablename <> 'organization_members'),
  '>', 0::bigint,
  'policies still reach membership by inline organization_members read (the class exists)');

set local "request.jwt.claim.sub" to '03110000-0000-0000-0000-0000000000a3';
set local role to 'authenticated';
select is((select count(*) from public.bins where id = :bin), 1::bigint,
  'ACTIVE: an inline-EXISTS(organization_members) policy lets the member read');
reset role;

set local "request.jwt.claim.sub" to '03110000-0000-0000-0000-0000000000a2';
set local role to 'authenticated';
select is((select count(*) from public.bins where id = :bin), 0::bigint,
  'DISABLED: the inline-EXISTS policy refuses, transitively via organization_members_select');
reset role;

-- ── 11. The fifteenth reader: user_can_see_item_category ──────────────────
-- Reads organization_members directly and reaches NO guarded helper (the
-- has_org_role in its body is a COMMENT, not a call). Its only policy use ANDs
-- the guarded is_org_member, so it was not a live bypass — but a policy author
-- reaching for it alone would have made one. Guarded in its own right now.
select matches(
  (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'user_can_see_item_category'),
  'disabled_at',
  'user_can_see_item_category inlines the disabled_at guard');

select is(
  (select count(*) from pg_policies
    where schemaname = 'public' and policyname = 'categories_select'
      and qual like '%is_org_member%' and qual like '%user_can_see_item_category%'),
  1::bigint,
  'categories_select still ANDs the guarded is_org_member with user_can_see_item_category');

set local "request.jwt.claim.sub" to '03110000-0000-0000-0000-0000000000a3';
set local role to 'authenticated';
select ok(public.user_can_see_item_category(:u_peer, :org, :cat),
  'ACTIVE: user_can_see_item_category is true');
select is((select count(*) from public.categories where id = :cat), 1::bigint,
  'ACTIVE: categories_select lets the member read');
reset role;

set local "request.jwt.claim.sub" to '03110000-0000-0000-0000-0000000000a2';
set local role to 'authenticated';
select ok(not public.user_can_see_item_category(:u_dis, :org, :cat),
  'DISABLED: user_can_see_item_category is false');
select is((select count(*) from public.categories where id = :cat), 0::bigint,
  'DISABLED: categories_select refuses');
reset role;

-- ── 12. Re-enable restores the picker end to end ──────────────────────────
set local role to 'service_role';
update public.user_profiles
   set disabled_at = null, disabled_reason = null, disabled_by = null
 where id = :u_dis;
reset role;

set local "request.jwt.claim.sub" to '03110000-0000-0000-0000-0000000000a2';
set local role to 'authenticated';
select ok(public.user_can_access_inventory(:u_dis, :wh, null, 'write'),
  'RE-ENABLED: user_can_access_inventory is true again');
select lives_ok(
  $$select public.partial_pick_line('03110000-0000-0000-0000-0000000000d3'::uuid, 10)$$,
  'RE-ENABLED: the once-blocked picker can pick again');
reset role;

select is((select quantity_picked from public.order_request_lines where id = :line_c), 10::numeric,
  'RE-ENABLED: the pick actually applied');

select * from finish();
rollback;
