import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  NEEDED_BY_BUSY_COPY,
  NEEDED_BY_CLOSED_COPY,
  NEEDED_BY_FAILED_COPY,
  NEEDED_BY_IN_PAST_COPY,
  NEEDED_BY_NO_ANSWER_COPY,
  NEEDED_BY_NO_WAREHOUSE_ACCESS_COPY,
  NEEDED_BY_NOT_APPROVER_COPY,
  NEEDED_BY_OUT_OF_RANGE_COPY,
  NEEDED_BY_REASON_REQUIRED_COPY,
  NEEDED_BY_RELOAD_COPY,
  NEEDED_BY_SIGN_IN_COPY,
  NEEDED_BY_TIMEZONE_UNREADABLE_COPY,
  NeededByResultShapeError,
  ORDER_WAREHOUSE_WRITE_REFUSED_COPY,
  READINESS_NEEDS_CONNECTION_COPY,
  neededByChangedCopy,
  neededByCurrentCopy,
  neededByEffectCopy,
  neededByInvalidTimeCopy,
  neededByRowCopy,
  neededByPreviewCopy,
  neededByRevisedCopy,
  neededByZoneNote,
  formatWallClock,
  wallClockToInstant,
  type NeededByRevisionOutcome,
} from '@stockpilot/core';

import { REQUEST_TIMED_OUT_COPY } from './connection-copy';
import {
  NEEDED_BY_ANSWER_UNREADABLE_COPY,
  NEEDED_BY_CANNOT_OPEN_TITLE,
  NEEDED_BY_DAY_COUNT,
  NEEDED_BY_DONE_TITLE,
  NEEDED_BY_NO_SLOTS_LEFT_COPY,
  NEEDED_BY_OTHER_HINT,
  NEEDED_BY_PICK_DAY_FIRST_COPY,
  NEEDED_BY_PICK_TIME_COPY,
  NEEDED_BY_DAY_ROW_INSET,
  NEEDED_BY_TOO_MANY_COPY,
  canOfferNeededByChange,
  firstOpenDayKey,
  initialNeededByDraft,
  neededByCardValue,
  neededByDayRowScroll,
  neededByDays,
  neededByDraftView,
  neededBySheetOpening,
  neededBySpokenUpdate,
  neededBySlots,
  neededByZoneUnknownCopy,
  needsNeededByZoneRead,
  parseNeededByOtherEntry,
  parseNeededByTime,
  readOrderNeededBy,
  selectNeededByDay,
  showNeededByCard,
  slotLabel,
  submitNeededByRevision,
  type NeededByCurrentRead,
  type NeededByDraft,
  type NeededByRevisionDeps,
} from './order-needed-by';

// The shape of lib/api.ts ApiError (status, code, details), without importing
// that module (it reaches expo-constants, AsyncStorage and Supabase at import
// time). The lib reads these fields, never `instanceof`.
class FakeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const LA = 'America/Los_Angeles';
const ORDER = '11111111-1111-1111-1111-111111111111';

// The device's own zone, set to one no case uses: an answer that reads the
// device clock anywhere comes out different (mutation: device-zone chips).
const DEVICE_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Asia/Tokyo';
});
afterAll(() => {
  if (DEVICE_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = DEVICE_TZ;
});

function draft(patch: Partial<NeededByDraft> = {}): NeededByDraft {
  return { dayKey: null, slot: null, other: false, otherText: '', reason: '', ...patch };
}

function ctx(patch: Partial<Parameters<typeof neededByDraftView>[1]> = {}) {
  return {
    now: Date.parse('2026-10-01T17:00:00Z'), // Thu Oct 1, 10:00 AM in Los Angeles
    zone: LA,
    current: null,
    status: 'approved' as string | null,
    offline: false,
    busy: false,
    closed: false,
    ...patch,
  };
}

describe('who is offered Change', () => {
  const base = { status: 'approved', role: 'staff', canApproveOrders: true, ordersModuleEnabled: true };

  it('an approver on an open order where Orders is on', () => {
    expect(canOfferNeededByChange(base)).toBe(true);
  });

  it('a manager holds orders:approve by role (the effective set), so a manager is offered it', () => {
    expect(canOfferNeededByChange({ ...base, role: 'manager', canApproveOrders: true })).toBe(true);
  });

  it('a manager or owner whose orders:approve was revoked is NOT offered it: the web page hides it and the service refuses them', () => {
    // OrderRequestsService.reviseNeededByIn refuses unless can(ctx,
    // 'orders:approve') (the effective set, overrides applied), and the web
    // page offers Change on that same test; the database's 0348 gate would
    // let the manager through, but the service in front of it does not.
    expect(canOfferNeededByChange({ ...base, role: 'manager', canApproveOrders: false })).toBe(false);
    expect(canOfferNeededByChange({ ...base, role: 'owner', canApproveOrders: false })).toBe(false);
  });

  it('a viewer granted orders:approve is NOT offered it, as on the web (slice D review, findings 1 and 10)', () => {
    // The web's neededByChangeView returns null for role viewer, and the
    // app refuses every write for a viewer (assertWarehouseAccess); the
    // revise function needs warehouse write, which a viewer never has.
    expect(canOfferNeededByChange({ ...base, role: 'viewer', canApproveOrders: true })).toBe(false);
  });

  it('nobody else, a closed order, or Orders off', () => {
    expect(canOfferNeededByChange({ ...base, canApproveOrders: false })).toBe(false);
    expect(canOfferNeededByChange({ ...base, role: null, canApproveOrders: false })).toBe(false);
    expect(canOfferNeededByChange({ ...base, role: 'wizard', canApproveOrders: false })).toBe(false);
    expect(canOfferNeededByChange({ ...base, ordersModuleEnabled: false })).toBe(false);
    for (const status of ['pending_confirmation', 'completed', 'denied', 'cancelled', null]) {
      expect(canOfferNeededByChange({ ...base, status })).toBe(false);
    }
  });

  it('every open status, pending included', () => {
    for (const status of ['pending_approval', 'approved', 'picking_in_progress', 'in_transit', 'backordered']) {
      expect(canOfferNeededByChange({ ...base, status })).toBe(true);
    }
  });

  it('the card shows with a date, or for someone who may set one', () => {
    expect(showNeededByCard('2026-10-03T21:00:00+00:00', false)).toBe(true);
    expect(showNeededByCard(null, true)).toBe(true);
    expect(showNeededByCard(null, false)).toBe(false);
  });

  it("the card prints core's row in the org's zone (the web page's words)", () => {
    const now = Date.parse('2026-10-01T17:00:00Z');
    expect(neededByCardValue('2026-10-03T21:00:00+00:00', LA, now)).toBe(
      neededByRowCopy('2026-10-03T21:00:00+00:00', LA, now),
    );
    expect(neededByCardValue('2026-10-03T21:00:00+00:00', LA, now)).toBe('Needed by Sat, Oct 3, 2:00 PM');
    expect(neededByCardValue('2026-10-03T21:00:00+00:00', 'America/New_York', now)).toBe(
      'Needed by Sat, Oct 3, 5:00 PM',
    );
    expect(neededByCardValue(null, LA)).toBe(neededByRowCopy(null, LA));
  });
});

describe('the zone read at load', () => {
  it('only when the order has a needed-by and no other read brings the zone', () => {
    const at = '2026-10-03T21:00:00+00:00';
    expect(needsNeededByZoneRead({ neededBy: at, readinessReadsZone: false, deliveryReadsZone: false })).toBe(true);
    expect(needsNeededByZoneRead({ neededBy: at, readinessReadsZone: true, deliveryReadsZone: false })).toBe(false);
    expect(needsNeededByZoneRead({ neededBy: at, readinessReadsZone: false, deliveryReadsZone: true })).toBe(false);
    expect(needsNeededByZoneRead({ neededBy: null, readinessReadsZone: false, deliveryReadsZone: false })).toBe(false);
  });
});

describe('opening the sheet', () => {
  const manager = { writableIds: null, unreadable: false };
  const WH = 'wh-1';

  it('opens in the org zone for a manager', () => {
    expect(neededBySheetOpening({ rawZone: ` ${LA} `, scope: manager, warehouseId: WH, isViewer: false })).toEqual({
      ok: true,
      timeZone: LA,
    });
  });

  it("refuses when the zone could not be read (core's words), never a guessed zone", () => {
    for (const rawZone of [null, undefined, '', '   ']) {
      expect(neededBySheetOpening({ rawZone, scope: manager, warehouseId: WH, isViewer: false })).toEqual({
        ok: false,
        title: NEEDED_BY_CANNOT_OPEN_TITLE,
        message: NEEDED_BY_TIMEZONE_UNREADABLE_COPY,
      });
    }
  });

  it('refuses a zone this engine cannot show (the server would convert in another)', () => {
    expect(neededBySheetOpening({ rawZone: 'Mars/Olympus_Mons', scope: manager, warehouseId: WH, isViewer: false })).toEqual({
      ok: false,
      title: NEEDED_BY_CANNOT_OPEN_TITLE,
      message: neededByZoneUnknownCopy('Mars/Olympus_Mons'),
    });
  });

  it("staff open it only for a warehouse they are assigned to; a viewer never (the function's warehouse_write gate)", () => {
    expect(
      neededBySheetOpening({ rawZone: LA, scope: { writableIds: [WH], unreadable: false }, warehouseId: WH, isViewer: false }).ok,
    ).toBe(true);
    // Small fixes slice 2 review: staff outside the order's warehouse read the
    // sentence every order action says (the server's too), not the date's
    // own "needs write access"; a viewer, who works there read-only, keeps it.
    for (const scope of [
      { writableIds: ['wh-2'], unreadable: false },
      { writableIds: [], unreadable: false },
    ]) {
      expect(neededBySheetOpening({ rawZone: LA, scope, warehouseId: WH, isViewer: false })).toEqual({
        ok: false,
        title: NEEDED_BY_CANNOT_OPEN_TITLE,
        message: ORDER_WAREHOUSE_WRITE_REFUSED_COPY,
      });
    }
    expect(
      neededBySheetOpening({ rawZone: LA, scope: { writableIds: [], unreadable: false }, warehouseId: WH, isViewer: true }),
    ).toEqual({ ok: false, title: NEEDED_BY_CANNOT_OPEN_TITLE, message: NEEDED_BY_NO_WAREHOUSE_ACCESS_COPY });
  });

  it('an unreadable assignment list is not a refusal: the server decides, in the sheet', () => {
    expect(
      neededBySheetOpening({ rawZone: LA, scope: { writableIds: [], unreadable: true }, warehouseId: WH, isViewer: false }).ok,
    ).toBe(true);
  });
});

describe('day chips, in the org zone', () => {
  it('21 days from the org today, named from its calendar', () => {
    const days = neededByDays(Date.parse('2026-10-01T17:00:00Z'), LA);
    expect(days).toHaveLength(NEEDED_BY_DAY_COUNT);
    expect(days[0]).toMatchObject({ key: '2026-10-01', label: 'Today', dateLabel: 'Oct 1' });
    expect(days[0]!.accessibilityLabel).toBe('Today, Thursday, October 1');
    expect(days[1]).toMatchObject({ key: '2026-10-02', label: 'Tomorrow' });
    expect(days[2]).toMatchObject({ key: '2026-10-03', label: 'Sat', dateLabel: 'Oct 3' });
    expect(days[2]!.accessibilityLabel).toBe('Saturday, October 3');
    expect(days[20]!.key).toBe('2026-10-21');
  });

  it("late evening in Los Angeles is still the org's today, whatever the UTC date or the device", () => {
    // Oct 3 06:30 UTC is Oct 2, 11:30 PM in Los Angeles (and Oct 3 in Tokyo).
    const now = Date.parse('2026-10-03T06:30:00Z');
    expect(neededByDays(now, LA)[0]!.key).toBe('2026-10-02');
    expect(neededByDays(now, 'Asia/Kolkata')[0]!.key).toBe('2026-10-03');
    // No slot is left on the org's today, so the sheet starts on tomorrow.
    expect(neededBySlots('2026-10-02', now, LA)).toEqual([]);
    expect(firstOpenDayKey(now, LA)).toBe('2026-10-03');
  });

  it('crosses a month and a year end on the calendar', () => {
    const days = neededByDays(Date.parse('2026-12-20T18:00:00Z'), LA);
    expect(days.map((d) => d.key)).toContain('2026-12-31');
    expect(days.map((d) => d.key)).toContain('2027-01-01');
    expect(days[20]!.key).toBe('2027-01-09');
  });
});

describe('time slots, in the org zone', () => {
  it('27 slots, 6:00 AM to 7:00 PM, each the instant the server would store', () => {
    const slots = neededBySlots('2026-10-05', 0, LA);
    expect(slots).toHaveLength(27);
    expect(slots[0]).toMatchObject({ time: '06:00', wall: '2026-10-05T06:00', label: '6:00 AM' });
    expect(slots[12]).toMatchObject({ time: '12:00', label: '12:00 PM' });
    expect(slots[26]).toMatchObject({ time: '19:00', wall: '2026-10-05T19:00', label: '7:00 PM' });
    expect(slots[16]!.at).toBe(Date.parse('2026-10-05T21:00:00Z')); // 2:00 PM PDT
  });

  it('only the ones still to come on the org today', () => {
    const now = Date.parse('2026-10-01T17:00:00Z'); // 10:00 AM PDT
    const slots = neededBySlots('2026-10-01', now, LA);
    expect(slots[0]!.label).toBe('10:30 AM');
    expect(slots).toHaveLength(18);
  });

  // Mutation caught: a slot built from the device clock or a fixed offset.
  // Every slot equals the strict conversion of its own wall clock, every day
  // of a year, in zones that change (both hemispheres), a half-hour zone and
  // one that never changes.
  it.each([LA, 'America/New_York', 'Europe/London', 'Asia/Kolkata', 'America/Phoenix', 'Australia/Sydney'])(
    'every slot of every day of a year in %s is the strict conversion of its wall clock',
    (zone) => {
      let slots = 0;
      for (let day = 0; day < 366; day += 1) {
        const d = new Date(Date.UTC(2026, 0, 1) + day * 86_400_000);
        const key = d.toISOString().slice(0, 10);
        const daySlots = neededBySlots(key, 0, zone);
        expect(daySlots).toHaveLength(27);
        for (const s of daySlots) {
          expect(s.wall.slice(0, 10)).toBe(key);
          expect(s.at).toBe(wallClockToInstant(s.wall, zone));
          // Reads back as its own wall clock in the zone (never the device's).
          expect(formatWallClock(s.at, zone)).toBe(s.wall);
          slots += 1;
        }
      }
      expect(slots).toBe(366 * 27);
    },
    30_000,
  );

  it('slot labels', () => {
    expect(slotLabel(0, 0)).toBe('12:00 AM');
    expect(slotLabel(6, 30)).toBe('6:30 AM');
    expect(slotLabel(12, 0)).toBe('12:00 PM');
    expect(slotLabel(19, 0)).toBe('7:00 PM');
  });
});

describe('Other time', () => {
  it.each([
    ['2:30 PM', { hour: 14, minute: 30 }],
    ['2:30pm', { hour: 14, minute: 30 }],
    ['2pm', { hour: 14, minute: 0 }],
    ['2 p.m.', { hour: 14, minute: 0 }],
    ['2:30p', { hour: 14, minute: 30 }],
    ['12:00 AM', { hour: 0, minute: 0 }],
    ['12:15 am', { hour: 0, minute: 15 }],
    ['12:00 PM', { hour: 12, minute: 0 }],
    ['14:30', { hour: 14, minute: 30 }],
    ['7:05', { hour: 7, minute: 5 }],
    ['0:00', { hour: 0, minute: 0 }],
  ])('reads %s', (raw, expected) => {
    expect(parseNeededByTime(raw)).toEqual(expected);
  });

  it.each(['', '2', '13:00 PM', '0:30 AM', '24:00', '7:60', 'noon', '2:3 PM', '14.30'])('refuses %j', (raw) => {
    expect(parseNeededByTime(raw)).toBeNull();
  });

  const now = Date.parse('2026-10-01T17:00:00Z');

  it('a time lands on the selected day', () => {
    expect(parseNeededByOtherEntry(' 7:45 PM ', '2026-10-03', now, LA)).toEqual({
      kind: 'ok',
      wall: { year: 2026, month: 10, day: 3, hour: 19, minute: 45 },
      hasOwnDate: false,
    });
  });

  it('a time with no day picked asks for one', () => {
    expect(parseNeededByOtherEntry('7:45 PM', null, now, LA)).toEqual({
      kind: 'problem',
      message: NEEDED_BY_PICK_DAY_FIRST_COPY,
    });
  });

  it('a date and a time: month/day/year, month/day (the next such day), ISO', () => {
    expect(parseNeededByOtherEntry('11/20/2026 9:15 AM', '2026-10-03', now, LA)).toMatchObject({
      kind: 'ok',
      wall: { year: 2026, month: 11, day: 20, hour: 9, minute: 15 },
      hasOwnDate: true,
    });
    expect(parseNeededByOtherEntry('11/20/27 9:15 AM', null, now, LA)).toMatchObject({
      wall: { year: 2027, month: 11, day: 20 },
    });
    // No year: this year's while it is still to come, next year's once past.
    expect(parseNeededByOtherEntry('11/20 9:15 AM', null, now, LA)).toMatchObject({ wall: { year: 2026 } });
    expect(parseNeededByOtherEntry('10/1 11:00 PM', null, now, LA)).toMatchObject({ wall: { year: 2026 } });
    expect(parseNeededByOtherEntry('9/30 9:15 AM', null, now, LA)).toMatchObject({ wall: { year: 2027 } });
    expect(parseNeededByOtherEntry('2027-01-08 21:45', null, now, LA)).toMatchObject({
      wall: { year: 2027, month: 1, day: 8, hour: 21, minute: 45 },
    });
  });

  it('anything else says what to type', () => {
    for (const raw of ['tomorrow', '11/20', '2026-11-20', 'noon', '11/20 25:00']) {
      expect(parseNeededByOtherEntry(raw, '2026-10-03', now, LA)).toEqual({
        kind: 'problem',
        message: NEEDED_BY_OTHER_HINT,
      });
    }
    expect(parseNeededByOtherEntry('   ', '2026-10-03', now, LA)).toEqual({ kind: 'empty' });
  });
});

describe('the draft the sheet opens with', () => {
  const now = Date.parse('2026-10-01T17:00:00Z');

  it('a needed-by on the grid selects its day and slot', () => {
    expect(initialNeededByDraft('2026-10-03T21:00:00.000000+00:00', now, LA)).toEqual(
      draft({ dayKey: '2026-10-03', slot: '14:00' }),
    );
  });

  it('off the grid: its time in Other time on its day', () => {
    expect(initialNeededByDraft('2026-10-04T03:15:00+00:00', now, LA)).toEqual(
      draft({ dayKey: '2026-10-03', other: true, otherText: '8:15 PM' }),
    );
    // Seconds: not a slot (saving the slot would move it).
    expect(initialNeededByDraft('2026-10-03T21:00:30+00:00', now, LA)).toMatchObject({
      other: true,
      otherText: '2:00 PM',
    });
  });

  it('past the chips: its date and time in Other time', () => {
    expect(initialNeededByDraft('2026-12-24T17:00:00+00:00', now, LA)).toEqual(
      draft({ dayKey: '2026-10-01', other: true, otherText: '12/24/2026 9:00 AM' }),
    );
  });

  it('none, or one already past: the first day with a time left, and no time', () => {
    expect(initialNeededByDraft(null, now, LA)).toEqual(draft({ dayKey: '2026-10-01' }));
    expect(initialNeededByDraft('2026-08-10T19:00:00+00:00', now, LA)).toEqual(draft({ dayKey: '2026-10-01' }));
  });

  it('what it opens with previews the same instant it started from', () => {
    for (const current of ['2026-10-03T21:00:00+00:00', '2026-10-04T03:15:00+00:00', '2026-12-24T17:00:00+00:00']) {
      const view = neededByDraftView({ ...initialNeededByDraft(current, now, LA), reason: 'x' }, ctx({ now }));
      expect(view.at).toBe(Date.parse(current));
    }
  });
});

describe('tapping a day chip', () => {
  const now = Date.parse('2026-10-01T17:00:00Z');

  it('keeps the slot', () => {
    expect(selectNeededByDay(draft({ dayKey: '2026-10-03', slot: '14:00' }), '2026-10-05', now, LA)).toEqual(
      draft({ dayKey: '2026-10-05', slot: '14:00' }),
    );
  });

  it('moves an Other time that carried its own date to that day, keeping its time', () => {
    const typed = draft({ dayKey: '2026-10-03', other: true, otherText: '12/24 9:15 AM', reason: 'x' });
    const moved = selectNeededByDay(typed, '2026-10-06', now, LA);
    expect(moved).toEqual({ ...typed, dayKey: '2026-10-06', otherText: '9:15 AM' });
    const view = neededByDraftView(moved, ctx({ now }));
    expect(view.selectedDayKey).toBe('2026-10-06');
    expect(view.wall).toBe('2026-10-06T09:15');
  });

  it('leaves a time-only Other time as typed', () => {
    const typed = draft({ dayKey: '2026-10-03', other: true, otherText: '7:45 PM' });
    expect(selectNeededByDay(typed, '2026-10-06', now, LA)).toEqual({ ...typed, dayKey: '2026-10-06' });
  });
});

describe('what the sheet shows', () => {
  it('nothing picked: says to pick, Save off with that reason', () => {
    const view = neededByDraftView(draft({ dayKey: '2026-10-03', reason: 'Moved' }), ctx());
    expect(view.wall).toBeNull();
    expect(view.timeProblem).toBe(NEEDED_BY_PICK_TIME_COPY);
    expect(view.canSave).toBe(false);
    expect(view.saveBlockedBy).toBe(NEEDED_BY_PICK_TIME_COPY);
    expect(view.zoneNote).toBe(neededByZoneNote(LA));
    expect(view.current).toBe(neededByCurrentCopy(null, LA));
  });

  it("what saving does, in core's words: past approval the entry follows; pending, approval adds it", () => {
    const d = draft({ dayKey: '2026-10-03', slot: '14:00', reason: 'x' });
    expect(neededByDraftView(d, ctx({ status: 'approved' })).effect).toBe(neededByEffectCopy('approved'));
    expect(neededByDraftView(d, ctx({ status: 'pending_approval' })).effect).toBe(
      neededByEffectCopy('pending_approval'),
    );
    expect(neededByEffectCopy('approved')).not.toBe(neededByEffectCopy('pending_approval'));
  });

  it("a slot and a reason: core's preview, and the wall clock Save sends", () => {
    const c = ctx({ current: '2026-10-02T16:00:00+00:00' });
    const view = neededByDraftView(draft({ dayKey: '2026-10-03', slot: '14:00', reason: '  School moved it  ' }), c);
    expect(view.wall).toBe('2026-10-03T14:00');
    expect(view.at).toBe(Date.parse('2026-10-03T21:00:00Z'));
    expect(view.preview).toBe(neededByPreviewCopy(view.at as number, LA, c.now));
    expect(view.preview).toBe('New needed-by: Sat, Oct 3, 2:00 PM');
    expect(view.reason).toBe('School moved it');
    expect(view.current).toBe('Current needed-by: Fri, Oct 2, 9:00 AM');
    expect(view.canSave).toBe(true);
    expect(view.saveBlockedBy).toBeNull();
    expect(view.selectedDayKey).toBe('2026-10-03');
  });

  it('offline: Save off, saying it needs a connection', () => {
    const view = neededByDraftView(draft({ dayKey: '2026-10-03', slot: '14:00', reason: 'x' }), ctx({ offline: true }));
    expect(view.canSave).toBe(false);
    expect(view.saveBlockedBy).toBe(READINESS_NEEDS_CONNECTION_COPY);
    expect(view.preview).not.toBeNull();
  });

  it("no reason: Save off with core's sentence; only spaces typed says it under the field", () => {
    const empty = neededByDraftView(draft({ dayKey: '2026-10-03', slot: '14:00' }), ctx());
    expect(empty.canSave).toBe(false);
    expect(empty.saveBlockedBy).toBe(NEEDED_BY_REASON_REQUIRED_COPY);
    expect(empty.reasonProblem).toBeNull();
    const spaces = neededByDraftView(draft({ dayKey: '2026-10-03', slot: '14:00', reason: '   ' }), ctx());
    expect(spaces.reasonProblem).toBe(NEEDED_BY_REASON_REQUIRED_COPY);
  });

  it('a time already past, and one that does not exist, in core words', () => {
    const past = neededByDraftView(draft({ dayKey: '2026-10-01', slot: '09:00', reason: 'x' }), ctx());
    expect(past.timeProblem).toBe(NEEDED_BY_IN_PAST_COPY);
    expect(past.canSave).toBe(false);
    const gap = neededByDraftView(
      draft({ dayKey: '2027-03-14', other: true, otherText: '2:30 AM', reason: 'x' }),
      ctx(),
    );
    expect(gap.timeProblem).toBe(neededByInvalidTimeCopy(LA));
    expect(gap.wall).toBeNull();
  });

  it('Other time with its own date selects that day chip (or none past the chips)', () => {
    const inChips = neededByDraftView(draft({ dayKey: '2026-10-03', other: true, otherText: '10/9 9:00 AM', reason: 'x' }), ctx());
    expect(inChips.selectedDayKey).toBe('2026-10-09');
    expect(inChips.wall).toBe('2026-10-09T09:00');
    const beyond = neededByDraftView(draft({ dayKey: '2026-10-03', other: true, otherText: '12/24 9:00 AM', reason: 'x' }), ctx());
    expect(beyond.selectedDayKey).toBe('2026-12-24');
    expect(beyond.days.some((d) => d.key === beyond.selectedDayKey)).toBe(false);
  });

  it('a date later than five years from now is said before saving, and Save stays off (the function refuses it)', () => {
    const far = neededByDraftView(
      draft({ dayKey: '2026-10-03', other: true, otherText: '11/20/2032 9:00 AM', reason: 'x' }),
      ctx(),
    );
    expect(far.timeProblem).toBe(NEEDED_BY_OUT_OF_RANGE_COPY);
    expect(far.wall).toBeNull();
    expect(far.canSave).toBe(false);
    expect(far.saveBlockedBy).toBe(NEEDED_BY_OUT_OF_RANGE_COPY);
    const near = neededByDraftView(
      draft({ dayKey: '2026-10-03', other: true, otherText: '9/30/2031 9:00 AM', reason: 'x' }),
      ctx(),
    );
    expect(near.wall).toBe('2031-09-30T09:00');
  });

  it('what VoiceOver hears when the time changes: the preview, or why there is none', () => {
    const picked = neededByDraftView(draft({ dayKey: '2026-10-03', slot: '14:00', reason: 'x' }), ctx());
    expect(neededBySpokenUpdate(picked)).toBe(picked.preview);
    expect(picked.preview).toBe('New needed-by: Sat, Oct 3, 2:00 PM');
    const gap = neededByDraftView(draft({ dayKey: '2027-03-14', other: true, otherText: '2:30 AM', reason: 'x' }), ctx());
    expect(neededBySpokenUpdate(gap)).toBe(neededByInvalidTimeCopy(LA));
    const nothing = neededByDraftView(draft({ dayKey: '2026-10-03' }), ctx());
    expect(neededBySpokenUpdate(nothing)).toBe(NEEDED_BY_PICK_TIME_COPY);
  });

  it('Other time with nothing typed says what to type', () => {
    const view = neededByDraftView(draft({ dayKey: '2026-10-03', other: true, reason: 'x' }), ctx());
    expect(view.timeProblem).toBe(NEEDED_BY_OTHER_HINT);
    expect(view.canSave).toBe(false);
  });

  it('a day with no times left says so (not while Other time is on)', () => {
    const late = ctx({ now: Date.parse('2026-10-02T03:00:00Z') }); // Oct 1, 8:00 PM PDT
    expect(neededByDraftView(draft({ dayKey: '2026-10-01' }), late).noSlotsNote).toBe(NEEDED_BY_NO_SLOTS_LEFT_COPY);
    expect(neededByDraftView(draft({ dayKey: '2026-10-01', other: true }), late).noSlotsNote).toBeNull();
  });

  it('closed, or a save running: Save off', () => {
    const d = draft({ dayKey: '2026-10-03', slot: '14:00', reason: 'x' });
    expect(neededByDraftView(d, ctx({ closed: true }))).toMatchObject({ canSave: false, saveBlockedBy: NEEDED_BY_CLOSED_COPY });
    expect(neededByDraftView(d, ctx({ busy: true })).canSave).toBe(false);
  });
});

// ── Saving ──────────────────────────────────────────────────────────────────

const OUTCOME: NeededByRevisionOutcome = {
  changed: true,
  previous: '2026-10-02T16:00:00.000Z',
  neededBy: '2026-10-03T21:00:00.000Z',
  eventId: 'ev-1',
  eventUpdated: true,
  eventStatus: 'scheduled',
  status: 'approved',
  schedule: 'moved',
  timeZone: LA,
};

// Stored with microseconds: a JS Date would drop them.
const STORED = '2026-10-02T16:00:00.123456+00:00';

function deps(overrides: Partial<NeededByRevisionDeps> = {}) {
  const revise = vi.fn<NeededByRevisionDeps['revise']>(async () => OUTCOME);
  const readCurrent = vi.fn<NeededByRevisionDeps['readCurrent']>(
    async (): Promise<NeededByCurrentRead> => ({ ok: true, neededBy: STORED, status: 'approved' }),
  );
  return { revise, readCurrent, ...overrides } as NeededByRevisionDeps & {
    revise: typeof revise;
    readCurrent: typeof readCurrent;
  };
}

const INPUT = {
  orderId: ORDER,
  wall: '2026-10-03T14:00',
  expected: STORED,
  reason: 'School moved it',
  zone: LA,
};

describe('saving', () => {
  it("sends the wall clock, the value it started from EXACTLY as read, and the reason; says core's confirmation", async () => {
    const d = deps();
    const res = await submitNeededByRevision(d, INPUT);
    expect(d.revise).toHaveBeenCalledWith(ORDER, {
      neededByLocal: '2026-10-03T14:00',
      expectedNeededBy: STORED,
      reason: 'School moved it',
    });
    expect(res).toEqual({
      kind: 'saved',
      outcome: OUTCOME,
      title: NEEDED_BY_DONE_TITLE,
      message: neededByRevisedCopy(OUTCOME),
    });
    expect(d.readCurrent).not.toHaveBeenCalled();
  });

  it('someone saved another date first: the value read back exactly, shown, and started from', async () => {
    const newer = '2026-10-04T18:30:00.654321+00:00';
    const d = deps({
      revise: vi.fn(async () => {
        throw new FakeApiError('Someone changed…', 409, 'conflict', {
          reason: 'needed_by_changed',
          current: '2026-10-04T18:30:00.654Z',
        });
      }),
      readCurrent: vi.fn(async () => ({ ok: true as const, neededBy: newer, status: 'approved' })),
    });
    const res = await submitNeededByRevision(d, INPUT);
    expect(res).toEqual({
      kind: 'refused',
      reason: 'needed_by_changed',
      message: neededByChangedCopy(newer, LA),
      current: { neededBy: newer },
      closed: false,
    });
    expect((res as { message: string }).message).toMatch(/^Someone changed this date to Sun, Oct 4, 11:30 AM/);
  });

  it("the read back failed: the refusal's own value, still shown and started from", async () => {
    const d = deps({
      revise: vi.fn(async () => {
        throw new FakeApiError('x', 409, 'conflict', { reason: 'needed_by_changed', current: null });
      }),
      readCurrent: vi.fn(async () => ({ ok: false as const })),
    });
    expect(await submitNeededByRevision(d, INPUT)).toEqual({
      kind: 'refused',
      reason: 'needed_by_changed',
      message: neededByChangedCopy(null, LA),
      current: { neededBy: null },
      closed: false,
    });
  });

  it('the read back shows the order closed meanwhile: says so, Save off', async () => {
    const d = deps({
      revise: vi.fn(async () => {
        throw new FakeApiError('x', 409, 'conflict', { reason: 'needed_by_changed', current: STORED });
      }),
      readCurrent: vi.fn(async () => ({ ok: true as const, neededBy: STORED, status: 'cancelled' })),
    });
    expect(await submitNeededByRevision(d, INPUT)).toMatchObject({
      reason: 'order_closed',
      message: NEEDED_BY_CLOSED_COPY,
      closed: true,
    });
  });

  it("no answer and nothing moved: core's may-or-may-not sentence (the web dialog's), nothing adopted", async () => {
    const d = deps({ revise: vi.fn(async () => Promise.reject(new TypeError('Network request failed'))) });
    expect(await submitNeededByRevision(d, INPUT)).toEqual({
      kind: 'refused',
      reason: 'no_answer',
      message: NEEDED_BY_NO_ANSWER_COPY,
      closed: false,
    });
    expect(d.readCurrent).toHaveBeenCalledTimes(1);
    // A timeout may still land later: the same words, never "not saved".
    const timedOut = deps({ revise: vi.fn(async () => Promise.reject(new Error(REQUEST_TIMED_OUT_COPY))) });
    expect(await submitNeededByRevision(timedOut, INPUT)).toMatchObject({ message: NEEDED_BY_NO_ANSWER_COPY });
  });

  it('no answer and the date moved (perhaps this save): shows it and starts from it, never a silent retry', async () => {
    const d = deps({
      revise: vi.fn(async () => Promise.reject(new TypeError('Network request failed'))),
      readCurrent: vi.fn(async () => ({ ok: true as const, neededBy: '2026-10-03T21:00:00+00:00', status: 'approved' })),
    });
    expect(await submitNeededByRevision(d, INPUT)).toEqual({
      kind: 'refused',
      reason: 'no_answer',
      message: NEEDED_BY_NO_ANSWER_COPY,
      current: { neededBy: '2026-10-03T21:00:00+00:00' },
      closed: false,
    });
  });

  it('an answer it cannot read: may have changed, read back and shown', async () => {
    const d = deps({ revise: vi.fn(async () => Promise.reject(new NeededByResultShapeError('bad'))) });
    expect(await submitNeededByRevision(d, INPUT)).toEqual({
      kind: 'refused',
      reason: 'unreadable',
      message: NEEDED_BY_ANSWER_UNREADABLE_COPY,
      current: { neededBy: STORED },
      closed: false,
    });
  });

  it.each([
    [409, { reason: 'order_closed', status: 'completed' }, 'x', 'order_closed', NEEDED_BY_CLOSED_COPY, true],
    [409, { reason: 'busy', retryable: true }, NEEDED_BY_BUSY_COPY, 'busy', NEEDED_BY_BUSY_COPY, false],
    [400, { reason: 'needed_by_in_past' }, NEEDED_BY_IN_PAST_COPY, 'needed_by_in_past', NEEDED_BY_IN_PAST_COPY, false],
    [400, { reason: 'needed_by_out_of_range' }, NEEDED_BY_OUT_OF_RANGE_COPY, 'needed_by_out_of_range', NEEDED_BY_OUT_OF_RANGE_COPY, false],
    [400, { reason: 'needed_by_out_of_range' }, 'validation_error', 'needed_by_out_of_range', NEEDED_BY_OUT_OF_RANGE_COPY, false],
    [400, { reason: 'reason_required' }, 'reason_required', 'reason_required', NEEDED_BY_REASON_REQUIRED_COPY, false],
    [400, { reason: 'invalid_time' }, 'validation_error', 'invalid_time', neededByInvalidTimeCopy(LA), false],
    [403, { reason: 'forbidden' }, NEEDED_BY_NO_WAREHOUSE_ACCESS_COPY, 'forbidden', NEEDED_BY_NO_WAREHOUSE_ACCESS_COPY, true],
    [403, { reason: 'forbidden' }, 'forbidden', 'forbidden', NEEDED_BY_NOT_APPROVER_COPY, true],
    [404, { reason: 'not_found' }, 'not_found', 'not_found', 'Order not found.', true],
    [409, { reason: 'timezone_unreadable', retryable: true }, NEEDED_BY_TIMEZONE_UNREADABLE_COPY, 'timezone_unreadable', NEEDED_BY_TIMEZONE_UNREADABLE_COPY, false],
    [400, { reason: 'failed' }, NEEDED_BY_RELOAD_COPY, 'failed', NEEDED_BY_RELOAD_COPY, false],
    [500, { reason: 'failed' }, 'internal detail', 'failed', NEEDED_BY_FAILED_COPY, false],
  ] as const)(
    '%i %j: core words, closing only what the sheet cannot fix',
    async (status, details, message, reason, said, closed) => {
      const d = deps({
        revise: vi.fn(async () => Promise.reject(new FakeApiError(message, status, 'x', details))),
      });
      expect(await submitNeededByRevision(d, INPUT)).toEqual({ kind: 'refused', reason, message: said, closed });
      expect(d.readCurrent).not.toHaveBeenCalled();
    },
  );

  it('rate limited, signed out, a 400 or 500 with no named reason, and an older server with no route', async () => {
    const run = (e: unknown) => submitNeededByRevision(deps({ revise: vi.fn(async () => Promise.reject(e)) }), INPUT);
    expect(await run(new FakeApiError('Too many requests — slow down.', 429, 'rate_limited'))).toMatchObject({
      reason: 'rate_limited',
      message: NEEDED_BY_TOO_MANY_COPY,
    });
    expect(await run(new FakeApiError('unauthenticated', 401, 'unauthenticated'))).toMatchObject({
      reason: 'unauthenticated',
      message: NEEDED_BY_SIGN_IN_COPY,
      closed: true,
    });
    expect(await run(new FakeApiError('Invalid order id', 400, 'validation_error'))).toMatchObject({
      reason: 'failed',
      message: NEEDED_BY_FAILED_COPY,
    });
    expect(await run(new FakeApiError('The server had a problem. Try again in a moment.', 502))).toMatchObject({
      message: NEEDED_BY_FAILED_COPY,
    });
    const older = 'That is not available on this version of the app. Update the app and try again.';
    expect(await run(new FakeApiError(older, 404))).toMatchObject({ reason: 'failed', message: older });
  });

  it('never throws, even when the read back throws', async () => {
    const d = deps({
      revise: vi.fn(async () => Promise.reject(new TypeError('offline'))),
      readCurrent: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await expect(submitNeededByRevision(d, INPUT)).resolves.toEqual({
      kind: 'refused',
      reason: 'no_answer',
      message: NEEDED_BY_NO_ANSWER_COPY,
      closed: false,
    });
  });
});

describe('reading the needed-by as stored', () => {
  function client(answer: unknown, calls: unknown[][] = []) {
    const chain = {
      select: (...a: unknown[]) => (calls.push(['select', ...a]), chain),
      eq: (...a: unknown[]) => (calls.push(['eq', ...a]), chain),
      maybeSingle: async () => {
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
    return { from: (t: string) => (calls.push(['from', t]), chain) };
  }

  it('the value EXACTLY as PostgREST returned it, filtered to the org and the order', async () => {
    const calls: unknown[][] = [];
    const res = await readOrderNeededBy(
      client({ data: { needed_by: STORED, status: 'approved' }, error: null }, calls),
      'org-1',
      ORDER,
    );
    expect(res).toEqual({ ok: true, neededBy: STORED, status: 'approved' });
    expect(calls).toEqual([
      ['from', 'order_requests'],
      ['select', 'needed_by, status'],
      ['eq', 'organization_id', 'org-1'],
      ['eq', 'id', ORDER],
    ]);
  });

  it('none is null; a failed, empty, odd or thrown read is not ok', async () => {
    expect(await readOrderNeededBy(client({ data: { needed_by: null, status: 'approved' }, error: null }), 'o', ORDER)).toEqual({
      ok: true,
      neededBy: null,
      status: 'approved',
    });
    for (const answer of [
      { data: null, error: { message: 'x' } },
      { data: null, error: null },
      { data: { needed_by: 5, status: 'approved' }, error: null },
      { data: { needed_by: STORED }, error: null },
      new Error('network'),
    ]) {
      expect(await readOrderNeededBy(client(answer), 'o', ORDER)).toEqual({ ok: false });
    }
  });
});

// iPhone 17 walk, 2026-09-30: the day row holds 21 chips and a phone shows
// about five, so an order needed a week out opened with its day chip off the
// right edge while its time chip showed selected below it.
describe('neededByDayRowScroll: the selected day is brought into the row', () => {
  const row = { offset: 0, viewport: 366 };

  it('a chip already whole in the row: no scroll', () => {
    expect(neededByDayRowScroll({ chipX: 0, chipWidth: 68, ...row })).toBeNull();
    expect(neededByDayRowScroll({ chipX: 298, chipWidth: 68, ...row })).toBeNull();
    expect(neededByDayRowScroll({ chipX: 400, chipWidth: 61, offset: 100, viewport: 366 })).toBeNull();
  });

  it('a chip past the right edge (even partly): scrolled to the left edge, less the inset', () => {
    expect(neededByDayRowScroll({ chipX: 470.5, chipWidth: 61.5, ...row })).toBe(Math.round(470.5 - NEEDED_BY_DAY_ROW_INSET));
    expect(neededByDayRowScroll({ chipX: 331, chipWidth: 61.3, ...row })).toBe(331 - NEEDED_BY_DAY_ROW_INSET);
  });

  it('a chip left of the scrolled window: scrolled back to it, never before the start', () => {
    expect(neededByDayRowScroll({ chipX: 94, chipWidth: 90, offset: 400, viewport: 366 })).toBe(94 - NEEDED_BY_DAY_ROW_INSET);
    expect(neededByDayRowScroll({ chipX: 4, chipWidth: 68, offset: 300, viewport: 366 })).toBe(0);
  });

  it('nothing measured yet (a zero or missing size): no scroll, never NaN', () => {
    expect(neededByDayRowScroll({ chipX: 470, chipWidth: 61, offset: 0, viewport: 0 })).toBeNull();
    expect(neededByDayRowScroll({ chipX: 470, chipWidth: 0, offset: 0, viewport: 366 })).toBeNull();
    expect(neededByDayRowScroll({ chipX: Number.NaN, chipWidth: 61, offset: 0, viewport: 366 })).toBeNull();
  });
});
