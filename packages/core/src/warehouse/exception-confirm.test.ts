import { describe, expect, it } from 'vitest';

import {
  CONFIRM_COUNT_INSTEAD_LABEL,
  CONFIRM_COUNT_LABEL,
  confirmationFactsRow,
  confirmCountDialogCopy,
  COUNT_CONFIRM_REASONS,
  COUNT_CONFIRM_STATES,
  countConfirmGate,
  countConfirmState,
  countVarianceAcknowledgeHelp,
  countVarianceClearCopy,
  countVarianceLead,
  describeConfirmError,
  EXCEPTION_CONFIRM_OFFLINE_COPY,
  isCountConfirmReason,
  isCountConfirmState,
  recountAbilityOf,
  type CountConfirmBlock,
  type CountConfirmReason,
  type CountConfirmState,
  type CountConfirmStateInput,
  type CountVarianceClearInput,
  type RecountAbility,
} from './exception-confirm';
import { GATE_EXPECTATIONS, GATE_READERS, GATE_REASON_TO_RPC } from './exception-confirm.fixture';
import { RECOUNT_COUNTS_TOTAL_COPY, RECOUNT_UNAVAILABLE_COPY } from './exception-recount';
import type { OccurrenceState } from './exceptions';

/**
 * COUNT DIFFERENCES: WHAT CLEARS THEM, AND CONFIRMING THE COUNTED NUMBER
 * (owner decision 2026-09-29, EX-000059).
 *
 * Every word pinned here is shown identically on the web page and the phone.
 * The phone ships this core in R1 and keeps it after R2 turns Confirm on, so
 * the feature-on words below are what phones will say for good: they are
 * asserted as whole strings.
 */

const FACTS = {
  itemName: 'Economy Auto Opening Umbrella',
  sku: 'SP-TH3HF-N1WPN3P',
  cycleCountId: 'cc-35',
  countNumber: 35,
  observedAt: '2026-09-29T17:00:00Z',
  completedAt: '2026-09-29T17:00:30Z',
  expected: 100,
  counted: 2,
  variance: -98,
  countedLocationName: null,
  aiAssisted: false,
  capturedOfflineAt: null,
};

const LEAD = 'CC-000035 found 2 where 100 was on record, and posting it changed the stock on record by -98.';
const ACK = 'Acknowledging does not clear this.';
const MODULE_OFF =
  'Cycle Counts is turned off for this organization, so it cannot be recounted until it is turned on again.';
const RECOUNT_IN_PROGRESS =
  'Recount CC-000040 is in progress (1 of 1 counted). When it is posted, this clears if it matches the stock on record, or shows the new numbers if it does not.';
const RECHECKING =
  'A newer count of this item was posted and is being checked. This updates at the next check, within 15 minutes.';

// ═══════════════════════════════════════════════════════════════════════════
// The state (independent of the reader)
// ═══════════════════════════════════════════════════════════════════════════

function stateInput(o: Partial<CountConfirmStateInput> = {}): CountConfirmStateInput {
  return {
    facts: FACTS,
    displayed: { kind: 'open' },
    linkedRecount: null,
    openLines: [],
    latest: { cycleCountId: 'cc-35', counted: 2, countable: true },
    onRecordNow: 2,
    alreadyConfirmed: false,
    ...o,
  };
}

const RECOUNT_OPEN = { cycleCountId: 'cc-40', status: 'in_progress', lineRechecks: true };
const DIFFERING_LINE = { cycleCountId: 'cc-41', countNumber: 41, counted: 3, expected: 2, rechecks: true };

/** Each step made true, with every LATER step also true, so the order is
 *  pinned: the first true step wins. */
const STEPS: Array<[CountConfirmState, Partial<CountConfirmStateInput>]> = [
  ['recount_in_progress', { linkedRecount: RECOUNT_OPEN }],
  ['count_in_progress', { openLines: [DIFFERING_LINE] }],
  ['rechecking', { displayed: { kind: 'rechecking' } }],
  ['unavailable', { latest: null }],
  ['count_changed', { latest: { cycleCountId: 'cc-50', counted: 2, countable: true } }],
  ['not_countable', { latest: { cycleCountId: 'cc-35', counted: 2, countable: false } }],
  ['stock_moved', { onRecordNow: 5 }],
  ['already_confirmed', { alreadyConfirmed: true }],
];

describe('countConfirmState: the order of the checks', () => {
  it('lists the states in the order they are checked, confirmable last', () => {
    expect(COUNT_CONFIRM_STATES).toEqual([
      'recount_in_progress',
      'count_in_progress',
      'rechecking',
      'unavailable',
      'count_changed',
      'not_countable',
      'stock_moved',
      'already_confirmed',
      'confirmable',
    ]);
    for (const s of COUNT_CONFIRM_STATES) expect(isCountConfirmState(s)).toBe(true);
    for (const s of ['', 'open', 'Confirmable', null, 3]) expect(isCountConfirmState(s)).toBe(false);
  });

  it('is confirmable when nothing stands in the way', () => {
    expect(countConfirmState(stateInput())).toBe('confirmable');
  });

  it.each(STEPS.map(([state], i) => [state, i] as const))('%s wins over every later check', (state, i) => {
    // This step and every later one true at once.
    const input = stateInput(Object.assign({}, ...STEPS.slice(i).map(([, o]) => o)));
    // Two steps set the latest count: keep this step's while the later one
    // (not countable) is also true.
    if (state === 'unavailable') input.latest = null;
    if (state === 'count_changed') input.latest = { cycleCountId: 'cc-50', counted: 2, countable: false };
    expect(countConfirmState(input)).toBe(state);
  });

  it('a linked recount blocks only while it is open and its line can re-check the item', () => {
    expect(countConfirmState(stateInput({ linkedRecount: { ...RECOUNT_OPEN, status: 'canceled' } }))).toBe('confirmable');
    expect(countConfirmState(stateInput({ linkedRecount: { ...RECOUNT_OPEN, lineRechecks: false } }))).toBe(
      'confirmable',
    );
    // Unknown fails toward caution.
    expect(countConfirmState(stateInput({ linkedRecount: { ...RECOUNT_OPEN, lineRechecks: null } }))).toBe(
      'recount_in_progress',
    );
  });

  it('another open count blocks only once it recorded a different number for the item that can re-check it', () => {
    // Uncounted: a warehouse-wide count must not freeze every Confirm.
    expect(countConfirmState(stateInput({ openLines: [{ ...DIFFERING_LINE, counted: null }] }))).toBe('confirmable');
    // Counted and matching its own expected: posting it changes nothing.
    expect(countConfirmState(stateInput({ openLines: [{ ...DIFFERING_LINE, counted: 2, expected: 2 }] }))).toBe(
      'confirmable',
    );
    // Counted before a later posted count: it cannot re-check the item.
    expect(countConfirmState(stateInput({ openLines: [{ ...DIFFERING_LINE, rechecks: false }] }))).toBe('confirmable');
    // A null expected counts as different (caution).
    expect(countConfirmState(stateInput({ openLines: [{ ...DIFFERING_LINE, expected: null }] }))).toBe(
      'count_in_progress',
    );
    // The linked recount's own line is never "another count".
    expect(
      countConfirmState(
        stateInput({
          linkedRecount: { ...RECOUNT_OPEN, status: 'canceled' },
          openLines: [{ ...DIFFERING_LINE, cycleCountId: 'cc-40' }],
        }),
      ),
    ).toBe('confirmable');
  });

  it('a latest count that names another count, or another number, is count_changed', () => {
    expect(countConfirmState(stateInput({ latest: { cycleCountId: 'cc-35', counted: 3, countable: true } }))).toBe(
      'count_changed',
    );
  });

  it('stock that moved and netted to zero is still confirmable; any other movement is stock_moved', () => {
    expect(countConfirmState(stateInput({ onRecordNow: 2.0 }))).toBe('confirmable');
    expect(countConfirmState(stateInput({ onRecordNow: 1 }))).toBe('stock_moved');
    // 0 counted, 0 on record.
    expect(
      countConfirmState(
        stateInput({
          facts: { ...FACTS, counted: 0, variance: -100 },
          latest: { cycleCountId: 'cc-35', counted: 0, countable: true },
          onRecordNow: 0,
        }),
      ),
    ).toBe('confirmable');
  });

  it('a read that failed, or facts without the count, is unavailable (never confirmable)', () => {
    for (const o of [
      { openLines: null },
      { onRecordNow: null },
      { alreadyConfirmed: null },
      { facts: { ...FACTS, cycleCountId: undefined } },
      { facts: { ...FACTS, counted: 'many' } },
    ] as Array<Partial<CountConfirmStateInput>>) {
      expect(countConfirmState(stateInput(o))).toBe('unavailable');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The gate (reader × state): one predicate for the page, the phone and the
// service hint; the RPC restates it (the fixture is the shared table)
// ═══════════════════════════════════════════════════════════════════════════

describe('countConfirmGate: reader × state, from the shared table', () => {
  it('the table covers every reader and every state', () => {
    expect(GATE_READERS.map((r) => r.name)).toEqual([
      'counter (staff)',
      'counter (manager)',
      'manager who did not count',
      'staff who did not count',
      'viewer',
      'manager without stock:adjust',
      'staff, counted_by null',
      'manager, counted_by null',
    ]);
    for (const r of GATE_READERS) {
      expect(Object.keys(GATE_EXPECTATIONS[r.name]!).sort()).toEqual([...COUNT_CONFIRM_STATES].sort());
    }
  });

  for (const reader of GATE_READERS) {
    for (const state of COUNT_CONFIRM_STATES) {
      const expected = GATE_EXPECTATIONS[reader.name]![state];
      it(`${reader.name} × ${state} → ${expected}`, () => {
        const g = countConfirmGate({ state, ...reader });
        expect(g.state).toBe(state);
        if (expected === 'counter' || expected === 'manager') {
          expect(g).toMatchObject({ canConfirm: true, reason: null, as: expected });
        } else {
          expect(g).toMatchObject({ canConfirm: false, reason: expected });
        }
      });
    }
  }

  it('every gate reason maps to the RPC answer the database gives, or is app-only', () => {
    expect(Object.keys(GATE_REASON_TO_RPC).sort()).toEqual([...COUNT_CONFIRM_REASONS, 'ok'].sort());
    // rechecking and count_changed are one refusal in the database.
    expect(GATE_REASON_TO_RPC.rechecking).toEqual(GATE_REASON_TO_RPC.count_changed);
    expect(GATE_REASON_TO_RPC.unavailable).toBe('app_only');
    expect(GATE_REASON_TO_RPC.not_permitted).toEqual({ sqlstate: '42501', hint: 'not_permitted' });
    expect(GATE_REASON_TO_RPC.not_counter).toEqual({ sqlstate: '42501', hint: 'not_counter' });
    for (const r of COUNT_CONFIRM_REASONS) expect(isCountConfirmReason(r)).toBe(true);
    expect(isCountConfirmReason('confirmable')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The words: the top card (reader × state × recount ability, and feature off)
// ═══════════════════════════════════════════════════════════════════════════

type Reader = { canAct: boolean; confirm: 'can' | 'not_counter' | 'not_permitted' };

const IN_PROGRESS_RECOUNT = {
  countNumber: 40,
  outcome: { kind: 'in_progress' as const, counted: 1, total: 1 },
};

function block(state: CountConfirmState, reader: Reader, o: Partial<CountConfirmBlock> = {}): CountConfirmBlock {
  const canConfirm = state === 'confirmable' && reader.confirm === 'can';
  const unavailableReason: CountConfirmReason | null = canConfirm
    ? null
    : reader.confirm === 'not_permitted'
      ? 'not_permitted'
      : state === 'confirmable'
        ? 'not_counter'
        : state;
  return {
    state,
    canConfirm,
    unavailableReason,
    cycleCountId: 'cc-35',
    countNumber: 35,
    counted: 2,
    onRecordBefore: 100,
    onRecordNow: state === 'stock_moved' ? 5 : 2,
    countedBy: { id: 'u-dana', label: 'Dana Lee' },
    postedBy: { id: 'u-dana', label: 'Dana Lee' },
    readerIsCounter: reader.confirm === 'can',
    otherCount: state === 'count_in_progress' ? { countNumber: 41, counted: 3 } : null,
    ...o,
  };
}

function displayedFor(state: CountConfirmState | null): OccurrenceState {
  if (state === 'recount_in_progress') return { kind: 'recount_in_progress', cycleCountId: 'cc-40', countNumber: 40 };
  if (state === 'rechecking') return { kind: 'rechecking', cycleCountId: 'cc-40', countNumber: 40 };
  return { kind: 'open' };
}

function clearInput(
  state: CountConfirmState | null,
  reader: Reader,
  ability: RecountAbility,
  o: Partial<CountVarianceClearInput> = {},
): CountVarianceClearInput {
  return {
    facts: FACTS,
    displayed: displayedFor(state),
    recount: state === 'recount_in_progress' ? IN_PROGRESS_RECOUNT : null,
    canAct: reader.canAct,
    canRecount: ability === 'can',
    recountUnavailableReason: ability === 'can' ? null : ability,
    confirm: state === null ? null : block(state, reader),
    ...o,
  };
}

const CAN_CONFIRM: Reader = { canAct: true, confirm: 'can' };
const NOT_COUNTER: Reader = { canAct: true, confirm: 'not_counter' };
const VIEWER: Reader = { canAct: false, confirm: 'not_permitted' };
const ABILITIES: RecountAbility[] = ['can', 'not_permitted', 'module_disabled'];

describe('countVarianceClearCopy: the lead', () => {
  it('is the same always-true sentence in every state and for every reader', () => {
    for (const state of [null, ...COUNT_CONFIRM_STATES]) {
      for (const reader of [CAN_CONFIRM, NOT_COUNTER, VIEWER]) {
        expect(countVarianceClearCopy(clearInput(state, reader, 'can')).lead).toBe(LEAD);
      }
    }
    expect(countVarianceLead(FACTS)).toBe(LEAD);
  });

  it('without a count number, with zero, with decimals, and with unreadable numbers', () => {
    expect(countVarianceLead({ ...FACTS, countNumber: null })).toBe(
      'A count found 2 where 100 was on record, and posting it changed the stock on record by -98.',
    );
    expect(countVarianceLead({ ...FACTS, counted: 0, variance: -100 })).toBe(
      'CC-000035 found 0 where 100 was on record, and posting it changed the stock on record by -100.',
    );
    expect(countVarianceLead({ ...FACTS, expected: 10, counted: 12.5, variance: 2.5 })).toBe(
      'CC-000035 found 12.5 where 10 was on record, and posting it changed the stock on record by +2.5.',
    );
    expect(countVarianceLead({ countNumber: 35 })).toBe('A count did not match the stock on record (CC-000035).');
    expect(countVarianceLead({})).toBe('A count did not match the stock on record.');
  });
});

describe('countVarianceClearCopy: feature on (the server sends countConfirm)', () => {
  const words = (state: CountConfirmState, reader: Reader, ability: RecountAbility) => {
    const c = countVarianceClearCopy(clearInput(state, reader, ability));
    return { options: c.options, reason: c.reason };
  };

  it('confirmable, reader can confirm: by recount ability', () => {
    expect(words('confirmable', CAN_CONFIRM, 'can')).toEqual({
      options: `If 2 is right, confirm it with Confirm this count. If you are not sure, count it once more with Recount. ${ACK}`,
      reason: null,
    });
    expect(words('confirmable', CAN_CONFIRM, 'not_permitted')).toEqual({
      options: `If 2 is right, confirm it with Confirm this count. If you are not sure, ask a manager who can assign counts for a recount. ${ACK}`,
      reason: null,
    });
    expect(words('confirmable', CAN_CONFIRM, 'module_disabled')).toEqual({
      options: `If 2 is right, confirm it with Confirm this count. ${MODULE_OFF} ${ACK}`,
      reason: null,
    });
  });

  it('confirmable, reader can act but did not count and is not a manager: names the counter', () => {
    for (const ability of ['can', 'not_permitted'] as const) {
      expect(words('confirmable', NOT_COUNTER, ability)).toEqual({
        options: `It clears when Dana Lee, who counted it, or a manager confirms that 2 is right, or when a recount matches the stock on record. ${ACK}`,
        reason: 'Only Dana Lee, who counted it, or a manager can confirm this count.',
      });
    }
    expect(words('confirmable', NOT_COUNTER, 'module_disabled')).toEqual({
      options: `It clears when Dana Lee, who counted it, or a manager confirms that 2 is right. ${ACK}`,
      reason: 'Only Dana Lee, who counted it, or a manager can confirm this count.',
    });
  });

  it('confirmable, the counter unknown: only a manager', () => {
    const c = countVarianceClearCopy(
      clearInput('confirmable', NOT_COUNTER, 'can', { confirm: block('confirmable', NOT_COUNTER, { countedBy: null }) }),
    );
    expect(c.options).toBe(
      `It clears when a manager confirms that 2 is right, or when a recount matches the stock on record. ${ACK}`,
    );
    expect(c.reason).toBe('Only a manager can confirm this count.');
  });

  it('confirmable, reader cannot act (viewer): the sentence without Acknowledging, and no reason', () => {
    expect(words('confirmable', VIEWER, 'not_permitted')).toEqual({
      options:
        'It clears when Dana Lee, who counted it, or a manager confirms that 2 is right, or when a recount matches the stock on record.',
      reason: null,
    });
    expect(words('confirmable', VIEWER, 'module_disabled')).toEqual({
      options: 'It clears when Dana Lee, who counted it, or a manager confirms that 2 is right.',
      reason: null,
    });
  });

  it('recount in progress: says what its result does; the reason only to a reader who can act', () => {
    expect(words('recount_in_progress', NOT_COUNTER, 'can')).toEqual({
      options: `${RECOUNT_IN_PROGRESS} ${ACK}`,
      reason:
        'Confirm this count is not offered while recount CC-000040 is in progress. Its result will settle this, or a manager can cancel it.',
    });
    expect(words('recount_in_progress', VIEWER, 'not_permitted')).toEqual({ options: RECOUNT_IN_PROGRESS, reason: null });
  });

  it('another count in progress recorded a different number', () => {
    expect(words('count_in_progress', NOT_COUNTER, 'can')).toEqual({
      options: `CC-000041, which is in progress, has already recorded 3 for this item. When it is posted, this exception shows its numbers. ${ACK}`,
      reason: 'Confirm this count is not offered while CC-000041 is in progress with a different number for this item.',
    });
    expect(words('count_in_progress', VIEWER, 'not_permitted')).toEqual({
      options:
        'CC-000041, which is in progress, has already recorded 3 for this item. When it is posted, this exception shows its numbers.',
      reason: null,
    });
  });

  it('re-checking and a newer count read the same: it updates at the next check', () => {
    for (const state of ['rechecking', 'count_changed'] as const) {
      expect(words(state, NOT_COUNTER, 'can')).toEqual({ options: `${RECHECKING} ${ACK}`, reason: null });
      expect(words(state, VIEWER, 'not_permitted')).toEqual({ options: RECHECKING, reason: null });
    }
  });

  it('unavailable: what clears it, and why Confirm is missing to a reader who can act', () => {
    expect(words('unavailable', NOT_COUNTER, 'can')).toEqual({
      options: `It clears when the counted number is confirmed or a later count matches the stock on record. ${ACK}`,
      reason: 'Confirming is unavailable right now. Reload to try again.',
    });
    expect(words('unavailable', VIEWER, 'not_permitted')).toEqual({
      options: 'It clears when the counted number is confirmed or a later count matches the stock on record.',
      reason: null,
    });
  });

  it('not countable: it closes at the next check', () => {
    for (const reader of [NOT_COUNTER, VIEWER]) {
      expect(words('not_countable', reader, 'can')).toEqual({
        options: 'This item can no longer be counted, so this exception closes at the next check.',
        reason: null,
      });
    }
  });

  it('stock moved after the count: Confirm is not offered, and the tail is the reader\'s way to clear it', () => {
    const moved = 'The stock on record changed after this count (counted 2, on record now 5), so confirming it is not offered.';
    expect(words('stock_moved', NOT_COUNTER, 'can')).toEqual({
      options: `${moved} Count it once more with Recount. ${ACK}`,
      reason: null,
    });
    expect(words('stock_moved', NOT_COUNTER, 'not_permitted')).toEqual({
      options: `${moved} Ask a manager who can assign counts for a recount. ${ACK}`,
      reason: null,
    });
    expect(words('stock_moved', VIEWER, 'not_permitted')).toEqual({
      options: `${moved} It clears when a recount matches the stock on record.`,
      reason: null,
    });
    expect(words('stock_moved', NOT_COUNTER, 'module_disabled')).toEqual({
      options: `${moved} ${MODULE_OFF} ${ACK}`,
      reason: null,
    });
    expect(words('stock_moved', VIEWER, 'module_disabled')).toEqual({ options: `${moved} ${MODULE_OFF}`, reason: null });
  });

  it('already confirmed on an earlier exception: the stock-moved tail', () => {
    const lead = 'CC-000035 was already confirmed on an earlier exception, so it cannot be confirmed again.';
    expect(words('already_confirmed', NOT_COUNTER, 'can').options).toBe(`${lead} Count it once more with Recount. ${ACK}`);
    expect(words('already_confirmed', VIEWER, 'not_permitted').options).toBe(
      `${lead} It clears when a recount matches the stock on record.`,
    );
    expect(words('already_confirmed', VIEWER, 'module_disabled').options).toBe(`${lead} ${MODULE_OFF}`);
  });

  it('offers Confirm only with canConfirm; offline it stays, disabled, with the reason', () => {
    const on = countVarianceClearCopy(clearInput('confirmable', CAN_CONFIRM, 'can'));
    expect(on.offerConfirm).toBe(true);
    expect(on.confirmDisabledReason).toBeNull();
    const off = countVarianceClearCopy(clearInput('confirmable', CAN_CONFIRM, 'can', { online: false }));
    expect(off.offerConfirm).toBe(true);
    expect(off.confirmDisabledReason).toBe(EXCEPTION_CONFIRM_OFFLINE_COPY);
    expect(off.reason).toBe('You are offline. Confirming a count needs a connection.');
    for (const state of COUNT_CONFIRM_STATES) {
      for (const reader of [NOT_COUNTER, VIEWER]) {
        expect(countVarianceClearCopy(clearInput(state, reader, 'can')).offerConfirm).toBe(false);
      }
    }
  });

  it('says who counted and who posted', () => {
    expect(countVarianceClearCopy(clearInput('confirmable', CAN_CONFIRM, 'can')).who).toBe('Counted and posted by Dana Lee.');
    expect(
      countVarianceClearCopy(
        clearInput('confirmable', CAN_CONFIRM, 'can', {
          confirm: block('confirmable', CAN_CONFIRM, { postedBy: { id: 'u-sam', label: 'Sam Ortiz' } }),
        }),
      ).who,
    ).toBe('Counted by Dana Lee, posted by Sam Ortiz.');
  });

  it('a withheld Confirm leaves the server\'s canConfirm as the only yes: a malformed block never offers it', () => {
    const c = countVarianceClearCopy(
      clearInput('stock_moved', CAN_CONFIRM, 'can', { confirm: { ...block('stock_moved', CAN_CONFIRM), canConfirm: true } }),
    );
    expect(c.offerConfirm).toBe(false);
  });
});

describe('countVarianceClearCopy: feature off (R1, or the server switch off)', () => {
  const off = (reader: Reader, ability: RecountAbility, displayed: OccurrenceState = { kind: 'open' }) => {
    const c = countVarianceClearCopy({
      ...clearInput(null, reader, ability),
      displayed,
      recount: displayed.kind === 'recount_in_progress' ? IN_PROGRESS_RECOUNT : null,
    });
    return c;
  };
  const BASE = 'It clears when a later count of this item matches the stock on record.';

  it('by recount ability, then whether the reader can act', () => {
    expect(off(CAN_CONFIRM, 'can').options).toBe(`${BASE} To close it, count it once more with Recount. ${ACK}`);
    expect(off(NOT_COUNTER, 'not_permitted').options).toBe(
      `${BASE} To close it, ask a manager who can assign counts for a recount. ${ACK}`,
    );
    expect(off(NOT_COUNTER, 'module_disabled').options).toBe(`${BASE} ${MODULE_OFF} ${ACK}`);
    expect(off(VIEWER, 'module_disabled').options).toBe(`${BASE} ${MODULE_OFF}`);
    expect(off(VIEWER, 'not_permitted').options).toBe(BASE);
  });

  it('a recount in progress, and a posted recount being checked, read as with the feature on', () => {
    expect(
      off(NOT_COUNTER, 'can', { kind: 'recount_in_progress', cycleCountId: 'cc-40', countNumber: 40 }).options,
    ).toBe(`${RECOUNT_IN_PROGRESS} ${ACK}`);
    expect(off(VIEWER, 'not_permitted', { kind: 'rechecking', cycleCountId: 'cc-40', countNumber: 40 }).options).toBe(
      RECHECKING,
    );
  });

  it('never names Confirm, never offers it, and has no reason line or who line', () => {
    for (const reader of [CAN_CONFIRM, NOT_COUNTER, VIEWER]) {
      for (const ability of ABILITIES) {
        const c = off(reader, ability);
        expect(c.options).not.toMatch(/confirm/i);
        expect(c.offerConfirm).toBe(false);
        expect(c.reason).toBeNull();
        expect(c.who).toBeNull();
      }
    }
  });

  it('a recount with no number and no progress', () => {
    expect(
      countVarianceClearCopy({
        ...clearInput(null, VIEWER, 'not_permitted'),
        displayed: { kind: 'recount_in_progress', cycleCountId: 'cc-40', countNumber: null },
        recount: { countNumber: null, outcome: { kind: 'in_progress', counted: null, total: null } },
      }).options,
    ).toBe(
      'A recount is in progress. When it is posted, this clears if it matches the stock on record, or shows the new numbers if it does not.',
    );
  });
});

describe('countVarianceClearCopy: the line under Recount', () => {
  it('what a count covers for a reader who can recount; why not only when the options do not already say', () => {
    expect(countVarianceClearCopy(clearInput(null, CAN_CONFIRM, 'can')).recountLine).toBe(RECOUNT_COUNTS_TOTAL_COPY);
    // The options already say to ask a manager, or that the module is off.
    expect(countVarianceClearCopy(clearInput(null, NOT_COUNTER, 'not_permitted')).recountLine).toBeNull();
    expect(countVarianceClearCopy(clearInput(null, NOT_COUNTER, 'module_disabled')).recountLine).toBeNull();
    expect(countVarianceClearCopy(clearInput('stock_moved', NOT_COUNTER, 'not_permitted')).recountLine).toBeNull();
    // They do not: the viewer, a recount in progress, a not-counter row.
    expect(countVarianceClearCopy(clearInput(null, VIEWER, 'not_permitted')).recountLine).toBe(
      RECOUNT_UNAVAILABLE_COPY.not_permitted,
    );
    expect(countVarianceClearCopy(clearInput('confirmable', NOT_COUNTER, 'not_permitted')).recountLine).toBe(
      RECOUNT_UNAVAILABLE_COPY.not_permitted,
    );
    expect(countVarianceClearCopy(clearInput('recount_in_progress', VIEWER, 'module_disabled')).recountLine).toBe(
      RECOUNT_UNAVAILABLE_COPY.module_disabled,
    );
  });
});

describe('countVarianceClearCopy: the whole matrix', () => {
  const READERS: Array<[string, Reader]> = [
    ['can confirm', CAN_CONFIRM],
    ['not counter', NOT_COUNTER],
    ['viewer', VIEWER],
  ];

  it('no cell names Confirm this count unless the reader can confirm, and none promises a recount with Cycle Counts off', () => {
    for (const state of [null, ...COUNT_CONFIRM_STATES]) {
      for (const [, reader] of READERS) {
        for (const ability of ABILITIES) {
          const c = countVarianceClearCopy(clearInput(state, reader, ability));
          const all = [c.lead, c.options, c.reason ?? '', c.who ?? '', c.recountLine ?? ''].join(' ');
          if (!c.offerConfirm) expect(all, `${state} ${ability}`).not.toContain('with Confirm this count');
          if (ability === 'module_disabled') {
            expect(all, `${state}`).not.toMatch(/or when a recount matches|count it once more with Recount/);
          }
          // The Acknowledging sentence only for a reader who sees Acknowledge.
          if (!reader.canAct) expect(c.options).not.toContain('Acknowledging');
          // Plain words: no jargon, no percentages, never a person as a cause.
          expect(all).not.toMatch(/\bbooks?\b|%|verified|accurate|undefined|NaN|null/i);
          expect(all).not.toMatch(/employee|staff|theft|stole|someone|worker|picker/i);
        }
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The Acknowledge step
// ═══════════════════════════════════════════════════════════════════════════

describe('countVarianceAcknowledgeHelp', () => {
  const SAYS = 'Acknowledging tells others this is being looked at. It does not clear this exception.';
  const help = (o: Partial<Parameters<typeof countVarianceAcknowledgeHelp>[0]> = {}) =>
    countVarianceAcknowledgeHelp({
      facts: FACTS,
      displayed: { kind: 'open' },
      recount: null,
      canRecount: false,
      confirm: null,
      ...o,
    });

  it('starts with the lead and its numbers, and says acknowledging does not clear it', () => {
    expect(help()).toBe(`${LEAD} ${SAYS} It clears when a later count matches the stock on record.`);
  });

  it('a reader who can confirm is told to confirm instead', () => {
    expect(help({ confirm: { state: 'confirmable', canConfirm: true } })).toBe(
      `${LEAD} ${SAYS} If you have checked that 2 is right, confirm the count instead.`,
    );
    expect(CONFIRM_COUNT_INSTEAD_LABEL).toBe('Confirm this count instead');
  });

  it('a recount in progress, then a reader who can recount', () => {
    expect(
      help({
        displayed: { kind: 'recount_in_progress', cycleCountId: 'cc-40', countNumber: 40 },
        recount: IN_PROGRESS_RECOUNT,
        canRecount: true,
      }),
    ).toBe(`${LEAD} ${SAYS} It clears when recount CC-000040 is posted and matches the stock on record.`);
    expect(help({ canRecount: true })).toBe(`${LEAD} ${SAYS} To close it, count it once more with Recount.`);
  });

  it('otherwise: with the feature on, a count that can still be confirmed says so; otherwise only a later count', () => {
    expect(help({ confirm: { state: 'confirmable', canConfirm: false } })).toBe(
      `${LEAD} ${SAYS} It clears when the count is confirmed or a later count matches the stock on record.`,
    );
    // A row nobody can confirm never promises a confirmation.
    for (const state of ['stock_moved', 'already_confirmed', 'count_in_progress', 'not_countable'] as const) {
      expect(help({ confirm: { state, canConfirm: false } })).toBe(
        `${LEAD} ${SAYS} It clears when a later count matches the stock on record.`,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The confirmation step, its errors, and what shows afterwards
// ═══════════════════════════════════════════════════════════════════════════

describe('confirmCountDialogCopy', () => {
  it('the numbers, the consequence, the note and the buttons', () => {
    const c = confirmCountDialogCopy({ reference: 'EX-000059', confirm: block('confirmable', CAN_CONFIRM) });
    expect(c.title).toBe('Confirm this count?');
    expect(c.sheetTitle).toBe('Confirm this count');
    expect(c.numbers).toEqual(['Counted in CC-000035: 2', 'On record before the count: 100', 'On record now: 2']);
    expect(c.who).toBe('Counted and posted by Dana Lee.');
    // One VoiceOver element: the numbers read together, never as loose lines.
    expect(c.numbersLabel).toBe(
      'Counted in CC-000035: 2. On record before the count: 100. On record now: 2. Counted and posted by Dana Lee.',
    );
    expect(c.consequence).toBe(
      'Confirming records that 2 is right. It closes EX-000059 now, without a second count. If a later count does not match the stock on record, a new exception opens.',
    );
    expect(c.noteLabel).toBe('Note (optional)');
    expect(c.notePlaceholder).toBe('How you checked, for example counted twice on the floor');
    expect(c.noteMax).toBe(1000);
    expect([c.cancelLabel, c.confirmLabel, c.pendingLabel]).toEqual(['Cancel', 'Confirm and close', 'Confirming...']);
    expect(c.success).toBe('Count confirmed. EX-000059 is closed.');
    expect(CONFIRM_COUNT_LABEL).toBe('Confirm this count');
  });

  it('with no references and unreadable numbers it names nothing it does not know', () => {
    const c = confirmCountDialogCopy({
      reference: null,
      confirm: { ...block('confirmable', CAN_CONFIRM), countNumber: null, onRecordBefore: null, onRecordNow: null, countedBy: null, postedBy: null },
    });
    expect(c.numbers).toEqual(['Counted: 2']);
    expect(c.who).toBeNull();
    expect(c.numbersLabel).toBe('Counted: 2.');
    expect(c.consequence).toBe(
      'Confirming records that 2 is right. It closes this exception now, without a second count. If a later count does not match the stock on record, a new exception opens.',
    );
    expect(c.success).toBe('Count confirmed. This exception is closed.');
  });
});

describe('describeConfirmError', () => {
  const web = { surface: 'web' as const, recount: 'can' as const, recountNumber: 40, counterLabel: 'Dana Lee' };
  const phone = { ...web, surface: 'phone' as const };

  it('words every refusal the route can give, by reason', () => {
    expect(describeConfirmError('occurrence_resolved', web)).toBe(
      'This exception has already been resolved. Refresh to see how.',
    );
    expect(describeConfirmError('occurrence_resolved', phone)).toBe(
      'This exception has already been resolved. Pull down to refresh.',
    );
    expect(describeConfirmError('count_changed', web)).toBe(
      'A newer count of this item was posted. Refresh to see its numbers before confirming.',
    );
    expect(describeConfirmError('stock_moved', web)).toBe(
      'The stock on record changed after this count, so it can no longer be confirmed. Count it once more with Recount.',
    );
    expect(describeConfirmError('stock_moved', { ...web, recount: 'not_permitted' })).toBe(
      'The stock on record changed after this count, so it can no longer be confirmed. Ask a manager who can assign counts for a recount.',
    );
    expect(describeConfirmError('recount_in_progress', web)).toBe(
      'Confirm this count is not offered while recount CC-000040 is in progress. Its result will settle this, or a manager can cancel it.',
    );
    expect(describeConfirmError('count_in_progress', web)).toBe(
      'Another count in progress has recorded a different number for this item. This exception shows its numbers when that count is posted.',
    );
    expect(describeConfirmError('already_confirmed', web)).toBe(
      'This count was already confirmed on an earlier exception, so it cannot be confirmed again. Count it once more with Recount.',
    );
    expect(describeConfirmError('not_countable', web)).toBe(
      'This item can no longer be counted, so this exception closes at the next check.',
    );
    expect(describeConfirmError('not_counter', web)).toBe(
      'Only Dana Lee, who counted it, or a manager can confirm this count.',
    );
    expect(describeConfirmError('busy', web)).toBe('A check is running. Try again in a moment.');
    expect(describeConfirmError('unavailable', web)).toBe('Confirming is unavailable right now. Reload to try again.');
  });

  it('a reason this build does not know reads the generic line, so a later server reason still reads sensibly', () => {
    for (const r of ['unknown', 'not_confirmable', 'a_newer_reason', '', null, undefined, 42]) {
      expect(describeConfirmError(r, web)).toBe('This count could not be confirmed. Refresh and try again.');
    }
    expect(describeConfirmError('a_newer_reason', phone)).toBe(
      'This count could not be confirmed. Pull down to refresh and try again.',
    );
  });
});

describe('confirmationFactsRow', () => {
  it('who confirmed it, whether they counted it, when, and that no second count was made', () => {
    const at = '2026-09-29T17:41:00Z';
    expect(confirmationFactsRow({ at, by: { id: 'u', label: 'Dana Lee' }, as: 'counter' }, 'Sep 29, 10:41 AM')).toEqual({
      label: 'Count confirmed',
      value: 'Dana Lee, who counted it, Sep 29, 10:41 AM, without a second count',
    });
    expect(
      confirmationFactsRow({ at, by: { id: 'u', label: 'Sam Ortiz' }, as: 'manager' }, 'Sep 29, 10:41 AM').value,
    ).toBe('Sam Ortiz, who did not count it, Sep 29, 10:41 AM, without a second count');
    expect(confirmationFactsRow({ at, by: null, as: null }, 'Sep 29, 10:41 AM').value).toBe(
      'Former member, Sep 29, 10:41 AM, without a second count',
    );
  });
});

describe('recountAbilityOf', () => {
  it('reads the server\'s Recount hint and reason; an unknown reason is the permission rule', () => {
    expect(recountAbilityOf(true, null)).toBe('can');
    expect(recountAbilityOf(false, 'module_disabled')).toBe('module_disabled');
    expect(recountAbilityOf(false, 'not_permitted')).toBe('not_permitted');
    expect(recountAbilityOf(false, null)).toBe('not_permitted');
  });
});
