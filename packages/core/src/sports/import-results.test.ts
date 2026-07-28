import { describe, expect, it } from 'vitest';

import {
  AMBIGUOUS_COLUMN_MEANINGS,
  AMBIGUOUS_COLUMN_MEANING_LABELS,
  BLOCKING_LINE_RESULTS,
  IMPORT_MAPPING_CONFIDENCE_THRESHOLD,
  LINE_RESULTS,
  LINE_RESULT_LABELS,
  lineResultBlocksApproval,
} from './import-results';

describe('import review vocabulary', () => {
  it('labels every result, so the table can never render a bare code', () => {
    for (const r of LINE_RESULTS) {
      expect(LINE_RESULT_LABELS[r], r).toBeTruthy();
    }
    expect(Object.keys(LINE_RESULT_LABELS)).toHaveLength(LINE_RESULTS.length);
  });

  it('never labels a result "Valid" or "Invalid"', () => {
    for (const label of Object.values(LINE_RESULT_LABELS)) {
      expect(label.toLowerCase()).not.toBe('valid');
      expect(label.toLowerCase()).not.toBe('invalid');
    }
  });

  it('blocks approval on every ambiguous or incomplete verdict', () => {
    for (const r of [
      'possible_duplicate',
      'missing_required_attribute',
      'ambiguous_category',
      'ambiguous_variant_match',
      'serial_required',
      'mapping_review_required',
    ] as const) {
      expect(lineResultBlocksApproval(r), r).toBe(true);
    }
  });

  it('does not block a decided outcome', () => {
    for (const r of [
      'ready',
      'create_new_group',
      'add_new_variant',
      'receive_into_existing_variant',
      'create_serialized_units',
    ] as const) {
      expect(lineResultBlocksApproval(r), r).toBe(false);
    }
    expect(BLOCKING_LINE_RESULTS.size).toBe(6);
  });

  it('keeps the mapping-confidence gate at 0.7', () => {
    expect(IMPORT_MAPPING_CONFIDENCE_THRESHOLD).toBe(0.7);
  });

  it('offers every meaning a bare "Number" column could carry, plus ignore', () => {
    expect(AMBIGUOUS_COLUMN_MEANINGS).toEqual([
      'jersey_number',
      'quantity',
      'serial',
      'style_number',
      'line_number',
      'ignore',
    ]);
    for (const m of AMBIGUOUS_COLUMN_MEANINGS) {
      expect(AMBIGUOUS_COLUMN_MEANING_LABELS[m], m).toBeTruthy();
    }
  });
});
