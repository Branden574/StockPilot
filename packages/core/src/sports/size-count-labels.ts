/**
 * Instant Size Count — TRAINING-CAPTURE ground-truth labels.
 *
 * The one place that decides what a capturer may tap as the ground truth for a
 * size-sticker photo, shared by the Expo capture screen, the review filter and
 * the API route, so the three can never disagree about what is loggable.
 *
 * WHY A FORMAT RULE AND NOT A MEMBERSHIP CHECK AGAINST `size_scale_values`
 *
 * The Phase 1 audit called 0284's hardcoded alpha CHECK one of five
 * inconsistent size lists, and Tasks 2-19 retired the others by pointing them
 * at the 0294 `size_scales` / `size_scale_values` tables. Training capture was
 * deliberately left alone, and it stays that way here for three reasons that
 * were checked, not assumed:
 *
 *   1. A Postgres CHECK constraint cannot contain a subquery — verified
 *      locally: `ERROR: cannot use subquery in check constraint`. So the DB
 *      simply cannot validate a label against another table this way.
 *   2. A foreign key is not a substitute. `size_scale_values` is unique on
 *      (size_scale_id, normalized), and 0294 seeds '9.5' into THREE scales
 *      (us_mens_shoe, us_womens_shoe, us_youth_shoe). Pointing at one row would
 *      mean the capturer had to declare men's vs women's vs youth — but they
 *      are photographing a sticker on a box, and that is exactly the judgement
 *      the future detector is supposed to avoid needing. Scales are also
 *      org-editable, so a manager pruning one would invalidate historical
 *      ground truth that was correct when it was captured.
 *   3. Nothing downstream RESOLVES the label to a scale. Every reader treats it
 *      as an opaque string key: `getTrainingStats` buckets counts by it,
 *      `listTrainingSamples` filters with `.eq('size_label', …)`, the review
 *      grid prints it on a badge. The label is a dataset annotation, not a
 *      stock-bearing size. So the storage layer's job is to refuse GARBAGE —
 *      typos, empty strings, OCR noise — while the scales stay the authority
 *      for anything that actually moves inventory.
 *
 * The numeric range mirrors 0294's seeded US scales (youth 1.0-7.0, men's and
 * women's 4.0-18.0, union 1.0-18.0) so every size the app already knows about
 * is loggable.
 */

import { normalizeSizeValue } from './variant-keys';

/**
 * Letter apparel sizes — byte-for-byte the nine the capture screen has offered
 * since 0284, in wearing order.
 *
 * Deliberately NOT widened to the 2XL/3XL spellings or the 6XL that
 * `size-order.ts` can sort. This list is a ground-truth vocabulary for a
 * detector: two spellings of one physical size would split the training set in
 * half and teach the model that 'XXL' and '2XL' are different classes. 0284's
 * pgTAP asserts 'XXXXXXL' is refused; that assertion still holds.
 */
export const APPAREL_TRAINING_LABELS = [
  'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL', 'XXXXXL',
] as const;
export type ApparelTrainingLabel = (typeof APPAREL_TRAINING_LABELS)[number];

/** The hard negative: a button, logo or neck tag the detector must ignore. */
export const TRAINING_NEGATIVE_LABEL = 'NONE';

/**
 * Numeric shoe range, expressed in HALF STEPS so the series is exact.
 *
 * Counting in halves (and dividing at print time) is the same trick 0294 uses
 * in SQL, and for the same reason: stepping a float by 0.5 and formatting it
 * produces '9' for some values and '9.0' or '9.5000000001' for others.
 */
const SHOE_MIN_HALF_STEPS = 2; // 1.0
const SHOE_MAX_HALF_STEPS = 36; // 18.0

/** Print one half-step count as a size scales-style label: '9', '9.5'. */
function halfStepsToLabel(halfSteps: number): string {
  const whole = Math.floor(halfSteps / 2);
  return halfSteps % 2 === 1 ? `${whole}.5` : `${whole}`;
}

/**
 * US shoe sizes, 1 through 18 in half steps — the union of the three US scales
 * 0294 seeds. Generated rather than typed out so it cannot drift by typo.
 */
export const SHOE_TRAINING_LABELS: readonly string[] = Array.from(
  { length: SHOE_MAX_HALF_STEPS - SHOE_MIN_HALF_STEPS + 1 },
  (_, i) => halfStepsToLabel(SHOE_MIN_HALF_STEPS + i),
);

/**
 * The format a stored label must match — the JS twin of migration 0305's CHECK.
 * Keep the two in lockstep; `size-count-labels.sql.test.ts` has no way to read
 * the database, so the migration quotes this pattern in a comment.
 *
 * Numeric branch: 1 through 20, whole or half. Bounds are encoded in the regex
 * itself rather than a `::numeric` cast because Postgres does not guarantee
 * left-to-right AND evaluation, so a cast guarded by a regex could still raise
 * 22P02 (invalid_text_representation) instead of failing the check cleanly as
 * 23514. 20 is the seeded ceiling of 18 plus headroom for oversize athletic
 * footwear; 0 and 21+ are typos, not sizes.
 */
export const TRAINING_SIZE_LABEL_PATTERN = /^(([1-9]|1[0-9])(\.5)?|20)$/;

const ALPHA_LABELS: ReadonlySet<string> = new Set<string>([
  ...APPAREL_TRAINING_LABELS,
  TRAINING_NEGATIVE_LABEL,
]);

/**
 * Is this EXACTLY a storable label? Takes the already-canonical form — call
 * `normalizeTrainingSizeLabel` first if the value came from a user or a wire.
 */
export function isTrainingSizeLabel(raw: string | null | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ALPHA_LABELS.has(raw) || TRAINING_SIZE_LABEL_PATTERN.test(raw);
}

/**
 * Canonicalise a label to the one form that gets stored, or null if it is not
 * a legal label at all.
 *
 * Normalisation is delegated to `normalizeSizeValue` — the ONE size normaliser
 * — so a training label and a variant size agree on what '9.0', '09' and ' xl '
 * mean. Without that, '9.0' and '9' would become two training classes for one
 * physical size.
 */
export function normalizeTrainingSizeLabel(raw: string | null | undefined): string | null {
  const normalized = normalizeSizeValue(raw);
  if (normalized === null) return null;
  return isTrainingSizeLabel(normalized) ? normalized : null;
}

/** One selectable vocabulary on the capture screen. */
export interface TrainingLabelSet {
  key: 'apparel' | 'shoes';
  /** Toggle text. Kept short — the toggle sits in the camera tool row. */
  name: string;
  labels: readonly string[];
}

/**
 * The sets the capture screen toggles between.
 *
 * Apparel is FIRST and is the screen's default, so an existing capturer sees
 * exactly the screen they saw yesterday until they choose to switch.
 */
export const TRAINING_LABEL_SETS: readonly TrainingLabelSet[] = [
  { key: 'apparel', name: 'Apparel', labels: [...APPAREL_TRAINING_LABELS] },
  { key: 'shoes', name: 'Shoes', labels: SHOE_TRAINING_LABELS },
];

/** Every label any set offers, plus NONE — the review screen's filter row. */
export const ALL_TRAINING_LABELS: readonly string[] = [
  ...APPAREL_TRAINING_LABELS,
  ...SHOE_TRAINING_LABELS,
  TRAINING_NEGATIVE_LABEL,
];
