-- supabase/tests/0284_size_count_training.test.sql
-- Proves migration 0284: size-count training-sample capture table + RLS.
--   • table exists; the size_label CHECK rejects an unknown label,
--   • a staff member can insert a labeled sample (+ a NONE hard negative),
--   • a member of a DIFFERENT org cannot read this org's samples (RLS).
--
-- Namespace: 5c028400. Wrapped in begin/rollback.

begin;

select plan(6);

\set orgA  '\'5c028400-0000-0000-0000-000000000001\''
\set orgB  '\'5c028400-0000-0000-0000-000000000002\''
\set stfA  '\'5c028400-0000-0000-0000-000000000003\''
\set stfB  '\'5c028400-0000-0000-0000-000000000004\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:stfA, 'stfA-0284@test.local', '{}'::jsonb),
  (:stfB, 'stfB-0284@test.local', '{}'::jsonb) on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:orgA, 'Train Org A 0284', 'train-org-a-0284'),
  (:orgB, 'Train Org B 0284', 'train-org-b-0284') on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :stfA, 'staff', now()),
  (:orgB, :stfB, 'staff', now()) on conflict do nothing;
-- user_profiles rows for the captured_by FK (on delete restrict).
insert into public.user_profiles (id, email) values
  (:stfA, 'stfA-0284@test.local'),
  (:stfB, 'stfB-0284@test.local') on conflict (id) do nothing;

-- 1. Table exists.
select has_table('public', 'size_count_training_samples', 'training samples table exists');

-- ── As staff A (org A) ──────────────────────────────────────────────────────
set local "request.jwt.claim.sub" to '5c028400-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- 2. A labeled positive sample inserts.
select lives_ok(
  $$ insert into public.size_count_training_samples
       (organization_id, captured_by, image_storage_path, size_label)
     values ('5c028400-0000-0000-0000-000000000001',
             '5c028400-0000-0000-0000-000000000003',
             '5c028400-0000-0000-0000-000000000001/a.jpg', 'L') $$,
  'staff can insert a labeled training sample');

-- 3. A hard negative (NONE) inserts.
select lives_ok(
  $$ insert into public.size_count_training_samples
       (organization_id, captured_by, image_storage_path, size_label, is_negative)
     values ('5c028400-0000-0000-0000-000000000001',
             '5c028400-0000-0000-0000-000000000003',
             '5c028400-0000-0000-0000-000000000001/b.jpg', 'NONE', true) $$,
  'staff can insert a NONE hard-negative sample');

-- 4. An unknown size_label is rejected by the CHECK.
select throws_ok(
  $$ insert into public.size_count_training_samples
       (organization_id, captured_by, image_storage_path, size_label)
     values ('5c028400-0000-0000-0000-000000000001',
             '5c028400-0000-0000-0000-000000000003',
             '5c028400-0000-0000-0000-000000000001/c.jpg', 'XXXXXXL') $$,
  '23514', null,
  'an unknown size_label is rejected by the CHECK constraint');

-- 5. Staff A reads their org's samples.
select is(
  (select count(*)::int from public.size_count_training_samples
   where organization_id = :orgA),
  2, 'staff A sees both org-A samples');

-- ── As staff B (org B) ──────────────────────────────────────────────────────
set local "request.jwt.claim.sub" to '5c028400-0000-0000-0000-000000000004';

-- 6. Staff B cannot read org A's samples (RLS isolation).
select is(
  (select count(*)::int from public.size_count_training_samples
   where organization_id = :orgA),
  0, 'a member of a different org cannot read org A''s training samples');

reset role;
select * from finish();
rollback;
