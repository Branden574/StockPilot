import { describe, expect, it } from 'vitest';

import type { OutboxRow } from './cycle-count-cache';
import { latestRowsPerLine } from './outbox-order';

const row = (id: number, lineId: string | null, countedQuantity: number): OutboxRow => ({
  id,
  kind: 'record_count',
  idempotencyKey: `k${id}`,
  payload: lineId ? { cycleCountId: 'c', lineId, countedQuantity } : { countedQuantity },
  attempts: 0,
  lastAttemptAt: null,
  status: 'pending',
});

describe('latestRowsPerLine — an older queued count never lands over a newer one', () => {
  it('sends only the newest row per line and supersedes the rest', () => {
    // Counted 5, corrected to 7: the 5 must never be sent.
    const { send, superseded } = latestRowsPerLine([row(1, 'L', 5), row(2, 'L', 7)]);
    expect(send.map((r) => r.id)).toEqual([2]);
    expect(superseded.map((r) => r.id)).toEqual([1]);
  });

  it('orders by id, not by array position — a retry that reorders rows cannot resurrect the old value', () => {
    const { send, superseded } = latestRowsPerLine([row(9, 'L', 7), row(3, 'L', 5)]);
    expect(send.map((r) => r.id)).toEqual([9]);
    expect(superseded.map((r) => r.id)).toEqual([3]);
  });

  it('keeps unrelated lines independent', () => {
    const { send, superseded } = latestRowsPerLine([row(1, 'A', 1), row(2, 'B', 2), row(3, 'A', 3)]);
    expect(send.map((r) => r.id).sort()).toEqual([2, 3]);
    expect(superseded.map((r) => r.id)).toEqual([1]);
  });

  it('passes rows without a lineId through untouched', () => {
    const { send, superseded } = latestRowsPerLine([row(1, null, 1)]);
    expect(send).toHaveLength(1);
    expect(superseded).toHaveLength(0);
  });
});
