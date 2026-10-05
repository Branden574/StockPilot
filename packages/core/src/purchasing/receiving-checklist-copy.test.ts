import { describe, expect, it } from 'vitest';

import {
  RECEIVE_GATE_CHECKING_COPY,
  RECEIVE_GATE_OFFLINE_COPY,
  RECEIVE_GATE_UNKNOWN_COPY,
  RECEIVE_MANAGER_POSTS_COPY,
  RECEIVE_POST_MANAGER_ONLY_COPY,
} from './receiving-gate';
import {
  CASE_TABLE_STEPS,
  CHECKLIST_INVALID_REASONS,
  type ReceiptChecklistState,
} from './receiving-checklist';
import {
  checklistWhen,
  describeChecklistIncomplete,
  describeChecklistInvalid,
  lateRecordLabel,
  RECEIVING_CHECKLIST_COPY,
  receiptChecklistActionLabel,
  receiptChecklistChipText,
  receiptChecklistChipTone,
  receivingChecklistCopySamples,
  checklistKindLabel,
  checklistVersionMetaLine,
  receivingRunAboutLines,
  receivingRunStatusLines,
  runProgressLine,
} from './receiving-checklist-copy';

/**
 * Words the checklist never uses: "book" for a quantity (owner rule: say "on
 * record"), and claims the product cannot stand behind. A checklist records
 * what a person checked; it never certifies anything.
 */
const NEVER =
  /\bbook\b|verified|inspected|certif|complian|approved|\bpassed\b|\bsent\b|ticket|attached/i;

const summary = (failedChecks: number) => ({
  total: 4,
  answered: 2,
  requiredTotal: 1,
  requiredAnswered: 1,
  failedChecks,
  linkedPhotos: 0,
});

describe('the words', () => {
  it('never say book, verified, inspected, certified, compliant, approved, passed, sent, ticket or attached', () => {
    const all = [
      ...receivingChecklistCopySamples(),
      RECEIVE_MANAGER_POSTS_COPY,
      RECEIVE_POST_MANAGER_ONLY_COPY,
      RECEIVE_GATE_CHECKING_COPY,
      RECEIVE_GATE_UNKNOWN_COPY,
      RECEIVE_GATE_OFFLINE_COPY,
      ...CHECKLIST_INVALID_REASONS.map((reason) =>
        describeChecklistInvalid(
          { field: 'results', reason, key: 's1', step: 1 },
          CASE_TABLE_STEPS,
        ),
      ),
    ];
    expect(all.length).toBeGreaterThan(100);
    expect(all.filter((t) => NEVER.test(t))).toEqual([]);
    // No emoji and no exclamation marks.
    expect(all.filter((t) => /[!\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t))).toEqual([]);
  });

  it('the guard itself still catches each word', () => {
    for (const w of [
      'book',
      'Verified',
      'inspected',
      'certified',
      'compliant',
      'approved',
      'passed',
      'sent',
      'ticket',
      'attached',
    ]) {
      expect(NEVER.test(`a ${w} b`), w).toBe(true);
    }
    expect(NEVER.test('Pass')).toBe(false);
  });

  it('the posted panel, chips and errors say what the plan says', () => {
    const c = RECEIVING_CHECKLIST_COPY;
    expect(c.postedTitle('R-1001')).toBe('Receipt R-1001 posted.');
    expect(c.postedBody).toBe(
      'Recording the receiving checklist is optional. You can also do it later from Receipts on this purchase order.',
    );
    expect(c.honesty).toBe(
      'This records what a person checked for this receipt. It does not change stock, the receipt or the purchase order.',
    );
    expect(c.chipFailed(1)).toBe('Checklist: 1 failed check');
    expect(c.chipFailed(2)).toBe('Checklist: 2 failed checks');
    expect(c.runChanged).toBe(
      'Someone else saved this checklist after you opened it. Your answers are still on screen. Reload to see the saved version.',
    );
    expect(c.receivedOnReceipt(48, 3)).toBe('Received on this receipt: 48 units on 3 lines.');
    expect(c.receivedOnReceipt(1, 1)).toBe('Received on this receipt: 1 unit on 1 line.');
    expect(c.receivedOnReceipt(2.5, 1)).toBe('Received on this receipt: 2.5 units on 1 line.');
    expect(c.keepsVersion(3, 2)).toBe(
      "Version 3 was published after this checklist was started. This one keeps version 2's steps.",
    );
    expect(c.publishConfirm(2)).toBe(
      'Receipts posted from now on offer version 2. Checklists already started keep the version they started with.',
    );
  });
});

describe('chips', () => {
  const cases: Array<[ReceiptChecklistState, string | null, string | null]> = [
    [
      {
        kind: 'completed',
        runId: 'r',
        summary: summary(0),
        completedAt: null,
        completedByName: null,
      },
      'Checklist: no failed checks',
      'ok',
    ],
    [
      {
        kind: 'completed',
        runId: 'r',
        summary: summary(1),
        completedAt: null,
        completedByName: null,
      },
      'Checklist: 1 failed check',
      'warn',
    ],
    [
      {
        kind: 'completed',
        runId: 'r',
        summary: summary(3),
        completedAt: null,
        completedByName: null,
      },
      'Checklist: 3 failed checks',
      'warn',
    ],
    [
      { kind: 'in_progress', runId: 'r', summary: summary(0), startedAt: 'x', startedByName: 'P' },
      'Checklist in progress',
      'muted',
    ],
    [{ kind: 'not_recorded' }, 'Checklist not recorded', 'muted'],
    [{ kind: 'unavailable' }, "Checklist status didn't load", 'warn'],
    [{ kind: 'none' }, null, null],
  ];
  it.each(cases)('%j reads %s', (state, text, tone) => {
    expect(receiptChecklistChipText(state)).toBe(text);
    expect(receiptChecklistChipTone(state)).toBe(tone);
  });

  // Mutation caught: an unavailable state rendered as "not recorded".
  it('unavailable never reads as not recorded', () => {
    expect(receiptChecklistChipText({ kind: 'unavailable' })).not.toBe(
      RECEIVING_CHECKLIST_COPY.chipNotRecorded,
    );
  });

  it('action labels', () => {
    expect(receiptChecklistActionLabel('record')).toBe('Record checklist');
    expect(receiptChecklistActionLabel('continue')).toBe('Continue checklist');
    expect(receiptChecklistActionLabel('view')).toBe('View checklist');
  });
});

describe('times in the organization zone', () => {
  it('completed and started lines read "on <date> at <time>"', () => {
    expect(checklistWhen('2026-10-05T22:04:00Z', 'America/Los_Angeles')).toBe(
      'October 5, 2026 at 3:04 PM',
    );
    expect(
      RECEIVING_CHECKLIST_COPY.completedBy(
        'Pat Lee',
        checklistWhen('2026-10-05T22:04:00Z', 'America/New_York'),
      ),
    ).toBe('Completed by Pat Lee on October 5, 2026 at 6:04 PM');
  });

  it('late recording is labelled only past a day, in calendar days of the zone', () => {
    const tz = 'America/Los_Angeles';
    expect(lateRecordLabel('2026-10-01T16:00:00Z', '2026-10-02T15:00:00Z', tz)).toBeNull();
    expect(lateRecordLabel('2026-10-01T16:00:00Z', '2026-10-02T17:00:00Z', tz)).toBe(
      'Recorded 1 day after the receipt was posted.',
    );
    expect(lateRecordLabel('2026-10-01T16:00:00Z', '2026-10-05T17:00:00Z', tz)).toBe(
      'Recorded 4 days after the receipt was posted.',
    );
    expect(lateRecordLabel('bad', '2026-10-05T17:00:00Z', tz)).toBeNull();
  });
});

describe("a run's About and status lines (one set for the web and the phone)", () => {
  const C = RECEIVING_CHECKLIST_COPY;
  const about = {
    unitsReceived: 48,
    lineCount: 3,
    warehouse: { kind: 'ok' as const, value: 'Main' as string | null },
    stockOwner: { kind: 'ok' as const, value: ['North Charter'] },
    billTo: { kind: 'ok' as const, value: 'South Charter' as string | null },
    stillToCome: { kind: 'ok' as const, value: 2 },
  };

  it('says what is known, the stock owner and the bill-to apart', () => {
    expect(receivingRunAboutLines(about, false).map((l) => l.text)).toEqual([
      C.receivedOnReceipt(48, 3),
      C.receivedInto('Main'),
      C.stockOwner(['North Charter']),
      C.billTo('South Charter'),
      C.stillToCome(2),
    ]);
  });

  // pattern #28: a failed read says it did not load, never "none" and never nothing.
  it('a read that failed says so; "none" only from an answer', () => {
    const lines = receivingRunAboutLines(
      {
        ...about,
        warehouse: { kind: 'unavailable' },
        stockOwner: { kind: 'unavailable' },
        billTo: { kind: 'unavailable' },
        stillToCome: { kind: 'unavailable' },
      },
      false,
    ).map((l) => l.text);
    // Desk check F10(d): the warehouse that did not load is said too.
    expect(lines).toEqual([
      C.receivedOnReceipt(48, 3),
      C.receivedIntoUnavailable,
      C.stockOwnerUnavailable,
      C.billToUnavailable,
      C.stillToComeUnavailable,
    ]);
    const none = receivingRunAboutLines(
      {
        ...about,
        stockOwner: { kind: 'ok', value: [] },
        billTo: { kind: 'ok', value: null },
        stillToCome: { kind: 'ok', value: 0 },
      },
      false,
    ).map((l) => l.text);
    expect(none).toContain(C.stockOwnerNone);
    expect(none).toContain(C.nothingToCome);
    expect(none.some((t) => t.startsWith('Bill-to'))).toBe(false);
    // A warehouse the answer did not name: no line, and no claim.
    const noWarehouse = receivingRunAboutLines(
      { ...about, warehouse: { kind: 'ok', value: null } },
      false,
    ).map((l) => l.text);
    expect(noWarehouse.some((t) => t.startsWith('Received into'))).toBe(false);
    expect(noWarehouse).not.toContain(C.receivedIntoUnavailable);
  });

  it('a failed check adds the reverse hint, marked as a warning', () => {
    expect(receivingRunAboutLines(about, true).at(-1)).toEqual({
      text: C.reverseHint,
      tone: 'warn',
    });
  });

  it('status: started, completed, late, reversed, a newer version and read only, each when it applies', () => {
    const tz = 'America/Los_Angeles';
    const base = {
      run: {
        status: 'in_progress' as 'in_progress' | 'completed',
        startedAt: '2026-10-05T17:00:00Z',
        startedByName: 'Pat Lee',
        completedAt: null as string | null,
        completedByName: null as string | null,
      },
      receipt: { receivedAt: '2026-10-01T16:00:00Z', reversedAt: '2026-10-06T00:00:00Z' },
      versionNumber: 1,
      newerVersionNumber: 3 as number | null,
      canRecord: false,
    };
    expect(receivingRunStatusLines(base, tz).map((l) => l.text)).toEqual([
      C.startedBy('Pat Lee', 'October 5, 2026 at 10:00 AM'),
      C.recordedLate(4),
      C.reversedAfter,
      C.keepsVersion(3, 1),
      C.readOnlyNotRecorder,
    ]);
    const done = receivingRunStatusLines(
      {
        ...base,
        run: {
          ...base.run,
          status: 'completed',
          completedAt: '2026-10-05T22:04:00Z',
          completedByName: 'Sam Ortiz',
        },
        receipt: { receivedAt: '2026-10-05T16:00:00Z', reversedAt: '2026-10-05T16:30:00Z' },
        canRecord: true,
      },
      tz,
    );
    expect(done.map((l) => l.text)).toEqual([
      C.startedBy('Pat Lee', 'October 5, 2026 at 10:00 AM'),
      C.completedBy('Sam Ortiz', 'October 5, 2026 at 3:04 PM'),
      C.reversedBefore,
    ]);
    expect(done[1]?.tone).toBe('done');
  });
});

describe("the editor's words", () => {
  it('names each kind of step', () => {
    expect(checklistKindLabel('check')).toBe('Pass, Fail or Not applicable');
    expect(checklistKindLabel('count')).toBe('A number');
    expect(checklistKindLabel('text')).toBe('A short answer');
    expect(checklistKindLabel('photo')).toBe('Photo or scan');
  });

  it('says who published a version and when, who turned it off, and its receipts for a publisher', () => {
    const tz = 'America/Los_Angeles';
    const v = {
      publishedByName: 'Pat Lee',
      publishedAt: '2026-10-01T15:00:00Z',
      retiredAt: null as string | null,
      retiredByName: null as string | null,
      runCount: null as number | null,
    };
    expect(checklistVersionMetaLine(v, tz)).toBe(
      'Published by Pat Lee on October 1, 2026 at 8:00 AM',
    );
    expect(
      checklistVersionMetaLine(
        { ...v, retiredAt: '2026-10-03T15:00:00Z', retiredByName: 'Sam Ortiz', runCount: 1 },
        tz,
      ),
    ).toBe(
      'Published by Pat Lee on October 1, 2026 at 8:00 AM · turned off by Sam Ortiz on October 3, 2026 at 8:00 AM · Recorded on 1 receipt',
    );
  });
});

describe('refusals', () => {
  it('a checklist_incomplete refusal names the steps by their labels', () => {
    expect(
      describeChecklistIncomplete(
        { missing: ['s1'], failedWithoutNote: ['s2'], photoStepsWithoutPhoto: [] },
        CASE_TABLE_STEPS,
      ),
    ).toBe(
      'Answer every required step before completing: Packing slip matches this purchase order. Add a note to each failed check: Boxes arrived undamaged.',
    );
  });

  it('every checklist_invalid reason has its own sentence', () => {
    for (const reason of CHECKLIST_INVALID_REASONS) {
      const text = describeChecklistInvalid(
        { field: 'steps', reason, step: 2, key: 's3' },
        CASE_TABLE_STEPS,
      );
      expect(text.length, reason).toBeGreaterThan(10);
    }
    expect(describeChecklistInvalid({ field: 'steps', reason: 'label_too_long', step: 3 })).toBe(
      'Step 3: the label can be up to 120 characters.',
    );
    expect(
      describeChecklistInvalid(
        { field: 'results', reason: 'count_out_of_range', key: 's3' },
        CASE_TABLE_STEPS,
      ),
    ).toBe('Number of boxes received: enter a number from 0 to 1,000,000.');
  });

  it('progress line', () => {
    expect(runProgressLine(summary(0))).toBe('1 of 1 required step answered');
    expect(runProgressLine({ ...summary(0), requiredTotal: 0 })).toBe('2 of 4 steps answered');
  });
});
