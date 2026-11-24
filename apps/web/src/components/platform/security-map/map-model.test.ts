// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  SECURITY_EVENT_CATEGORIES,
  SECURITY_MAP_WHOLE_POLL_MS,
  SECURITY_MAP_WORDS,
  securityMapArcOf,
  type SecurityMapFeedRow,
  type SecurityMapPlan,
  type SecurityMapWholeRead,
} from '@stockpilot/core';

import { facingYaw, heatOf } from './globe-math';
import {
  CATEGORY_LOOKS,
  SHAPE_INDEX,
  SOURCE_LABELS,
  countryName,
  drawnArcs,
  focusOf,
  globeArcsOf,
  heatByCountry,
  planDrawnArcs,
  REPLAY_REREAD_AFTER_MS,
  localDayStart,
  nextLocalMidnight,
  nextPoll,
  notOnMapWords,
  replayWantsWhole,
  sourceLabels,
  stageOf,
  stageSpan,
  tickerRowOf,
  viewShown,
  webglAvailable,
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

  it("the globe faces the drawn arcs' sources, each country weighed by the square root of its events", () => {
    const drawn = drawnArcs([arc('DE', 1, 0, 5), arc('DE', 0, 1, 4), arc('BR', 2, 0, 16)]);
    expect(focusOf(drawn)).toBe(
      facingYaw(
        [
          { lonLat: countryPoint('DE')!, weight: 3 },
          { lonLat: countryPoint('BR')!, weight: 4 },
        ],
        STOCKPILOT_LON_LAT,
      ),
    );
    // Nothing to draw: StockPilot.
    expect(focusOf([])).toBe(facingYaw([], STOCKPILOT_LON_LAT));
  });

  it('every arc of the play: live, every hour of the replay, or the still picture once it stops', () => {
    expect(planDrawnArcs(plan('live'), false).map((d) => d.arc.key)).toEqual([
      'DE:exploit:blocked',
    ]);
    expect(planDrawnArcs(plan('replay'), false).map((d) => d.arc.country)).toEqual(['BR', 'SG']);
    expect(planDrawnArcs(plan('replay'), true).map((d) => d.arc.country)).toEqual(['SG', 'BR']);
    expect(planDrawnArcs(plan('still'), false)).toEqual([]);
  });

  it("each source country's glow: its events in the arcs on the map against the most (log scale)", () => {
    const heat = heatByCountry(
      drawnArcs([arc('DE', 1, 0, 90), arc('DE', 0, 1, 10), arc('BR', 2, 0, 5)]),
    );
    expect([...heat.keys()]).toEqual(['DE', 'BR']);
    expect(heat.get('DE')).toBe(1);
    expect(heat.get('BR')).toBe(heatOf(5, 100));
    expect(heatByCountry([]).size).toBe(0);
  });
});

describe("the sources' labels", () => {
  const whole = (floors: string[]) => ({ whole: { floors } }) as unknown as SecurityMapWholeRead;

  it('the top five sources by their events, with the country name and the count', () => {
    const drawn = drawnArcs([
      arc('DE', 1, 0, 9),
      arc('DE', 0, 0, 3),
      arc('BR', 1, 0, 20),
      arc('US', 1, 0, 1),
      arc('JP', 1, 0, 2),
      arc('IN', 1, 0, 4),
      arc('FR', 1, 0, 5),
      arc('QY', 1, 0, 99),
    ]);
    const labels = sourceLabels(drawn, whole([]));
    expect(SOURCE_LABELS).toBe(5);
    expect(labels.map((l) => [l.code, l.name, l.count])).toEqual([
      ['BR', 'Brazil', '20'],
      ['DE', 'Germany', '12'],
      ['FR', 'France', '5'],
      ['IN', 'India', '4'],
      ['JP', 'Japan', '2'],
    ]);
    expect(labels[0]!.from).toEqual(countryPoint('BR'));
  });

  it('"at least" where the newest whole read counts that kind and outcome as a floor', () => {
    const drawn = drawnArcs([arc('DE', 1, 0, 9), arc('DE', 0, 1, 3), arc('BR', 0, 0, 2)]);
    const labels = sourceLabels(drawn, whole(['totals.password_guessing.flagged']));
    expect(labels.map((l) => l.count)).toEqual(['at least 12', '2']);
    expect(sourceLabels(drawn, null).map((l) => l.count)).toEqual(['12', '2']);
  });
});

describe('the ticker: the newest entry the stage draws', () => {
  const MIN = 60_000;
  const T0 = Date.parse('2026-11-23T10:00:00.000Z');
  const at = (m: number) => new Date(T0 + m * MIN).toISOString();
  const row = (
    key: string,
    minute: number,
    category: number,
    outcome: 0 | 1 | 2,
    country: string | null,
    source = 'web',
  ): SecurityMapFeedRow => [
    key,
    at(minute),
    1,
    false,
    category,
    outcome,
    'Example reason',
    source,
    country,
    'Example City',
    null,
    null,
    1,
  ];
  const drawn = drawnArcs([arc('DE', 1, 0, 5), arc('BR', 0, 1, 2)]);
  const live = { fromMs: T0, toMs: Number.POSITIVE_INFINITY };

  it('the newest entry whose country, kind and outcome is an arc on the stage', () => {
    const rows = [
      row('a', 3, 1, 0, 'DE'),
      row('b', 5, 0, 1, 'BR'),
      row('c', 7, 1, 1, 'DE'),
      row('d', 8, 2, 0, 'SG'),
    ];
    expect(tickerRowOf(rows, drawn, live, true)?.[0]).toBe('b');
  });

  it('never an allowed entry, one with no place, one before the span drawn, or a late source in the live play', () => {
    const rows = [
      row('allowed', 9, 1, 2, 'DE'),
      row('no-place', 9, 1, 0, null),
      row('phone', 9, 1, 0, 'DE', 'phone'),
      row('old', -5, 1, 0, 'DE'),
    ];
    expect(tickerRowOf(rows, drawn, live, true)).toBeNull();
    // A replay draws the late sources' events: the phone entry is in its hour.
    expect(tickerRowOf(rows, drawn, { fromMs: T0, toMs: T0 + 60 * MIN }, false)?.[0]).toBe('phone');
  });

  it('nothing drawn, or no span: no entry', () => {
    const rows = [row('a', 3, 1, 0, 'DE')];
    expect(tickerRowOf(rows, [], live, true)).toBeNull();
    expect(tickerRowOf(rows, drawn, null, true)).toBeNull();
  });

  it("the span the stage draws: the replay's hour, the live play's ten minutes, the still replay's whole window", () => {
    const replay = plan('replay');
    expect(stageSpan(replay, stageOf(replay, null, 1), null)).toEqual({ fromMs: 1, toMs: 2 });
    expect(stageSpan(plan('live'), stageOf(plan('live'), null, 0), at(0))).toEqual(live);
    expect(stageSpan(plan('live'), stageOf(plan('live'), null, 0), null)).toBeNull();
    expect(stageSpan(replay, stageOf(replay, 'paused', 0), null)).toEqual({
      fromMs: Number.NEGATIVE_INFINITY,
      toMs: Number.POSITIVE_INFINITY,
    });
    expect(stageSpan(plan('still'), stageOf(plan('still'), null, 0), at(0))).toBeNull();
  });
});

describe('a WebGL 2 context, asked for before three.js is loaded', () => {
  const canvas = (gl: unknown) => () => ({ getContext: () => gl }) as unknown as HTMLCanvasElement;

  it('none: the flat map; one: the globe, and the test context is given back at once', () => {
    expect(webglAvailable(canvas(null))).toBe(false);
    let lost = 0;
    const gl = { getExtension: () => ({ loseContext: () => (lost += 1) }) };
    expect(webglAvailable(canvas(gl))).toBe(true);
    expect(lost).toBe(1);
    const throws = () => {
      throw new Error('no canvas');
    };
    expect(webglAvailable(throws as unknown as () => HTMLCanvasElement)).toBe(false);
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
  /** All well: the server's first read at T, no midnight in sight and no replay just begun. */
  const WELL = {
    lastPollAt: T,
    lastWholeAt: T,
    lastWholeTryAt: T,
    failures: 0,
    wholeFailures: 0,
    dayEndsAt: null,
    wholeWanted: false,
    dayUnread: false,
  } as const;

  it("right after the page opens the whole window is read again at once, with the viewer's day (Q22)", () => {
    // The server's first read could not carry the viewer's midnight.
    expect(nextPoll({ ...WELL, dayUnread: true }, T + 5)).toEqual({ scope: 'whole', at: T + 5 });
    // After a failed read it waits out the back-off; after a failed whole read, its own.
    expect(nextPoll({ ...WELL, dayUnread: true, failures: 1 }, T + 5)).toEqual({
      scope: 'whole',
      at: T + 60_000,
    });
    expect(
      nextPoll(
        { ...WELL, dayUnread: true, wholeFailures: 1, failures: 1, lastWholeTryAt: T },
        T + 5,
      ),
    ).toEqual({ scope: 'recent', at: T + 60_000 });
  });

  it("once a whole read has carried the viewer's day: the last ten minutes, 30 seconds on", () => {
    expect(nextPoll(WELL, T)).toEqual({ scope: 'recent', at: T + 30_000 });
    // No read at all yet: the last ten minutes at once.
    expect(nextPoll({ ...WELL, lastPollAt: null }, T)).toEqual({ scope: 'recent', at: T });
  });

  it('then the last ten minutes every 30 seconds, and the whole window in their place every 5 minutes', () => {
    const whole = T + SECURITY_MAP_WHOLE_POLL_MS;
    expect(nextPoll({ ...WELL, lastPollAt: whole - 10_000 }, T)).toEqual({
      scope: 'whole',
      at: whole,
    });
    expect(nextPoll({ ...WELL, lastPollAt: whole - 40_000 }, T)).toEqual({
      scope: 'recent',
      at: whole - 10_000,
    });
  });

  it('after failed reads the wait grows, 60 then 120 seconds, and nothing is sent sooner', () => {
    expect(nextPoll({ ...WELL, failures: 1 }, T)).toEqual({ scope: 'recent', at: T + 60_000 });
    expect(nextPoll({ ...WELL, failures: 5 }, T)).toEqual({ scope: 'recent', at: T + 120_000 });
    // A whole read that is overdue still waits out the back-off.
    expect(nextPoll({ ...WELL, lastWholeAt: T - 3_600_000, failures: 2 }, T)).toEqual({
      scope: 'whole',
      at: T + 120_000,
    });
  });

  it('after a failed read of the whole window the next waits 2, 4, 8, then 10 minutes from that attempt; the last ten minutes go on in between', () => {
    const failed = { ...WELL, lastWholeAt: T - 600_000, wholeFailures: 1, failures: 1 };
    // The next read is the last ten minutes, after the ordinary back-off, never the whole window again.
    expect(nextPoll(failed, T)).toEqual({ scope: 'recent', at: T + 60_000 });
    // A good read of the last ten minutes since: they go on every 30 seconds.
    const going = { ...failed, failures: 0, lastPollAt: T + 60_000 };
    expect(nextPoll(going, T + 60_000)).toEqual({ scope: 'recent', at: T + 90_000 });
    expect(nextPoll({ ...going, lastPollAt: T + 100_000 }, T + 100_000)).toEqual({
      scope: 'whole',
      at: T + 120_000,
    });
    for (const [wholeFailures, wait] of [
      [2, 240_000],
      [3, 480_000],
      [4, 600_000],
      [9, 600_000],
    ] as const) {
      const clock = { ...going, wholeFailures, lastPollAt: T + wait - 10_000 };
      expect(nextPoll(clock, T), String(wholeFailures)).toEqual({ scope: 'whole', at: T + wait });
    }
    // Not one whole read in a row: run the old way for an hour, the count is the back-off's.
    let clock: Parameters<typeof nextPoll>[0] = { ...going, lastPollAt: T };
    let now = T;
    const whole: number[] = [];
    while (now < T + 3_600_000) {
      const step = nextPoll(clock, now);
      now = step.at;
      if (step.scope === 'whole') {
        whole.push(now - T);
        clock = {
          ...clock,
          lastPollAt: now,
          lastWholeTryAt: now,
          wholeFailures: clock.wholeFailures + 1,
        };
      } else {
        clock = { ...clock, lastPollAt: now };
      }
    }
    expect(whole.slice(0, 5)).toEqual([120_000, 360_000, 840_000, 1_440_000, 2_040_000]);
    expect(whole.length).toBeLessThanOrEqual(7);
  });

  it('no good read of the whole window yet: the last ten minutes run alone', () => {
    const none = { ...WELL, lastWholeAt: null, wholeFailures: 1 };
    expect(nextPoll(none, T)).toEqual({ scope: 'recent', at: T + 30_000 });
    expect(nextPoll({ ...none, lastPollAt: T + 100_000 }, T + 100_000)).toEqual({
      scope: 'whole',
      at: T + 120_000,
    });
  });

  it("at the viewer's midnight the whole window is read, even between the 30-second reads", () => {
    expect(nextPoll({ ...WELL, dayEndsAt: T + 10_000 }, T)).toEqual({
      scope: 'whole',
      at: T + 10_000,
    });
    // A midnight later than the 5-minute read changes nothing.
    expect(nextPoll({ ...WELL, dayEndsAt: T + SECURITY_MAP_WHOLE_POLL_MS + 1 }, T)).toEqual({
      scope: 'recent',
      at: T + 30_000,
    });
    // After failed reads the midnight read waits out the back-off too.
    expect(nextPoll({ ...WELL, failures: 2, dayEndsAt: T + 10_000 }, T)).toEqual({
      scope: 'whole',
      at: T + 120_000,
    });
    // And after a failed read of the whole window, its own.
    expect(nextPoll({ ...WELL, wholeFailures: 1, dayEndsAt: T + 10_000 }, T)).toEqual({
      scope: 'recent',
      at: T + 30_000,
    });
  });

  it('the replay just begun on an old read: the whole window at once (after the back-offs when reads fail)', () => {
    const clock = {
      ...WELL,
      lastWholeAt: T - 90_000,
      lastWholeTryAt: T - 90_000,
      wholeWanted: true,
    };
    expect(nextPoll(clock, T + 5)).toEqual({ scope: 'whole', at: T + 5 });
    expect(nextPoll({ ...clock, failures: 1 }, T + 5)).toEqual({ scope: 'whole', at: T + 60_000 });
    // A failed whole read a moment ago: its own back-off, the replay does not hurry it.
    expect(nextPoll({ ...clock, wholeFailures: 1, lastWholeTryAt: T }, T + 5)).toEqual({
      scope: 'recent',
      at: T + 30_000,
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
  it("the viewer's choice when the globe can be drawn (under reduced motion too: it is drawn still)", () => {
    expect(viewShown('globe', 'ok')).toEqual({
      view: 'globe',
      globeOffered: true,
      note: null,
    });
    expect(viewShown('flat', 'ok')).toEqual({
      view: 'flat',
      globeOffered: true,
      note: null,
    });
  });

  it('a globe that cannot be drawn, or stopped drawing: the flat map, and one plain sentence', () => {
    expect(viewShown('globe', 'unavailable')).toEqual({
      view: 'flat',
      globeOffered: false,
      note: SECURITY_MAP_WORDS.globeUnavailable,
    });
    expect(viewShown('globe', 'lost')).toEqual({
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
