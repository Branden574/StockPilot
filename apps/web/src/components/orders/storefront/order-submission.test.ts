import { describe, expect, it, vi } from 'vitest';

vi.mock('@/server/actions/order-requests', () => ({
  createOrderRequestAction: vi.fn(),
  getOrderSubmissionAction: vi.fn(),
  withdrawOrderSubmissionAction: vi.fn(),
}));

import { serviceErrorStatus, type ServiceError } from '@/server/services/context';

import {
  actionStatusForCode,
  cartStateFromPendingBody,
  orderPendingKey,
  readPendingRecord,
  writePendingRecord,
} from './order-submission';

/**
 * The New order page's pending record helpers (phone ordering PO-2): the
 * per-account key, the read that drops a record another account left, and
 * the status mapping that makes a web refusal classify as the phone's.
 */

const USER = '6d80b722-1e44-4059-aa99-efd69718cb14';
const OTHER = '31d0a995-2701-4481-aed0-ed26130b6e6e';
const KEY = 'eeeeeeee-0000-4000-8000-000000000001';

function record(placer: string, extra: Record<string, unknown> = {}) {
  return {
    key: KEY,
    state: 'possibly_sent',
    sends: 1,
    firstSentAt: '2026-10-04T10:00:00Z',
    body: {
      idempotencyKey: KEY,
      placerUserId: placer,
      warehouseId: 'aaaaaaaa-0000-4000-8000-000000000001',
      fulfillmentType: 'delivery',
      deliveryCharterId: 'cccccccc-0000-4000-8000-000000000001',
      onBehalfOf: { name: 'Maria Lopez', email: 'maria@example.org' },
      notes: 'Room 12',
      neededByLocal: '2026-12-01T09:30',
      lines: [
        { itemId: 'bbbbbbbb-0000-4000-8000-00000000000a', quantity: 2 },
        { itemId: 'bbbbbbbb-0000-4000-8000-00000000000a', quantity: 3 },
      ],
    },
    ...extra,
  };
}

describe('actionStatusForCode', () => {
  it('equals serviceErrorStatus for every ServiceError code (one classification on both surfaces)', () => {
    const codes: Array<ServiceError['code']> = [
      'unauthenticated',
      'forbidden',
      'not_found',
      'validation_error',
      'plan_limit_exceeded',
      'module_disabled',
      'conflict',
      'internal_error',
    ];
    for (const code of codes)
      expect(actionStatusForCode(code), code).toBe(serviceErrorStatus(code));
  });

  it('rate_limited is 429 (the route answers it), anything unknown 500', () => {
    expect(actionStatusForCode('rate_limited')).toBe(429);
    expect(actionStatusForCode('something_new')).toBe(500);
  });
});

describe('the pending record', () => {
  it('lives under one account, one organization and one warehouse', () => {
    expect(orderPendingKey(USER, 'org-1', 'wh-1')).toBe(`order-pending:v1:${USER}:org-1:wh-1`);
  });

  it("reads this account's record", () => {
    localStorage.setItem('k', JSON.stringify(record(USER)));
    expect(readPendingRecord(localStorage, 'k', USER)).toMatchObject({ key: KEY, sends: 1 });
    localStorage.clear();
  });

  it('drops (and removes) a record whose body names another placer, or that is not a record', () => {
    for (const raw of [JSON.stringify(record(OTHER)), 'not json', JSON.stringify({ key: 'x' })]) {
      localStorage.setItem('k', raw);
      expect(readPendingRecord(localStorage, 'k', USER)).toBeNull();
      expect(localStorage.getItem('k')).toBeNull();
    }
  });

  it('keeps a same-account record whose body this build cannot read, flagged (it may have placed an order)', () => {
    localStorage.setItem(
      'k',
      JSON.stringify(record(USER, { body: { idempotencyKey: KEY, placerUserId: USER, odd: 1 } })),
    );
    expect(readPendingRecord(localStorage, 'k', USER)).toMatchObject({
      key: KEY,
      bodyUnreadable: true,
    });
    localStorage.clear();
  });

  it('writes and removes', () => {
    writePendingRecord(localStorage, 'k', record(USER) as never);
    expect(JSON.parse(localStorage.getItem('k')!)).toMatchObject({ key: KEY });
    writePendingRecord(localStorage, 'k', null);
    expect(localStorage.getItem('k')).toBeNull();
  });

  it('a write the browser refuses throws (the caller then sends nothing)', () => {
    const full = {
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
    } as unknown as Storage;
    expect(() => writePendingRecord(full, 'k', record(USER) as never)).toThrow();
  });
});

describe('cartStateFromPendingBody', () => {
  it('rebuilds the locked cart from exactly what was sent (lines of one item summed)', () => {
    const r = record(USER);
    expect(
      cartStateFromPendingBody(r.body as never, 'aaaaaaaa-0000-4000-8000-000000000001'),
    ).toEqual({
      warehouseId: 'aaaaaaaa-0000-4000-8000-000000000001',
      charterId: 'cccccccc-0000-4000-8000-000000000001',
      fulfillmentType: 'delivery',
      onBehalfOf: { name: 'Maria Lopez', email: 'maria@example.org' },
      notes: 'Room 12',
      neededBy: '2026-12-01T09:30',
      lines: [{ itemId: 'bbbbbbbb-0000-4000-8000-00000000000a', quantity: 5 }],
      kits: {},
    });
  });
});
