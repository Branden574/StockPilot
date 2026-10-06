import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

import { buildDigestPayload, getDigestData, getDigestSource } from './digest';

/**
 * The weekly digest's OVERDUE flag and its "N purchase orders overdue" count.
 *
 * A purchase order's expected date is a DAY, stored as that day's midnight
 * UTC. The digest flagged a purchase order overdue when that stored midnight
 * was before the moment the digest was built, so the Monday digest (14:00 UTC,
 * 7 AM in Los Angeles) flagged every purchase order expected THAT Monday as
 * overdue, and a preview sent on a Sunday evening flagged Monday's. The rule
 * (core isPastExpectedDay): overdue once the organization's current date is
 * after the expected day.
 */

const LA = 'America/Los_Angeles';
const SYDNEY = 'Australia/Sydney';

/** Monday Oct 12 2026, 14:00 UTC: the cron's send time (vercel.json
 *  `0 14 * * 1`). 7 AM Monday in Los Angeles, 1 AM Tuesday in Sydney. */
const MONDAY_SEND = new Date('2026-10-12T14:00:00.000Z');

const po = (id: string, expected_at: string | null) => ({
  id,
  organization_id: 'org-1',
  po_number: id.toUpperCase(),
  status: 'ordered',
  expected_at,
  destination_location_id: null,
  destination: null,
  supplier: { name: 'Meridian' },
});

const POS = [
  po('sunday', '2026-10-11T00:00:00.000Z'),
  po('monday', '2026-10-12T00:00:00.000Z'),
  po('tuesday', '2026-10-13T00:00:00.000Z'),
  po('no-date', null),
];

function client() {
  return makeSupabaseStub({
    'purchase_orders.select': servedLikePostgrest(POS),
    'inventory_items.select': { data: [], error: null },
    'cycle_counts.select': { data: [], error: null },
  }).client;
}

function flags(pos: Array<{ id: string; isOverdue: boolean }>): Record<string, boolean> {
  return Object.fromEntries(pos.map((p) => [p.id, p.isOverdue]));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the digest flags a purchase order overdue only after its expected day, in the organization's zone", () => {
  it('the Monday digest in Los Angeles: Sunday’s is overdue, the one expected that Monday is not', async () => {
    vi.setSystemTime(MONDAY_SEND);
    const source = await getDigestSource(client(), 'org-1', { timeZone: LA, now: MONDAY_SEND });
    expect(flags(source.openPos)).toEqual({
      sunday: true,
      monday: false,
      tuesday: false,
      'no-date': false,
    });
    const payload = buildDigestPayload(source, null);
    expect(payload.overduePosTotal).toBe(1);
    expect(payload.openPos.filter((p) => p.isOverdue).map((p) => p.id)).toEqual(['sunday']);
  });

  it('the same send in Sydney, where it is already Tuesday morning: Sunday’s and Monday’s are overdue', async () => {
    vi.setSystemTime(MONDAY_SEND);
    const source = await getDigestSource(client(), 'org-1', { timeZone: SYDNEY, now: MONDAY_SEND });
    expect(flags(source.openPos)).toEqual({
      sunday: true,
      monday: true,
      tuesday: false,
      'no-date': false,
    });
    expect(buildDigestPayload(source, null).overduePosTotal).toBe(2);
  });

  it('a preview on Sunday evening in Los Angeles flags nothing: Sunday is still today there', async () => {
    const sundayEvening = new Date('2026-10-12T01:00:00.000Z'); // Sun Oct 11, 6 PM PDT
    vi.setSystemTime(sundayEvening);
    const payload = await getDigestData(client(), 'org-1', { timeZone: LA, now: sundayEvening });
    expect(flags(payload.openPos)).toEqual({
      sunday: false,
      monday: false,
      tuesday: false,
      'no-date': false,
    });
    expect(payload.overduePosTotal).toBe(0);
  });

  it('a preview on Tuesday evening in Sydney does not flag the one expected that Tuesday', async () => {
    const tuesdayEvening = new Date('2026-10-13T08:00:00.000Z'); // Tue Oct 13, 7 PM AEDT
    vi.setSystemTime(tuesdayEvening);
    const payload = await getDigestData(client(), 'org-1', { timeZone: SYDNEY, now: tuesdayEvening });
    expect(flags(payload.openPos)).toEqual({
      sunday: true,
      monday: true,
      tuesday: false,
      'no-date': false,
    });
  });

  it('an organization row with no zone reads as the documented default zone (Los Angeles)', async () => {
    vi.setSystemTime(MONDAY_SEND);
    const source = await getDigestSource(client(), 'org-1', { timeZone: null, now: MONDAY_SEND });
    expect(flags(source.openPos).monday).toBe(false);
    expect(flags(source.openPos).sunday).toBe(true);
  });
});
