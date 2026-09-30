import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { neededByInvalidTimeCopy, wallClockToInstant } from '@stockpilot/core';

import {
  restoreIntl,
  useHermesLikeIntl,
} from '../../../../packages/core/src/time/__fixtures__/hermes-like-intl';
import fixture from './__fixtures__/needed-by-wall-clocks.json';
import { neededByDraftView, type NeededByDraft } from './order-needed-by';

/**
 * F2-4: THE PHONE SHEET AND THE WEB DIALOG STORE THE SAME INSTANT FOR THE
 * SAME WALL CLOCK. One shared fixture (./__fixtures__/needed-by-wall-clocks.json)
 * names, per case, what the phone is given (a day chip and a slot, or the
 * Other time entry), what the web dialog's datetime-local yields
 * (`webLocal`), and the instant the server must store.
 *
 *   - The phone sends exactly the web's string: the server gets one shape
 *     from both, and converts it once (core wallClockToInstant, strict).
 *   - That conversion gives the fixture's instant, or refuses (null) a wall
 *     clock that does not exist in the zone, as the server does.
 *   - The phone's own preview instant is that same conversion, so what the
 *     sheet says ("New needed-by: …") is what gets stored.
 *   - All of it again under a Hermes stand-in (the phone's engine types only
 *     the date fields of a combined date-and-time formatter), and the preview
 *     words are the same on both engines.
 *
 * Mutations caught: converting in the device's zone (the device here is set
 * to Tokyo, which no case uses), a slot built from the device clock, a
 * 12-hour parse that reads 12:00 AM as noon, and a lenient conversion that
 * accepts the spring-forward hour.
 */

interface Case {
  name: string;
  zone: string;
  phone: { day: string; slot?: string; other?: string };
  webLocal: string;
  instant: string | null;
}

const CASES = (fixture as { cases: Case[] }).cases;
// Before every case, so each is still to come.
const NOW = Date.parse('2026-09-29T12:00:00Z');

function phoneDraft(c: Case): NeededByDraft {
  return {
    dayKey: c.phone.day,
    slot: c.phone.slot ?? null,
    other: c.phone.other !== undefined,
    otherText: c.phone.other ?? '',
    reason: 'Moved by the school',
  };
}

function phoneView(c: Case) {
  return neededByDraftView(phoneDraft(c), {
    now: NOW,
    zone: c.zone,
    current: null,
    status: 'approved',
    offline: false,
    busy: false,
    closed: false,
  });
}

// The device's own zone, set to one no case uses: a conversion that reads
// the device clock anywhere gives another instant.
const DEVICE_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Asia/Tokyo';
});
afterAll(() => {
  if (DEVICE_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = DEVICE_TZ;
});
afterEach(() => restoreIntl());

describe('the shared fixture', () => {
  it('runs with the device in a zone no case uses', () => {
    expect(new Date(Date.UTC(2026, 9, 3, 0, 0)).getHours()).toBe(9);
  });

  it('covers slots and Other time, a gap, a repeated hour, a missing date and five zones', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(15);
    expect(CASES.some((c) => c.phone.slot)).toBe(true);
    expect(CASES.some((c) => c.phone.other)).toBe(true);
    expect(CASES.filter((c) => c.instant === null).length).toBeGreaterThanOrEqual(2);
    expect(new Set(CASES.map((c) => c.zone)).size).toBeGreaterThanOrEqual(5);
  });
});

describe.each([
  ['this engine (the server, Node)', false],
  ['a Hermes stand-in (the phone)', true],
])('on %s', (_label, hermes) => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    if (hermes) useHermesLikeIntl();
    const server = wallClockToInstant(c.webLocal, c.zone);
    const expected = c.instant === null ? null : Date.parse(c.instant);
    expect(server).toBe(expected);

    const view = phoneView(c);
    if (expected === null) {
      // The phone never sends it: it says the time does not exist, in core's
      // words, and Save stays off.
      expect(view.wall).toBeNull();
      expect(view.timeProblem).toBe(neededByInvalidTimeCopy(c.zone));
      expect(view.canSave).toBe(false);
      return;
    }
    // What the phone sends is the web's own string...
    expect(view.wall).toBe(c.webLocal);
    // ...the server converts it to the fixture's instant...
    expect(wallClockToInstant(view.wall as string, c.zone)).toBe(expected);
    // ...and the preview the sheet showed was that instant.
    expect(view.at).toBe(expected);
    expect(view.canSave).toBe(true);
  });
});

describe('the preview reads the same on both engines', () => {
  it.each(CASES.filter((c) => c.instant !== null).map((c) => [c.name, c] as const))(
    '%s',
    (_name, c) => {
      const onNode = phoneView(c).preview;
      useHermesLikeIntl();
      const onHermes = phoneView(c).preview;
      expect(onNode).toMatch(/^New needed-by: /);
      expect(onHermes).toBe(onNode);
    },
  );
});
