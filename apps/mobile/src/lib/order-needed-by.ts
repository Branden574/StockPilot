/**
 * CHANGE AN ORDER'S NEEDED-BY DATE ON THE PHONE (F2-4): every decision the
 * order screen's "Needed by" card and the revise sheet make, pure and tested
 * here (the sheet and the screen import native modules, so vitest cannot
 * render them; order-f2-4-wiring.test.ts pins them to this module).
 *
 * The phone has no native date picker (OTA-safe: JS only). It offers day
 * chips for the next 21 days and 30-minute time slots from 6:00 AM to 7:00 PM,
 * both worked out in the ORGANIZATION's zone (organizations.timezone), never
 * the device's, plus an "Other time" entry. What it sends is a zone-less wall
 * clock, "YYYY-MM-DDTHH:mm", exactly the shape the web dialog's
 * datetime-local sends; the server converts it in the org's zone (core
 * wallClockToInstant, strict), and the preview here uses the same function,
 * so the preview and the saved instant cannot disagree
 * (needed-by-wall-clock-parity.test.ts proves it, on this engine and on a
 * Hermes stand-in).
 *
 * Every word a person reads about the date is core's
 * (orders/needed-by-revision.ts), the web dialog's own: the row and its
 * Change, the title, the current date, the field and reason labels, the zone
 * note, the preview, what saving does, Save, a date in the past, a time that
 * does not exist, a stale edit, no answer, the confirmation and every
 * refusal. Only the phone's own controls (the day and time chips, "Other
 * time" and its hint) are worded here: the web has a datetime field instead.
 *
 * Nothing here composes or opens an email. A revision never does (Outlook
 * rule 1): the requester's delivery-request draft is unchanged and opens only
 * on their tap.
 */

import {
  NEEDED_BY_BUSY_COPY,
  NEEDED_BY_CLOSED_COPY,
  NEEDED_BY_FAILED_COPY,
  NEEDED_BY_IN_PAST_COPY,
  NEEDED_BY_MODULE_OFF_COPY,
  NEEDED_BY_NO_ANSWER_COPY,
  NEEDED_BY_NO_WAREHOUSE_ACCESS_COPY,
  NEEDED_BY_NOT_APPROVER_COPY,
  NEEDED_BY_NOT_FOUND_COPY,
  NEEDED_BY_OUT_OF_RANGE_COPY,
  NEEDED_BY_REASON_REQUIRED_COPY,
  NEEDED_BY_RELOAD_COPY,
  NEEDED_BY_SIGN_IN_COPY,
  NEEDED_BY_TIMEZONE_UNREADABLE_COPY,
  NeededByResultShapeError,
  READINESS_NEEDS_CONNECTION_COPY,
  isNeededByRevisable,
  isNeededByWithinReach,
  neededByChangedCopy,
  neededByCurrentCopy,
  neededByEffectCopy,
  neededByInvalidTimeCopy,
  neededByPreviewCopy,
  neededByRevisedCopy,
  neededByRowCopy,
  neededByZoneNote,
  normalizeNeededByReason,
  resolveOrgTimezone,
  wallClockString,
  wallClockToInstant,
  zonedParts,
  type NeededByFailureReason,
  type NeededByRevisionOutcome,
  type WallClock,
} from '@stockpilot/core';

// ── The phone's own control words (the web dialog has no chips) ─────────────

export const NEEDED_BY_DAY_EYEBROW = 'DAY';
export const NEEDED_BY_TIME_EYEBROW = 'TIME';
export const NEEDED_BY_OTHER_TIME_LABEL = 'Other time';
export const NEEDED_BY_OTHER_PLACEHOLDER = '2:30 PM, or 11/20 9:00 AM';
export const NEEDED_BY_OTHER_A11Y = 'Other time, or a date and a time';
export const NEEDED_BY_OTHER_HINT =
  'Type a time such as 2:30 PM or 14:30, or a date and a time such as 11/20 9:00 AM.';
export const NEEDED_BY_PICK_TIME_COPY = 'Pick a day and a time.';
export const NEEDED_BY_PICK_DAY_FIRST_COPY = 'Pick a day, or type a date with the time.';
export const NEEDED_BY_NO_SLOTS_LEFT_COPY = 'No times left today. Use Other time, or pick another day.';
export const NEEDED_BY_CANCEL_LABEL = 'Cancel';
export const NEEDED_BY_CLOSE_LABEL = 'Close';
/** The confirmation's title; its message is core's neededByRevisedCopy. */
export const NEEDED_BY_DONE_TITLE = 'Needed-by date';
/** The Alert title when the sheet cannot open (its message is core's). */
export const NEEDED_BY_CANNOT_OPEN_TITLE = "Can't change the needed-by date";
/** The server answered 200 with something this build cannot read. */
export const NEEDED_BY_ANSWER_UNREADABLE_COPY =
  "The server's answer couldn't be read, so the date may or may not have changed. Check the order's needed-by date before trying again.";
export const NEEDED_BY_TOO_MANY_COPY = 'Too many requests. Wait a moment and try again.';

/** The org's zone is one this phone's engine does not know (Hermes ships a
 *  reduced ICU): times would be shown in another zone than the server uses. */
export function neededByZoneUnknownCopy(zone: string): string {
  return `This phone can't show times in ${zone}, so the needed-by date can't be changed here. Change it on the web.`;
}

// ── Who is offered the change ───────────────────────────────────────────────

/**
 * Whether the order screen offers "Change" beside the needed-by: the orders
 * module is on, the order is open (core isNeededByRevisable), and the viewer
 * holds orders:approve in the EFFECTIVE set (a manager by role default, with
 * overrides applied): the one test the web page offers Change on and the
 * service refuses without (OrderRequestsService.reviseNeededByIn). A manager
 * whose orders:approve was revoked is not offered it, although the
 * database's 0348 gate would accept them: the service in front of it does
 * not. `role` decides one thing: never a viewer, even granted
 * orders:approve, as the web's neededByChangeView (the app refuses every
 * write for a viewer, and the revise needs warehouse write). Warehouse write
 * access is otherwise checked when the sheet opens (neededBySheetOpening);
 * the server re-checks everything.
 */
export function canOfferNeededByChange(input: {
  status: string | null | undefined;
  role: string | null | undefined;
  canApproveOrders: boolean;
  ordersModuleEnabled: boolean;
}): boolean {
  return (
    input.ordersModuleEnabled &&
    isNeededByRevisable(input.status) &&
    input.canApproveOrders &&
    input.role !== 'viewer'
  );
}

/** Whether the "Needed by" card shows: the order has one, or the viewer may set one. */
export function showNeededByCard(neededBy: string | null, canChange: boolean): boolean {
  return neededBy !== null || canChange;
}

/**
 * Whether `load` reads the org's zone for the needed-by on its own. Only when
 * the order has a needed-by to print and no other read of this load already
 * brings the zone (readiness reads it; a live delivery order reads the org row
 * for its email routing). Started beside the lines read, so it adds no serial
 * round trip; an order with no needed-by reads nothing.
 */
export function needsNeededByZoneRead(input: {
  neededBy: string | null | undefined;
  readinessReadsZone: boolean;
  deliveryReadsZone: boolean;
}): boolean {
  return !!input.neededBy && !input.readinessReadsZone && !input.deliveryReadsZone;
}

/** What the card prints: core's row ("Needed by Fri, Oct 3, 2:00 PM" in the
 *  org's zone, or "No needed-by date"), the web page's words. */
export function neededByCardValue(neededBy: string | null, timeZone: string | null, now?: number): string {
  return neededByRowCopy(neededBy, timeZone ?? '', now);
}

export type NeededBySheetOpening =
  | { ok: true; timeZone: string }
  | { ok: false; title: string; message: string };

/**
 * Whether the sheet can open, from the org's zone (as read) and the viewer's
 * writable warehouses (lib/holdings-elsewhere readDestinationWarehouseScope:
 * null for a manager or above, the assignment rows for staff, none for a
 * viewer). Refused, in core's words:
 *   - the zone could not be read: converting a wall clock in a guessed zone
 *     would write a wrong instant (the server refuses it the same way);
 *   - the zone is one this phone cannot show: the day chips, the slots and the
 *     preview would be in another zone than the server converts in;
 *   - the viewer has no write access to the order's warehouse (the function's
 *     warehouse_write gate). A failed assignment read is not a refusal: the
 *     server decides, and says so in the sheet.
 */
export function neededBySheetOpening(input: {
  rawZone: string | null | undefined;
  scope: { writableIds: readonly string[] | null; unreadable: boolean };
  warehouseId: string | null;
}): NeededBySheetOpening {
  const zone = typeof input.rawZone === 'string' ? input.rawZone.trim() : '';
  if (zone === '') {
    return { ok: false, title: NEEDED_BY_CANNOT_OPEN_TITLE, message: NEEDED_BY_TIMEZONE_UNREADABLE_COPY };
  }
  if (resolveOrgTimezone(zone) !== zone) {
    return { ok: false, title: NEEDED_BY_CANNOT_OPEN_TITLE, message: neededByZoneUnknownCopy(zone) };
  }
  const { writableIds, unreadable } = input.scope;
  if (
    !unreadable &&
    writableIds !== null &&
    (input.warehouseId === null || !writableIds.includes(input.warehouseId))
  ) {
    return {
      ok: false,
      title: NEEDED_BY_CANNOT_OPEN_TITLE,
      message: NEEDED_BY_NO_WAREHOUSE_ACCESS_COPY,
    };
  }
  return { ok: true, timeZone: zone };
}

// ── Days and time slots, in the org's zone ──────────────────────────────────

export const NEEDED_BY_DAY_COUNT = 21;
/** Slots run 6:00 AM to 7:00 PM, every 30 minutes (27 slots). */
export const NEEDED_BY_FIRST_SLOT_MINUTE = 6 * 60;
export const NEEDED_BY_LAST_SLOT_MINUTE = 19 * 60;
export const NEEDED_BY_SLOT_STEP_MINUTES = 30;

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export interface NeededByDay {
  /** "YYYY-MM-DD": a calendar day in the org's zone. */
  key: string;
  year: number;
  month: number;
  day: number;
  /** "Today", "Tomorrow", or the short weekday ("Fri"). */
  label: string;
  /** "Oct 3". */
  dateLabel: string;
  /** "Today, Friday, October 3". */
  accessibilityLabel: string;
}

export interface NeededBySlot {
  /** "HH:mm", 24-hour. */
  time: string;
  /** "YYYY-MM-DDTHH:mm": what the server is sent. */
  wall: string;
  /** The instant it names in the org's zone. */
  at: number;
  /** "2:00 PM". */
  label: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** "YYYY-MM-DD" for a calendar day. */
export function dayKeyOf(d: { year: number; month: number; day: number }): string {
  return `${String(d.year).padStart(4, '0')}-${pad2(d.month)}-${pad2(d.day)}`;
}

function parseDayKey(key: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** A calendar day `offset` days after `d`: plain calendar arithmetic, no zone. */
function addDays(
  d: { year: number; month: number; day: number },
  offset: number,
): { year: number; month: number; day: number } {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day) + offset * DAY_MS);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

function weekdayOf(d: { year: number; month: number; day: number }): number {
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
}

/** "2:00 PM" for a 24-hour hour and minute (no Intl: the same on every engine). */
export function slotLabel(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${pad2(minute)} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** The org's calendar day at `now`. */
export function orgToday(now: number, zone: string): { year: number; month: number; day: number } {
  const p = zonedParts(now, zone);
  return { year: p.year, month: p.month, day: p.day };
}

/**
 * Every slot of a day, 6:00 AM to 7:00 PM, with the instant each names in the
 * org's zone: each one the server's own strict conversion of its wall clock
 * (core wallClockToInstant), so a slot on a daylight-saving change day is
 * right too, and a slot that does not exist in the zone is left out.
 */
function allSlotsOf(dayKey: string, zone: string): NeededBySlot[] {
  const d = parseDayKey(dayKey);
  if (!d) return [];
  const out: NeededBySlot[] = [];
  for (
    let minute = NEEDED_BY_FIRST_SLOT_MINUTE;
    minute <= NEEDED_BY_LAST_SLOT_MINUTE;
    minute += NEEDED_BY_SLOT_STEP_MINUTES
  ) {
    const wall: WallClock = { ...d, hour: Math.floor(minute / 60), minute: minute % 60 };
    const at = wallClockToInstant(wall, zone);
    if (at === null) continue;
    out.push({
      time: `${pad2(wall.hour)}:${pad2(wall.minute)}`,
      wall: wallClockString(wall),
      at,
      label: slotLabel(wall.hour, wall.minute),
    });
  }
  return out;
}

/** The slots of a day that are still to come at `now`. */
export function neededBySlots(dayKey: string, now: number, zone: string): NeededBySlot[] {
  return allSlotsOf(dayKey, zone).filter((s) => s.at > now);
}

/**
 * The next 21 days in the org's zone, starting with the org's today (which
 * may have no slots left; Other time still works there). "Today" and
 * "Tomorrow" are the org's, not the device's.
 */
export function neededByDays(now: number, zone: string): NeededByDay[] {
  const today = orgToday(now, zone);
  const out: NeededByDay[] = [];
  for (let i = 0; i < NEEDED_BY_DAY_COUNT; i += 1) {
    const d = addDays(today, i);
    const weekday = WEEKDAYS[weekdayOf(d)]!;
    const month = MONTHS[d.month - 1]!;
    const relative = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : null;
    out.push({
      key: dayKeyOf(d),
      ...d,
      label: relative ?? weekday.slice(0, 3),
      dateLabel: `${month.slice(0, 3)} ${d.day}`,
      accessibilityLabel: `${relative ? `${relative}, ` : ''}${weekday}, ${month} ${d.day}`,
    });
  }
  return out;
}

/** The day the sheet selects first: the first with a slot still to come. */
export function firstOpenDayKey(now: number, zone: string): string {
  const days = neededByDays(now, zone);
  const open = days.find((d) => neededBySlots(d.key, now, zone).length > 0);
  return (open ?? days[0]!).key;
}

// ── "Other time" ────────────────────────────────────────────────────────────

const TIME_12 = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*(?:m\.?)?$/;
const TIME_24 = /^(\d{1,2}):(\d{2})$/;
const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(.+))?$/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?:\s+(.+))?$/;

/** "2:30 PM", "2pm", "2:30p", "2 p.m." or "14:30"; null otherwise. */
export function parseNeededByTime(raw: string): { hour: number; minute: number } | null {
  const s = raw.trim().toLowerCase();
  const twelve = TIME_12.exec(s);
  if (twelve) {
    const h = Number(twelve[1]);
    const m = twelve[2] === undefined ? 0 : Number(twelve[2]);
    if (h < 1 || h > 12 || m > 59) return null;
    const hour = (h % 12) + (twelve[3] === 'p' ? 12 : 0);
    return { hour, minute: m };
  }
  const day = TIME_24.exec(s);
  if (day) {
    const hour = Number(day[1]);
    const minute = Number(day[2]);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
  }
  return null;
}

export type NeededByOtherEntry =
  | { kind: 'empty' }
  | { kind: 'problem'; message: string }
  | { kind: 'ok'; wall: WallClock; hasOwnDate: boolean };

/**
 * Reads the "Other time" entry: a time on the selected day ("2:30 PM",
 * "14:30"), or a date and a time ("11/20 9:00 AM", "11/20/2026 9:00 AM",
 * "2026-11-20 14:00") for a day past the chips. A month and day with no year
 * is the next such day in the org's calendar (never one already past). The
 * calendar is checked by the strict conversion, not here: a date that does
 * not exist is core's "don't exist" sentence, like a time in the
 * spring-forward hour.
 */
export function parseNeededByOtherEntry(
  raw: string,
  dayKey: string | null,
  now: number,
  zone: string,
): NeededByOtherEntry {
  const s = raw.replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s === '') return { kind: 'empty' };
  const hint: NeededByOtherEntry = { kind: 'problem', message: NEEDED_BY_OTHER_HINT };

  const iso = ISO_DATE.exec(s);
  const us = iso ? null : US_DATE.exec(s);
  if (iso || us) {
    const timeText = (iso ? iso[4] : us![4]) ?? '';
    const time = parseNeededByTime(timeText);
    if (!time) return hint;
    let year: number;
    let month: number;
    let day: number;
    if (iso) {
      year = Number(iso[1]);
      month = Number(iso[2]);
      day = Number(iso[3]);
    } else {
      month = Number(us![1]);
      day = Number(us![2]);
      const today = orgToday(now, zone);
      if (us![3] !== undefined) {
        const y = Number(us![3]);
        year = us![3].length === 2 ? 2000 + y : y;
      } else {
        // The next such day: this year's, or next year's once it has passed.
        const thisYear = dayKeyOf({ year: today.year, month, day });
        year = thisYear < dayKeyOf(today) ? today.year + 1 : today.year;
      }
    }
    return { kind: 'ok', wall: { year, month, day, ...time }, hasOwnDate: true };
  }

  const time = parseNeededByTime(s);
  if (!time) return hint;
  const d = dayKey ? parseDayKey(dayKey) : null;
  if (!d) return { kind: 'problem', message: NEEDED_BY_PICK_DAY_FIRST_COPY };
  return { kind: 'ok', wall: { ...d, ...time }, hasOwnDate: false };
}

// ── The draft and what the sheet shows ──────────────────────────────────────

export interface NeededByDraft {
  /** The selected day chip ("YYYY-MM-DD"), or null. */
  dayKey: string | null;
  /** The selected slot ("HH:mm"), or null. Ignored while `other` is on. */
  slot: string | null;
  /** "Other time" is selected: the entry decides the time. */
  other: boolean;
  otherText: string;
  reason: string;
}

/**
 * The draft the sheet opens with. A needed-by still to come is selected as it
 * is: its day and slot, or its time in "Other time" when it is off the grid
 * (with its date too when it is past the chips). Otherwise the first day with
 * a time left, and no time: the person picks one.
 */
export function initialNeededByDraft(current: string | null, now: number, zone: string): NeededByDraft {
  const blank: NeededByDraft = {
    dayKey: firstOpenDayKey(now, zone),
    slot: null,
    other: false,
    otherText: '',
    reason: '',
  };
  const t = current ? Date.parse(current) : Number.NaN;
  if (!Number.isFinite(t) || t <= now) return blank;
  const p = zonedParts(t, zone);
  const key = dayKeyOf(p);
  const inChips = neededByDays(now, zone).some((d) => d.key === key);
  const time = `${pad2(p.hour)}:${pad2(p.minute)}`;
  if (inChips && allSlotsOf(key, zone).some((s) => s.time === time && s.at === t)) {
    return { ...blank, dayKey: key, slot: time };
  }
  const clock = slotLabel(p.hour, p.minute);
  return {
    ...blank,
    dayKey: inChips ? key : blank.dayKey,
    other: true,
    otherText: inChips ? clock : `${p.month}/${p.day}/${p.year} ${clock}`,
  };
}

/**
 * A day chip tapped. The time stays: a slot stays selected, and an "Other
 * time" that carried its own date keeps its time and moves to this day
 * (otherwise its own date would still win, and the chip tapped would not show
 * as selected).
 */
export function selectNeededByDay(
  draft: NeededByDraft,
  dayKey: string,
  now: number,
  zone: string,
): NeededByDraft {
  if (draft.other) {
    const entry = parseNeededByOtherEntry(draft.otherText, dayKey, now, zone);
    if (entry.kind === 'ok' && entry.hasOwnDate) {
      return { ...draft, dayKey, otherText: slotLabel(entry.wall.hour, entry.wall.minute) };
    }
  }
  return { ...draft, dayKey };
}

export interface NeededByDraftView {
  days: NeededByDay[];
  /** The chip shown as selected: the draft's day, or the date typed in Other time. */
  selectedDayKey: string | null;
  /** The selected day's slots still to come. */
  slots: NeededBySlot[];
  /** Said under the slots when the selected day has none left. */
  noSlotsNote: string | null;
  /** What Save sends ("YYYY-MM-DDTHH:mm"), or null while there is none. */
  wall: string | null;
  /** The instant `wall` names in the org's zone (the server's conversion). */
  at: number | null;
  /** Core's "New needed-by: Fri, Oct 3, 2:00 PM". */
  preview: string | null;
  /** Why there is no preview: nothing picked, the entry, a time past or one that does not exist. */
  timeProblem: string | null;
  /** The reason as the function takes it (trimmed, 1 to 500), or null. */
  reason: string | null;
  /** Core's "Say why…" once something is typed that is not a reason (only spaces). */
  reasonProblem: string | null;
  /** Core's "Times are in America/Los_Angeles." */
  zoneNote: string;
  /** Core's "Current needed-by: Fri, Oct 3, 2:00 PM" (or that it has none). */
  current: string;
  /** Core's sentence on what saving does to the Schedule entry, before saving. */
  effect: string;
  /** Save can be pressed. */
  canSave: boolean;
  /** Why Save cannot be pressed (its VoiceOver hint), or null. */
  saveBlockedBy: string | null;
}

/**
 * Everything the sheet shows for a draft, at `now`. Save needs a connection,
 * a time still to come that exists in the org's zone, a reason, no save
 * already running, and an order that is still open (`closed`, set after the
 * server said the order closed, or after a refusal nothing more can fix).
 */
export function neededByDraftView(
  draft: NeededByDraft,
  ctx: {
    now: number;
    zone: string;
    current: string | null;
    /** The order's status (what saving does depends on it). */
    status: string | null;
    offline: boolean;
    busy: boolean;
    closed: boolean;
  },
): NeededByDraftView {
  const { now, zone } = ctx;
  const days = neededByDays(now, zone);

  let wallClock: WallClock | null = null;
  let timeProblem: string | null = null;
  let selectedDayKey = draft.dayKey;
  if (draft.other) {
    const entry = parseNeededByOtherEntry(draft.otherText, draft.dayKey, now, zone);
    if (entry.kind === 'ok') {
      wallClock = entry.wall;
      if (entry.hasOwnDate) selectedDayKey = dayKeyOf(entry.wall);
    } else if (entry.kind === 'problem') {
      timeProblem = entry.message;
    } else {
      timeProblem = NEEDED_BY_OTHER_HINT;
    }
  } else if (draft.dayKey && draft.slot) {
    const d = parseDayKey(draft.dayKey);
    const t = /^(\d{2}):(\d{2})$/.exec(draft.slot);
    if (d && t) wallClock = { ...d, hour: Number(t[1]), minute: Number(t[2]) };
  }
  if (wallClock === null && timeProblem === null) timeProblem = NEEDED_BY_PICK_TIME_COPY;

  let wall: string | null = null;
  let at: number | null = null;
  let preview: string | null = null;
  if (wallClock) {
    const instant = wallClockToInstant(wallClock, zone);
    if (instant === null) {
      timeProblem = neededByInvalidTimeCopy(zone);
    } else if (instant <= now) {
      timeProblem = NEEDED_BY_IN_PAST_COPY;
    } else if (!isNeededByWithinReach(instant, now)) {
      // The function refuses it (needed_by_out_of_range); said here first.
      timeProblem = NEEDED_BY_OUT_OF_RANGE_COPY;
    } else {
      wall = wallClockString(wallClock);
      at = instant;
      preview = neededByPreviewCopy(instant, zone, now);
    }
  }

  const slots = draft.dayKey ? neededBySlots(draft.dayKey, now, zone) : [];
  const reason = normalizeNeededByReason(draft.reason);
  const reasonProblem = reason === null && draft.reason.length > 0 ? NEEDED_BY_REASON_REQUIRED_COPY : null;

  const saveBlockedBy = ctx.closed
    ? NEEDED_BY_CLOSED_COPY
    : ctx.offline
      ? READINESS_NEEDS_CONNECTION_COPY
      : wall === null
        ? timeProblem
        : reason === null
          ? NEEDED_BY_REASON_REQUIRED_COPY
          : null;

  return {
    days,
    selectedDayKey,
    slots,
    noSlotsNote: draft.dayKey && !draft.other && slots.length === 0 ? NEEDED_BY_NO_SLOTS_LEFT_COPY : null,
    wall,
    at,
    preview,
    timeProblem: wall === null ? timeProblem : null,
    reason,
    reasonProblem,
    zoneNote: neededByZoneNote(zone),
    current: neededByCurrentCopy(ctx.current, zone, now),
    effect: neededByEffectCopy(ctx.status),
    canSave: saveBlockedBy === null && !ctx.busy,
    saveBlockedBy,
  };
}

/**
 * What VoiceOver is told when the chosen time changes (a chip, Other time, or
 * a slot passing on the clock): the preview in the org's zone, or why there is
 * none. The web dialog's preview is a live region; on iOS the sheet announces
 * it (debounced while typing).
 */
export function neededBySpokenUpdate(view: Pick<NeededByDraftView, 'preview' | 'timeProblem'>): string | null {
  return view.preview ?? view.timeProblem;
}

/** Space kept to the left of a day chip scrolled into the row (the row's gap). */
export const NEEDED_BY_DAY_ROW_INSET = 8;

/**
 * Where the sheet's day row must scroll so the selected day shows whole, or
 * null when it already does (or nothing is measured yet). The row holds 21
 * chips and a phone shows about five, so an order needed a week out opened
 * with its day chip off the right edge while its time chip showed selected
 * below it (iPhone 17 walk, 2026-09-30). The chip is brought to the row's
 * left edge, less a small inset, never before the start.
 */
export function neededByDayRowScroll(input: {
  /** The chip's x in the row's content, and its width (its onLayout). */
  chipX: number;
  chipWidth: number;
  /** The row's scroll offset and its visible width. */
  offset: number;
  viewport: number;
}): number | null {
  const { chipX, chipWidth, offset, viewport } = input;
  if (![chipX, chipWidth, offset, viewport].every(Number.isFinite)) return null;
  if (viewport <= 0 || chipWidth <= 0) return null;
  if (chipX >= offset && chipX + chipWidth <= offset + viewport) return null;
  return Math.max(0, Math.round(chipX - NEEDED_BY_DAY_ROW_INSET));
}

// ── Saving ──────────────────────────────────────────────────────────────────

/** POST /api/v1/orders/[id]/needed-by's body. */
export interface ReviseNeededByBody {
  /** A wall clock in the org's zone, "YYYY-MM-DDTHH:mm". */
  neededByLocal: string;
  /** The needed-by the sheet started from, EXACTLY as PostgREST returned it
   *  (a JS Date would drop the microseconds some rows carry, and the stale
   *  check compares exactly), or null when the order had none. */
  expectedNeededBy: string | null;
  reason: string;
}

/** The order's needed-by and status as stored now, read directly. */
export type NeededByCurrentRead =
  | { ok: true; neededBy: string | null; status: string }
  | { ok: false };

export interface NeededByRevisionDeps {
  revise: (orderId: string, body: ReviseNeededByBody) => Promise<NeededByRevisionOutcome>;
  readCurrent: () => Promise<NeededByCurrentRead>;
}

export type NeededBySubmitResult =
  | { kind: 'saved'; outcome: NeededByRevisionOutcome; title: string; message: string }
  | {
      kind: 'refused';
      reason: NeededByFailureReason | 'no_answer' | 'unreadable' | 'rate_limited' | 'unauthenticated';
      message: string;
      /** The needed-by as stored now, when it was read or the server said it:
       *  the sheet shows it and starts from it (the next save's expected). */
      current?: { neededBy: string | null };
      /** Nothing in the sheet can fix it: Save stays off. */
      closed: boolean;
    };

const REASONS: ReadonlySet<string> = new Set<NeededByFailureReason>([
  'needed_by_changed',
  'needed_by_in_past',
  'needed_by_out_of_range',
  'reason_required',
  'order_closed',
  'invalid_time',
  'forbidden',
  'not_found',
  'module_disabled',
  'busy',
  'timezone_unreadable',
  'not_pending',
  'failed',
]);

/** Refusals nothing in the sheet can fix. */
const CLOSING: ReadonlySet<string> = new Set(['order_closed', 'forbidden', 'not_found', 'module_disabled']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Date.parse(a) === Date.parse(b);
}

/** Core's sentence for a refusal the server named without one it sent. */
function fallbackCopy(reason: NeededByFailureReason, zone: string): string {
  switch (reason) {
    case 'needed_by_in_past':
      return NEEDED_BY_IN_PAST_COPY;
    case 'needed_by_out_of_range':
      return NEEDED_BY_OUT_OF_RANGE_COPY;
    case 'reason_required':
      return NEEDED_BY_REASON_REQUIRED_COPY;
    case 'order_closed':
      return NEEDED_BY_CLOSED_COPY;
    case 'invalid_time':
      return neededByInvalidTimeCopy(zone);
    case 'forbidden':
      return NEEDED_BY_NOT_APPROVER_COPY;
    case 'not_found':
      return NEEDED_BY_NOT_FOUND_COPY;
    case 'module_disabled':
      return NEEDED_BY_MODULE_OFF_COPY;
    case 'busy':
      return NEEDED_BY_BUSY_COPY;
    case 'timezone_unreadable':
      return NEEDED_BY_TIMEZONE_UNREADABLE_COPY;
    default:
      return NEEDED_BY_FAILED_COPY;
  }
}

/** A sentence a person can read (the route's messages are core's); a lone
 *  snake_case token or an empty string is not one. */
function sentence(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  const m = message.trim();
  if (m === '' || /^[a-z0-9_]+$/.test(m)) return null;
  return m;
}

/**
 * Change the needed-by: POST the wall clock with the value the sheet started
 * from and the reason, and say what happened.
 *   - Saved: core's confirmation, from what the server did.
 *   - needed_by_changed: someone saved another date first. The order's
 *     needed-by is read again EXACTLY as stored (the refusal's own copy is a
 *     millisecond ISO, which a stored microsecond value would not match), the
 *     sheet shows it and starts from it, and says core's "Someone changed this
 *     date to …". A closed order says so and Save stays off.
 *   - No answer (the connection dropped or timed out after sending): it may
 *     or may not have been applied (core's NEEDED_BY_NO_ANSWER_COPY), so the
 *     needed-by is read again; when it moved, the sheet shows it and starts
 *     from it, never a silent retry over it.
 *   - Every other refusal: core's sentence for it, the selection and the
 *     reason kept; the closing ones (closed, forbidden, not found, module
 *     off) turn Save off.
 * Never throws.
 */
export async function submitNeededByRevision(
  deps: NeededByRevisionDeps,
  input: { orderId: string; wall: string; expected: string | null; reason: string; zone: string },
): Promise<NeededBySubmitResult> {
  const { zone } = input;
  try {
    const outcome = await deps.revise(input.orderId, {
      neededByLocal: input.wall,
      expectedNeededBy: input.expected,
      reason: input.reason,
    });
    return { kind: 'saved', outcome, title: NEEDED_BY_DONE_TITLE, message: neededByRevisedCopy(outcome) };
  } catch (e) {
    const status = isRecord(e) && typeof e.status === 'number' ? e.status : null;
    const answered = status !== null || e instanceof NeededByResultShapeError;

    if (!answered) {
      // Whether it was saved is unknown (it may still land after a timeout):
      // core's words say so, and the order is read again. When the date
      // moved, the sheet shows it and starts from it, never retrying silently
      // over it.
      const now = await safeRead(deps);
      const moved = !!now && now.ok && !sameInstant(now.neededBy, input.expected);
      return {
        kind: 'refused',
        reason: 'no_answer',
        message: NEEDED_BY_NO_ANSWER_COPY,
        ...(moved && now && now.ok ? { current: { neededBy: now.neededBy } } : {}),
        closed: moved && !!now && now.ok && !isNeededByRevisable(now.status),
      };
    }

    if (e instanceof NeededByResultShapeError) {
      // It answered 200 with something this build cannot read: the date may
      // have changed. Read it and show it.
      const now = await safeRead(deps);
      return {
        kind: 'refused',
        reason: 'unreadable',
        message: NEEDED_BY_ANSWER_UNREADABLE_COPY,
        ...(now && now.ok ? { current: { neededBy: now.neededBy } } : {}),
        closed: !!now && now.ok && !isNeededByRevisable(now.status),
      };
    }

    const details = isRecord(e) && isRecord(e.details) ? e.details : null;
    const named = details && typeof details.reason === 'string' && REASONS.has(details.reason)
      ? (details.reason as NeededByFailureReason)
      : null;

    if (status === 429) {
      return { kind: 'refused', reason: 'rate_limited', message: NEEDED_BY_TOO_MANY_COPY, closed: false };
    }
    if (status === 401) {
      return { kind: 'refused', reason: 'unauthenticated', message: NEEDED_BY_SIGN_IN_COPY, closed: true };
    }

    if (named === 'needed_by_changed') {
      const said = details && typeof details.current === 'string' ? details.current : null;
      const now = await safeRead(deps);
      const current = now && now.ok ? now.neededBy : said;
      if (now && now.ok && !isNeededByRevisable(now.status)) {
        return {
          kind: 'refused',
          reason: 'order_closed',
          message: NEEDED_BY_CLOSED_COPY,
          current: { neededBy: current },
          closed: true,
        };
      }
      return {
        kind: 'refused',
        reason: 'needed_by_changed',
        message: neededByChangedCopy(current, zone),
        current: { neededBy: current },
        closed: false,
      };
    }

    if (named) {
      // The route's message is core's sentence (the forbidden one names what
      // is missing: approving, or the warehouse); a fault is core's generic
      // one. A value the server could not read back comes as core's "Reload
      // the order" (NEEDED_BY_RELOAD_COPY), kept as it is.
      const message =
        named === 'failed'
          ? (sentence(isRecord(e) ? e.message : null) === NEEDED_BY_RELOAD_COPY
              ? NEEDED_BY_RELOAD_COPY
              : NEEDED_BY_FAILED_COPY)
          : (sentence(isRecord(e) ? e.message : null) ?? fallbackCopy(named, zone));
      return { kind: 'refused', reason: named, message, closed: CLOSING.has(named) };
    }

    // An answer with no named refusal: the route's own body check (a 400), a
    // server fault, or a server from before F2-4 (no such route).
    const message =
      status !== null && status >= 500
        ? NEEDED_BY_FAILED_COPY
        : status === 400
          ? NEEDED_BY_FAILED_COPY
          : (sentence(isRecord(e) ? e.message : null) ?? NEEDED_BY_FAILED_COPY);
    return { kind: 'refused', reason: 'failed', message, closed: false };
  }
}

async function safeRead(deps: NeededByRevisionDeps): Promise<NeededByCurrentRead | null> {
  try {
    return await deps.readCurrent();
  } catch {
    return null;
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

export interface NeededByReadClient {
  from(table: string): unknown;
}

interface OrderNeededByChain {
  select(columns: string): OrderNeededByChain;
  eq(column: string, value: string): OrderNeededByChain;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
}

/**
 * The order's needed-by and status as stored now, straight from the row
 * (RLS: any member of the org reads its orders). The needed-by comes back
 * EXACTLY as PostgREST returned it, never re-formatted: it is the next save's
 * expected value. Awaited (a lazy query builder sends nothing otherwise), and
 * never throws: a failed read is `{ ok: false }`.
 */
export async function readOrderNeededBy(
  client: NeededByReadClient,
  organizationId: string,
  orderId: string,
): Promise<NeededByCurrentRead> {
  try {
    const res = await (client.from('order_requests') as OrderNeededByChain)
      .select('needed_by, status')
      .eq('organization_id', organizationId)
      .eq('id', orderId)
      .maybeSingle();
    if (!res || res.error || !isRecord(res.data)) return { ok: false };
    const neededBy = res.data.needed_by;
    const status = res.data.status;
    if (typeof status !== 'string') return { ok: false };
    if (neededBy !== null && typeof neededBy !== 'string') return { ok: false };
    return { ok: true, neededBy, status };
  } catch {
    return { ok: false };
  }
}
