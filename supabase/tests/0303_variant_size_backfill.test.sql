-- supabase/tests/0303_variant_size_backfill.test.sql
--
-- Proves migration 0303: the STORED size in custom_fields is copied into the
-- indexed variant_size column, rows a human must look at are flagged, and
-- NOTHING ELSE MOVES.
--
-- The headline assertion is #14: group_id is NULL for every backfilled row.
-- Owner decision 2026-07-27 — "existing families link via a bulk review tool
-- the owner drives. NO name-heuristic auto-backfill" — because a wrong guess
-- would bake a wrong grouping into persistent identity. This file is the proof
-- that 0303 never guesses a group, in either direction: it neither invents a
-- link for an ungrouped row nor disturbs one that already exists.
--
-- The migration already ran during `supabase db reset`, before these fixtures
-- existed, so the test re-invokes the SAME function the migration called
-- (public._backfill_variant_size) against its own rows — the real statements,
-- not a transcription of them. Same shape as 0293's test.
--
-- Fixtures (nine items in one org; one product group):
--   i1  'Team Shirt - XL'      cf {"size":"XL", ...}  ungrouped -> XL, sized_but_ungrouped
--   i2  'Loose Shirt'          cf {"size":"  xl  "}             -> XL, original VERBATIM
--   i3  'Plain Widget'         cf {}                            -> untouched, no flag
--   i4  'Odd Sized Thing'      cf {"size": 31 chars}            -> ambiguous_size
--   i5  'Grouped Shirt - M'    cf {"size":"M"}     GROUPED      -> M, group kept, no flag
--   i6  'Falcons Jersey - XL'  cf {"size":"L"}                  -> L, name_size_conflict
--   i7  'Deleted Shirt - S'    cf {"size":"S"}     soft-deleted -> untouched
--   i8  'Preset Shirt'         cf {"size":"XXL"}   variant_size already 'L'
--                                                                -> NOT overwritten
--   i9  'Numeric Size'         cf {"size": 10}     jsonb NUMBER  -> ambiguous_size
--   i10 'Cased Shirt - XL'     variant_size 'xl' (lowercase)     -> NOT a conflict
--
-- Assertion index (31):
--    1  fixture sanity: exactly two rows already carry a variant_size
--    2  fixture sanity: exactly one row is grouped
--    3  the backfill runs
--    4  i1 variant_size = 'XL'
--    5  i1 variant_size_original = 'XL'
--    6  i2 variant_size is NORMALIZED (upper + trim)
--    7  i2 variant_size_original is VERBATIM (whitespace and case kept)
--    8  i1 custom_fields is byte-identical to what it was
--    9  NO row's custom_fields changed at all (rollback safety: the source survives)
--   10  i3 (no stored size) keeps a NULL variant_size
--   11  i3 gets no flag
--   12  i8's pre-existing variant_size is NOT overwritten
--   13  ...and its variant_size_original stays NULL (nothing half-written)
--   14  HEADLINE: no row's group_id changed — no link invented, none disturbed
--   15  ...and the only grouped row is still the one seeded that way
--   16  i5 keeps its group
--   17  i1 is flagged sized_but_ungrouped
--   18  i5 (grouped) is NOT flagged sized_but_ungrouped
--   19  i4 (over-long stored size) is flagged ambiguous_size
--   20  ...and got no variant_size out of it
--   21  i9 (non-string stored size) is flagged ambiguous_size
--   22  i6 (name suffix disagrees with the stored size) is flagged name_size_conflict
--   23  i7 (soft-deleted) is untouched
--   24  quantity_on_hand is unchanged on every row
--   25  ZERO stock_movements rows were written
--   26  updated_at was NOT bumped (0242 discipline: this is a derived write)
--   27  ...and a REAL edit still bumps updated_at (the escape hatch is off by default)
--   28  IDEMPOTENT: a second run changes no value
--   29  ...and still does not bump updated_at
--   30  the flag CHECK rejects a value outside the vocabulary
--   31  a name/size pair differing only in CASE is not a conflict
--
-- Namespace: bf302000. Wrapped in begin/rollback -- nothing leaks.

begin;

select plan(31);

\set org  '\'bf302000-0000-0000-0000-000000000001\''
\set usr  '\'bf302000-0000-0000-0000-000000000002\''
\set wh   '\'bf302000-0000-0000-0000-000000000003\''
\set grp  '\'bf302000-0000-0000-0000-0000000000a1\''
\set i1   '\'bf302000-0000-0000-0000-000000000011\''
\set i2   '\'bf302000-0000-0000-0000-000000000012\''
\set i3   '\'bf302000-0000-0000-0000-000000000013\''
\set i4   '\'bf302000-0000-0000-0000-000000000014\''
\set i5   '\'bf302000-0000-0000-0000-000000000015\''
\set i6   '\'bf302000-0000-0000-0000-000000000016\''
\set i7   '\'bf302000-0000-0000-0000-000000000017\''
\set i8   '\'bf302000-0000-0000-0000-000000000018\''
\set i9   '\'bf302000-0000-0000-0000-000000000019\''
\set i10  '\'bf302000-0000-0000-0000-00000000001a\''

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixtures (seeded as superuser — RLS is NOT active during this block).
-- Every item carries a fixed PAST updated_at so a bump is unambiguous. INSERT
-- does not fire the BEFORE UPDATE trigger, so the seeded value sticks.
-- ─────────────────────────────────────────────────────────────────────────────

insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'bf-0303@test.local', '{}'::jsonb) on conflict (id) do nothing;

insert into public.organizations (id, name, slug)
  values (:org, 'Backfill Org 0303', 'backfill-org-0303') on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :usr, 'manager', now()) on conflict do nothing;

insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'BF WH 0303', 'WH-BF-0303', 'active') on conflict (id) do nothing;

insert into public.product_groups
  (id, organization_id, name, brand, model, group_key, default_counting_unit)
  values (:grp, :org, 'Grouped Shirt', 'Acme', 'Shirt', 'apparel|acme|shirt||', 'each')
  on conflict (id) do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status,
   tracking_type, custom_fields, group_id, variant_size, deleted_at, updated_at)
values
  (:i1, :org, :wh, 'BF-0303-1', 'Team Shirt - XL',     7, 'active', 'none',
   '{"size":"XL","rack_number":"22"}'::jsonb, null, null, null, '2020-01-01 00:00:00+00'),
  (:i2, :org, :wh, 'BF-0303-2', 'Loose Shirt',        11, 'active', 'none',
   '{"size":"  xl  "}'::jsonb,                null, null, null, '2020-01-01 00:00:00+00'),
  (:i3, :org, :wh, 'BF-0303-3', 'Plain Widget',        3, 'active', 'none',
   '{}'::jsonb,                               null, null, null, '2020-01-01 00:00:00+00'),
  (:i4, :org, :wh, 'BF-0303-4', 'Odd Sized Thing',     1, 'active', 'none',
   '{"size":"EXTRA LARGE TALL LONG SLEEVE"}'::jsonb,
                                              null, null, null, '2020-01-01 00:00:00+00'),
  (:i5, :org, :wh, 'BF-0303-5', 'Grouped Shirt - M',   4, 'active', 'none',
   '{"size":"M"}'::jsonb,                     :grp, null, null, '2020-01-01 00:00:00+00'),
  (:i6, :org, :wh, 'BF-0303-6', 'Falcons Jersey - XL', 2, 'active', 'none',
   '{"size":"L"}'::jsonb,                     null, null, null, '2020-01-01 00:00:00+00'),
  (:i7, :org, :wh, 'BF-0303-7', 'Deleted Shirt - S',   9, 'active', 'none',
   '{"size":"S"}'::jsonb,                     null, null, now(), '2020-01-01 00:00:00+00'),
  (:i8, :org, :wh, 'BF-0303-8', 'Preset Shirt',        6, 'active', 'none',
   '{"size":"XXL"}'::jsonb,                   null, 'L',  null, '2020-01-01 00:00:00+00'),
  (:i9, :org, :wh, 'BF-0303-9', 'Numeric Size',        5, 'active', 'none',
   '{"size": 10}'::jsonb,                     null, null, null, '2020-01-01 00:00:00+00'),
  (:i10, :org, :wh, 'BF-0303-10', 'Cased Shirt - XL',  8, 'active', 'none',
   '{}'::jsonb,                               null, 'xl', null, '2020-01-01 00:00:00+00');

-- Byte-exact snapshot of everything the backfill must NOT move.
create temp table bf_before as
  select id, custom_fields, quantity_on_hand, group_id, updated_at
    from public.inventory_items where organization_id = :org;

-- 1-2. Fixture sanity. Without these the file could pass vacuously.
select is(
  (select count(*)::int from public.inventory_items
    where organization_id = :org and variant_size is not null),
  2,
  'fixture: exactly two rows already carry a variant_size (i8, i10)');

select is(
  (select count(*)::int from public.inventory_items
    where organization_id = :org and group_id is not null),
  1,
  'fixture: exactly one row is grouped (i5)');

-- 3. Re-run the migration's own statements over these fixtures.
select lives_ok(
  $$ select public._backfill_variant_size() $$,
  'the backfill runs');

-- ── The copy ────────────────────────────────────────────────────────────────

-- 4-5. The plain case: 'XL' in, 'XL' out, original recorded.
select is(
  (select variant_size from public.inventory_items where id = :i1),
  'XL',
  'a stored custom_fields.size of XL lands in variant_size');

select is(
  (select variant_size_original from public.inventory_items where id = :i1),
  'XL',
  'variant_size_original records the source verbatim');

-- 6-7. Normalization touches ONLY the indexed column. The original is the
--      audit trail against the source and is never cleaned up.
select is(
  (select variant_size from public.inventory_items where id = :i2),
  'XL',
  'variant_size is normalized (upper + trim)');

select is(
  (select variant_size_original from public.inventory_items where id = :i2),
  '  xl  ',
  'variant_size_original is VERBATIM — whitespace and case survive');

-- ── custom_fields is never mutated (the rollback guarantee) ─────────────────

-- 8-9. This is what makes 0303 reversible: the source of every backfilled
--      value is still sitting in custom_fields, untouched.
select is(
  (select custom_fields from public.inventory_items where id = :i1),
  '{"size":"XL","rack_number":"22"}'::jsonb,
  'custom_fields is UNCHANGED, sibling keys and all');

select is(
  (select count(*)::int from public.inventory_items i
     join bf_before b on b.id = i.id
    where i.custom_fields is distinct from b.custom_fields),
  0,
  'NOT ONE row had its custom_fields modified');

-- ── What is deliberately left alone ─────────────────────────────────────────

-- 10-11. No stored size = nothing to copy and nothing to review.
select is(
  (select variant_size from public.inventory_items where id = :i3),
  null::text,
  'an item with no custom_fields.size keeps a NULL variant_size');

select is(
  (select sports_review_flag from public.inventory_items where id = :i3),
  null::text,
  '...and is not flagged for review');

-- 12-13. Never overwrite a size the app already wrote first-class.
select is(
  (select variant_size from public.inventory_items where id = :i8),
  'L',
  'an existing variant_size is NOT overwritten by a differing custom_fields.size');

select is(
  (select variant_size_original from public.inventory_items where id = :i8),
  null::text,
  '...and no half-written original is left behind');

-- ── HEADLINE: the anti-inference assertion ──────────────────────────────────

-- 14. THE assertion this migration exists to satisfy. Every backfilled row
--     keeps the group_id it had — which for every historical row is NULL.
--     Grouping is opt-in through /dashboard/product-groups/link, never here.
select is(
  (select count(*)::int from public.inventory_items i
     join bf_before b on b.id = i.id
    where i.group_id is distinct from b.group_id),
  0,
  'HEADLINE: group_id is untouched on every row — the backfill never infers a group');

-- 15-16. Stated the other way round, so a future refactor that starts guessing
--        trips both spellings.
select is(
  (select count(*)::int from public.inventory_items
    where organization_id = :org and group_id is not null),
  1,
  'still exactly one grouped row — no link was invented for the eight ungrouped ones');

select is(
  (select group_id from public.inventory_items where id = :i5),
  :grp::uuid,
  'the row that WAS grouped keeps its group');

-- ── The review queue ────────────────────────────────────────────────────────

-- 17-18. sized_but_ungrouped is exactly the linking-candidate set Task 18 reads.
select is(
  (select sports_review_flag from public.inventory_items where id = :i1),
  'sized_but_ungrouped',
  'a sized, ungrouped item is flagged as a linking candidate');

select is(
  (select sports_review_flag from public.inventory_items where id = :i5),
  null::text,
  'an already-grouped item is NOT a linking candidate');

-- 19-21. Unparseable stored sizes go to a human, never to a guess.
select is(
  (select sports_review_flag from public.inventory_items where id = :i4),
  'ambiguous_size',
  'a stored size too long to be a real size is flagged ambiguous_size');

select is(
  (select variant_size from public.inventory_items where id = :i4),
  null::text,
  '...and nothing was truncated into variant_size to make it fit');

select is(
  (select sports_review_flag from public.inventory_items where id = :i9),
  'ambiguous_size',
  'a NON-STRING stored size is flagged ambiguous_size, not coerced');

-- 22. Two sources already disagree — flag it rather than silently trust either.
select is(
  (select sports_review_flag from public.inventory_items where id = :i6),
  'name_size_conflict',
  'a name suffix that disagrees with the stored size is flagged');

-- 23. Soft-deleted rows are not part of anyone's inventory.
select is(
  (select count(*)::int from public.inventory_items
    where id = :i7 and variant_size is null and sports_review_flag is null),
  1,
  'a soft-deleted row is left completely untouched');

-- ── The ledger, and the surfaces a backfill must not spam ───────────────────

-- 24-25. The ledger invariant is absolute: this migration writes no quantity
--        column and no movement row, so SUM(movements) = quantity_on_hand
--        still holds trivially for every touched item.
select is(
  (select count(*)::int from public.inventory_items i
     join bf_before b on b.id = i.id
    where i.quantity_on_hand is distinct from b.quantity_on_hand),
  0,
  'quantity_on_hand is unchanged on every row');

select is(
  (select count(*)::int from public.stock_movements
    where organization_id = :org),
  0,
  'ZERO stock_movements rows were written');

-- 26. 0242 discipline. A backfill is a derived write: bumping updated_at on
--     every sized item in the org would light up every "recently changed"
--     surface and force a full mobile re-sync for a change no human made.
select is(
  (select count(*)::int from public.inventory_items i
     join bf_before b on b.id = i.id
    where i.updated_at is distinct from b.updated_at),
  0,
  'updated_at was NOT bumped by the backfill');

-- 27. ...and the escape hatch that buys us #26 is OFF for everybody else, so a
--     genuine edit still looks like one.
update public.inventory_items set name = 'Team Shirt - XL (edited)' where id = :i1;

select isnt(
  (select updated_at from public.inventory_items where id = :i1),
  '2020-01-01 00:00:00+00'::timestamptz,
  'a REAL edit still bumps updated_at (0242 is intact)');

-- ── Idempotence ─────────────────────────────────────────────────────────────

-- 28-29. Re-running is a no-op. This is what makes the migration safe to
--        re-apply and safe to run in a rehearsal before the real push.
create temp table bf_after_first as
  select id, variant_size, variant_size_original, sports_review_flag,
         custom_fields, quantity_on_hand, group_id, updated_at
    from public.inventory_items where organization_id = :org;

select lives_ok(
  $$ select public._backfill_variant_size() $$,
  'a second run is accepted');

select is(
  (select count(*)::int from public.inventory_items i
     join bf_after_first a on a.id = i.id
    where (i.variant_size,          i.variant_size_original, i.sports_review_flag,
           i.custom_fields,         i.quantity_on_hand,      i.group_id,
           i.updated_at)
       is distinct from
          (a.variant_size,          a.variant_size_original, a.sports_review_flag,
           a.custom_fields,         a.quantity_on_hand,      a.group_id,
           a.updated_at)),
  0,
  'IDEMPOTENT: the second run changed nothing, updated_at included');

-- 30. The flag vocabulary is closed. A typo in a future tool is a hard error,
--     not a silently unreadable review queue.
select throws_ok(
  format($$ update public.inventory_items set sports_review_flag = 'probably_fine' where id = %L $$, :i3),
  '23514',
  null,
  'the flag CHECK rejects a value outside the vocabulary');

-- 31. 'xl' against a name ending in 'XL' is not a disagreement about the SIZE.
--     Flagging it would fill the review queue with clean rows, so the conflict
--     test folds case on both sides. The row is still a linking candidate.
select is(
  (select sports_review_flag from public.inventory_items where id = :i10),
  'sized_but_ungrouped',
  'a name/size pair differing only in CASE is not a conflict');

select * from finish();
rollback;
