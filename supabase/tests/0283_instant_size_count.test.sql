-- supabase/tests/0283_instant_size_count.test.sql
-- Proves migration 0283: size-count session/event/adjustment data model + RLS.
--
--   • the three tables + the idempotent (session_id, idempotency_key) unique,
--   • a staff member can create a session and append events,
--   • a duplicate idempotency_key on the same session is rejected (idempotent
--     replay guard),
--   • the event ledger is IMMUTABLE (no UPDATE policy → 0 rows updated),
--   • the per-size tally = SUM(quantity_delta) grouped by size,
--   • a non-member of the org cannot read another org's session (RLS).
--
-- Namespace: 5c028300. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(13);

\set orgA  '\'5c028300-0000-0000-0000-000000000001\''
\set orgB  '\'5c028300-0000-0000-0000-000000000002\''
\set stfA  '\'5c028300-0000-0000-0000-000000000003\''
\set stfB  '\'5c028300-0000-0000-0000-000000000004\''
\set whA   '\'5c028300-0000-0000-0000-00000000000a\''
\set sess  '\'5c028300-0000-0000-0000-0000000000e0\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:stfA, 'stfA-0283@test.local', '{}'::jsonb),
  (:stfB, 'stfB-0283@test.local', '{}'::jsonb) on conflict (id) do nothing;

insert into public.organizations (id, name, slug) values
  (:orgA, 'Size Org A 0283', 'size-org-a-0283'),
  (:orgB, 'Size Org B 0283', 'size-org-b-0283') on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :stfA, 'staff', now()),
  (:orgB, :stfB, 'staff', now()) on conflict do nothing;

insert into public.warehouses (id, organization_id, name, code, status)
  values (:whA, :orgA, 'WH A 0283', 'WH-A-0283', 'active') on conflict (id) do nothing;
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id)
  values (:orgA, :stfA, :whA) on conflict do nothing;

-- ── 1-3. Tables exist ───────────────────────────────────────────────────────
select has_table('public', 'size_count_sessions', 'size_count_sessions exists');
select has_table('public', 'size_count_events', 'size_count_events exists');
select has_table('public', 'size_count_adjustments', 'size_count_adjustments exists');

-- ── As staff A (org A) ──────────────────────────────────────────────────────
set local "request.jwt.claim.sub" to '5c028300-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- 4. Staff A creates a session.
select lives_ok(
  $$ insert into public.size_count_sessions (id, organization_id, warehouse_id, style_key, started_by)
     values ('5c028300-0000-0000-0000-0000000000e0',
             '5c028300-0000-0000-0000-000000000001',
             '5c028300-0000-0000-0000-00000000000a', 'TEE-BLACK',
             '5c028300-0000-0000-0000-000000000003') $$,
  'staff can create a size-count session');

-- 5. Staff A appends two events (M x1, L x1) with distinct idempotency keys.
select lives_ok(
  $$ insert into public.size_count_events
       (session_id, organization_id, idempotency_key, size, quantity_delta, counted_by)
     values
       ('5c028300-0000-0000-0000-0000000000e0','5c028300-0000-0000-0000-000000000001','k1','M',1,'5c028300-0000-0000-0000-000000000003'),
       ('5c028300-0000-0000-0000-0000000000e0','5c028300-0000-0000-0000-000000000001','k2','M',1,'5c028300-0000-0000-0000-000000000003'),
       ('5c028300-0000-0000-0000-0000000000e0','5c028300-0000-0000-0000-000000000001','k3','L',1,'5c028300-0000-0000-0000-000000000003') $$,
  'staff can append size-count events');

-- 6. A duplicate idempotency_key on the same session is rejected (idempotent).
select throws_ok(
  $$ insert into public.size_count_events
       (session_id, organization_id, idempotency_key, size, quantity_delta, counted_by)
     values ('5c028300-0000-0000-0000-0000000000e0','5c028300-0000-0000-0000-000000000001','k1','M',1,'5c028300-0000-0000-0000-000000000003') $$,
  '23505', null,
  'a duplicate (session, idempotency_key) event is rejected (idempotent replay guard)');

-- 7. The ledger is immutable — no UPDATE policy → 0 rows changed.
update public.size_count_events set quantity_delta = 99 where idempotency_key = 'k1';
select is(
  (select quantity_delta from public.size_count_events where idempotency_key = 'k1'),
  1, 'size_count_events is immutable (RLS has no UPDATE policy → value unchanged)');

-- 8. Per-size tally = SUM(quantity_delta) grouped by size.
select is(
  (select sum(quantity_delta)::int from public.size_count_events
   where session_id = :sess and size = 'M'),
  2, 'the M tally is 2 (two +1 events)');
select is(
  (select sum(quantity_delta)::int from public.size_count_events
   where session_id = :sess and size = 'L'),
  1, 'the L tally is 1');

-- 9. Staff A records a manual adjustment (audit row).
select lives_ok(
  $$ insert into public.size_count_adjustments
       (session_id, organization_id, size, previous_quantity, new_quantity, delta, reason, operator_id)
     values ('5c028300-0000-0000-0000-0000000000e0','5c028300-0000-0000-0000-000000000001','M',2,3,1,'miscount','5c028300-0000-0000-0000-000000000003') $$,
  'staff can record a size-tally adjustment');

-- 10. Staff A can read their own org's session.
select is(
  (select count(*)::int from public.size_count_sessions where id = :sess),
  1, 'staff A can read their org session');

-- ── As staff B (org B — a DIFFERENT org) ────────────────────────────────────
set local "request.jwt.claim.sub" to '5c028300-0000-0000-0000-000000000004';

-- 11. Staff B cannot read org A's session (RLS org isolation).
select is(
  (select count(*)::int from public.size_count_sessions where id = :sess),
  0, 'a member of a DIFFERENT org cannot read org A''s session (RLS isolation)');

-- 12. Staff B cannot append an event to org A's session.
select throws_ok(
  $$ insert into public.size_count_events
       (session_id, organization_id, idempotency_key, size, quantity_delta, counted_by)
     values ('5c028300-0000-0000-0000-0000000000e0','5c028300-0000-0000-0000-000000000001','x1','M',1,'5c028300-0000-0000-0000-000000000004') $$,
  '42501', null,
  'a member of a different org cannot append events to org A''s session (RLS)');

reset role;
select * from finish();
rollback;
