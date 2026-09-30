import { describe, expect, it, vi } from 'vitest';

import { EXCEPTION_CONFIRM_OFFLINE_COPY, occurrenceStateLabel } from '@stockpilot/core';

import { countVarianceView, displayedStateOf } from './exception-confirm-view';
import { parseExceptionDetail, type MobileExceptionDetail } from './exceptions-api';

// ./api reaches for native modules at import time (exceptions-api.test.ts).
vi.mock('./api', () => ({ api: vi.fn() }));

/**
 * The phone's count-difference view (R1): the top WHAT CLEARS THIS section,
 * the Acknowledge help and what the confirm sheet needs, all from core and
 * the server's answer. The Confirm code ships now and stays DORMANT until the
 * server sends a countConfirm block; the phone gets no second release, so
 * both sides of that switch are pinned here.
 */

const ID = '11111111-1111-4111-8111-111111111111';
const FACTS = { itemName: 'Umbrella', cycleCountId: 'cc-35', countNumber: 35, expected: 100, counted: 2, variance: -98 };

const COUNT_CONFIRM = {
  state: 'confirmable',
  canConfirm: true,
  unavailableReason: null,
  cycleCountId: 'cc-35',
  countNumber: 35,
  counted: 2,
  onRecordBefore: 100,
  onRecordNow: 2,
  countedBy: { id: 'u-dana', label: 'Dana Lee' },
  postedBy: { id: 'u-dana', label: 'Dana Lee' },
  readerIsCounter: true,
  otherCount: null,
};

function detail(o: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): MobileExceptionDetail {
  return parseExceptionDetail({
    organizationId: 'org-1',
    occurrence: {
      id: ID,
      number: 59,
      reference: 'EX-000059',
      rule: 'count_variance',
      itemId: '22222222-2222-4222-8222-222222222222',
      item: { name: 'Umbrella', sku: 'U1' },
      facts: FACTS,
      firstSeenAt: '2026-09-29T17:01:00Z',
      lastSeenAt: '2026-09-29T17:15:00Z',
      acknowledgedAt: null,
      acknowledgedBy: null,
      recount: null,
      resolvedAt: null,
      resolvedReason: null,
      recurrenceIndex: 0,
      canAct: true,
      canRecount: true,
      ...o,
    },
    timeline: [],
    history: [],
    historyTruncated: false,
    syncState: null,
    ...extra,
  });
}

describe('countVarianceView', () => {
  it('only for an open count difference', () => {
    expect(countVarianceView(detail({ rule: 'label_mismatch', facts: {} }), { online: true })).toBeNull();
    expect(countVarianceView(detail({ resolvedAt: '2026-09-29T18:00:00Z', resolvedReason: 'cleared' }), { online: true })).toBeNull();
  });

  // The phone's words and the web's are core's; this pins the switch.
  it('feature off (no block): recount-only words, no Confirm anywhere', () => {
    const v = countVarianceView(detail(), { online: true })!;
    expect(v.clear.lead).toBe('CC-000035 found 2 where 100 was on record, and posting it changed the stock on record by -98.');
    expect(v.clear.options).toBe(
      'It clears when a later count of this item matches the stock on record. To close it, count it once more with Recount. Acknowledging does not clear this.',
    );
    expect(v.clear.offerConfirm).toBe(false);
    expect(v.confirm.block).toBeNull();
    expect(v.acknowledgeHelp).toBe(
      'CC-000035 found 2 where 100 was on record, and posting it changed the stock on record by -98. Acknowledging tells others this is being looked at. It does not clear this exception. To close it, count it once more with Recount.',
    );
    for (const text of [v.clear.options, v.acknowledgeHelp, v.clear.recountLine ?? '']) expect(text).not.toMatch(/confirm/i);
  });

  it('a malformed block is feature off too', () => {
    const v = countVarianceView(detail({}, { countConfirm: { ...COUNT_CONFIRM, counted: 'two' } }), { online: true })!;
    expect(v.clear.offerConfirm).toBe(false);
    expect(v.confirm.block).toBeNull();
  });

  it('feature on, a reader who can confirm: Confirm offered, in the help too', () => {
    const v = countVarianceView(detail({}, { countConfirm: COUNT_CONFIRM }), { online: true })!;
    expect(v.clear.offerConfirm).toBe(true);
    expect(v.clear.confirmDisabledReason).toBeNull();
    expect(v.clear.options).toBe(
      'If 2 is right, confirm it with Confirm this count. If you are not sure, count it once more with Recount. Acknowledging does not clear this.',
    );
    expect(v.clear.who).toBe('Counted and posted by Dana Lee.');
    expect(v.acknowledgeHelp).toMatch(/If you have checked that 2 is right, confirm the count instead\.$/);
    expect(v.confirm.block?.cycleCountId).toBe('cc-35');
    expect(v.confirm.unavailable).toBeNull();
    expect(v.confirm.errorContext).toEqual({ recount: 'can', recountNumber: null, counterLabel: 'Dana Lee' });
  });

  // Mutation caught: the view built with online: true.
  it('offline, Confirm stays offered but disabled, with the reason', () => {
    const v = countVarianceView(detail({}, { countConfirm: COUNT_CONFIRM }), { online: false })!;
    expect(v.clear.offerConfirm).toBe(true);
    expect(v.clear.confirmDisabledReason).toBe(EXCEPTION_CONFIRM_OFFLINE_COPY);
    expect(v.clear.reason).toBe(EXCEPTION_CONFIRM_OFFLINE_COPY);
  });

  it('feature on, a reader who cannot: why, handed to the sheet as the reason', () => {
    const v = countVarianceView(
      detail({ canRecount: false }, { countConfirm: { ...COUNT_CONFIRM, canConfirm: false, unavailableReason: 'not_counter', readerIsCounter: false } }),
      { online: true },
    )!;
    expect(v.clear.offerConfirm).toBe(false);
    expect(v.clear.reason).toBe('Only Dana Lee, who counted it, or a manager can confirm this count.');
    expect(v.confirm.unavailable).toBe('Only Dana Lee, who counted it, or a manager can confirm this count.');
  });

  // Review 2026-09-29 (the phone keeps this core after the server turns
  // Confirm on): the counter the act gate refuses is told why, never named
  // to themselves in the third person.
  it('feature on, the counter who cannot act on the item: only a manager, and why, handed to the sheet', () => {
    const v = countVarianceView(
      detail({}, { countConfirm: { ...COUNT_CONFIRM, canConfirm: false, unavailableReason: 'not_permitted', readerIsCounter: true } }),
      { online: true },
    )!;
    const why = 'You counted it, but you cannot change stock for this item, so only a manager can confirm this count.';
    expect(v.clear.options).toBe(
      'It clears when a manager confirms that 2 is right, or when a recount matches the stock on record. Acknowledging does not clear this.',
    );
    expect(v.clear.reason).toBe(why);
    expect(v.confirm.unavailable).toBe(why);
  });

  it('feature on, the item can no longer be counted: no Recount, and the Acknowledge help agrees', () => {
    const v = countVarianceView(
      detail({}, { countConfirm: { ...COUNT_CONFIRM, state: 'not_countable', canConfirm: false, unavailableReason: 'not_countable' } }),
      { online: true },
    )!;
    expect(v.clear.offerRecount).toBe(false);
    expect(v.clear.recountLine).toBeNull();
    expect(v.acknowledgeHelp).toMatch(/This item can no longer be counted, so this exception closes at the next check\.$/);
  });

  it('the active recount names the count for the error words', () => {
    const v = countVarianceView(
      detail(
        {
          recount: {
            cycleCountId: 'cc-40',
            countNumber: 40,
            status: 'in_progress',
            completedAt: null,
            outcome: { kind: 'in_progress', counted: 1, total: 1 },
          },
        },
        { countConfirm: { ...COUNT_CONFIRM, state: 'recount_in_progress', canConfirm: false, unavailableReason: 'recount_in_progress' } },
      ),
      { online: true },
    )!;
    expect(v.confirm.errorContext.recountNumber).toBe(40);
    expect(v.clear.options).toMatch(/^Recount CC-000040 is in progress \(1 of 1 counted\)\./);
  });
});

describe('displayedStateOf', () => {
  it('a confirmed row reads with who confirmed it; an unknown reason reads "Resolved"', () => {
    const confirmed = detail({
      resolvedAt: '2026-09-29T17:41:00Z',
      resolvedReason: 'confirmed',
      confirmation: { at: '2026-09-29T17:41:00Z', by: { id: 'u', label: 'Sam Ortiz' }, cycleCountId: 'cc-35', countNumber: 35, quantity: 2, as: 'manager' },
    });
    expect(occurrenceStateLabel(displayedStateOf(confirmed))).toBe('Resolved: Confirmed by a manager');
    const unknown = detail({ resolvedAt: '2026-09-29T17:41:00Z', resolvedReason: 'a_newer_reason' });
    expect(occurrenceStateLabel(displayedStateOf(unknown))).toBe('Resolved');
  });
});
