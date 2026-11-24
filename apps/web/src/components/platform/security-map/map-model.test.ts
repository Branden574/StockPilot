// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  SECURITY_EVENT_CATEGORIES,
  SECURITY_MAP_EARLY_WHOLE_GAP_MS,
  SECURITY_MAP_WHOLE_POLL_MS,
  SECURITY_MAP_WORDS,
  dayStartInZone,
  securityMapArcOf,
  zonedParts,
  type SecurityMapFeedRow,
  type SecurityMapPlan,
  type SecurityMapWholeRead,
} from '@stockpilot/core';

import { facingOf, heatOf } from './globe-math';
import {
  CATEGORY_LOOKS,
  HIDDEN_KIND_LOOK,
  arcLookOf,
  SHAPE_INDEX,
  SOURCE_LABELS,
  countryName,
  drawnArcs,
  STAGE_MAX_PX,
  STAGE_MIN_PX,
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
  stageHeightFor,
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

  it('a flagged sign-in alert (no category) is handed to the globe grey, hollow and dashed, with no kind', () => {
    const alert = {
      key: 'PT:alert:flagged',
      country: 'PT',
      category: null,
      outcome: 'flagged' as const,
      events: 2,
      width: 1.23,
    };
    const [globe] = globeArcsOf(drawnArcs([alert]));
    expect(globe).toEqual({
      key: 'PT:alert:flagged',
      from: countryPoint('PT'),
      rgb: HIDDEN_KIND_LOOK.rgb,
      width: 1.23,
      flagged: true,
      shape: SHAPE_INDEX.triangle,
      events: 2,
    });
    expect(arcLookOf(null)).toBe(HIDDEN_KIND_LOOK);
    expect(arcLookOf('exploit')).toBe(CATEGORY_LOOKS.exploit);
    // It can be a labelled source: its country's name and count, "at least" from its own entries.
    expect(sourceLabels(drawnArcs([{ ...alert, atLeast: true }]), null)).toEqual([
      { code: 'PT', from: countryPoint('PT'), name: 'Portugal', count: 'at least 2' },
    ]);
    expect(JSON.stringify(globe)).not.toMatch(/phishing|malware/i);
  });

  it("the globe faces the drawn arcs' sources, each country weighed by the square root of its events", () => {
    const drawn = drawnArcs([arc('DE', 1, 0, 5), arc('DE', 0, 1, 4), arc('BR', 2, 0, 16)]);
    expect(focusOf(drawn)).toEqual(
      facingOf(
        [
          { lonLat: countryPoint('DE')!, weight: 3 },
          { lonLat: countryPoint('BR')!, weight: 4 },
        ],
        STOCKPILOT_LON_LAT,
      ),
    );
    // One loud country and one quiet one: weighed 7 to 1, not alike (that would
    // face between them) and not 49 to 1.
    const loud = focusOf(drawnArcs([arc('US', 0, 0, 49), arc('BR', 1, 0, 1)]));
    const weighed = (a: number, b: number) =>
      facingOf(
        [
          { lonLat: countryPoint('US')!, weight: a },
          { lonLat: countryPoint('BR')!, weight: b },
        ],
        STOCKPILOT_LON_LAT,
      );
    expect(loud).toEqual(weighed(7, 1));
    expect(loud).not.toEqual(weighed(1, 1));
    expect(loud).not.toEqual(weighed(49, 1));
    // Nothing to draw: StockPilot.
    expect(focusOf([])).toEqual(facingOf([], STOCKPILOT_LON_LAT));
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
  /**
   * All well: the server's first read at T, no midnight in sight and no
   * replay just begun. The page sent no whole read of its own yet (the
   * server's is not one it sent), so no start is on record.
   */
  const WELL = {
    lastPollAt: T,
    lastWholeAt: T,
    lastWholeTryAt: T,
    failures: 0,
    wholeFailures: 0,
    dayEndsAt: null,
    wholeWanted: false,
    dayUnread: false,
    totalsBehind: false,
    lastWholeStartAt: null,
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

  it('a poll brought events newer than the totals: the whole window early, never sooner than 45 s after the last whole read began', () => {
    // Quiet: the 5-minute rhythm, unchanged.
    expect(nextPoll({ ...WELL, lastPollAt: T + 30_000 }, T + 30_000)).toEqual({
      scope: 'recent',
      at: T + 60_000,
    });
    // Behind, and the last whole read began long enough ago: at once.
    expect(
      nextPoll(
        { ...WELL, lastPollAt: T + 30_000, totalsBehind: true, lastWholeStartAt: T - 60_000 },
        T + 30_000,
      ),
    ).toEqual({ scope: 'whole', at: T + 30_000 });
    // Behind, but the last whole read began 30 s ago: at its start plus 45 s.
    expect(
      nextPoll(
        { ...WELL, lastPollAt: T + 30_000, totalsBehind: true, lastWholeStartAt: T },
        T + 30_000,
      ),
    ).toEqual({ scope: 'whole', at: T + SECURITY_MAP_EARLY_WHOLE_GAP_MS });
    // The gap is 45 seconds.
    expect(SECURITY_MAP_EARLY_WHOLE_GAP_MS).toBe(45_000);
    // Behind never hurries a whole read past its back-off after a failure...
    const failed = { ...WELL, wholeFailures: 1, lastWholeTryAt: T, totalsBehind: true };
    expect(nextPoll(failed, T + 30_000)).toEqual({ scope: 'recent', at: T + 30_000 });
    // ...nor past the wait after a failed read of any kind.
    expect(
      nextPoll({ ...WELL, failures: 1, totalsBehind: true, lastWholeStartAt: T - 600_000 }, T + 5),
    ).toEqual({ scope: 'whole', at: T + 60_000 });
    // No start on record: at once.
    expect(nextPoll({ ...WELL, totalsBehind: true, lastWholeStartAt: null }, T + 7)).toEqual({
      scope: 'whole',
      at: T + 7,
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

  /* ── review M1 (2026-11-24): the floor on every whole read, and the midnight that never moved on ── */

  it("every whole read after the page's first waits until 45 s after the last one was sent, whatever asks for it", () => {
    // The page sent a whole read 1 s before T; it came back at T.
    const sent = { ...WELL, lastWholeStartAt: T - 1_000 };
    const floor = T - 1_000 + SECURITY_MAP_EARLY_WHOLE_GAP_MS;
    const asks = {
      'a midnight already past': { dayEndsAt: T - 60_000 },
      'the 5-minute read long overdue, as when a tab is shown again': {
        lastWholeAt: T - 3_600_000,
      },
      'events newer than the totals': { totalsBehind: true },
      "the replay's turn": { wholeWanted: true },
      'the day not read yet': { dayUnread: true },
    } as const;
    for (const [why, ask] of Object.entries(asks)) {
      // The last ten minutes first, 30 seconds on; the whole window no sooner than the floor.
      expect(nextPoll({ ...sent, ...ask }, T), why).toEqual({ scope: 'recent', at: T + 30_000 });
      expect(nextPoll({ ...sent, ...ask, lastPollAt: T + 30_000 }, T + 30_000), why).toEqual({
        scope: 'whole',
        at: floor,
      });
      // At the floor, at once.
      const step = nextPoll({ ...sent, ...ask, lastPollAt: T + 30_000 }, floor + 5);
      expect(step.scope, why).toBe('whole');
      expect(step.at, why).toBeGreaterThanOrEqual(floor);
      expect(step.at, why).toBeLessThanOrEqual(floor + 5);
    }
    // The page's own first whole read (right after it mounts, Q22) has no start before it: at once.
    expect(nextPoll({ ...WELL, dayUnread: true }, T + 5)).toEqual({ scope: 'whole', at: T + 5 });
    // A failed whole read's back-off is longer than the floor and is kept.
    expect(nextPoll({ ...sent, wholeFailures: 1, lastPollAt: T + 100_000 }, T + 100_000)).toEqual({
      scope: 'whole',
      at: T + 120_000,
    });
  });

  /**
   * The island's poll on the page's clock with the pure rules only, as
   * use-security-map-poll.ts keeps its state: every answer good, `latency` ms
   * after it was sent; when `busy`, every read of the last ten minutes brings
   * events newer than the totals; a whole read comes back with the day start
   * it was sent with, and the next midnight is worked out from that. Opened at
   * `from` with the server's read. No replay. Every send, until `to`.
   */
  function simulateDay(zone: string, from: number, to: number, busy: boolean, latency = 300) {
    let clock: Parameters<typeof nextPoll>[0] = {
      ...WELL,
      lastPollAt: from,
      lastWholeAt: from,
      lastWholeTryAt: from,
      dayUnread: true,
    };
    let counted: string | null = null;
    const sends: { scope: 'whole' | 'recent'; at: number; dayStart: string | null }[] = [];
    let now = from;
    while (now < to && sends.length < 20_000) {
      const dayEndsAt = counted === null ? null : nextLocalMidnight(counted, zone);
      const step = nextPoll({ ...clock, dayEndsAt }, now);
      const at = Math.max(step.at, now);
      const dayStart = step.scope === 'whole' ? localDayStart(new Date(at), zone) : null;
      sends.push({ scope: step.scope, at, dayStart });
      now = at + latency;
      if (step.scope === 'whole') {
        counted = dayStart;
        clock = {
          ...clock,
          lastPollAt: now,
          lastWholeAt: now,
          lastWholeTryAt: now,
          dayUnread: false,
          totalsBehind: false,
          lastWholeStartAt: at,
        };
      } else {
        clock = { ...clock, lastPollAt: now, totalsBehind: clock.totalsBehind || busy };
      }
    }
    return sends;
  }

  const dateIn = (ms: number, zone: string) => {
    const p = zonedParts(ms, zone);
    return Date.UTC(p.year, p.month - 1, p.day);
  };

  it.each([
    // Havana: 00:00 CST on 14 March 2027 is 01:00 CDT. Open from 17:00 on the 13th to 06:00 on the 15th.
    ['America/Havana', '2027-03-13T22:00:00Z', '2027-03-15T10:00:00Z', '2027-03-14T05:00:00.000Z'],
    // Santiago: 00:00 -04 on 5 September 2027 is 01:00 -03. From 17:00 on the 4th to 06:00 on the 6th.
    [
      'America/Santiago',
      '2027-09-04T21:00:00Z',
      '2027-09-06T09:00:00Z',
      '2027-09-05T04:00:00.000Z',
    ],
  ])(
    'a day and a half open in %s across the night the clocks skip midnight: no two whole reads under 45 s apart, the last ten minutes read between them, each day read from its first instant',
    (zone, fromIso, toIso, change) => {
      const from = Date.parse(fromIso);
      const to = Date.parse(toIso);
      for (const busy of [false, true]) {
        const sends = simulateDay(zone, from, to, busy);
        const label = `${zone}, ${busy ? 'a stream of new events' : 'quiet'}`;
        expect(sends[sends.length - 1]!.at, label).toBeGreaterThanOrEqual(to - 60_000);
        const wholes = sends.filter((s) => s.scope === 'whole');
        const gaps = wholes.slice(1).map((s, i) => s.at - wholes[i]!.at);
        expect(Math.min(...gaps), label).toBeGreaterThanOrEqual(SECURITY_MAP_EARLY_WHOLE_GAP_MS);
        // The short poll goes on: never two whole reads in a row.
        const inRow = sends.findIndex(
          (s, i) => i > 0 && s.scope === 'whole' && sends[i - 1]!.scope === 'whole',
        );
        expect(inRow, label).toBe(-1);
        // How many an hour: the 5-minute rhythm and a midnight when quiet; at most 80 under a stream.
        const perHour = new Map<number, number>();
        for (const s of wholes) {
          const hour = Math.floor((s.at - from) / 3_600_000);
          perHour.set(hour, (perHour.get(hour) ?? 0) + 1);
        }
        expect(Math.max(...perHour.values()), label).toBeLessThanOrEqual(busy ? 80 : 14);
        // Every whole read carries the first instant of the day it was sent in, there.
        for (const s of wholes) {
          const start = Date.parse(s.dayStart!);
          expect(start, label).toBeLessThanOrEqual(s.at);
          expect(dateIn(start, zone), label).toBe(dateIn(s.at, zone));
          expect(dateIn(start - 1, zone), label).toBeLessThan(dateIn(s.at, zone));
        }
        // The day the clocks skip midnight is read from the change itself, 01:00 on the clock.
        expect(
          wholes.some((s) => s.dayStart === change),
          label,
        ).toBe(true);
      }
    },
  );

  it('every zone this runtime knows, every day of 2027: the next midnight is later than now, at the day start and on its evening', () => {
    const faults: string[] = [];
    for (const zone of Intl.supportedValuesOf('timeZone')) {
      let start = dayStartInZone(Date.UTC(2027, 0, 1, 12), zone);
      for (let day = 0; day < 365 && faults.length < 5; day += 1) {
        const next = nextLocalMidnight(new Date(start).toISOString(), zone);
        // The day's last millisecond: its next midnight is the same one, still later than it.
        const evening = (next ?? Number.NaN) - 1;
        const after = Number.isFinite(evening)
          ? nextLocalMidnight(new Date(evening).toISOString(), zone)
          : null;
        if (next === null || !(next > start) || after !== next || !(after > evening)) {
          faults.push(
            `${zone} from ${new Date(start).toISOString()}: next ${next}, after ${after}`,
          );
          break;
        }
        start = next;
      }
    }
    expect(faults).toEqual([]);
  }, 60_000);

  it('should a zone ever answer a next midnight that is not later, the answer is looked for again an hour on, and on', async () => {
    // The fault the review found, made on purpose: the "next" day start answered as that same day's start.
    let fault: 'same day' | 'never later' = 'same day';
    vi.resetModules();
    vi.doMock('@stockpilot/core', async (importOriginal) => {
      const core = await importOriginal<typeof import('@stockpilot/core')>();
      return {
        ...core,
        nextDayStartInZone: (at: Date | number, zone: string) =>
          fault === 'same day' ? core.dayStartInZone(at, zone) : 0,
      };
    });
    try {
      const faulty = await import('./map-model');
      // 00:00 CST on 13 March 2027 in Havana: the first answer an hour on that is later is the 14th's start.
      const start = '2027-03-13T05:00:00.000Z';
      expect(new Date(faulty.nextLocalMidnight(start, 'America/Havana')!).toISOString()).toBe(
        '2027-03-14T05:00:00.000Z',
      );
      // A rule that never answers a later one: no time, never a midnight at or before the day start.
      fault = 'never later';
      expect(faulty.nextLocalMidnight(start, 'America/Havana')).toBeNull();
    } finally {
      vi.doUnmock('@stockpilot/core');
      vi.resetModules();
    }
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

describe("the stage's height (lab walk 2, F1)", () => {
  it('68% of the window from 420 to 760 px when the caption fits under it', () => {
    expect(stageHeightFor({ viewport: 1000, stageTop: 240, below: 40 })).toBe(680);
    expect(stageHeightFor({ viewport: 1400, stageTop: 240, below: 40 })).toBe(STAGE_MAX_PX);
    expect(stageHeightFor({ viewport: 500, stageTop: 240, below: 40 })).toBe(STAGE_MIN_PX);
  });

  it('shorter first, so the caption ends above the fold, 8 px to spare', () => {
    // 1440x900, live: the caption ends 42 px under the stage.
    expect(stageHeightFor({ viewport: 900, stageTop: 244, below: 42 })).toBe(606);
    // 1280x800, a replay with the longest sentences: 5 lines of caption.
    const h = stageHeightFor({ viewport: 800, stageTop: 244, below: 93 });
    expect(h).toBe(455);
    expect(244 + h + 93).toBeLessThanOrEqual(800 - 8);
  });

  it('never under 420 px: past that the caption falls below rather than the stage', () => {
    expect(stageHeightFor({ viewport: 700, stageTop: 244, below: 93 })).toBe(STAGE_MIN_PX);
    expect(STAGE_MIN_PX).toBe(420);
    expect(STAGE_MAX_PX).toBe(760);
  });
});
