-- 0319_shoe_scale_add_3_and_3_5.sql
--
-- Adds US Men's shoe sizes 3 and 3.5 to the built-in shoe size scale.
--
-- Owner request (2026-08-07): the shoe size picker started at 4, but L4L stocks
-- smaller youth/small-adult sizes. The 0294 seed ran 4 -> 18 in half steps.
--
-- Scale: 'US Men's shoe', id 5ca1e000-0000-0000-0000-000000000002. It is a
-- BUILT-IN scale (organization_id is null), so this addition reaches every org
-- rather than one tenant — which is what "the canonical US men's run" should
-- mean. Nothing is removed and no existing row's sort_order moves, so no item's
-- stored size can be orphaned by this change.
--
-- Column conventions verified against the live 0294 rows rather than assumed:
--   * normalized  — NOT NULL, no default, NOT generated: must be supplied.
--                   For numeric shoe values it mirrors `value` verbatim
--                   ('4' -> '4', '4.5' -> '4.5'). It is the uniqueness key:
--                   size_scale_values_size_scale_id_normalized_key is
--                   UNIQUE (size_scale_id, normalized) — note NOT (.., value) —
--                   so the conflict target below must name `normalized`.
--   * is_half     — true on the .5 steps (4.5/5.5/6.5 are all true).
--   * sort_order  — value * 10 (4 -> 40, 4.5 -> 45), keeping halves adjacent to
--                   their whole size. 3 -> 30 and 3.5 -> 35 continue that and
--                   sort ahead of 4 with no renumbering.
--
-- Idempotent: on conflict (size_scale_id, normalized) do nothing, so a re-run
-- and a fresh `supabase db reset` both land these two rows exactly once.

insert into public.size_scale_values (size_scale_id, value, normalized, sort_order, is_half)
values
  ('5ca1e000-0000-0000-0000-000000000002', '3',   '3',   30, false),
  ('5ca1e000-0000-0000-0000-000000000002', '3.5', '3.5', 35, true)
on conflict (size_scale_id, normalized) do nothing;
