import { describe, expect, it } from 'vitest';

import {
  AMBIGUOUS_COLUMN_MEANINGS,
  AMBIGUOUS_COLUMN_MEANING_LABELS,
  BLOCKING_LINE_RESULTS,
  IMPORT_MAPPING_CONFIDENCE_THRESHOLD,
  LINE_RESULTS,
  LINE_RESULT_LABELS,
  lineCarriesSportsMapping,
  lineNeedsMappingConfirmation,
  lineResultBlocksApproval,
  SPORTS_MAPPED_LINE_FIELDS,
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

describe('lineNeedsMappingConfirmation — scoped to sports mappings', () => {
  const LOW = IMPORT_MAPPING_CONFIDENCE_THRESHOLD - 0.3;

  it('does NOT flag an ordinary scan line that mapped nothing sports-y', () => {
    // The regression this exists to prevent: the extractor emits a mapping
    // confidence for EVERY scanned line, so a bare confidence test made a
    // perfectly ordinary non-sports PO unapprovable.
    expect(lineNeedsMappingConfirmation({ mapping_confidence: LOW })).toBe(false);
  });

  it('flags the same confidence once a sports value is actually on the line', () => {
    for (const field of SPORTS_MAPPED_LINE_FIELDS) {
      expect(
        lineNeedsMappingConfirmation({ mapping_confidence: LOW, [field]: 'x' }),
        field,
      ).toBe(true);
    }
  });

  it('never flags a confident line, sports value or not', () => {
    expect(
      lineNeedsMappingConfirmation({ mapping_confidence: 0.99, jersey_number: '12' }),
    ).toBe(false);
    expect(lineNeedsMappingConfirmation({ mapping_confidence: null, jersey_number: '12' })).toBe(
      false,
    );
  });

  it('treats a blank string as no mapping at all', () => {
    // '' is how a CSV cell and the extractor both say "the document printed
    // nothing" — it is not a value someone has to confirm.
    expect(lineCarriesSportsMapping({ jersey_number: '', variant_size: '   ' })).toBe(false);
    expect(lineCarriesSportsMapping({ variant_size: 'M' })).toBe(true);
  });

  it('fires exactly at the threshold boundary and not above it', () => {
    const at = { mapping_confidence: IMPORT_MAPPING_CONFIDENCE_THRESHOLD, jersey_number: '12' };
    const below = {
      mapping_confidence: IMPORT_MAPPING_CONFIDENCE_THRESHOLD - 0.001,
      jersey_number: '12',
    };
    expect(lineNeedsMappingConfirmation(at)).toBe(false);
    expect(lineNeedsMappingConfirmation(below)).toBe(true);
  });
});
