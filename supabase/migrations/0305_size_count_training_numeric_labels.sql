-- Instant Size Count — training capture accepts NUMERIC SHOE SIZES, halves included.
--
-- 0284 pinned the ground-truth label to nine apparel letters plus NONE:
--
--   check (size_label in
--     ('XS','S','M','L','XL','XXL','XXXL','XXXXL','XXXXXL','NONE'))
--
-- The Phase 1 audit listed that CHECK as one of five inconsistent hardcoded
-- size lists. Tasks 2-19 retired the other four by pointing them at the 0294
-- `size_scales` / `size_scale_values` tables and deliberately left this one
-- alone. It stays a FORMAT rule rather than becoming a lookup, for three
-- reasons that were checked against the database, not assumed:
--
--   1. A CHECK constraint cannot hold a subquery. Postgres refuses outright:
--      "ERROR: cannot use subquery in check constraint". Validating a label
--      against size_scale_values this way is not merely awkward, it is
--      impossible.
--   2. A foreign key is not a stand-in. size_scale_values is unique on
--      (size_scale_id, normalized), and 0294 seeds '9.5' into THREE scales
--      (us_mens_shoe, us_womens_shoe, us_youth_shoe). An FK would therefore
--      need a scale_id column on every sample, forcing the capturer to declare
--      men's vs women's vs youth from a sticker on a box — the very judgement
--      the future detector exists to avoid. Scales are also org-editable, so a
--      manager pruning one would retroactively invalidate ground truth that
--      was correct when it was captured.
--   3. Nothing downstream resolves the label to a scale. Every reader treats it
--      as an opaque string key: getTrainingStats() buckets counts by it,
--      listTrainingSamples() filters with .eq('size_label', …), and the Expo
--      review grid prints it on a badge. It is a dataset annotation, never a
--      stock-bearing size. So this constraint's job is to refuse GARBAGE while
--      the scales remain the authority for anything that moves inventory.
--
-- WHAT THE NUMERIC BRANCH ALLOWS: 1 through 20, whole or half ('9', '9.5').
-- The seeded US scales span youth 1.0-7.0 and men's/women's 4.0-18.0 (union
-- 1.0-18.0); 20 adds headroom for oversize athletic footwear. 0 and 21+ are
-- typos, not sizes.
--
-- The bounds live in the REGEX rather than a `size_label::numeric between …`
-- guard on purpose. Postgres does not guarantee left-to-right evaluation of
-- AND, so a cast guarded by a regex may still be evaluated first and raise
-- 22P02 (invalid_text_representation) instead of failing cleanly as 23514 —
-- which would surface to the API as a 500 rather than a clean rejection.
--
-- The pattern also demands the CANONICAL form: '9', never '9.0' or '09'. The
-- app normalises through @stockpilot/core's normalizeTrainingSizeLabel (which
-- delegates to normalizeSizeValue, the one size normaliser) before writing, so
-- one physical size can never split into two training classes. This constraint
-- is the last line of defence that keeps that true.
--
-- The alpha branch is UNCHANGED, so every sample captured to date stays legal
-- and 0284's assertion that 'XXXXXXL' is refused still holds.
--
-- JS twin: packages/core/src/sports/size-count-labels.ts
--          (TRAINING_SIZE_LABEL_PATTERN). Keep the two in lockstep.

alter table public.size_count_training_samples
  drop constraint if exists size_count_training_samples_size_label_check;

alter table public.size_count_training_samples
  add constraint size_count_training_samples_size_label_check check (
    size_label in ('XS','S','M','L','XL','XXL','XXXL','XXXXL','XXXXXL','NONE')
    or size_label ~ '^(([1-9]|1[0-9])(\.5)?|20)$'
  );

comment on column public.size_count_training_samples.size_label is
  'Ground-truth label the capturer tapped: an apparel letter (XS-5XL), a US '
  'shoe size 1-20 in half steps (''9'', ''9.5''), or NONE for a hard negative. '
  'Stored in canonical form — normalise through @stockpilot/core''s '
  'normalizeTrainingSizeLabel before writing.';
