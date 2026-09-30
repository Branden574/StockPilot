import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NEEDED_BY_IN_PAST_COPY, wallClockToInstant, type OrderReadinessResult } from '@stockpilot/core';

import { assertWarehouseAccess, roleSeesEveryWarehouse, type WarehouseAccess } from '@/lib/auth/warehouse';
import { orderReadinessFacts, READINESS_FAILED, readinessOk, visibleItemFacts } from '@/test/order-readiness-facts';

import {
  initialNeededByWallClock,
  minNeededByWallClock,
  neededByChangeView,
  neededByExpectedToSend,
  readNeededByDraft,
} from './needed-by-change';

/**
 * F2-4: who the web order page offers "Change" beside the needed-by, in which
 * zone its dialog works, and the dialog's pure steps. The server re-checks
 * everything on save (the service and revise_order_needed_by); these keep the
 * entry away from people the save would refuse and the preview in the zone the
 * save converts in.
 */

const LA = 'America/Los_Angeles';
const NOW = Date.parse('2026-09-29T17:00:00Z');

const facts = (timeZone: string | null): OrderReadinessResult =>
  readinessOk(
    orderReadinessFacts('o-1', 'approved', [{ lineId: 'L1', itemId: 'i1', requested: 1 }], [visibleItemFacts('i1')], {
      timeZone,
    }),
  );

const base = {
  orderId: 'o-1',
  status: 'approved',
  neededBy: '2026-10-01T21:00:00.123456+00:00',
  warehouseId: 'wh-1',
  canApprove: true,
  role: 'manager' as const,
  roleSeesEveryWarehouse: true,
  access: null,
  zoneFacts: facts('America/New_York'),
  now: NOW,
};

const runtimeZone = process.env.TZ;
beforeEach(() => {
  // Neither the org's zone nor UTC: nothing here may read the runtime's.
  process.env.TZ = 'Asia/Tokyo';
});
afterEach(() => {
  if (runtimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = runtimeZone;
});

describe('neededByChangeView: who is offered Change', () => {
  it('an approver whose role gives every warehouse, on an open order, with the zone read: the view, the date exactly as read', () => {
    expect(neededByChangeView(base)).toEqual({
      orderId: 'o-1',
      neededBy: '2026-10-01T21:00:00.123456+00:00',
      status: 'approved',
      timeZone: 'America/New_York',
      rowLabel: 'Needed by Thu, Oct 1, 5:00 PM',
    });
  });

  it('never without orders:approve, and never on a closed order', () => {
    expect(neededByChangeView({ ...base, canApprove: false })).toBeNull();
    for (const status of ['completed', 'denied', 'cancelled', 'pending_confirmation']) {
      expect(neededByChangeView({ ...base, status }), status).toBeNull();
    }
    for (const status of ['pending_approval', 'backordered', 'picking_complete', 'in_transit']) {
      expect(neededByChangeView({ ...base, status }), status).not.toBeNull();
    }
  });

  it("anyone else needs write access to the order's warehouse, as the service asserts it", () => {
    const staff = { ...base, role: 'staff' as const, roleSeesEveryWarehouse: false };
    expect(neededByChangeView({ ...staff, access: { hasAllAccess: false, writableIds: ['wh-1'] } })).not.toBeNull();
    expect(neededByChangeView({ ...staff, access: { hasAllAccess: true, writableIds: [] } })).not.toBeNull();
    expect(neededByChangeView({ ...staff, access: { hasAllAccess: false, writableIds: ['wh-2'] } })).toBeNull();
    // Not read (or a failed read): no access, never a guess.
    expect(neededByChangeView({ ...staff, access: null })).toBeNull();
    // A read-only role never writes, whatever its access lists say.
    expect(
      neededByChangeView({ ...staff, role: 'viewer', access: { hasAllAccess: true, writableIds: ['wh-1'] } }),
    ).toBeNull();
  });

  it("the org's zone must have been READ: a failed or missing read offers no Change; an org with no zone set is core's default", () => {
    expect(neededByChangeView({ ...base, zoneFacts: READINESS_FAILED })).toBeNull();
    expect(neededByChangeView({ ...base, zoneFacts: null })).toBeNull();
    expect(neededByChangeView({ ...base, zoneFacts: facts(null) })).toMatchObject({ timeZone: LA });
    // An unknown zone resolves as the server resolves it.
    expect(neededByChangeView({ ...base, zoneFacts: facts('Mars/Olympus_Mons') })).toMatchObject({ timeZone: LA });
  });

  it("agrees with the service's own gate (assertWarehouseAccess 'write') for every role and access shape (pattern #26)", async () => {
    const shapes: WarehouseAccess[] = [
      { readableIds: ['wh-1'], writableIds: ['wh-1'], hasAllAccess: false, primaryWarehouseId: 'wh-1' },
      { readableIds: ['wh-1'], writableIds: [], hasAllAccess: false, primaryWarehouseId: 'wh-1' },
      { readableIds: ['wh-2'], writableIds: ['wh-2'], hasAllAccess: false, primaryWarehouseId: 'wh-2' },
      { readableIds: [], writableIds: [], hasAllAccess: true, primaryWarehouseId: null },
      { readableIds: [], writableIds: [], hasAllAccess: false, primaryWarehouseId: null, unreadable: true },
      { readableIds: [], writableIds: [], hasAllAccess: true, primaryWarehouseId: null, unreadable: true },
    ];
    for (const role of ['owner', 'admin', 'manager', 'staff', 'viewer'] as const) {
      for (const access of shapes) {
        const service = await assertWarehouseAccess(
          'wh-1',
          'write',
          { organizationId: 'org-1', userId: 'u-1', role },
          Promise.resolve(access),
        ).then(
          () => true,
          () => false,
        );
        const byRole = roleSeesEveryWarehouse(role);
        const page =
          neededByChangeView({ ...base, role, roleSeesEveryWarehouse: byRole, access: byRole ? null : access }) !==
          null;
        // A manager's access is never read by the page: the role decides, as
        // getWarehouseAccess answers hasAllAccess for it whatever its lists.
        if (!byRole || access.hasAllAccess) {
          expect(page, `${role} ${JSON.stringify(access)}`).toBe(service);
        } else {
          expect(page, role).toBe(true);
        }
      }
    }
  });

  it('an order with no date: "No needed-by date"', () => {
    expect(neededByChangeView({ ...base, neededBy: null })).toMatchObject({
      neededBy: null,
      rowLabel: 'No needed-by date',
    });
  });
});

describe("readNeededByDraft: the field, read in the org's zone exactly as the server reads it", () => {
  it('previews the wall clock in the org zone, whatever the runtime zone', () => {
    expect(readNeededByDraft('2026-10-03T14:00', LA, NOW)).toEqual({
      kind: 'ok',
      instant: Date.parse('2026-10-03T21:00:00Z'),
      preview: 'New needed-by: Sat, Oct 3, 2:00 PM',
    });
    expect(readNeededByDraft('2026-10-03T14:00', 'America/New_York', NOW)).toMatchObject({
      instant: Date.parse('2026-10-03T18:00:00Z'),
      preview: 'New needed-by: Sat, Oct 3, 2:00 PM',
    });
  });

  it('across daylight saving (2026-11-01 in Los Angeles): the first 1:30 AM, and the hour that does not exist is refused', () => {
    // The fall-back hour happens twice; both sides take the first (PDT).
    expect(readNeededByDraft('2026-11-01T01:30', LA, NOW)).toMatchObject({
      kind: 'ok',
      instant: Date.parse('2026-11-01T08:30:00Z'),
    });
    // After the change, PST (UTC-8).
    expect(readNeededByDraft('2026-11-02T09:00', LA, NOW)).toMatchObject({
      instant: Date.parse('2026-11-02T17:00:00Z'),
    });
    // The spring-forward gap.
    expect(readNeededByDraft('2027-03-14T02:30', LA, NOW)).toEqual({
      kind: 'invalid',
      message: "That date and time don't exist in America/Los_Angeles. Pick another time.",
    });
  });

  it('the dialog and the server convert with the same function: the same instant for every wall clock (a copies guard)', () => {
    const clocks = [
      '2026-10-03T14:00',
      '2026-11-01T00:59',
      '2026-11-01T01:00',
      '2026-11-01T01:30',
      '2026-11-01T02:00',
      '2027-03-14T01:59',
      '2027-03-14T02:00',
      '2027-03-14T03:00',
      '2026-12-31T23:30',
      '2027-02-29T09:00',
    ];
    for (const zone of [LA, 'America/New_York', 'Europe/London', 'Australia/Lord_Howe']) {
      for (const clock of clocks) {
        const draft = readNeededByDraft(clock, zone, NOW);
        const server = wallClockToInstant(clock, zone);
        expect(draft.kind === 'ok' ? draft.instant : null, `${zone} ${clock}`).toBe(server);
      }
    }
    // And the server does convert with it, strictly, in the org's zone.
    const service = readFileSync(
      path.resolve(__dirname, '../../server/services/order-requests.ts'),
      'utf8',
    );
    expect(service).toContain('wallClockToInstant(input.neededByLocal as string, timeZone)');
  });

  it('a time already past, a value that is not a wall clock, and an empty field', () => {
    expect(readNeededByDraft('2026-09-29T09:59', LA, NOW)).toEqual({ kind: 'past', message: NEEDED_BY_IN_PAST_COPY });
    expect(readNeededByDraft('2026-09-29T10:00', LA, NOW)).toMatchObject({ kind: 'past' });
    expect(readNeededByDraft('2026-09-29T10:01', LA, NOW)).toMatchObject({ kind: 'ok' });
    expect(readNeededByDraft('2026-10-03', LA, NOW)).toMatchObject({ kind: 'invalid' });
    expect(readNeededByDraft('2026-10-03T14:00Z', LA, NOW)).toMatchObject({ kind: 'invalid' });
    expect(readNeededByDraft('', LA, NOW)).toEqual({ kind: 'empty' });
  });
});

describe('the field and the stale check', () => {
  it("starts at the current date as a wall clock in the org's zone, or empty when there is none or it has passed", () => {
    expect(initialNeededByWallClock('2026-10-01T21:00:00.123456+00:00', LA, NOW)).toBe('2026-10-01T14:00');
    expect(initialNeededByWallClock('2026-10-01T21:00:00Z', 'America/New_York', NOW)).toBe('2026-10-01T17:00');
    expect(initialNeededByWallClock('2026-09-20T21:00:00Z', LA, NOW)).toBe('');
    expect(initialNeededByWallClock(null, LA, NOW)).toBe('');
    expect(minNeededByWallClock(LA, NOW)).toBe('2026-09-29T10:00');
  });

  it("sends the date the person saw; the page's own text of it when it names the same instant (microseconds kept)", () => {
    const onPage = '2026-10-05T16:00:00.123456+00:00';
    expect(neededByExpectedToSend(onPage, onPage)).toBe(onPage);
    // After a stale refusal: the server's value, until the page is read again...
    expect(neededByExpectedToSend('2026-10-05T16:00:00.123Z', '2026-10-01T21:00:00+00:00')).toBe(
      '2026-10-05T16:00:00.123Z',
    );
    // ...then the page's exact text of that same instant.
    expect(neededByExpectedToSend('2026-10-05T16:00:00.123Z', onPage)).toBe(onPage);
    // Never the page's value when it is another date (someone else's).
    expect(neededByExpectedToSend('2026-10-01T21:00:00+00:00', onPage)).toBe('2026-10-01T21:00:00+00:00');
    expect(neededByExpectedToSend(null, onPage)).toBeNull();
    expect(neededByExpectedToSend(onPage, null)).toBe(onPage);
  });
});
