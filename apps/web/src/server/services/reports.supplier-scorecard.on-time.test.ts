import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

const { reportErrorMock } = vi.hoisted(() => ({ reportErrorMock: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: reportErrorMock }));

import { ReportsService } from './reports';

/**
 * Supplier scorecard, On-time rate.
 *
 * A purchase order's expected date is a DAY, stored as that day's midnight UTC;
 * received_at is an instant. The scorecard counted a delivery on time when
 * `received_at <= expected_at`, so a delivery received at any time ON its
 * expected day (after that midnight UTC) counted as LATE. The rule (core
 * isPastExpectedDay): late when it was received on a day, in the
 * organization's zone, after the expected day. The expected day is on time.
 */

const LA = 'America/Los_Angeles';
const SYDNEY = 'Australia/Sydney';

/** Expected Oct 10, as every writer stores it. */
const OCT_10 = '2026-10-10T00:00:00.000Z';

let seq = 0;
function delivery(supplier: string, expected_at: string | null, received_at: string | null) {
  seq += 1;
  return {
    id: `po-${String(seq).padStart(3, '0')}`,
    supplier_id: supplier,
    status: 'received',
    ordered_at: '2026-10-01T00:00:00.000Z',
    expected_at,
    received_at,
    total: 100,
    created_at: '2026-10-01T00:00:00.000Z',
    supplier: { name: supplier },
  };
}

async function onTimeRates(zone: string | null, pos: ReturnType<typeof delivery>[]) {
  const stub = makeSupabaseStub({
    'organizations.select': { data: [{ timezone: zone }], error: null },
    'purchase_orders.select': { data: pos, error: null },
    'purchase_order_items.select': { data: [], error: null },
  });
  const report = await new ReportsService(makeServiceContext(stub.client) as never).supplierScorecard();
  return {
    stub,
    rates: Object.fromEntries(report.rows.map((r) => [r.supplierName, r.onTimeRate])),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
});

describe('supplier scorecard: a delivery is late only when received after its expected day, in the organization zone', () => {
  it('Los Angeles: received at 3 PM and at 11 PM on the expected day is on time; the next morning is late', async () => {
    const { rates } = await onTimeRates(LA, [
      delivery('On the day', OCT_10, '2026-10-10T22:00:00.000Z'), // Oct 10, 3 PM PDT
      delivery('Late evening', OCT_10, '2026-10-11T06:00:00.000Z'), // Oct 10, 11 PM PDT (Oct 11 in UTC)
      delivery('Early', OCT_10, '2026-10-09T18:00:00.000Z'), // Oct 9, 11 AM PDT
      delivery('Next morning', OCT_10, '2026-10-11T16:00:00.000Z'), // Oct 11, 9 AM PDT
    ]);
    expect(rates).toEqual({
      'On the day': 1,
      'Late evening': 1,
      Early: 1,
      'Next morning': 0,
    });
  });

  it('Sydney: received at 2 PM on the expected day is on time; at 8 AM the next day it is late', async () => {
    const { rates } = await onTimeRates(SYDNEY, [
      delivery('On the day', OCT_10, '2026-10-10T03:00:00.000Z'), // Oct 10, 2 PM AEDT
      delivery('Next morning', OCT_10, '2026-10-10T21:00:00.000Z'), // Oct 11, 8 AM AEDT
    ]);
    expect(rates).toEqual({ 'On the day': 1, 'Next morning': 0 });
  });

  it('weighs a supplier across its deliveries, and leaves out a purchase order without both dates', async () => {
    const { rates } = await onTimeRates(LA, [
      delivery('Meridian', OCT_10, '2026-10-10T22:00:00.000Z'), // on time (on the day)
      delivery('Meridian', OCT_10, '2026-10-12T17:00:00.000Z'), // late (Oct 12)
      delivery('Meridian', '2026-10-12T00:00:00.000Z', '2026-10-12T23:00:00.000Z'), // on time (Oct 12, 4 PM)
      delivery('Meridian', null, '2026-10-12T23:00:00.000Z'), // no expected date: not counted
      delivery('Meridian', OCT_10, null), // not received: not counted
    ]);
    expect(rates.Meridian).toBeCloseTo(2 / 3);
  });

  it('reads the zone from the organization row, and an unreadable row uses the documented default zone and is reported', async () => {
    const { stub } = await onTimeRates(SYDNEY, [delivery('X', OCT_10, '2026-10-10T03:00:00.000Z')]);
    expect(stub.chainArgs.get('organizations.select')).toEqual([['timezone'], ['id', 'org-test']]);

    const failing = makeSupabaseStub({
      'organizations.select': { data: null, error: { message: 'permission denied' } },
      'purchase_orders.select': {
        // 11 PM on Oct 10 in Los Angeles (the default zone): on time there.
        data: [delivery('Default zone', OCT_10, '2026-10-11T06:00:00.000Z')],
        error: null,
      },
      'purchase_order_items.select': { data: [], error: null },
    });
    const report = await new ReportsService(
      makeServiceContext(failing.client) as never,
    ).supplierScorecard();
    expect(report.rows[0]?.onTimeRate).toBe(1);
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock.mock.calls[0]![1]).toMatchObject({
      tag: 'reports.supplier_scorecard.org_timezone',
      level: 'warning',
    });
  });
});
