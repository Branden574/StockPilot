import { describe, expect, it } from 'vitest';

import {
  isNeededByRevisable,
  isNeededByWithinReach,
  NEEDED_BY_BUSY_COPY,
  NEEDED_BY_CHANGE_ACCESSIBILITY_LABEL,
  NEEDED_BY_CHANGE_LABEL,
  NEEDED_BY_CLOSED_COPY,
  NEEDED_BY_FAILED_COPY,
  NEEDED_BY_FIELD_LABEL,
  NEEDED_BY_MODULE_OFF_COPY,
  NEEDED_BY_NO_ANSWER_COPY,
  NEEDED_BY_NO_WAREHOUSE_ACCESS_COPY,
  NEEDED_BY_NOT_APPROVER_COPY,
  NEEDED_BY_NOT_FOUND_COPY,
  NEEDED_BY_NOT_PENDING_COPY,
  NEEDED_BY_REASON_HINT,
  NEEDED_BY_REASON_LABEL,
  NEEDED_BY_REASON_MAX,
  NEEDED_BY_REASON_REQUIRED_COPY,
  NEEDED_BY_REVISE_TITLE,
  NEEDED_BY_REVISABLE_STATUSES,
  NEEDED_BY_RELOAD_COPY,
  NEEDED_BY_REVISED_TIMELINE_LABEL,
  NEEDED_BY_SAVE_LABEL,
  NEEDED_BY_SIGN_IN_COPY,
  NEEDED_BY_TIMEZONE_UNREADABLE_COPY,
  neededByChangedCopy,
  neededByCurrentCopy,
  neededByEffectCopy,
  neededByInvalidTimeCopy,
  neededByPreviewCopy,
  neededByRevisedCopy,
  neededByRowCopy,
  NeededByResultShapeError,
  normalizeNeededByReason,
  orderBelongsOnSchedule,
  ORDER_SCHEDULE_SENTENCE_PATTERN,
  ORDER_SCHEDULE_SENTENCE_TAKEN_PATTERN,
  orderScheduleEventDetails,
  parseNeededByRevisionResult,
  withOrderScheduleSentence,
  type NeededByRevisionOutcome,
  type NeededBySchedule,
} from './needed-by-revision';
import {
  NEEDED_BY_IN_PAST_COPY,
  NEEDED_BY_MAX_YEARS_AHEAD,
  NEEDED_BY_OUT_OF_RANGE_COPY,
  neededByLabel,
  neededByZoneNote,
} from './needed-by-words';
import { ALLOWED_TRANSITIONS, type OrderStatus } from '../order-state-machine';

const LA = 'America/Los_Angeles';
const NOW = Date.parse('2026-09-29T17:00:00Z');

describe('statuses', () => {
  it('every open status may be revised; closed ones (and the unconfirmed public request) may not', () => {
    const all = Object.keys(ALLOWED_TRANSITIONS) as OrderStatus[];
    const closed = all.filter((s) => !isNeededByRevisable(s)).sort();
    expect(closed).toEqual(['cancelled', 'completed', 'denied', 'pending_confirmation']);
    expect(NEEDED_BY_REVISABLE_STATUSES).toHaveLength(all.length - 4);
    expect(isNeededByRevisable(null)).toBe(false);
  });

  it('a pending order has no Schedule entry yet; every later open status belongs on the Schedule', () => {
    expect(orderBelongsOnSchedule('pending_approval')).toBe(false);
    expect(NEEDED_BY_REVISABLE_STATUSES.filter(orderBelongsOnSchedule)).toEqual(
      NEEDED_BY_REVISABLE_STATUSES.filter((s) => s !== 'pending_approval'),
    );
    expect(orderBelongsOnSchedule('completed')).toBe(false);
  });
});

describe('orderScheduleEventDetails (the one Schedule description)', () => {
  it('names the order and the needed-by in the org zone, never UTC', () => {
    expect(
      orderScheduleEventDetails({ id: 'abc', orderNumber: 16, neededBy: '2026-10-03T21:00:00Z' }, LA),
    ).toBe('Auto-created from order SO-000016. Needed by Oct 3, 2026, 2:00 PM.');
    expect(
      orderScheduleEventDetails(
        { id: 'abc', orderNumber: 16, neededBy: '2026-10-03T21:00:00Z' },
        'America/New_York',
      ),
    ).toBe('Auto-created from order SO-000016. Needed by Oct 3, 2026, 5:00 PM.');
  });

  it('falls back to the id when the order has no number yet, and to the default zone for a bad one', () => {
    expect(
      orderScheduleEventDetails(
        { id: 'deadbeef-0000', orderNumber: null, neededBy: '2026-10-03T21:00:00Z' },
        'Not/AZone',
      ),
    ).toBe('Auto-created from order DEADBEEF. Needed by Oct 3, 2026, 2:00 PM.');
  });

  it('is always the sentence the function takes (0383 ignores any other description)', () => {
    const taken = new RegExp(ORDER_SCHEDULE_SENTENCE_TAKEN_PATTERN);
    const sentences = [
      orderScheduleEventDetails({ id: 'x', orderNumber: 999_999_999, neededBy: NOW }, LA),
      orderScheduleEventDetails({ id: 'x', orderNumber: 1, neededBy: NOW }, LA),
      orderScheduleEventDetails({ id: 'deadbeef-0000', orderNumber: null, neededBy: NOW }, LA),
      orderScheduleEventDetails({ id: 'deadbeef-0000', orderNumber: 0, neededBy: NOW }, 'Not/AZone'),
      ...['Pacific/Auckland', 'Asia/Kolkata', 'America/St_Johns', 'UTC'].map((z) =>
        orderScheduleEventDetails({ id: 'x', orderNumber: 16, neededBy: '2027-12-31T23:59:00Z' }, z),
      ),
    ];
    for (const sentence of sentences) expect(sentence).toMatch(taken);
    // And the sentence it replaces in an event's description finds it too.
    for (const sentence of sentences) expect(sentence).toMatch(new RegExp(ORDER_SCHEDULE_SENTENCE_PATTERN));
  });
});

describe("withOrderScheduleSentence (0383's description rule, for the service's own move)", () => {
  const NEW = 'Auto-created from order SO-000016. Needed by Oct 9, 2026, 2:00 PM.';
  it('replaces only the sentence, where it sits, and keeps what a person wrote around it', () => {
    expect(
      withOrderScheduleSentence(
        'Auto-created from order SO-000016. Needed by Oct 3, 2026, 2:00 PM.\nGate code 4411; call Maria.',
        NEW,
      ),
    ).toBe(`${NEW}\nGate code 4411; call Maria.`);
    expect(
      withOrderScheduleSentence(
        'Deliver to the gym. Auto-created from order SO-000016. Needed by 9/11/2026, 2:00:00 AM. Bring the cart.',
        NEW,
      ),
    ).toBe(`Deliver to the gym. ${NEW} Bring the cart.`);
  });

  it('keeps a description rewritten by hand whole, and gives an empty one the sentence', () => {
    expect(withOrderScheduleSentence('Call Maria first; the side door is locked.', NEW)).toBe(
      'Call Maria first; the side door is locked.',
    );
    expect(withOrderScheduleSentence(null, NEW)).toBe(NEW);
    expect(withOrderScheduleSentence('   ', NEW)).toBe(NEW);
  });

  it('is the same rule, character for character, as the migration (pattern #26)', () => {
    // Read by the guard test in apps/web (order-schedule-details.guard.test.ts),
    // which checks both patterns appear verbatim in 0383.
    expect(ORDER_SCHEDULE_SENTENCE_PATTERN).toBe('Auto-created from order [^.\\n]*\\. Needed by [^.\\n]*\\.');
    expect(ORDER_SCHEDULE_SENTENCE_TAKEN_PATTERN).toBe(
      '^Auto-created from order (SO-[0-9]{6,}|[0-9A-F]{8})\\. Needed by [^.]{1,64}\\.$',
    );
  });
});

describe('isNeededByWithinReach (the function refuses later than five years: needed_by_out_of_range)', () => {
  it('takes a date up to five years ahead, and refuses one past it or one no screen can hold', () => {
    expect(NEEDED_BY_MAX_YEARS_AHEAD).toBe(5);
    expect(isNeededByWithinReach(Date.parse('2031-09-29T16:59:00Z'), NOW)).toBe(true);
    expect(isNeededByWithinReach(Date.parse('2031-09-29T17:00:00Z'), NOW)).toBe(true);
    expect(isNeededByWithinReach(Date.parse('2031-09-29T17:01:00Z'), NOW)).toBe(false);
    expect(isNeededByWithinReach(Date.parse('9999-12-31T00:00:00Z'), NOW)).toBe(false);
    expect(isNeededByWithinReach(Number.NaN, NOW)).toBe(false);
    expect(NEEDED_BY_OUT_OF_RANGE_COPY).toBe('Pick a needed-by date within the next 5 years.');
  });
});

describe('parseNeededByRevisionResult', () => {
  const answer = {
    changed: true,
    previous: '2026-10-01T21:00:00+00:00',
    neededBy: '2026-10-03T21:00:00+00:00',
    eventId: 'e1',
    eventUpdated: true,
    eventStatus: 'scheduled',
    status: 'approved',
  };

  it('reads the answer and normalises the times', () => {
    expect(parseNeededByRevisionResult(answer)).toEqual({
      changed: true,
      previous: '2026-10-01T21:00:00.000Z',
      neededBy: '2026-10-03T21:00:00.000Z',
      eventId: 'e1',
      eventUpdated: true,
      eventStatus: 'scheduled',
      status: 'approved',
    });
  });

  it("takes the event's status as null when the order has no event, or when an answer leaves it out", () => {
    expect(parseNeededByRevisionResult({ ...answer, eventId: null, eventStatus: null }).eventStatus).toBeNull();
    expect(parseNeededByRevisionResult({ ...answer, eventStatus: undefined }).eventStatus).toBeNull();
  });

  it('takes a null previous and a null event, and ignores keys it does not know', () => {
    expect(
      parseNeededByRevisionResult({ ...answer, previous: null, eventId: null, eventUpdated: false, later: 1 }),
    ).toMatchObject({ previous: null, eventId: null, eventUpdated: false });
  });

  it.each([
    ['not an object', null],
    ['a list', []],
    ['changed missing', { ...answer, changed: undefined }],
    ['changed as a string', { ...answer, changed: 'true' }],
    ['neededBy missing', { ...answer, neededBy: null }],
    ['neededBy unreadable', { ...answer, neededBy: 'soon' }],
    ['previous unreadable', { ...answer, previous: 'yesterday' }],
    ['eventId empty', { ...answer, eventId: '' }],
    ['eventUpdated missing', { ...answer, eventUpdated: undefined }],
    ['status missing', { ...answer, status: undefined }],
    ['eventStatus a number', { ...answer, eventStatus: 3 }],
  ])('refuses %s, never guessing', (_label, raw) => {
    expect(() => parseNeededByRevisionResult(raw)).toThrow(NeededByResultShapeError);
  });
});

describe('words', () => {
  const outcome = (
    schedule: NeededBySchedule,
    extra: Partial<NeededByRevisionOutcome> = {},
  ): NeededByRevisionOutcome => ({
    changed: schedule !== 'unchanged',
    previous: '2026-10-01T21:00:00.000Z',
    neededBy: '2026-10-03T21:00:00.000Z',
    eventId: null,
    eventUpdated: schedule === 'moved',
    eventStatus: schedule === 'moved' ? 'scheduled' : null,
    status: 'approved',
    schedule,
    timeZone: LA,
    ...extra,
  });

  it('prints a needed-by in the org zone, with the year only when it is not this year', () => {
    expect(neededByLabel('2026-10-03T21:00:00Z', LA, NOW)).toBe('Sat, Oct 3, 2:00 PM');
    expect(neededByLabel('2027-01-08T17:00:00Z', LA, NOW)).toBe('Fri, Jan 8, 2027, 9:00 AM');
    // New Year's Eve evening in LA is already next year in UTC: the year is LA's.
    expect(neededByLabel('2027-01-01T05:00:00Z', LA, Date.parse('2026-12-31T20:00:00Z'))).toBe(
      'Thu, Dec 31, 9:00 PM',
    );
    expect(neededByLabel('soon', LA, NOW)).toBe('—');
  });

  it('the dialog and sheet sentences', () => {
    expect(neededByZoneNote(LA)).toBe('Times are in America/Los_Angeles.');
    expect(neededByPreviewCopy('2026-10-03T21:00:00Z', LA, NOW)).toBe('New needed-by: Sat, Oct 3, 2:00 PM');
    expect(neededByChangedCopy('2026-10-03T21:00:00Z', LA, NOW)).toBe(
      'Someone changed this date to Sat, Oct 3, 2:00 PM while you were editing.',
    );
    expect(neededByInvalidTimeCopy(LA)).toBe(
      "That date and time don't exist in America/Los_Angeles. Pick another time.",
    );
  });

  it('the confirmation says what the server did to the Schedule entry', () => {
    expect(neededByRevisedCopy(outcome('moved'), NOW)).toBe(
      'Needed-by changed to Sat, Oct 3, 2:00 PM. The Schedule entry moved too, and its reminders are set for the new time.',
    );
    // An entry already under way moves, but the cron reminds only a
    // scheduled one: no reminder claim for it.
    expect(neededByRevisedCopy(outcome('moved', { eventStatus: 'in_progress' }), NOW)).toBe(
      'Needed-by changed to Sat, Oct 3, 2:00 PM. The Schedule entry moved too.',
    );
    expect(neededByRevisedCopy(outcome('moved', { eventStatus: null }), NOW)).toBe(
      'Needed-by changed to Sat, Oct 3, 2:00 PM. The Schedule entry moved too.',
    );
    expect(neededByRevisedCopy(outcome('created'), NOW)).toBe(
      "Needed-by changed to Sat, Oct 3, 2:00 PM. It's on the Schedule now.",
    );
    expect(neededByRevisedCopy(outcome('none_yet'), NOW)).toBe(
      'Needed-by changed to Sat, Oct 3, 2:00 PM. Approving the order puts it on the Schedule.',
    );
    expect(neededByRevisedCopy(outcome('left_closed'), NOW)).toBe(
      'Needed-by changed to Sat, Oct 3, 2:00 PM. The Schedule entry is completed or cancelled, so it stays as it is.',
    );
    // The insert failed: saving the same date again adds it (the service
    // retries a missing entry on an unchanged save).
    expect(neededByRevisedCopy(outcome('not_added'), NOW)).toBe(
      "Needed-by changed to Sat, Oct 3, 2:00 PM. Its Schedule entry couldn't be added just now; save the same date again to add it.",
    );
    // The entry may not match the order: left at another date, not confirmed
    // closed with a closed order, or not readable.
    expect(neededByRevisedCopy(outcome('not_moved'), NOW)).toBe(
      'Needed-by changed to Sat, Oct 3, 2:00 PM. The Schedule entry may not match the order; check it on the Schedule.',
    );
    expect(neededByRevisedCopy(outcome('unchanged'), NOW)).toBe(
      'The needed-by date is already Sat, Oct 3, 2:00 PM. Nothing changed.',
    );
  });

  it('an unchanged save that added a missing entry says the date was already set', () => {
    expect(neededByRevisedCopy(outcome('created', { changed: false }), NOW)).toBe(
      "The needed-by date is already Sat, Oct 3, 2:00 PM. It's on the Schedule now.",
    );
    expect(neededByRevisedCopy(outcome('not_added', { changed: false }), NOW)).toBe(
      "The needed-by date is already Sat, Oct 3, 2:00 PM. Its Schedule entry couldn't be added just now; save the same date again to add it.",
    );
  });

  it('honest words: no email or notification claim, no percentage, no "book", no guarantee', () => {
    const all = [
      NEEDED_BY_REASON_REQUIRED_COPY,
      NEEDED_BY_IN_PAST_COPY,
      NEEDED_BY_CLOSED_COPY,
      NEEDED_BY_NOT_APPROVER_COPY,
      NEEDED_BY_NO_WAREHOUSE_ACCESS_COPY,
      NEEDED_BY_BUSY_COPY,
      NEEDED_BY_NOT_FOUND_COPY,
      NEEDED_BY_MODULE_OFF_COPY,
      NEEDED_BY_FAILED_COPY,
      NEEDED_BY_TIMEZONE_UNREADABLE_COPY,
      NEEDED_BY_NOT_PENDING_COPY,
      NEEDED_BY_OUT_OF_RANGE_COPY,
      NEEDED_BY_SIGN_IN_COPY,
      NEEDED_BY_RELOAD_COPY,
      NEEDED_BY_REVISED_TIMELINE_LABEL,
      NEEDED_BY_NO_ANSWER_COPY,
      NEEDED_BY_CHANGE_LABEL,
      NEEDED_BY_CHANGE_ACCESSIBILITY_LABEL,
      NEEDED_BY_REVISE_TITLE,
      NEEDED_BY_FIELD_LABEL,
      NEEDED_BY_REASON_LABEL,
      NEEDED_BY_REASON_HINT,
      NEEDED_BY_SAVE_LABEL,
      neededByRowCopy('2026-10-03T21:00:00Z', LA, NOW),
      neededByRowCopy(null, LA),
      neededByCurrentCopy('2026-10-03T21:00:00Z', LA, NOW),
      neededByCurrentCopy(null, LA),
      neededByEffectCopy('pending_approval'),
      neededByEffectCopy('approved'),
      neededByZoneNote(LA),
      neededByPreviewCopy(NOW, LA, NOW),
      neededByChangedCopy(null, LA),
      neededByChangedCopy('2026-10-03T21:00:00Z', LA, NOW),
      neededByInvalidTimeCopy(LA),
      ...(['moved', 'created', 'none_yet', 'left_closed', 'not_added', 'not_moved', 'unchanged'] as const).map((s) =>
        neededByRevisedCopy(outcome(s), NOW),
      ),
    ];
    expect(all.filter((l) => /email|notif|sent|verif|guarantee|\bbooks?\b|%/i.test(l))).toEqual([]);
  });
});

describe('the change: its entry, its dialog and its sheet (one set of words for web and phone)', () => {
  it('the entry beside the date: a visible word, and an accessible name that starts with it', () => {
    expect(NEEDED_BY_CHANGE_LABEL).toBe('Change');
    expect(NEEDED_BY_CHANGE_ACCESSIBILITY_LABEL).toBe('Change needed-by date');
    // Speech input finds the button by what it shows (WCAG 2.5.3).
    expect(NEEDED_BY_CHANGE_ACCESSIBILITY_LABEL.startsWith(NEEDED_BY_CHANGE_LABEL)).toBe(true);
    expect(NEEDED_BY_REVISE_TITLE).toBe('Change needed-by date');
  });

  it('the row the entry sits on, in the org zone; an order with no date says so', () => {
    expect(neededByRowCopy('2026-10-03T21:00:00Z', LA, NOW)).toBe('Needed by Sat, Oct 3, 2:00 PM');
    expect(neededByRowCopy('2026-10-03T21:00:00Z', 'America/New_York', NOW)).toBe('Needed by Sat, Oct 3, 5:00 PM');
    // A value exactly as PostgREST prints it, microseconds included.
    expect(neededByRowCopy('2026-10-03T21:00:00.123456+00:00', LA, NOW)).toBe('Needed by Sat, Oct 3, 2:00 PM');
    expect(neededByRowCopy(null, LA)).toBe('No needed-by date');
    expect(neededByRowCopy('', LA)).toBe('No needed-by date');
    expect(neededByRowCopy('soon', LA)).toBe('No needed-by date');
  });

  it('the date being replaced', () => {
    expect(neededByCurrentCopy('2026-10-03T21:00:00Z', LA, NOW)).toBe('Current needed-by: Sat, Oct 3, 2:00 PM');
    expect(neededByCurrentCopy(null, LA)).toBe('This order has no needed-by date yet.');
  });

  it('what saving does, before saving: past approval an open entry follows; a pending order gets one when approved', () => {
    // Said before the screen knows the entry's status: a completed or
    // cancelled entry stays, and one already under way gets no reminders.
    expect(neededByEffectCopy('approved')).toBe(
      "The order's Schedule entry moves to the new date unless it's completed or cancelled. If it hasn't started, its reminders are set for the new time.",
    );
    expect(neededByEffectCopy('in_transit')).toBe(neededByEffectCopy('approved'));
    expect(neededByEffectCopy('pending_approval')).toBe('Approving the order puts it on the Schedule at this date.');
  });

  it('the reason hint names the limit the function enforces', () => {
    expect(NEEDED_BY_REASON_HINT).toContain(String(NEEDED_BY_REASON_MAX));
    expect(NEEDED_BY_FIELD_LABEL).toBe('New needed-by date and time');
  });
});

describe('normalizeNeededByReason', () => {
  it('trims, and refuses empty or too long, counting characters as the function does', () => {
    expect(normalizeNeededByReason('  Pushed by the school  ')).toBe('Pushed by the school');
    expect(normalizeNeededByReason('   ')).toBeNull();
    expect(normalizeNeededByReason(null)).toBeNull();
    expect(normalizeNeededByReason('x'.repeat(NEEDED_BY_REASON_MAX))).toHaveLength(NEEDED_BY_REASON_MAX);
    expect(normalizeNeededByReason('x'.repeat(NEEDED_BY_REASON_MAX + 1))).toBeNull();
    // 500 characters outside the BMP (two UTF-16 units each) are 500
    // characters to char_length, not 1000.
    expect(normalizeNeededByReason('\u{20000}'.repeat(NEEDED_BY_REASON_MAX))).not.toBeNull();
  });
});
