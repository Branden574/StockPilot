import { describe, expect, it } from 'vitest';

import { recordCountBody } from './cycle-count-record-body';

/**
 * Server 0369 measures a count against the book at the moment it was TAKEN.
 * The phone sends capturedAt (stamped at enqueue, or the row's own created_at
 * for a row queued before the field existed) and clientSentAt (this send).
 */
describe('recordCountBody', () => {
  const now = Date.parse('2026-09-24T15:00:00.000Z');
  const created = Date.parse('2026-09-24T14:20:00.000Z');

  it('keeps the capture time stamped at enqueue and adds the send time', () => {
    const body = recordCountBody(
      { cycleCountId: 'cc1', lineId: 'l1', countedQuantity: 5, capturedAt: '2026-09-24T14:21:00.000Z' },
      5,
      created,
      now,
    );
    expect(body).toEqual({
      cycleCountId: 'cc1',
      lineId: 'l1',
      countedQuantity: 5,
      capturedAt: '2026-09-24T14:21:00.000Z',
      clientSentAt: '2026-09-24T15:00:00.000Z',
    });
  });

  it('a row queued before capturedAt existed falls back to its created_at', () => {
    const body = recordCountBody({ cycleCountId: 'cc1', lineId: 'l1', countedQuantity: 5 }, 5, created, now);
    expect(body.capturedAt).toBe('2026-09-24T14:20:00.000Z');
    expect(body.clientSentAt).toBe('2026-09-24T15:00:00.000Z');
  });

  it('no usable time at all: neither field is sent (an online record)', () => {
    for (const createdAt of [null, undefined, Number.NaN, 1]) {
      const body = recordCountBody({ cycleCountId: 'cc1', lineId: 'l1', countedQuantity: 5 }, 5, createdAt, now);
      expect('capturedAt' in body).toBe(false);
      expect('clientSentAt' in body).toBe(false);
    }
  });

  it('a blank stamped capturedAt is replaced by created_at, and the counted quantity is the normalized one', () => {
    const body = recordCountBody(
      { cycleCountId: 'cc1', lineId: 'l1', countedQuantity: '5', capturedAt: '  ' },
      5,
      created,
      now,
    );
    expect(body.countedQuantity).toBe(5);
    expect(body.capturedAt).toBe('2026-09-24T14:20:00.000Z');
  });

  it('never forwards a stale clientSentAt from the payload', () => {
    const body = recordCountBody(
      { cycleCountId: 'cc1', lineId: 'l1', countedQuantity: 5, clientSentAt: '2020-01-01T00:00:00.000Z' },
      5,
      null,
      now,
    );
    expect('clientSentAt' in body).toBe(false);
  });
});
