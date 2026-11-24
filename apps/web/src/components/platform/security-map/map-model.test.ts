// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  SECURITY_EVENT_CATEGORIES,
  SECURITY_MAP_WHOLE_POLL_MS,
  SECURITY_MAP_WORDS,
  securityMapArcOf,
  type SecurityMapPlan,
  type SecurityMapWholeRead,
} from '@stockpilot/core';

import { facingOf } from './globe-math';
import {
  CATEGORY_LOOKS,
  SHAPE_INDEX,
  countryName,
  drawnArcs,
  focusOf,
  globeArcsOf,
  REPLAY_REREAD_AFTER_MS,
  localDayStart,
  nextLocalMidnight,
  nextPoll,
  notOnMapWords,
  replayWantsWhole,
  stageOf,
  viewShown,
} from './map-model';
import { STOCKPILOT_LON_LAT, countryPoint } from './world-geometry';

/** The island's rules for showing core's plan: looks, what is on the map now, when to read, which view. */

const arc = (country: string, category: number, outcome: 0 | 1, events: number) =>
  securityMapArcOf([country, category, outcome, events]);

const live = [arc('DE', 1, 0, 5)];
const steps = [
  { fromMs: 0, toMs: 1, arcs: [arc('BR', 0, 1, 2)] },
  { fromMs: 1, toMs: 2, arcs: [arc('SG', 2, 0, 9)] },
];
const picture = [arc('SG', 2, 0, 9), arc('BR', 0, 1, 2)];
const plan = (mode: SecurityMapPlan['mode']): SecurityMapPlan => ({
  mode,
  live: mode === 'live' ? live : [],
  steps: mode === 'replay' ? steps : [],
  picture: mode === 'live' ? live : mode === 'replay' ? picture : [],
  cut: false,
  liveUndrawn: false,
});

describe('how a category looks', () => {
  it('every category has its own colour and its own shape, so colour is never the only sign', () => {
    const looks = SECURITY_EVENT_CATEGORIES.map((c) => CATEGORY_LOOKS[c]);
    expect(new Set(looks.map((l) => l.hex)).size).toBe(SECURITY_EVENT_CATEGORIES.length);
    expect(new Set(looks.map((l) => l.shape)).size).toBe(SECURITY_EVENT_CATEGORIES.length);
    for (const l of looks) {
      expect(l.hex).toMatch(/^#[0-9a-f]{6}$/);
      expect(SHAPE_INDEX[l.shape]).toBeGreaterThanOrEqual(0);
      for (const v of l.rgb) expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('what is on the map this moment', () => {
  it('live: the live arcs loop', () => {
    expect(stageOf(plan('live'), null, 7)).toEqual({ timing: 'live', arcs: live, stepIndex: -1 });
  });

  it("replay: the step's own hour, counting round", () => {
    expect(stageOf(plan('replay'), null, 0)).toEqual({
      timing: 'replay',
      arcs: steps[0]!.arcs,
      stepIndex: 0,
    });
    expect(stageOf(plan('replay'), null, 3).stepIndex).toBe(1);
  });

  it('anything that stops the play: the one still picture, nothing moves (old arcs never move as if live)', () => {
    for (const stop of [
      'sign_in_again',
      'not_updating',
      'reduced_motion',
      'paused',
      'hidden',
    ] as const) {
      expect(stageOf(plan('live'), stop, 0)).toEqual({
        timing: 'still',
        arcs: live,
        stepIndex: -1,
      });
      expect(stageOf(plan('replay'), stop, 1)).toEqual({
        timing: 'still',
        arcs: picture,
        stepIndex: -1,
      });
    }
    expect(stageOf(plan('still'), null, 0)).toEqual({ timing: 'still', arcs: [], stepIndex: -1 });
  });

  it('an arc of a code with no point is not drawn; never placed at a made-up point', () => {
    const drawn = drawnArcs([arc('DE', 1, 0, 5), arc('QY', 1, 0, 3)]);
    expect(drawn.map((d) => d.arc.country)).toEqual(['DE']);
    expect(drawn[0]!.from).toEqual(countryPoint('DE'));
  });

  it('the globe is handed each arc with its own outcome: flagged is never handed over as blocked', () => {
    const arcs = globeArcsOf(drawnArcs([arc('DE', 1, 0, 5), arc('BR', 0, 1, 2)]));
    expect(arcs.map((a) => [a.key, a.flagged, a.shape])).toEqual([
      ['DE:exploit:blocked', false, SHAPE_INDEX[CATEGORY_LOOKS.exploit.shape]],
      ['BR:password_guessing:flagged', true, SHAPE_INDEX[CATEGORY_LOOKS.password_guessing.shape]],
    ]);
    expect(arcs[0]!.rgb).toEqual(CATEGORY_LOOKS.exploit.rgb);
    expect(arcs[0]!.from).toEqual(countryPoint('DE'));
  });

  it("the globe faces the drawn arcs' starts and StockPilot", () => {
    const drawn = drawnArcs([arc('DE', 1, 0, 5)]);
    expect(focusOf(drawn)).toEqual(facingOf([countryPoint('DE')!, STOCKPILOT_LON_LAT]));
    expect(focusOf([])).toBeNull();
  });
});

describe('the line for places with no point', () => {
  const whole = (table: Array<[string, number, 0 | 1, number]>) =>
    ({ whole: { table } }) as unknown as SecurityMapWholeRead;

  it('counts the events of codes with no point, names the codes, and says they are in the table', () => {
    expect(
      notOnMapWords(
        whole([
          ['DE', 1, 0, 50],
          ['QY', 1, 0, 4],
          ['QY', 2, 1, 1],
          ['QZ', 0, 0, 2],
          ['XK', 1, 0, 9],
        ]),
      ),
    ).toBe(
      'Not on the map: 7 events come from places the map has no point for (QY, QZ). They are in the table.',
    );
    expect(notOnMapWords(whole([['QY', 1, 0, 1]]))).toBe(
      'Not on the map: 1 event comes from a place the map has no point for (QY). It is in the table.',
    );
    expect(notOnMapWords(whole([['DE', 1, 0, 50]]))).toBeNull();
  });
});

describe('when to read', () => {
  const T = 1_000_000;
  /** No midnight in sight and no replay just begun. */
  const QUIET = { dayEndsAt: null, wholeWanted: false } as const;

  it("first, at once: the whole window with the viewer's day start", () => {
    expect(
      nextPoll(
        { lastPollAt: null, lastWholeAt: T - 10, failures: 0, dayCounted: false, ...QUIET },
        T,
      ),
    ).toEqual({ scope: 'whole', at: T });
  });

  it('then the last ten minutes every 30 seconds, and the whole window in their place every 5 minutes', () => {
    expect(
      nextPoll({ lastPollAt: T, lastWholeAt: T, failures: 0, dayCounted: true, ...QUIET }, T),
    ).toEqual({
      scope: 'recent',
      at: T + 30_000,
    });
    const whole = T + SECURITY_MAP_WHOLE_POLL_MS;
    expect(
      nextPoll(
        { lastPollAt: whole - 10_000, lastWholeAt: T, failures: 0, dayCounted: true, ...QUIET },
        T,
      ),
    ).toEqual({ scope: 'whole', at: whole });
  });

  it('after failed reads the wait grows, 60 then 120 seconds, and nothing is sent sooner', () => {
    expect(
      nextPoll({ lastPollAt: T, lastWholeAt: T, failures: 1, dayCounted: true, ...QUIET }, T),
    ).toEqual({
      scope: 'recent',
      at: T + 60_000,
    });
    expect(
      nextPoll({ lastPollAt: T, lastWholeAt: T, failures: 5, dayCounted: true, ...QUIET }, T),
    ).toEqual({
      scope: 'recent',
      at: T + 120_000,
    });
    // A whole read that is overdue still waits out the back-off.
    expect(
      nextPoll(
        { lastPollAt: T, lastWholeAt: T - 3_600_000, failures: 2, dayCounted: true, ...QUIET },
        T,
      ),
    ).toEqual({ scope: 'whole', at: T + 120_000 });
    expect(
      nextPoll({ lastPollAt: T, lastWholeAt: null, failures: 1, dayCounted: false, ...QUIET }, T),
    ).toEqual({ scope: 'whole', at: T + 60_000 });
  });

  it("at the viewer's midnight the whole window is read, even between the 30-second reads", () => {
    const clock = { lastPollAt: T, lastWholeAt: T, failures: 0, dayCounted: true };
    expect(nextPoll({ ...clock, dayEndsAt: T + 10_000, wholeWanted: false }, T)).toEqual({
      scope: 'whole',
      at: T + 10_000,
    });
    // A midnight later than the 5-minute read changes nothing.
    expect(
      nextPoll({ ...clock, dayEndsAt: T + SECURITY_MAP_WHOLE_POLL_MS + 1, wholeWanted: false }, T),
    ).toEqual({ scope: 'recent', at: T + 30_000 });
    // After failed reads the midnight read waits out the back-off too.
    expect(
      nextPoll({ ...clock, failures: 2, dayEndsAt: T + 10_000, wholeWanted: false }, T),
    ).toEqual({ scope: 'whole', at: T + 120_000 });
  });

  it('the replay just begun on an old read: the whole window at once (after the back-off when reads fail)', () => {
    const clock = { lastPollAt: T, lastWholeAt: T - 90_000, dayCounted: true, dayEndsAt: null };
    expect(nextPoll({ ...clock, failures: 0, wholeWanted: true }, T + 5)).toEqual({
      scope: 'whole',
      at: T + 5,
    });
    expect(nextPoll({ ...clock, failures: 1, wholeWanted: true }, T + 5)).toEqual({
      scope: 'whole',
      at: T + 60_000,
    });
  });

  it('only the turn to the replay asks, and only on a read more than a minute old', () => {
    const old = T - REPLAY_REREAD_AFTER_MS - 1;
    expect(replayWantsWhole(false, true, old, T)).toBe(true);
    expect(replayWantsWhole(false, true, null, T)).toBe(true);
    expect(replayWantsWhole(false, true, T - REPLAY_REREAD_AFTER_MS, T)).toBe(false);
    expect(replayWantsWhole(true, true, old, T)).toBe(false);
    expect(replayWantsWhole(true, false, old, T)).toBe(false);
    expect(replayWantsWhole(false, false, old, T)).toBe(false);
    expect(REPLAY_REREAD_AFTER_MS).toBe(60_000);
  });

  it("the next midnight is the viewer's own, a day on, also across a change of the clocks", () => {
    const start = new Date(2026, 10, 23);
    const next = new Date(nextLocalMidnight(start.toISOString())!);
    expect([next.getFullYear(), next.getMonth(), next.getDate()]).toEqual([2026, 10, 24]);
    expect([next.getHours(), next.getMinutes(), next.getSeconds()]).toEqual([0, 0, 0]);
    // Whatever the zone, every day of a year turns at a midnight one calendar day on.
    for (let day = new Date(2026, 0, 1); day.getFullYear() === 2026;) {
      const after = new Date(nextLocalMidnight(localDayStart(day))!);
      expect(after.getDate()).toBe(
        new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getDate(),
      );
      expect(after.getTime()).toBeGreaterThan(day.getTime());
      day = after;
    }
    expect(nextLocalMidnight(null)).toBeNull();
    expect(nextLocalMidnight('not a time')).toBeNull();
  });

  it("the day start is the viewer's own midnight, as an instant", () => {
    const now = new Date(2026, 10, 23, 15, 42, 7);
    const start = new Date(localDayStart(now));
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(10);
    expect(start.getDate()).toBe(23);
    expect([start.getHours(), start.getMinutes(), start.getSeconds()]).toEqual([0, 0, 0]);
    expect(localDayStart(now)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/);
  });
});

describe('which view', () => {
  it("the viewer's choice when the globe can be drawn", () => {
    expect(viewShown('globe', false, 'ok')).toEqual({
      view: 'globe',
      globeOffered: true,
      note: null,
    });
    expect(viewShown('flat', false, 'ok')).toEqual({
      view: 'flat',
      globeOffered: true,
      note: null,
    });
  });

  it('reduced motion: the flat map, never the globe, and why', () => {
    expect(viewShown('globe', true, 'ok')).toEqual({
      view: 'flat',
      globeOffered: false,
      note: SECURITY_MAP_WORDS.globeReducedMotion,
    });
  });

  it('a globe that cannot be drawn, or stopped drawing: the flat map, and one plain sentence', () => {
    expect(viewShown('globe', false, 'unavailable')).toEqual({
      view: 'flat',
      globeOffered: false,
      note: SECURITY_MAP_WORDS.globeUnavailable,
    });
    expect(viewShown('globe', false, 'lost')).toEqual({
      view: 'flat',
      globeOffered: false,
      note: SECURITY_MAP_WORDS.globeLost,
    });
  });

  it("a country's name, or its code when the runtime has none", () => {
    expect(countryName('DE')).toBe('Germany');
    expect(countryName('QZ')).toBe('QZ');
  });
});
