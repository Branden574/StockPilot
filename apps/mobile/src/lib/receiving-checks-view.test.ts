import { describe, expect, it, vi } from 'vitest';

import { RECEIVING_CHECKLIST_COPY as C, receivingGate } from '@stockpilot/core';

import { IDS, poChecksAnswer } from './__fixtures__/receiving-checks';
import { parsePoChecks } from './receiving-checks-api';
import {
  CHECK_ANSWER_OPTIONS,
  historyChecksFailed,
  postedAlertPlan,
  receiptChip,
  receivingCheckPath,
  startAfterPostFailureBody,
  type PoChecksState,
} from './receiving-checks-view';

vi.mock('./api', () => ({ api: vi.fn() }));

/**
 * F4-1 on the phone: what Receipt history and the "Posted" alert say about
 * the receiving checklist, from core's state rules (the web PO page's).
 */

const READY: PoChecksState = { kind: 'ready', checks: parsePoChecks(poChecksAnswer()) };
const FAILED: PoChecksState = { kind: 'ready', checks: { ok: false } };

const MANAGER = receivingGate({
  role: 'manager',
  canAdjust: true,
  canReadPo: true,
  canManagePo: true,
  receivingOn: true,
});
const STAFF = receivingGate({
  role: 'staff',
  canAdjust: true,
  canReadPo: true,
  canManagePo: false,
  receivingOn: true,
});

const receipt = (id: string, status: string, receivedAt: string | null) => ({
  id,
  status,
  receivedAt,
});

describe('the chip on a Receipt history card', () => {
  it('a completed run says how many checks failed, and offers View', () => {
    expect(
      receiptChip({
        receipt: receipt(IDS.rcptA, 'posted', '2026-10-02T15:00:00Z'),
        checks: READY,
        canRecord: true,
      }),
    ).toEqual({
      text: C.chipFailed(1),
      tone: 'warn',
      action: 'view',
      actionLabel: C.viewChecklist,
      runId: IDS.runA,
    });
  });

  it('an open run offers Continue to a recorder, View to anyone else', () => {
    const r = receipt(IDS.rcptB, 'posted', '2026-10-04T15:00:00Z');
    expect(receiptChip({ receipt: r, checks: READY, canRecord: true })).toMatchObject({
      text: C.chipInProgress,
      action: 'continue',
      runId: IDS.runB,
    });
    expect(receiptChip({ receipt: r, checks: READY, canRecord: false })).toMatchObject({
      action: 'view',
      actionLabel: C.viewChecklist,
    });
  });

  it('a receipt with no run while a checklist was live: not recorded, Record only for a recorder', () => {
    const r = receipt(IDS.rcptC, 'posted', '2026-10-04T18:00:00Z');
    expect(receiptChip({ receipt: r, checks: READY, canRecord: true })).toEqual({
      text: C.chipNotRecorded,
      tone: 'muted',
      action: 'record',
      actionLabel: C.recordChecklist,
      runId: null,
    });
    expect(receiptChip({ receipt: r, checks: READY, canRecord: false })).toMatchObject({
      text: C.chipNotRecorded,
      action: null,
      actionLabel: null,
    });
  });

  it('never nags: a receipt from before any checklist, and a reversal entry, have no chip', () => {
    expect(
      receiptChip({
        receipt: receipt(IDS.rcptC, 'posted', '2026-09-01T15:00:00Z'),
        checks: READY,
        canRecord: true,
      }),
    ).toBeNull();
    expect(
      receiptChip({
        receipt: receipt(IDS.rcptC, 'reversal', '2026-10-04T18:00:00Z'),
        checks: READY,
        canRecord: true,
      }),
    ).toBeNull();
    // No time on the receipt: never claimed "not recorded".
    expect(
      receiptChip({ receipt: receipt(IDS.rcptC, 'posted', null), checks: READY, canRecord: true }),
    ).toBeNull();
  });

  // pattern #28 (mutation caught: a failed read shown as "not recorded" on
  // every card, with Record offered).
  it('while loading, and after a failed read, a card claims nothing; the history says it once', () => {
    const r = receipt(IDS.rcptC, 'posted', '2026-10-04T18:00:00Z');
    expect(receiptChip({ receipt: r, checks: { kind: 'loading' }, canRecord: true })).toBeNull();
    expect(receiptChip({ receipt: r, checks: FAILED, canRecord: true })).toBeNull();
    expect(historyChecksFailed(FAILED, 3)).toBe(true);
    expect(historyChecksFailed(FAILED, 0)).toBe(false);
    expect(historyChecksFailed(READY, 3)).toBe(false);
    expect(historyChecksFailed({ kind: 'loading' }, 3)).toBe(false);
    expect(C.chipUnavailable).toBe("Checklist status didn't load");
  });
});

describe('the Posted alert', () => {
  const base = {
    lineCount: 2,
    receiptId: IDS.rcptC,
    receiptNumber: 'R-1003',
    gate: MANAGER,
    checks: READY,
  };

  it('offers Record checklist with Done when a checklist is live and this person may record it', () => {
    expect(postedAlertPlan(base)).toEqual({
      title: C.postedTitle('R-1003'),
      body: `Received 2 lines. ${C.postedBody}`,
      offerRecord: true,
    });
  });

  // Mutation caught: Record offered on a guess (gate unknown, the status read
  // failed, nothing live, or no receipt id to start).
  it('otherwise it is the plain alert it always was', () => {
    const plain = { title: 'Posted', body: 'Received 2 lines.', offerRecord: false };
    expect(postedAlertPlan({ ...base, gate: STAFF })).toEqual(plain);
    expect(postedAlertPlan({ ...base, gate: null })).toEqual(plain);
    expect(postedAlertPlan({ ...base, checks: FAILED })).toEqual(plain);
    expect(postedAlertPlan({ ...base, checks: { kind: 'loading' } })).toEqual(plain);
    expect(postedAlertPlan({ ...base, receiptId: null })).toEqual(plain);
    const noneLive = parsePoChecks({ checks: { ok: true, versions: [], runs: [] } });
    expect(postedAlertPlan({ ...base, checks: { kind: 'ready', checks: noneLive } })).toEqual(
      plain,
    );
    expect(postedAlertPlan({ ...base, gate: STAFF, lineCount: 1 }).body).toBe('Received 1 line.');
  });

  it('a start that fails after the post says the receipt is saved', () => {
    expect(startAfterPostFailureBody(new Error('x'))).toBe(C.startFailedAfterPostPhone);
    expect(
      startAfterPostFailureBody(
        Object.assign(new Error('x'), { status: 409, details: { reason: 'no_checklist' } }),
      ),
    ).toBe(`${C.noChecklist} ${C.startFailedAfterPostPhone}`);
  });
});

describe('the run screen', () => {
  it('offers Pass, Fail and Not applicable in that order, in words', () => {
    expect(CHECK_ANSWER_OPTIONS).toEqual([
      { value: 'pass', label: 'Pass' },
      { value: 'fail', label: 'Fail' },
      { value: 'na', label: 'Not applicable' },
    ]);
    expect(receivingCheckPath(IDS.runA)).toBe(`/receiving-check/${IDS.runA}`);
  });
});
