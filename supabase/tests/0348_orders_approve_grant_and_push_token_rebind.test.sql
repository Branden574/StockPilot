-- supabase/tests/0348_orders_approve_grant_and_push_token_rebind.test.sql
-- Proves migration 0348.
--
-- PART 1 — 'orders:approve' has been advertised as FULLY grantable since 0212
-- (packages/core/src/constants/permissions.ts), but only the RLS was migrated
-- to has_permission(). The seven SECURITY DEFINER order RPCs still gated on
-- has_org_role('manager'), a pure role-rank lookup that never reads
-- role_permission_overrides / user_permission_overrides. On the 0347 head an
-- admin could grant staff the permission, watch the Approve button appear, and
-- get 'forbidden' -> "Only managers can approve requests". Assertions 7-14 and
-- 17 FAIL on that head.
--
-- PART 2 — POST /api/v1/push/register upserted push_tokens on the USER-authed
-- client with `onConflict: 'token'`. Postgres evaluates ON CONFLICT DO UPDATE
-- against the EXISTING row's USING expression, and push_tokens_self (0003) is
-- `user_id = auth.uid()`, so a shared warehouse device whose token still
-- belonged to the previous user answered 42501 -> the route 500'd and the
-- token stayed bound to the person who left (pushes followed the wrong user
-- for up to the 120-day dispatch window). Assertions 18-27 FAIL on the 0347
-- head: register_push_token does not exist there.
--
-- HOW THE ROLES ARE SIMULATED
--   These gates depend on auth.uid(), not on RLS, so they run as the test
--   superuser with `set local "request.jwt.claim.sub"` — the form 0331/0346
--   use. `set local role authenticated` + throws_ok is avoided (it segfaulted
--   local Postgres 17 during the 0345 work); the one place a REAL
--   `authenticated` role matters (assertion 27, proving the EXECUTE grant is
--   usable) runs a plain statement under that role and asserts afterwards.
--
-- Run via `supabase test db` after `supabase db reset`.

begin;
select plan(27);

\set orgA    '\'03480000-0000-0000-0000-00000000000a\''
\set u_own   '\'03480000-0000-0000-0000-0000000000a1\''
\set u_mgr   '\'03480000-0000-0000-0000-0000000000a2\''
\set u_stf   '\'03480000-0000-0000-0000-0000000000a3\''
\set whA     '\'03480000-0000-0000-0000-0000000000c1\''
\set itemA   '\'03480000-0000-0000-0000-0000000000c2\''
\set o_appr  '\'03480000-0000-0000-0000-0000000000d1\''
\set o_cxl   '\'03480000-0000-0000-0000-0000000000d2\''
\set o_back  '\'03480000-0000-0000-0000-0000000000d3\''
\set o_pick  '\'03480000-0000-0000-0000-0000000000d4\''
\set o_mgr   '\'03480000-0000-0000-0000-0000000000d5\''
\set p_userA '\'03480000-0000-0000-0000-0000000000e1\''
\set p_userB '\'03480000-0000-0000-0000-0000000000e2\''
\set p_token '\'ExponentPushToken[shared-warehouse-ipad-0348]\''

-- ── Fixtures (superuser: RLS bypassed) ──────────────────────────────────────
insert into auth.users (id, email, raw_user_meta_data) values
  (:u_own,   'own-0348@test.local', '{}'::jsonb),
  (:u_mgr,   'mgr-0348@test.local', '{}'::jsonb),
  (:u_stf,   'stf-0348@test.local', '{}'::jsonb),
  (:p_userA, 'pa-0348@test.local',  '{}'::jsonb),
  (:p_userB, 'pb-0348@test.local',  '{}'::jsonb)
on conflict (id) do nothing;

insert into public.organizations (id, name, slug) values
  (:orgA, 'Grant Org 0348', 'grant-org-0348')
on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :u_own, 'owner',   now()),
  (:orgA, :u_mgr, 'manager', now()),
  (:orgA, :u_stf, 'staff',   now())
on conflict do nothing;

insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgA, 'Grant WH 0348', 'WH-0348', 'active')
on conflict (id) do nothing;

-- assign_picking ALSO requires warehouse write access for both the actor and
-- the target (0239), which is orthogonal to 'orders:approve' — a staff picker
-- gets it from a warehouse assignment, exactly as the app's
-- requireWarehouseAccess() expects. Without this row assertion 13 fails on the
-- SECOND forbidden (warehouse scope), not on the permission gate under test.
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id) values
  (:orgA, :u_stf, :whA)
on conflict do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type, item_type) values
  (:itemA, :orgA, :whA, 'GRANT-0348', 'Grantable item', 100, 'active', 'none', 'product')
on conflict (id) do nothing;

-- Five orders so each RPC gets a clean subject. The requester is the OWNER on
-- every one: cancel_order_request also allows the requester, and that branch
-- must not be what makes the staff assertions pass.
-- fulfillment_type 'pickup' keeps delivery_charter_id null and satisfies
-- order_requests_delivery_target_chk without dragging a charter fixture in.
insert into public.order_requests (id, organization_id, warehouse_id, status, requester_user_id, fulfillment_type) values
  (:o_appr, :orgA, :whA, 'pending_approval',    :u_own, 'pickup'),
  (:o_cxl,  :orgA, :whA, 'pending_approval',    :u_own, 'pickup'),
  (:o_back, :orgA, :whA, 'backordered',         :u_own, 'pickup'),
  (:o_pick, :orgA, :whA, 'pick_slip_generated', :u_own, 'pickup'),
  (:o_mgr,  :orgA, :whA, 'pending_approval',    :u_own, 'pickup')
on conflict (id) do nothing;

insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values
  (:o_appr, :itemA, 5),
  (:o_cxl,  :itemA, 5),
  (:o_back, :itemA, 5),
  (:o_pick, :itemA, 5),
  (:o_mgr,  :itemA, 5);

-- ── 1. Structure: every gate now consults BOTH helpers ─────────────────────
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('approve_order_request','approve_partial','close_partial',
                        'resume_fulfillment','reopen_picking','assign_picking',
                        'cancel_order_request')
      and p.prosrc ~ 'has_permission'
      and p.prosrc ~ 'orders:approve'),
  7,
  '0348/1: all seven order RPCs consult has_permission(..., ''orders:approve'')');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('approve_order_request','approve_partial','close_partial',
                        'resume_fulfillment','reopen_picking','assign_picking',
                        'cancel_order_request')
      and p.prosrc ~ 'has_org_role'),
  7,
  '0348/2: ... and all seven RETAIN the has_org_role term, so manager-by-role is unchanged');

-- ── 2. STAFF with no grant is still refused (the floor must not drop) ──────
set local "request.jwt.claim.sub" to :u_stf;
select throws_ok(
  format($$select public.approve_order_request(%L)$$, :o_appr),
  '42501', 'forbidden',
  '0348/3: staff without the grant cannot approve');
select throws_ok(
  format($$select public.cancel_order_request(%L, null)$$, :o_cxl),
  '42501', 'forbidden',
  '0348/4: staff without the grant cannot cancel someone else''s order');
select throws_ok(
  format($$select public.close_partial(%L)$$, :o_back),
  '42501', 'forbidden',
  '0348/5: staff without the grant cannot close a partial');
select throws_ok(
  format($$select public.assign_picking(%L, %L)$$, :o_pick, :u_stf),
  '42501', 'forbidden',
  '0348/6: staff without the grant cannot assign a picker');

-- ── 3. An admin grants 'orders:approve' to the staff ROLE ──────────────────
-- This is exactly what /dashboard/settings/roles writes. Everything below
-- FAILS on the 0347 head, where the RPCs never look at this table.
insert into public.role_permission_overrides (organization_id, role, permission, granted)
values (:orgA, 'staff', 'orders:approve', true)
on conflict (organization_id, role, permission) do update set granted = excluded.granted;

select lives_ok(
  format($$select public.approve_order_request(%L)$$, :o_appr),
  '0348/7: a granted staff member CAN approve');
select is((select status from public.order_requests where id = :o_appr), 'approved',
  '0348/8: ... and the order really moved to approved');

select lives_ok(
  format($$select public.cancel_order_request(%L, 'wrong site')$$, :o_cxl),
  '0348/9: a granted staff member CAN cancel someone else''s order');
select is((select status from public.order_requests where id = :o_cxl), 'cancelled',
  '0348/10: ... and the order really moved to cancelled');

select lives_ok(
  format($$select public.close_partial(%L)$$, :o_back),
  '0348/11: a granted staff member CAN close a partial');
select is((select status from public.order_requests where id = :o_back), 'completed',
  '0348/12: ... and the order really moved to completed');

select lives_ok(
  format($$select public.assign_picking(%L, %L)$$, :o_pick, :u_stf),
  '0348/13: a granted staff member CAN assign a picker');
select is((select assigned_picker_id from public.order_requests where id = :o_pick), :u_stf,
  '0348/14: ... and the picker really landed on the order');

-- ── 4. A per-user granted=false override still wins over the role grant ────
insert into public.user_permission_overrides (organization_id, user_id, permission, granted)
values (:orgA, :u_stf, 'orders:approve', false)
on conflict (organization_id, user_id, permission) do update set granted = excluded.granted;

select throws_ok(
  format($$select public.approve_order_request(%L)$$, :o_mgr),
  '42501', 'forbidden',
  '0348/15: an explicit per-user granted=false revokes the role grant (has_permission precedence is honoured)');

-- ── 5. Manager-by-role is untouched — no override row exists for managers ──
set local "request.jwt.claim.sub" to :u_mgr;
select lives_ok(
  format($$select public.approve_order_request(%L)$$, :o_mgr),
  '0348/16: a manager with NO grant of any kind still approves (the retained has_org_role term)');
select is((select status from public.order_requests where id = :o_mgr), 'approved',
  '0348/17: ... and that approval landed');

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2. register_push_token — shared-device rebind.
-- ═══════════════════════════════════════════════════════════════════════════
insert into public.push_tokens (user_id, token, platform, device_id, last_used_at)
values (:p_userA, :p_token, 'ios', 'ipad-0348', now() - interval '1 day');

select ok(
  has_function_privilege('authenticated', 'public.register_push_token(text, text, text)', 'execute'),
  '0348/18: authenticated may execute register_push_token (every registration is a signed-in device)');
select ok(
  not has_function_privilege('anon', 'public.register_push_token(text, text, text)', 'execute'),
  '0348/19: anon holds no EXECUTE — the anon key ships inside the app binary');

-- No service caller exists for this helper, so a null uid is refused rather
-- than waved through the way 0331/0341/0346 do for their service paths.
set local "request.jwt.claim.sub" to '';
select throws_ok(
  format($$select public.register_push_token(%L, 'ios', null)$$, :p_token),
  '42501', 'unauthenticated',
  '0348/20: a connection with no sub claim cannot bind a token to nobody');

-- THE BUG. User B signs in on the iPad user A signed out of. The old route did
-- this as a raw upsert and Postgres refused it with 42501 against A's row.
set local "request.jwt.claim.sub" to :p_userB;
select lives_ok(
  format($$select public.register_push_token(%L, 'ios', 'ipad-0348')$$, :p_token),
  '0348/21: the second user on a shared device CAN claim the token');
select is(
  (select user_id from public.push_tokens where token = :p_token), :p_userB,
  '0348/22: ... the token is now bound to B, so A''s pushes stop following the hardware');
select is(
  (select count(*)::int from public.push_tokens where token = :p_token), 1,
  '0348/23: ... and exactly one row holds it (the unique index is intact, no orphan left behind)');

select throws_ok(
  format($$select public.register_push_token(%L, 'blackberry', null)$$, :p_token),
  'P0001', 'invalid_platform',
  '0348/24: an unknown platform is a named error, not a raw constraint violation');
select throws_ok(
  $$select public.register_push_token('short', 'ios', null)$$,
  'P0001', 'invalid_push_token',
  '0348/25: an implausibly short token is refused');

-- The device changes hands again: rebinding must work in both directions.
set local "request.jwt.claim.sub" to :p_userA;
select lives_ok(
  format($$select public.register_push_token(%L, 'ios', 'ipad-0348')$$, :p_token),
  '0348/26: and back again when A takes the iPad next');

-- The EXECUTE grant has to be usable by the real PostgREST role, not just by
-- the superuser running this file. Plain statement (no throws_ok) under that
-- role — see the header.
set local "request.jwt.claim.sub" to :p_userB;
set local role to 'authenticated';
select public.register_push_token(:p_token, 'android', 'ipad-0348-reflashed');
reset role;
select is(
  (select user_id::text || ':' || platform || ':' || device_id from public.push_tokens where token = :p_token),
  (:p_userB) || ':android:ipad-0348-reflashed',
  '0348/27: a real `authenticated` session rebinds and refreshes platform + device id');

select * from finish();
rollback;
