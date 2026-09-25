import { describe, expect, it } from 'vitest';

import {
  adjustDrainVerdict,
  createAdjustSendGate,
  describeQueuedAdjust,
  describeQueuedChanges,
  discardedInFlightAdjustMessage,
  formatQueuedNet,
  isUnconfirmedAdjustRow,
  offlineAdjustNote,
  orphanedQueuedAdjustMessage,
  parseQueuedAdjust,
  QueuedAdjustInvalidError,
  queuedAdjustPayload,
  queuedAdjustRefusalReason,
  refusedQueuedAdjustMessage,
  UNCONFIRMED_ADJUST_PREFIX,
  unconfirmedQueuedAdjustMessage,
  wasAnswered,
} from './adjust-outbox';
import { UNCONFIRMED_SETTLE_MS } from './unconfirmed-stock';

/** Shaped like api()'s ApiError: the verdict reads `status` and `code` only. */
function httpError(status: number, code?: string, message = 'boom') {
  return Object.assign(new Error(message), { name: 'ApiError', status, code });
}

const QUEUED_AT = Date.UTC(2026, 8, 25, 17, 2, 3);
const PAYLOAD = queuedAdjustPayload({
  itemId: 'item-1',
  body: { quantityChange: -1, movementType: 'remove', reason: 'Mobile detail' },
  itemLabel: '  Polo S (POLO-S)  ',
  queuedAt: QUEUED_AT,
});

describe('the queued row carries the online body, plus what the operator needs', () => {
  it('stores the item, the exact body fields, the offline note and the label', () => {
    expect(PAYLOAD).toEqual({
      itemId: 'item-1',
      quantityChange: -1,
      movementType: 'remove',
      reason: 'Mobile detail',
      notes: 'Queued offline on the phone at 2026-09-25T17:02:03.000Z (phone clock).',
      itemLabel: 'Polo S (POLO-S)',
    });
    expect(offlineAdjustNote(QUEUED_AT)).toBe(PAYLOAD.notes);
  });

  it('omits an empty label rather than storing a blank one', () => {
    const p = queuedAdjustPayload({
      itemId: 'item-1',
      body: { quantityChange: 2, movementType: 'add', reason: 'Mobile detail' },
      itemLabel: '   ',
      queuedAt: QUEUED_AT,
    });
    expect(p).not.toHaveProperty('itemLabel');
  });

  it('reads back to exactly the route body: no item id, no label, no idempotency key', () => {
    const parsed = parseQueuedAdjust(PAYLOAD);
    expect(parsed.itemId).toBe('item-1');
    expect(parsed.itemLabel).toBe('Polo S (POLO-S)');
    expect(parsed.body).toEqual({
      quantityChange: -1,
      movementType: 'remove',
      reason: 'Mobile detail',
      notes: PAYLOAD.notes,
    });
  });

  it.each([
    [{ quantityChange: 1 }, 'no item'],
    [{ itemId: '  ', quantityChange: 1 }, 'no item'],
    [{ itemId: 'item-1', quantityChange: 0 }, 'no quantity'],
    [{ itemId: 'item-1', quantityChange: '1' }, 'no quantity'],
    [{ itemId: 'item-1', quantityChange: Number.NaN }, 'no quantity'],
    [{ itemId: 'item-1' }, 'no quantity'],
  ])('refuses an unusable payload %j (%s)', (payload, detail) => {
    expect(() => parseQueuedAdjust(payload as Record<string, unknown>)).toThrow(
      QueuedAdjustInvalidError,
    );
    expect(() => parseQueuedAdjust(payload as Record<string, unknown>)).toThrow(detail);
  });

  it('drops a movement kind the route would refuse, so the server derives it from the sign', () => {
    const parsed = parseQueuedAdjust({ itemId: 'i', quantityChange: -2, movementType: 'receive_po' });
    expect(parsed.body).toEqual({ quantityChange: -2 });
  });
});

describe('adjustDrainVerdict — AT MOST ONCE', () => {
  const live = { accountDisabled: false, handedOff: true };

  it('a request never handed to fetch is retried, whatever the error', () => {
    expect(adjustDrainVerdict(new Error('Network request failed'), { ...live, handedOff: false })).toBe(
      'failed',
    );
    expect(adjustDrainVerdict(null, { ...live, handedOff: false })).toBe('failed');
  });

  it('a malformed row is rejected before anything is sent', () => {
    expect(
      adjustDrainVerdict(new QueuedAdjustInvalidError('no item'), { ...live, handedOff: false }),
    ).toBe('rejected');
  });

  it.each([400, 403, 409, 422])('a definitive %i refusal is rejected (nothing was written)', (s) => {
    expect(adjustDrainVerdict(httpError(s, 'forbidden'), live)).toBe('rejected');
  });

  it("a 404 carrying our code (the item is gone) is rejected; a framework 404 is retried", () => {
    expect(adjustDrainVerdict(httpError(404, 'not_found'), live)).toBe('rejected');
    expect(adjustDrainVerdict(httpError(404), live)).toBe('failed');
  });

  it('a 401 is retried on a live account and rejected on a disabled one', () => {
    expect(adjustDrainVerdict(httpError(401, 'unauthenticated'), live)).toBe('failed');
    expect(
      adjustDrainVerdict(httpError(401, 'unauthenticated'), { ...live, accountDisabled: true }),
    ).toBe('rejected');
  });

  it('a 429 is retried: the rate limit answers before the route writes', () => {
    expect(adjustDrainVerdict(httpError(429, 'rate_limited'), live)).toBe('failed');
  });

  it.each([500, 502, 503, 504, 408])(
    'a %i after the hand-off is UNCONFIRMED: it may have committed, so it is never re-sent',
    (s) => {
      expect(adjustDrainVerdict(httpError(s), live)).toBe('unconfirmed');
    },
  );

  it('a network error or timeout after the hand-off is UNCONFIRMED', () => {
    expect(adjustDrainVerdict(new Error('Network request failed'), live)).toBe('unconfirmed');
    expect(
      adjustDrainVerdict(new Error('Request timed out. Check your connection and try again.'), live),
    ).toBe('unconfirmed');
    expect(adjustDrainVerdict(null, live)).toBe('unconfirmed');
  });
});

describe('what the operator is told', () => {
  it('an unconfirmed send names the change and the item, and says it may have been saved', () => {
    const m = unconfirmedQueuedAdjustMessage(PAYLOAD);
    expect(m.startsWith(UNCONFIRMED_ADJUST_PREFIX)).toBe(true);
    expect(m).toContain('−1 to Polo S (POLO-S)');
    expect(m).toMatch(/may or may not have been saved/);
    expect(m).toMatch(/not sent again/);
  });

  it('a send cut short by the app closing says so, with the same prefix', () => {
    const m = orphanedQueuedAdjustMessage(PAYLOAD);
    expect(m.startsWith(UNCONFIRMED_ADJUST_PREFIX)).toBe(true);
    expect(m).toMatch(/when the app closed/);
  });

  it('a refusal quotes the server and says nothing was changed', () => {
    expect(refusedQueuedAdjustMessage(PAYLOAD, 'Insufficient stock for this adjustment')).toBe(
      '−1 to Polo S (POLO-S): Insufficient stock for this adjustment. Nothing was changed.',
    );
    expect(refusedQueuedAdjustMessage({}, '')).toBe(
      'A change to an item: The server refused it. Nothing was changed.',
    );
  });

  it('describes a payload without a label or a readable quantity without throwing', () => {
    expect(describeQueuedAdjust({ quantityChange: 5 })).toBe('+5 to an item');
    expect(describeQueuedAdjust({ quantityChange: 'x' })).toBe('A change to an item');
  });

  it('only an adjust_stock row with the prefix counts as not confirmed', () => {
    const m = unconfirmedQueuedAdjustMessage(PAYLOAD);
    expect(isUnconfirmedAdjustRow({ kind: 'adjust_stock', lastError: m })).toBe(true);
    expect(isUnconfirmedAdjustRow({ kind: 'distribute_bundle', lastError: m })).toBe(false);
    expect(
      isUnconfirmedAdjustRow({
        kind: 'adjust_stock',
        lastError: refusedQueuedAdjustMessage(PAYLOAD, 'Forbidden'),
      }),
    ).toBe(false);
    expect(isUnconfirmedAdjustRow({ kind: 'adjust_stock', lastError: null })).toBe(false);
  });

  it('formats the queued net for the item screen', () => {
    expect(formatQueuedNet(3)).toBe('+3');
    expect(formatQueuedNet(-2)).toBe('−2');
    expect(formatQueuedNet(0)).toBe('0');
  });
});

describe('the words for queued changes (the ON HAND note and the Adjust sheet)', () => {
  it('one change is its signed amount', () => {
    expect(describeQueuedChanges({ count: 1, net: 1 })).toBe('+1');
    expect(describeQueuedChanges({ count: 1, net: -5 })).toBe('−5');
  });

  it('two or more say how many, so changes that net to 0 never read as nothing queued', () => {
    expect(describeQueuedChanges({ count: 2, net: 0 })).toBe('2 changes, net 0');
    expect(describeQueuedChanges({ count: 3, net: 4 })).toBe('3 changes, net +4');
  });
});

describe('a parked "Not confirmed" record', () => {
  it('says to wait out the window in which a saved change can still appear', () => {
    const secs = `${UNCONFIRMED_SETTLE_MS / 1000} seconds`;
    expect(unconfirmedQueuedAdjustMessage(PAYLOAD)).toContain(`within ${secs} of being sent`);
    expect(orphanedQueuedAdjustMessage(PAYLOAD)).toContain(`within ${secs} of being sent`);
  });

  it('one discarded at sign-out while on the wire is a not-confirmed record, never "nothing changed"', () => {
    const m = discardedInFlightAdjustMessage(PAYLOAD);
    expect(m.startsWith(UNCONFIRMED_ADJUST_PREFIX)).toBe(true);
    expect(m).toContain('−1 to Polo S (POLO-S)');
    expect(m).toMatch(/discarded at sign-out/);
    expect(m).toMatch(/may or may not have been saved/);
    expect(m).not.toMatch(/Nothing was changed/);
    expect(isUnconfirmedAdjustRow({ kind: 'adjust_stock', lastError: m })).toBe(true);
  });
});

describe('queuedAdjustRefusalReason', () => {
  it("never records the route's bare 401 code word", () => {
    expect(queuedAdjustRefusalReason(httpError(401, 'unauthenticated'), 'unauthenticated')).toBe(
      'This account was disabled when it was sent',
    );
    expect(
      refusedQueuedAdjustMessage(
        PAYLOAD,
        queuedAdjustRefusalReason(httpError(401, 'unauthenticated'), 'unauthenticated'),
      ),
    ).toBe('−1 to Polo S (POLO-S): This account was disabled when it was sent. Nothing was changed.');
  });

  it("keeps every other refusal's server sentence", () => {
    expect(queuedAdjustRefusalReason(httpError(403), 'Missing permission: stock:adjust')).toBe(
      'Missing permission: stock:adjust',
    );
  });
});

describe('the send gate', () => {
  it('is closed at app start, opens on any answer, and closes on a lost one', () => {
    const gate = createAdjustSendGate();
    expect(gate.canSend()).toBe(false);
    gate.serverAnswered();
    expect(gate.canSend()).toBe(true);
    gate.noAnswer();
    expect(gate.canSend()).toBe(false);
    gate.serverAnswered();
    gate.resetForTests();
    expect(gate.canSend()).toBe(false);
  });

  it('an HTTP status is an answer; a network error or a timeout is not', () => {
    expect(wasAnswered(httpError(500))).toBe(true);
    expect(wasAnswered(httpError(401))).toBe(true);
    expect(wasAnswered(new TypeError('Network request failed'))).toBe(false);
    expect(wasAnswered(new Error('Request timed out.'))).toBe(false);
    expect(wasAnswered(null)).toBe(false);
  });
});
