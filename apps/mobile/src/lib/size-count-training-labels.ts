/**
 * Which ground-truth labels the TRAINING-CAPTURE screen offers, and which the
 * review screen can filter by.
 *
 * Pure — no React, no network — so it can be unit-tested directly, the same
 * posture as `size-count-chips.ts` next door.
 *
 * Note the two are NOT the same problem, despite both being "size chips".
 * `size-count-chips.ts` serves the TALLY screen, where the chips come from the
 * counted product group's own size scale (migration 0302). This module serves
 * the training capture screen, where there is no product group at all — the
 * capturer is photographing a sticker to teach a detector, and the label is a
 * dataset annotation rather than a stock-bearing size. So the vocabulary here
 * is the fixed shared one from @stockpilot/core, which the API route and
 * migration 0305's CHECK also derive from.
 */

import {
  ALL_TRAINING_LABELS,
  TRAINING_LABEL_SETS,
  type TrainingLabelSet,
} from '@stockpilot/core';

export type TrainingLabelSetKey = TrainingLabelSet['key'];

/** Apparel — byte-for-byte the row this screen showed before shoes existed, so
 *  an existing capturer sees no change until they choose to switch. */
export const DEFAULT_TRAINING_LABEL_SET_KEY: TrainingLabelSetKey = TRAINING_LABEL_SETS[0]!.key;

/**
 * The set for a key, falling back to the default for anything unrecognised.
 *
 * The fallback is load-bearing, not defensive noise: a stale key would render
 * an empty chip row, which leaves the shutter with nothing to tap and no
 * visible way to recover.
 */
export function resolveTrainingLabelSet(key: TrainingLabelSetKey): TrainingLabelSet {
  return TRAINING_LABEL_SETS.find((s) => s.key === key) ?? TRAINING_LABEL_SETS[0]!;
}

/** The next vocabulary in the cycle — the toggle wraps, so it cannot dead-end. */
export function nextTrainingLabelSetKey(key: TrainingLabelSetKey): TrainingLabelSetKey {
  const i = TRAINING_LABEL_SETS.findIndex((s) => s.key === key);
  // findIndex returns -1 for an unknown key, which lands the cycle back at 0.
  return TRAINING_LABEL_SETS[(i + 1) % TRAINING_LABEL_SETS.length]!.key;
}

/**
 * The review screen's filter row: ALL, then every label any set can produce.
 *
 * Derived rather than hand-listed. A hand-listed row is exactly how numeric
 * captures would become invisible — stored correctly, and reachable only under
 * ALL by someone auditing the dataset.
 */
export function buildTrainingFilters(): string[] {
  return ['ALL', ...ALL_TRAINING_LABELS];
}
