import { describe, expect, it } from 'vitest';

import {
  CASE_TABLE_STEPS,
  normalizeChecklistResults,
  normalizeChecklistSteps,
} from './receiving-checklist';
import {
  checklistDraftsEqual,
  checklistDraftsFrom,
  checklistEditorStepsFrom,
  checklistPublishPayload,
  checklistResultsFromDrafts,
  moveChecklistStep,
} from './receiving-checklist-drafts';

const STEPS = [...CASE_TABLE_STEPS];

describe('checklistDraftsFrom and checklistResultsFromDrafts', () => {
  it('round-trips what a run holds', () => {
    const results = {
      s1: { value: 'fail' as const, note: 'Two boxes crushed' },
      s3: { value: 12 },
      s4: { value: 'Short one carton' },
    };
    const drafts = checklistDraftsFrom(STEPS, results);
    expect(drafts.s1).toEqual({ value: 'fail', note: 'Two boxes crushed' });
    expect(drafts.s3).toEqual({ value: '12', note: '' });
    expect(drafts.s2).toEqual({ value: '', note: '' });
    expect(checklistResultsFromDrafts(STEPS, drafts)).toEqual(results);
  });

  // Mutation caught: a count parsed with Number() (" 1.5 " became 1.5, and
  // "12abc" NaN), so the form guessed instead of the server naming the step.
  it('sends a count as a number only when it is whole, so a typo is refused by name', () => {
    expect(checklistResultsFromDrafts(STEPS, { s3: { value: ' 12 ', note: '' } })).toEqual({
      s3: { value: 12 },
    });
    expect(checklistResultsFromDrafts(STEPS, { s3: { value: '1.5', note: '' } })).toEqual({
      s3: { value: '1.5' },
    });
    const refused = normalizeChecklistResults(
      STEPS,
      checklistResultsFromDrafts(STEPS, { s3: { value: '1.5', note: '' } }),
    );
    expect(refused.ok).toBe(false);
  });

  it('leaves out a step with no answer and no note, and keeps a text answer as typed', () => {
    expect(
      checklistResultsFromDrafts(STEPS, {
        s2: { value: '', note: ' ' },
        s4: { value: ' text ', note: '' },
      }),
    ).toEqual({ s4: { value: ' text ' } });
  });

  it('checklistDraftsEqual compares answers and notes, a missing step reading as blank', () => {
    const a = checklistDraftsFrom(STEPS, {});
    expect(checklistDraftsEqual(a, { ...a })).toBe(true);
    expect(checklistDraftsEqual(a, {})).toBe(true);
    expect(checklistDraftsEqual(a, { ...a, s1: { value: 'pass', note: '' } })).toBe(false);
    expect(checklistDraftsEqual(a, { ...a, s1: { value: '', note: 'x' } })).toBe(false);
  });
});

describe('the editor rows', () => {
  it('rows from drafts carry a row key only, and publish drops it (a blank help is null)', () => {
    const rows = checklistEditorStepsFrom([
      { kind: 'check', label: 'A' },
      { kind: 'count', label: 'B', help: '  ', required: true },
    ]);
    expect(rows.map((r) => r.uid)).toEqual([
      expect.stringMatching(/^step-\d+$/),
      expect.stringMatching(/^step-\d+$/),
    ]);
    expect(new Set(rows.map((r) => r.uid)).size).toBe(2);
    expect(checklistPublishPayload(rows)).toEqual([
      { kind: 'check', label: 'A', help: null, required: false },
      { kind: 'count', label: 'B', help: null, required: true },
    ]);
    // What publish sends is what the server accepts.
    expect(normalizeChecklistSteps(checklistPublishPayload(rows)).ok).toBe(true);
  });

  it('moveChecklistStep moves one row and ignores a move off either end', () => {
    const rows = ['A', 'B', 'C'];
    expect(moveChecklistStep(rows, 0, 1)).toEqual(['B', 'A', 'C']);
    expect(moveChecklistStep(rows, 2, -1)).toEqual(['A', 'C', 'B']);
    expect(moveChecklistStep(rows, 0, -1)).toEqual(rows);
    expect(moveChecklistStep(rows, 2, 1)).toEqual(rows);
    expect(moveChecklistStep(rows, 5, -1)).toEqual(rows);
    // Never the same array: a state update always sees a new list.
    expect(moveChecklistStep(rows, 0, -1)).not.toBe(rows);
  });
});
