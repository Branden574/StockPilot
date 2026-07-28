-- supabase/tests/0305_size_count_training_numeric_labels.test.sql
-- Proves migration 0305: the training-sample size_label CHECK accepts NUMERIC
-- shoe sizes (half sizes included) alongside the alpha apparel labels 0284
-- shipped.
--   • every alpha label 0284 allowed still inserts (no existing capture
--     becomes illegal), and NONE still works,
--   • '9.5' round-trips EXACTLY — not rounded to 9 or 10, not stored as '9.50',
--   • whole and boundary numerics insert,
--   • garbage ('9.55', 'abc', '', '0', '21', non-canonical '9.0'/'09') is
--     refused with 23514 — a check violation, never a cast error.
--
-- Namespace: 5c030500. Wrapped in begin/rollback.

begin;

-- 10 alpha + 1 half-size insert + 1 round-trip + 4 numeric + 8 garbage = 24.
select plan(24);

\set orgA  '\'5c030500-0000-0000-0000-000000000001\''
\set stfA  '\'5c030500-0000-0000-0000-000000000003\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:stfA, 'stfA-0305@test.local', '{}'::jsonb) on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:orgA, 'Train Org A 0305', 'train-org-a-0305') on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :stfA, 'staff', now()) on conflict do nothing;
insert into public.user_profiles (id, email) values
  (:stfA, 'stfA-0305@test.local') on conflict (id) do nothing;

set local "request.jwt.claim.sub" to '5c030500-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ── 1-10. Every alpha label 0284 allowed still inserts ──────────────────────
-- Widening a CHECK must never narrow it. Each of the ten is asserted
-- individually so a regression names the exact label that broke.
select lives_ok(
  format(
    $$ insert into public.size_count_training_samples
         (organization_id, captured_by, image_storage_path, size_label, is_negative)
       values ('5c030500-0000-0000-0000-000000000001',
               '5c030500-0000-0000-0000-000000000003',
               '5c030500-0000-0000-0000-000000000001/alpha-%s.jpg', %L, %L) $$,
    lbl, lbl, lbl = 'NONE'),
  format('the 0284 alpha label %s still inserts', lbl))
from unnest(array['XS','S','M','L','XL','XXL','XXXL','XXXXL','XXXXXL','NONE']) as lbl;

-- ── 11. A half size inserts ─────────────────────────────────────────────────
select lives_ok(
  $$ insert into public.size_count_training_samples
       (organization_id, captured_by, image_storage_path, size_label)
     values ('5c030500-0000-0000-0000-000000000001',
             '5c030500-0000-0000-0000-000000000003',
             '5c030500-0000-0000-0000-000000000001/half.jpg', '9.5') $$,
  'a half shoe size (9.5) inserts');

-- ── 12. …and round-trips EXACTLY, neither rounded nor reformatted ───────────
select is(
  (select size_label from public.size_count_training_samples
    where image_storage_path = '5c030500-0000-0000-0000-000000000001/half.jpg'),
  '9.5',
  '9.5 round-trips exactly — not rounded to 9 or 10, not stored as 9.50');

-- ── 13-16. Whole and boundary numerics insert ──────────────────────────────
select lives_ok(
  format(
    $$ insert into public.size_count_training_samples
         (organization_id, captured_by, image_storage_path, size_label)
       values ('5c030500-0000-0000-0000-000000000001',
               '5c030500-0000-0000-0000-000000000003',
               '5c030500-0000-0000-0000-000000000001/num-%s.jpg', %L) $$,
    lbl, lbl),
  format('the numeric label %s inserts', lbl))
from unnest(array['1','9','10.5','20']) as lbl;

-- ── 17-24. Garbage is refused as a CHECK violation ─────────────────────────
-- 23514 specifically: a `size_label::numeric` guard could raise 22P02 instead
-- (Postgres does not guarantee AND short-circuits), which the API would surface
-- as a 500. Asserting the SQLSTATE is what pins that down.
--
-- '9.0' is refused deliberately: the canonical form is '9', and admitting both
-- would split one physical size into two training classes.
select throws_ok(
  format(
    $$ insert into public.size_count_training_samples
         (organization_id, captured_by, image_storage_path, size_label)
       values ('5c030500-0000-0000-0000-000000000001',
               '5c030500-0000-0000-0000-000000000003',
               '5c030500-0000-0000-0000-000000000001/bad.jpg', %L) $$,
    lbl),
  '23514', null,
  format('the garbage label %L is refused by the CHECK', lbl))
from unnest(array['9.55','abc','','0','21','9.0','09','XXXXXXL']) as lbl;

reset role;
select * from finish();
rollback;
