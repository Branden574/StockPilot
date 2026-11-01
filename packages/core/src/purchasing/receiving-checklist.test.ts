import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CASE_TABLE_STEPS,
  CHECKLIST_LIMITS,
  checklistPublishBodySchema,
  checklistSaveBodySchema,
  checklistTextLength,
  firstChecklistPublishedAt,
  isRunCompletable,
  liveChecklistVersion,
  normalizeChecklistResults,
  normalizeChecklistSteps,
  normalizeChecklistTitle,
  normalizeRunNote,
  parseChecklistIncompleteDetail,
  parseChecklistInvalidDetail,
  parseStoredResults,
  parseStoredSteps,
  receiptChecklistAction,
  receiptChecklistState,
  receivedAfterFirstChecklist,
  receivingChecklistCases,
  SUGGESTED_RECEIVING_PHOTO_STEP,
  SUGGESTED_RECEIVING_STEPS,
  summarizeRun,
  trimChecklistText,
  validateRunForCompletion,
  versionLiveAt,
  type ChecklistRunLite,
  type ChecklistVersionLite,
} from './receiving-checklist';

const TESTS = join(dirname(fileURLToPath(import.meta.url)), '../../../../supabase/tests');

describe('the case table shared with pgTAP', () => {
  // Renumber-safe: the suite is found by its name, not its number.
  const file = readdirSync(TESTS).find((f) => f.endsWith('_receiving_checklist.test.sql'));
  const sql = file ? readFileSync(join(TESTS, file), 'utf8') : '';
  const markers = [...sql.matchAll(/^-- case: ([a-z0-9_]+)\s*$/gm)].map((m) => m[1]!);

  it('finds the receiving checklist suite', () => {
    expect(file).toBeDefined();
  });

  it('every core case has exactly one pgTAP marker, and every marker a core case', () => {
    const names = receivingChecklistCases().map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names)
      expect(
        markers.filter((m) => m === n),
        n,
      ).toHaveLength(1);
    expect(markers.filter((m) => !names.includes(m))).toEqual([]);
  });

  it.each(receivingChecklistCases().map((c) => [c.name, c] as const))(
    '%s: core agrees',
    (_name, c) => {
      if (c.target === 'steps') {
        const r = normalizeChecklistSteps(c.input);
        if (c.expect.ok) {
          expect(r.ok).toBe(true);
          if (r.ok && c.expect.steps) expect(r.value).toEqual(c.expect.steps);
        } else {
          expect(r).toEqual({
            ok: false,
            detail: {
              field: 'steps',
              reason: c.expect.reason,
              ...(c.expect.step ? { step: c.expect.step } : {}),
            },
          });
        }
      } else if (c.target === 'title') {
        const r = normalizeChecklistTitle(c.input);
        expect(r).toEqual(
          c.expect.ok
            ? { ok: true, value: c.expect.title }
            : { ok: false, detail: { field: 'title', reason: c.expect.reason } },
        );
      } else if (c.target === 'results') {
        const r = normalizeChecklistResults(CASE_TABLE_STEPS, c.input);
        expect(r).toEqual(
          c.expect.ok
            ? { ok: true, value: c.expect.results }
            : {
                ok: false,
                detail: { field: 'results', key: c.expect.key, reason: c.expect.reason },
              },
        );
      } else {
        expect(validateRunForCompletion(CASE_TABLE_STEPS, c.input)).toEqual(c.expect);
      }
    },
  );

  it('the suite publishes the same four steps the result and completion cases use', () => {
    for (const s of CASE_TABLE_STEPS) expect(sql).toContain(s.label);
  });
});

describe('text rules match the SQL', () => {
  it('trims spaces, tabs and line breaks only', () => {
    expect(trimChecklistText(' \t\n\r\f\vSlip\v\f\r\n\t ')).toBe('Slip');
    expect(trimChecklistText(' Slip')).toBe(' Slip');
  });

  it('counts characters as Postgres does (code points)', () => {
    // U+1D400: one code point, two UTF-16 units (JavaScript's length says 2).
    expect('𝐀'.length).toBe(2);
    expect(checklistTextLength('𝐀'.repeat(80))).toBe(80);
    expect(normalizeChecklistTitle('𝐀'.repeat(80)).ok).toBe(true);
    expect(normalizeChecklistTitle('𝐀'.repeat(81))).toEqual({
      ok: false,
      detail: { field: 'title', reason: 'title_too_long' },
    });
  });

  it('a run note is trimmed, blank is none, and over 1,000 characters is refused', () => {
    expect(normalizeRunNote('  ')).toEqual({ ok: true, value: null });
    expect(normalizeRunNote(null)).toEqual({ ok: true, value: null });
    expect(normalizeRunNote(` ${'n'.repeat(1000)} `)).toEqual({
      ok: true,
      value: 'n'.repeat(1000),
    });
    expect(normalizeRunNote('n'.repeat(1001))).toEqual({
      ok: false,
      detail: { field: 'note', reason: 'run_note_too_long' },
    });
  });

  it('photo steps are allowed only when asked for (F4-2)', () => {
    expect(normalizeChecklistSteps([SUGGESTED_RECEIVING_PHOTO_STEP]).ok).toBe(false);
    expect(normalizeChecklistSteps([SUGGESTED_RECEIVING_PHOTO_STEP], { allowPhoto: true })).toEqual(
      {
        ok: true,
        value: [
          {
            key: 's1',
            kind: 'photo',
            label: 'Photo or scan of the packing slip',
            help: null,
            required: false,
          },
        ],
      },
    );
  });

  it('a photo step takes no typed answer', () => {
    const steps = [
      { key: 's1', kind: 'photo' as const, label: 'Slip photo', help: null, required: true },
    ];
    expect(normalizeChecklistResults(steps, { s1: { value: 'x' } })).toEqual({
      ok: false,
      detail: { field: 'results', key: 's1', reason: 'photo_takes_no_value' },
    });
    expect(validateRunForCompletion(steps, {})).toEqual({
      missing: [],
      failedWithoutNote: [],
      photoStepsWithoutPhoto: ['s1'],
    });
    expect(validateRunForCompletion(steps, {}, { s1: 1 }).photoStepsWithoutPhoto).toEqual([]);
  });

  it('results that are not an object are refused', () => {
    expect(normalizeChecklistResults(CASE_TABLE_STEPS, [])).toEqual({
      ok: false,
      detail: { field: 'results', reason: 'not_an_object' },
    });
    expect(normalizeChecklistResults(CASE_TABLE_STEPS, { s1: 'pass' })).toEqual({
      ok: false,
      detail: { field: 'results', key: 's1', reason: 'answer_not_an_object' },
    });
  });
});

describe('suggested steps', () => {
  it('pass the publish rules, need no photo, and keep the plan order', () => {
    const r = normalizeChecklistSteps(SUGGESTED_RECEIVING_STEPS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((s) => s.label)).toEqual([
      'Packing slip matches this purchase order',
      'Items and quantities match the packing slip',
      'Stock owner (charter) on these items is right for this delivery',
      'Boxes arrived undamaged',
      'Number of boxes received',
      'Anything missing, extra or damaged?',
    ]);
    expect(r.value.map((s) => [s.kind, s.required])).toEqual([
      ['check', true],
      ['check', true],
      ['check', false],
      ['check', true],
      ['count', false],
      ['text', false],
    ]);
    expect(r.value.every((s) => checklistTextLength(s.label) <= CHECKLIST_LIMITS.label)).toBe(true);
  });
});

describe('summarizeRun and completion', () => {
  it('counts failed checks, required steps answered and photos', () => {
    expect(
      summarizeRun(
        CASE_TABLE_STEPS,
        {
          s1: { value: 'fail', note: 'crushed' },
          s2: { value: 'fail', note: 'x' },
          s3: { value: 0 },
        },
        2,
      ),
    ).toEqual({
      total: 4,
      answered: 3,
      requiredTotal: 1,
      requiredAnswered: 1,
      failedChecks: 2,
      linkedPhotos: 2,
    });
    expect(summarizeRun(CASE_TABLE_STEPS, { s2: { note: 'only a note' } })).toEqual({
      total: 4,
      answered: 0,
      requiredTotal: 1,
      requiredAnswered: 0,
      failedChecks: 0,
      linkedPhotos: 0,
    });
  });

  it('a note alone is no answer, and Not applicable is one', () => {
    expect(validateRunForCompletion(CASE_TABLE_STEPS, { s1: { note: 'looked' } }).missing).toEqual([
      's1',
    ]);
    expect(
      isRunCompletable(validateRunForCompletion(CASE_TABLE_STEPS, { s1: { value: 'na' } })),
    ).toBe(true);
  });
});

const V1: ChecklistVersionLite = {
  id: 'v1',
  versionNumber: 1,
  title: 'Delivery checks',
  steps: CASE_TABLE_STEPS as ChecklistVersionLite['steps'],
  publishedAt: '2026-10-01T10:00:00Z',
  retiredAt: '2026-10-03T10:00:00Z',
};
const V2: ChecklistVersionLite = {
  ...V1,
  id: 'v2',
  versionNumber: 2,
  publishedAt: '2026-10-03T10:00:00Z',
  retiredAt: null,
};
const run = (over: Partial<ChecklistRunLite>): ChecklistRunLite => ({
  id: 'run1',
  receiptId: 'r1',
  versionId: 'v1',
  status: 'in_progress',
  results: {},
  startedAt: '2026-10-02T10:00:00Z',
  startedByName: 'Pat Lee',
  completedAt: null,
  completedByName: null,
  ...over,
});
const receipt = (over: Partial<{ id: string; status: string; receivedAt: string }> = {}) => ({
  id: 'r1',
  status: 'posted',
  receivedAt: '2026-10-02T09:00:00Z',
  ...over,
});

describe('receiptChecklistState', () => {
  it('completed, with the failed-check count from summarizeRun', () => {
    const s = receiptChecklistState({
      receipt: receipt(),
      versions: [V1, V2],
      runs: [
        run({
          status: 'completed',
          results: { s1: { value: 'fail', note: 'n' } },
          completedAt: '2026-10-02T11:00:00Z',
          completedByName: 'Sam',
        }),
      ],
    });
    expect(s).toMatchObject({ kind: 'completed', runId: 'run1', completedByName: 'Sam' });
    expect(s.kind === 'completed' && s.summary.failedChecks).toBe(1);
  });

  it('in progress, with who started it and when', () => {
    expect(
      receiptChecklistState({ receipt: receipt(), versions: [V1, V2], runs: [run({})] }),
    ).toMatchObject({
      kind: 'in_progress',
      startedByName: 'Pat Lee',
      startedAt: '2026-10-02T10:00:00Z',
    });
  });

  it('not recorded only inside a live window, for posted and reversed receipts', () => {
    expect(receiptChecklistState({ receipt: receipt(), versions: [V1, V2], runs: [] })).toEqual({
      kind: 'not_recorded',
    });
    expect(
      receiptChecklistState({
        receipt: receipt({ status: 'reversed' }),
        versions: [V1, V2],
        runs: [],
      }),
    ).toEqual({ kind: 'not_recorded' });
    // Before the first publish: never nagged.
    expect(
      receiptChecklistState({
        receipt: receipt({ receivedAt: '2026-09-30T09:00:00Z' }),
        versions: [V1, V2],
        runs: [],
      }),
    ).toEqual({ kind: 'none' });
    // In a gap after a turn-off with nothing live.
    const off = { ...V2, retiredAt: '2026-10-04T00:00:00Z' };
    expect(
      receiptChecklistState({
        receipt: receipt({ receivedAt: '2026-10-04T09:00:00Z' }),
        versions: [V1, off],
        runs: [],
      }),
    ).toEqual({ kind: 'none' });
  });

  it('reversal rows, drafts and cancelled receipts never show a chip', () => {
    for (const status of ['reversal', 'draft', 'canceled']) {
      expect(
        receiptChecklistState({ receipt: receipt({ status }), versions: [V1, V2], runs: [] }),
      ).toEqual({
        kind: 'none',
      });
    }
  });

  // Mutation caught: a failed read treated as an empty list ("not recorded").
  it('a failed versions or runs read is unavailable, never not recorded', () => {
    expect(receiptChecklistState({ receipt: receipt(), versions: null, runs: [] })).toEqual({
      kind: 'unavailable',
    });
    expect(receiptChecklistState({ receipt: receipt(), versions: [V1, V2], runs: null })).toEqual({
      kind: 'unavailable',
    });
    // A run whose version did not come back cannot be summarised.
    expect(receiptChecklistState({ receipt: receipt(), versions: [V2], runs: [run({})] })).toEqual({
      kind: 'unavailable',
    });
  });

  it('live windows: published at or before, retired after', () => {
    expect(versionLiveAt(V1, '2026-10-01T10:00:00Z')).toBe(true);
    expect(versionLiveAt(V1, '2026-10-03T10:00:00Z')).toBe(false);
    expect(versionLiveAt(V2, '2026-10-03T10:00:00Z')).toBe(true);
    expect(versionLiveAt(V2, '2026-10-03T09:59:59Z')).toBe(false);
    expect(liveChecklistVersion([V1, V2])?.id).toBe('v2');
    expect(liveChecklistVersion([V1])).toBeNull();
  });
});

describe('receiptChecklistAction', () => {
  const st = (kind: 'completed' | 'in_progress' | 'not_recorded' | 'none' | 'unavailable') =>
    kind === 'completed'
      ? receiptChecklistState({
          receipt: receipt(),
          versions: [V1, V2],
          runs: [run({ status: 'completed', completedAt: 'x', completedByName: 'S' })],
        })
      : kind === 'in_progress'
        ? receiptChecklistState({ receipt: receipt(), versions: [V1, V2], runs: [run({})] })
        : ({ kind } as const);
  /** v1 Oct 1-3 and v2 from Oct 3 (live): a receipt on Oct 2 was inside v1. */
  const act = (
    state: ReturnType<typeof st>,
    over: Partial<{
      status: string;
      receivedAt: string | null;
      versions: ChecklistVersionLite[];
      canRecord: boolean;
    }> = {},
  ) =>
    receiptChecklistAction({
      state,
      receipt: {
        status: over.status ?? 'posted',
        receivedAt: 'receivedAt' in over ? (over.receivedAt ?? null) : receipt().receivedAt,
      },
      versions: over.versions ?? [V1, V2],
      canRecord: over.canRecord ?? true,
    });
  const off = { ...V2, retiredAt: '2026-10-04T00:00:00Z' };

  it('Record only with a live version, a recorder and a posted or reversed receipt', () => {
    expect(act(st('not_recorded'))).toBe('record');
    expect(act(st('not_recorded'), { status: 'reversed' })).toBe('record');
    expect(act(st('not_recorded'), { versions: [V1, off] })).toBeNull();
    expect(act(st('not_recorded'), { canRecord: false })).toBeNull();
    expect(act(st('none'), { status: 'reversal' })).toBeNull();
    expect(act(st('none'), { status: 'draft' })).toBeNull();
  });

  // Desk check F4: one rule for the web and the phone.
  it('never Record for a receipt from before the first checklist: it had none to follow', () => {
    for (const receivedAt of ['2026-09-30T09:00:00Z', '2026-10-01T09:59:59Z']) {
      expect(act(st('none'), { receivedAt }), receivedAt).toBeNull();
      expect(act(st('none'), { receivedAt, status: 'reversed' }), receivedAt).toBeNull();
    }
    // The instant it was published counts as after (the live window's edge).
    expect(act(st('none'), { receivedAt: '2026-10-01T10:00:00Z' })).toBe('record');
    // No readable time: never claimed.
    expect(act(st('none'), { receivedAt: null })).toBeNull();
    expect(act(st('none'), { receivedAt: 'not a time' })).toBeNull();
  });

  it('Record for a receipt from a gap after the first checklist, once one is on again', () => {
    const v3 = { ...V2, id: 'v3', versionNumber: 3, publishedAt: '2026-10-05T00:00:00Z' };
    const gap = { receivedAt: '2026-10-04T12:00:00Z', versions: [V1, off, v3] };
    // No version was live then: no chip (never nagged)...
    expect(
      receiptChecklistState({
        receipt: receipt({ receivedAt: gap.receivedAt }),
        versions: gap.versions,
        runs: [],
      }),
    ).toEqual({ kind: 'none' });
    // ...but it came after the first checklist, so a recorder may record it.
    expect(act(st('none'), gap)).toBe('record');
    expect(act(st('none'), { ...gap, canRecord: false })).toBeNull();
    // While the checklist is off, nothing is offered.
    expect(act(st('none'), { ...gap, versions: [V1, off] })).toBeNull();
  });

  it('nothing ever published: nothing offered', () => {
    expect(act(st('none'), { versions: [] })).toBeNull();
  });

  it('Continue for an open run the person may record, View otherwise and for completed runs', () => {
    expect(act(st('in_progress'), { versions: [V1, off] })).toBe('continue');
    expect(act(st('in_progress'), { canRecord: false })).toBe('view');
    expect(act(st('completed'))).toBe('view');
    // A run is shown whatever the receipt's time.
    expect(act(st('completed'), { receivedAt: '2026-09-01T00:00:00Z' })).toBe('view');
  });

  it('nothing when the state did not load', () => {
    expect(act(st('unavailable'))).toBeNull();
  });

  it('the first checklist is the earliest publish of any version', () => {
    expect(firstChecklistPublishedAt([V2, V1])).toBe(Date.parse(V1.publishedAt));
    expect(firstChecklistPublishedAt([])).toBeNull();
    expect(firstChecklistPublishedAt([{ publishedAt: 'x' }])).toBeNull();
    expect(receivedAfterFirstChecklist('2026-10-01T10:00:00Z', [V2, V1])).toBe(true);
    expect(receivedAfterFirstChecklist('2026-10-01T09:59:59Z', [V2, V1])).toBe(false);
  });
});

describe('reading what the database stored', () => {
  it('stored steps keep only well-formed steps', () => {
    expect(
      parseStoredSteps([
        { key: 's1', kind: 'check', label: 'Slip', help: null, required: true },
        { key: 's2', kind: 'nope', label: 'x' },
        'junk',
        { key: 's3', kind: 'text', label: 'Notes', help: 'h', required: 'yes' },
      ]),
    ).toEqual([
      { key: 's1', kind: 'check', label: 'Slip', help: null, required: true },
      { key: 's3', kind: 'text', label: 'Notes', help: 'h', required: false },
    ]);
    expect(parseStoredSteps(null)).toEqual([]);
  });

  it('stored results keep only values and notes', () => {
    expect(
      parseStoredResults({ s1: { value: 'pass', x: 1 }, s2: 'bad', s3: { note: 'n' }, s4: {} }),
    ).toEqual({
      s1: { value: 'pass' },
      s3: { note: 'n' },
    });
  });

  it('an invalid detail keeps only known fields and reasons', () => {
    expect(
      parseChecklistInvalidDetail('{"step": 3, "field": "steps", "reason": "label_too_long"}'),
    ).toEqual({
      field: 'steps',
      step: 3,
      reason: 'label_too_long',
    });
    expect(
      parseChecklistInvalidDetail({ field: 'results', key: 's2', reason: 'note_too_long' }),
    ).toEqual({
      field: 'results',
      key: 's2',
      reason: 'note_too_long',
    });
    expect(parseChecklistInvalidDetail('{"field": "steps", "reason": "<script>"}')).toBeNull();
    expect(parseChecklistInvalidDetail('not json')).toBeNull();
    expect(
      parseChecklistInvalidDetail({ field: 'results', key: 'DROP TABLE', reason: 'unknown_step' }),
    ).toEqual({
      field: 'results',
      reason: 'unknown_step',
    });
  });

  it("an incomplete detail keeps only the run's own step keys, in step order", () => {
    expect(
      parseChecklistIncompleteDetail(
        '{"missing": ["s4", "s1", "s99"], "failedWithoutNote": ["s2"], "photoStepsWithoutPhoto": "x"}',
        CASE_TABLE_STEPS,
      ),
    ).toEqual({ missing: ['s1', 's4'], failedWithoutNote: ['s2'], photoStepsWithoutPhoto: [] });
    expect(parseChecklistIncompleteDetail('junk', CASE_TABLE_STEPS)).toEqual({
      missing: [],
      failedWithoutNote: [],
      photoStepsWithoutPhoto: [],
    });
  });
});

describe('request bodies', () => {
  const U = '00000000-0000-4000-8000-000000000001';
  it('publish needs a client id and names the version it replaces (null when none)', () => {
    expect(
      checklistPublishBodySchema.safeParse({
        title: 'T',
        steps: [{ kind: 'check', label: 'x' }],
        expectedCurrentId: null,
        clientPublishId: U,
      }).success,
    ).toBe(true);
    expect(
      checklistPublishBodySchema.safeParse({ title: 'T', steps: [], expectedCurrentId: null })
        .success,
    ).toBe(false);
    expect(
      checklistPublishBodySchema.safeParse({ title: 'T', steps: [], clientPublishId: U }).success,
    ).toBe(false);
  });

  it('a save names its revision and a save id, and says whether it completes', () => {
    expect(
      checklistSaveBodySchema.safeParse({
        results: {},
        expectedRevision: 0,
        saveId: U,
        complete: false,
      }).success,
    ).toBe(true);
    expect(
      checklistSaveBodySchema.safeParse({
        results: {},
        expectedRevision: -1,
        saveId: U,
        complete: false,
      }).success,
    ).toBe(false);
    expect(
      checklistSaveBodySchema.safeParse({ results: {}, expectedRevision: 0, complete: false })
        .success,
    ).toBe(false);
    expect(
      checklistSaveBodySchema.safeParse({
        results: { s1: { value: { x: 1 } } },
        expectedRevision: 0,
        saveId: U,
        complete: true,
      }).success,
    ).toBe(false);
  });
});
