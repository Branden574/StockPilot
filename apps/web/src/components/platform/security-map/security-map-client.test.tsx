import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SECURITY_EVENT_CATEGORIES,
  SECURITY_MAP_MARK_WORDS,
  SECURITY_MAP_POLL_FAILED,
  SECURITY_MAP_POLL_REFUSED,
  SECURITY_MAP_REPLAY_STEP_MS,
  SECURITY_MAP_WORDS,
  securityEventCategoryLabel,
  securityEventSourceLabel,
  securityMapViewOf,
  type SecurityMapAnswer,
} from '@stockpilot/core';

/**
 * THE ATTACK MAP'S ISLAND, in the browser (the globe itself is a stub here:
 * WebGL cannot run in the test environment; globe-math.test.ts holds its
 * arithmetic).
 *
 * Security invariant. Pinned: the categories the map does not show
 * (Phishing, Malware) are never drawn, listed in the legend or the table, and
 * their events are one line of words; flagged is a different mark from
 * blocked (a dashed line and a hollow mark) and is called "flagged, not
 * blocked" in words; a flagged sum says "at least"; an organization's name
 * that looks like markup is put on the page as plain text; after two failed
 * reads the page says "Not updating since" and nothing moves; a refused read
 * says "Sign in again" and nothing moves; the first read carries the
 * viewer's day start, then the last ten minutes every 30 seconds and the
 * whole window every 5 minutes, at the viewer's midnight and when the replay
 * begins on an old read, never while the tab is hidden; a read of the last
 * ten minutes never replaces the window's table; a shortened window says so
 * and is never labelled as the whole one; a number the database calls a
 * floor says "at least", and no other; the flagged list beside the map shows
 * flagged entries only, with the hollow mark, city and country and nothing
 * else of where; reduced motion shows the flat map, still; a globe that
 * cannot be drawn, or loses its context, gives way to the flat map with one
 * plain sentence. Made-up data only.
 */

const h = vi.hoisted(() => ({
  globeProps: [] as Array<Record<string, unknown>>,
  globeFails: null as null | 'unavailable' | 'lost',
}));

vi.mock('@/server/actions/platform/security-map', () => ({
  pollPlatformSecurityMapAction: vi.fn(async () => {
    throw new Error('the test hands its own poll');
  }),
}));

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({
      href,
      prefetch,
      children,
      className,
    }: {
      href: string;
      prefetch?: boolean | null;
      children: React.ReactNode;
      className?: string;
    }) =>
      React.createElement('a', { href, className, 'data-prefetch': String(prefetch) }, children),
  };
});

vi.mock('./security-map-globe', async () => {
  const React = await import('react');
  return {
    SecurityMapGlobe: (props: Record<string, unknown>) => {
      h.globeProps.push(props);
      React.useEffect(() => {
        if (h.globeFails === 'unavailable') (props.onUnavailable as () => void)();
        if (h.globeFails === 'lost') (props.onLost as () => void)();
      }, [props.onUnavailable, props.onLost]);
      return React.createElement('canvas', { 'data-testid': 'globe-stub', 'aria-hidden': 'true' });
    },
  };
});

import { CATEGORY_LOOKS } from './map-model';
import { SecurityMapClient } from './security-map-client';

/* ───────────────────────────── made-up answers ───────────────────────────── */

const ORG = '5eed0000-0001-4000-8000-0000000000c1';
const MARKUP_NAME = '<img src=x onerror=alert(1)> Example "Academy" & Co';

const zeros = () =>
  Object.fromEntries(
    SECURITY_EVENT_CATEGORIES.map((c) => [c, { blocked: 0, flagged: 0, allowed: 0 }]),
  ) as SecurityMapAnswer['totals'];

function answer(over: Partial<SecurityMapAnswer> = {}): SecurityMapAnswer {
  const totals = zeros();
  totals.exploit.blocked = 17;
  totals.password_guessing.flagged = 3;
  totals.bots.blocked = 40;
  totals.phishing.flagged = 2;
  return {
    window: {
      from: '2026-11-22T22:00:00+00:00',
      to: '2026-11-23T22:00:00+00:00',
      live_from: '2026-11-23T21:50:00+00:00',
      asked_from: '2026-11-22T22:00:00+00:00',
    },
    window_shortened: false,
    short_window: false,
    refused: null,
    generated_at: '2026-11-23T22:00:00+00:00',
    oldest_event_at: '2026-11-01T00:00:00+00:00',
    timeline: [
      cell('2026-11-23T10:10:00+00:00', 600, 'DE', 'exploit', 'blocked', 12),
      cell('2026-11-23T10:20:00+00:00', 600, 'BR', 'password_guessing', 'flagged', 3),
      cell('2026-11-23T14:00:00+00:00', 600, 'SG', 'bots', 'blocked', 40),
      cell('2026-11-23T14:10:00+00:00', 600, 'US', 'phishing', 'flagged', 2),
    ],
    timeline_truncated: false,
    by_country: [
      { country: 'SG', category: 'bots', outcome: 'blocked', events: 40 },
      { country: 'DE', category: 'exploit', outcome: 'blocked', events: 12 },
      { country: 'QZ', category: 'exploit', outcome: 'blocked', events: 5 },
      { country: 'BR', category: 'password_guessing', outcome: 'flagged', events: 3 },
      { country: 'US', category: 'phishing', outcome: 'flagged', events: 2 },
    ],
    by_country_truncated: false,
    totals,
    no_place: zeros(),
    blocked_window: 57,
    flagged_window: 5,
    allowed_window: 0,
    day_start: null,
    blocked_since_day_start: null,
    blocked_since_day_start_partial: false,
    floors: ['flagged_window', 'totals.phishing.flagged'],
    feed: [
      feedEntry({ organization_id: ORG, organization_name: MARKUP_NAME }),
      feedEntry({
        minute: '2026-11-23T21:40:00+00:00',
        category: 'phishing',
        outcome: 'flagged',
        reason: 'sign_in_new_country',
        country: 'US',
        city: 'Example Falls',
      }),
    ],
    flagged_feed: [
      feedEntry({
        minute: '2026-11-23T21:44:00+00:00',
        category: 'password_guessing',
        outcome: 'flagged',
        reason: 'sign_in_alerts_held',
        source: 'api',
        country: 'GB',
        city: 'Example Borough',
        events: 4,
        at_least: true,
        organization_id: ORG,
        organization_name: 'Example Hidden Academy',
        organizations: 1,
      }),
      feedEntry({
        minute: '2026-11-23T21:40:00+00:00',
        category: 'phishing',
        outcome: 'flagged',
        reason: 'sign_in_new_country',
        country: 'US',
        city: 'Example Falls',
      }),
    ],
    late_sources: [],
    tallies: [],
    flood_rows: [],
    ...over,
  };
}

function cell(
  bucket_start: string,
  bucket_seconds: 600 | 60,
  country: string,
  category: SecurityMapAnswer['timeline'][number]['category'],
  outcome: 'blocked' | 'flagged' | 'allowed',
  events: number,
) {
  return { bucket_start, bucket_seconds, country, category, outcome, events };
}

function feedEntry(over: Partial<SecurityMapAnswer['feed'][number]> = {}) {
  return {
    minute: '2026-11-23T21:58:00+00:00',
    category: 'exploit' as const,
    outcome: 'blocked' as const,
    reason: 'env_file',
    source: 'web' as const,
    country: 'DE',
    city: 'Example Town',
    events: 12,
    at_least: false,
    organization_id: null,
    organization_name: null,
    organizations: 0,
    ...over,
  };
}

/** A whole read that counts the day the poll asked for, as the database does. */
const dayRead =
  (over: Partial<SecurityMapAnswer> = {}) =>
  (input: unknown) => {
    const { dayStart } = input as { dayStart: string | null };
    return wholeRead(answer({ day_start: dayStart, blocked_since_day_start: 9, ...over }));
  };

const wholeRead = (a: SecurityMapAnswer = answer()) => ({
  ok: true,
  view: securityMapViewOf(a, 'whole'),
  refusedWindow: null,
});
const recentRead = (a: SecurityMapAnswer) => ({
  ok: true,
  view: securityMapViewOf(a, 'recent'),
  refusedWindow: null,
});
/** The live play: one-minute cells in the last ten minutes. */
const liveAnswer = () =>
  answer({
    generated_at: '2026-11-23T22:00:30+00:00',
    window: {
      from: '2026-11-23T21:50:30+00:00',
      to: '2026-11-23T22:00:30+00:00',
      live_from: '2026-11-23T21:50:30+00:00',
      asked_from: '2026-11-23T21:50:30+00:00',
    },
    short_window: true,
    timeline: [cell('2026-11-23T21:59:00+00:00', 60, 'CN', 'exploit', 'blocked', 4)],
    by_country: [],
    flagged_feed: [],
  });
/** A read of the last ten minutes with nothing in them: the play turns to the replay. */
const quietAnswer = () => answer({ ...liveAnswer(), timeline: [], feed: [] });

/* ─────────────────────────────── the browser ─────────────────────────────── */

let reduced = false;
const motionListeners = new Set<() => void>();
let visibility: 'visible' | 'hidden' = 'visible';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-11-23T22:00:05Z'));
  h.globeProps = [];
  h.globeFails = null;
  reduced = false;
  motionListeners.clear();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query.includes('reduced-motion') ? reduced : false;
    },
    media: query,
    addEventListener: (_: string, fn: () => void) => motionListeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => motionListeners.delete(fn),
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  vi.useRealTimers();
});

/** Lets the timers run and the reads land. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function mount(poll: (input: unknown) => Promise<unknown>, initial: unknown = wholeRead()) {
  const spy = vi.fn(poll);
  const view = render(<SecurityMapClient initial={initial} poll={spy} />);
  return { spy, ...view };
}

const lastGlobe = () => h.globeProps[h.globeProps.length - 1]!;
const today = () =>
  screen.getByText('Blocked since midnight, your time').parentElement!.querySelector('dd')!
    .textContent;
const chooseFlat = () =>
  fireEvent.click(screen.getByRole('button', { name: SECURITY_MAP_WORDS.flat }));

/* ────────────────────────────────── tests ────────────────────────────────── */

describe('the reads', () => {
  it("the first read is the whole window with the viewer's day start, at once; then the last ten minutes every 30 seconds; the whole window every 5 minutes", async () => {
    const { spy } = mount(async (input) =>
      (input as { scope: string }).scope === 'whole' ? dayRead()(input) : recentRead(liveAnswer()),
    );
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(1);
    const first = spy.mock.calls[0]![0] as { scope: string; dayStart: string };
    expect(first.scope).toBe('whole');
    expect(new Date(first.dayStart).getHours()).toBe(0);
    await advance(30_000);
    expect(spy.mock.calls[1]![0]).toEqual({ scope: 'recent', dayStart: null });
    // Each read is scheduled when the one before it has landed.
    for (let i = 0; i < 9; i += 1) await advance(30_000);
    expect(spy.mock.calls.map((c) => (c[0] as { scope: string }).scope)).toEqual([
      'whole',
      'recent',
      'recent',
      'recent',
      'recent',
      'recent',
      'recent',
      'recent',
      'recent',
      'recent',
      'whole',
    ]);
  });

  it("the day's counter: 'Not counted yet' until the read with the day start lands, then its number", async () => {
    let release: (v: unknown) => void = () => {};
    const { spy } = mount(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    expect(today()).toBe('Not counted yet');
    await advance(0);
    await act(async () => {
      release(dayRead()(spy.mock.calls[0]![0]));
    });
    expect(today()).toBe('9');
  });

  it("the whole window is read again at the viewer's midnight, with the new day, between the 30-second reads", async () => {
    vi.setSystemTime(new Date(2026, 10, 23, 23, 57, 50));
    const { spy } = mount(async (input) =>
      (input as { scope: string }).scope === 'whole' ? dayRead()(input) : recentRead(liveAnswer()),
    );
    await advance(0);
    for (let i = 0; i < 4; i += 1) await advance(30_000);
    expect(today()).toBe('9');
    // 23:59:50 was the last read; midnight is 10 seconds on, before the next 30-second read.
    await advance(10_000);
    const calls = spy.mock.calls.map((c) => c[0] as { scope: string; dayStart: string | null });
    expect(calls.map((c) => c.scope)).toEqual([
      'whole',
      'recent',
      'recent',
      'recent',
      'recent',
      'whole',
    ]);
    expect(new Date(calls[0]!.dayStart!).getDate()).toBe(23);
    const next = new Date(calls[5]!.dayStart!);
    expect([next.getDate(), next.getHours(), next.getMinutes()]).toEqual([24, 0, 0]);
    expect(today()).toBe('9');
  });

  it("past midnight, before the new day is read, the day's counter says 'Not counted yet', never the old day's number", async () => {
    vi.setSystemTime(new Date(2026, 10, 23, 23, 59, 45));
    let wholeReads = 0;
    mount(async (input) => {
      if ((input as { scope: string }).scope !== 'whole') return recentRead(liveAnswer());
      wholeReads += 1;
      return wholeReads === 1 ? dayRead()(input) : SECURITY_MAP_POLL_FAILED;
    });
    await advance(0);
    expect(today()).toBe('9');
    await advance(15_000);
    expect(wholeReads).toBe(2);
    expect(today()).toBe('Not counted yet');
  });

  it('the whole window is read again at once when the replay begins on a read more than a minute old; not again while it goes on', async () => {
    let recentReads = 0;
    const { spy } = mount(async (input) => {
      if ((input as { scope: string }).scope === 'whole') return dayRead()(input);
      recentReads += 1;
      return recentRead(recentReads <= 2 ? liveAnswer() : quietAnswer());
    });
    const scopes = () => spy.mock.calls.map((c) => (c[0] as { scope: string }).scope);
    await advance(0);
    await advance(30_000);
    await advance(30_000);
    expect(lastGlobe().timing).toBe('live');
    // 90 seconds after the whole read, the last ten minutes come back empty: the replay begins.
    await advance(30_000);
    await advance(0);
    expect(scopes()).toEqual(['whole', 'recent', 'recent', 'recent', 'whole']);
    expect(lastGlobe().timing).toBe('replay');
    for (let i = 0; i < 4; i += 1) await advance(30_000);
    expect(scopes()).toEqual([
      'whole',
      'recent',
      'recent',
      'recent',
      'whole',
      'recent',
      'recent',
      'recent',
      'recent',
    ]);
  });

  it('a replay that begins within a minute of the last whole read asks for nothing more', async () => {
    // The whole window's own last ten minutes hold an arc: the play starts live.
    const liveWhole = {
      timeline: [
        ...answer().timeline,
        cell('2026-11-23T21:59:00+00:00', 60, 'CN', 'exploit', 'blocked', 4),
      ],
    };
    const { spy } = mount(
      async (input) =>
        (input as { scope: string }).scope === 'whole'
          ? dayRead(liveWhole)(input)
          : recentRead(quietAnswer()),
      wholeRead(answer(liveWhole)),
    );
    await advance(0);
    expect(lastGlobe().timing).toBe('live');
    // 30 seconds after the whole read the last ten minutes are empty: the replay, on a fresh read.
    await advance(30_000);
    await advance(0);
    expect(lastGlobe().timing).toBe('replay');
    await advance(30_000);
    expect(spy.mock.calls.map((c) => (c[0] as { scope: string }).scope)).toEqual([
      'whole',
      'recent',
      'recent',
    ]);
  });

  it('never reads while the tab is hidden; an overdue read goes at once when it comes back', async () => {
    const { spy } = mount(async () => wholeRead());
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(1);
    visibility = 'hidden';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await advance(5 * 60_000);
    expect(spy).toHaveBeenCalledTimes(1);
    visibility = 'visible';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('one read at a time: a slow read holds the next one back', async () => {
    const { spy } = mount(() => new Promise(() => {}));
    await advance(10 * 60_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('one read at a time: a tab hidden and shown while a read is out sends no second read', async () => {
    const { spy } = mount(() => new Promise(() => {}));
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(1);
    visibility = 'hidden';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    visibility = 'visible';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await advance(10 * 60_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a read of the last ten minutes never replaces the window's table or numbers", async () => {
    mount(async (input) =>
      (input as { scope: string }).scope === 'whole' ? wholeRead() : recentRead(liveAnswer()),
    );
    await advance(0);
    await advance(30_000);
    expect(lastGlobe().timing).toBe('live');
    const table = screen.getByRole('region', { name: 'Blocked and flagged events by country' });
    expect(within(table).getByText('Singapore')).toBeInTheDocument();
    expect(screen.getByText('Blocked, last 24 hours').parentElement!.textContent).toContain('57');
  });
});

describe('what is never drawn or listed', () => {
  it('the hidden categories are not in the legend, the table, the feed or the drawing; their events are one line of words', async () => {
    mount(async () => wholeRead());
    const legend = screen.getAllByRole('listitem').filter((li) => li.hasAttribute('data-legend'));
    expect(legend.map((li) => li.getAttribute('data-legend'))).toEqual([
      'password_guessing',
      'exploit',
      'bots',
    ]);
    const text = document.body.textContent ?? '';
    expect(text).not.toContain(securityEventCategoryLabel('phishing'));
    expect(text).not.toContain(securityEventCategoryLabel('malware'));
    expect(
      screen.getByText(
        'Not drawn: at least 2 flagged sign-in alerts. They are on the Security page.',
      ),
    ).toBeInTheDocument();
    // The drawing: no arc of a hidden category, in either view.
    for (const props of h.globeProps) {
      const arcs = props.arcs as Array<{ arc: { category: string } }>;
      expect(arcs.every((a) => a.arc.category !== 'phishing' && a.arc.category !== 'malware')).toBe(
        true,
      );
    }
    chooseFlat();
    expect(document.querySelectorAll('[data-arc^="US:phishing"]')).toHaveLength(0);
  });

  it('a code with no point is in the table, said as not on the map, and never drawn', async () => {
    mount(async () => wholeRead());
    const table = screen.getByRole('region', { name: 'Blocked and flagged events by country' });
    expect(within(table).getByText('Not on the map: no point for this code')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Not on the map: 5 events come from a place the map has no point for (QZ). They are in the table.',
      ),
    ).toBeInTheDocument();
    chooseFlat();
    expect(document.querySelectorAll('[data-arc^="QZ:"]')).toHaveLength(0);
  });
});

describe('flagged against blocked', () => {
  it('in words: the counters, the legend and the table say "flagged, not blocked"; a flagged sum the database calls a floor says "at least"', () => {
    mount(async () => wholeRead());
    const flagged = screen.getByText('Flagged, last 24 hours').parentElement!;
    expect(flagged.textContent).toContain('at least 5');
    expect(flagged.textContent).toContain('flagged, not blocked');
    expect(screen.getByText(SECURITY_MAP_MARK_WORDS.blocked)).toBeInTheDocument();
    expect(screen.getByText(SECURITY_MAP_MARK_WORDS.flagged)).toBeInTheDocument();
    const table = screen.getByRole('region', { name: 'Blocked and flagged events by country' });
    expect(within(table).getByRole('columnheader', { name: 'Flagged, not blocked' })).toBeTruthy();
  });

  it('on the flat map: a flagged arc is dashed with a hollow mark, a blocked one solid with a filled mark', () => {
    reduced = true;
    mount(async () => wholeRead());
    const blocked = document.querySelector('[data-arc="DE:exploit:blocked"]')!;
    const flaggedArc = document.querySelector('[data-arc="BR:password_guessing:flagged"]')!;
    expect(blocked.querySelector('path')!.getAttribute('stroke-dasharray')).toBeNull();
    expect(blocked.querySelector('[data-mark]')!.getAttribute('data-mark')).toBe('filled');
    expect(flaggedArc.querySelector('path')!.getAttribute('stroke-dasharray')).not.toBeNull();
    expect(flaggedArc.querySelector('[data-mark]')!.getAttribute('data-mark')).toBe('hollow');
    // The mark itself, not only its label: hollow has no fill, filled has the colour.
    expect(flaggedArc.querySelector('[data-mark]')!.getAttribute('fill')).toBe('none');
    const blockedFill = blocked.querySelector('[data-mark]')!.getAttribute('fill');
    expect(blockedFill).toMatch(/^#[0-9a-f]{6}$/);
    expect(Number(flaggedArc.querySelector('path')!.getAttribute('stroke-width'))).toBeLessThan(
      Number(blocked.querySelector('path')!.getAttribute('stroke-width')),
    );
  });

  it('on the globe: each arc is handed over with its own outcome', () => {
    mount(async () => wholeRead());
    const arcs = lastGlobe().arcs as Array<{ arc: { key: string; outcome: string } }>;
    expect(arcs.map((a) => [a.arc.key, a.arc.outcome])).toEqual([
      ['DE:exploit:blocked', 'blocked'],
      ['BR:password_guessing:flagged', 'flagged'],
    ]);
  });
});

describe('a window the database shortened', () => {
  const shortened = () =>
    answer({
      window: {
        from: '2026-11-23T18:08:00+00:00',
        to: '2026-11-23T22:00:00+00:00',
        live_from: '2026-11-23T21:50:00+00:00',
        asked_from: '2026-11-22T22:00:00+00:00',
      },
      window_shortened: true,
    });

  it('says so in plain words, with the part read; the numbers are labelled with that part, never the whole day', () => {
    mount(async () => new Promise(() => {}), wholeRead(shortened()));
    const words = screen.getByTestId('security-map-shortened').textContent ?? '';
    expect(words).toMatch(
      /^Showing the last 3 hours 52 minutes only, from \d\d:\d\d, your time: there were too many events to count all of the last 24 hours\. Nothing before \d\d:\d\d is in these numbers\.$/,
    );
    expect(screen.getByText('Blocked, last 3 hours 52 minutes')).toBeInTheDocument();
    expect(screen.getByText('Flagged, last 3 hours 52 minutes')).toBeInTheDocument();
    expect(screen.queryByText('Blocked, last 24 hours')).toBeNull();
    expect(screen.getByTestId('security-map-mode').textContent).toMatch(
      /^Replay of the last 3 hours 52 minutes:/,
    );
  });

  it('a window read whole says nothing of the kind', () => {
    mount(async () => new Promise(() => {}));
    expect(screen.queryByTestId('security-map-shortened')).toBeNull();
    expect(screen.getByText('Blocked, last 24 hours')).toBeInTheDocument();
  });
});

describe('floors: "at least" where the database says, and nowhere else', () => {
  it('with no floors the same numbers are plain', () => {
    // No entry of either feed is a floor here either.
    mount(async () => new Promise(() => {}), wholeRead(answer({ floors: [], flagged_feed: [] })));
    const flagged = screen.getByText('Flagged, last 24 hours').parentElement!;
    expect(flagged.querySelector('dd')!.textContent).toBe('5');
    expect(
      screen.getByText('Not drawn: 2 flagged sign-in alerts. They are on the Security page.'),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('at least');
  });

  it('the blocked counter, the day counter and a table cell say "at least" when theirs are floors', () => {
    const a = answer({
      floors: ['blocked_window', 'blocked_since_day_start', 'totals.exploit.blocked'],
      day_start: '2026-11-23T08:00:00+00:00',
      blocked_since_day_start: 9,
    });
    mount(async () => new Promise(() => {}), wholeRead(a));
    expect(
      screen.getByText('Blocked, last 24 hours').parentElement!.querySelector('dd')!.textContent,
    ).toBe('at least 57');
    expect(
      screen.getByText('Flagged, last 24 hours').parentElement!.querySelector('dd')!.textContent,
    ).toBe('5');
    const legend = document.querySelector('[data-legend="exploit"]')!;
    expect(legend.textContent).toContain('at least 17 blocked');
  });

  it('a feed entry whose count is a floor says "at least" in its facts', () => {
    const a = answer({ feed: [feedEntry({ at_least: true, events: 12 })] });
    mount(async () => new Promise(() => {}), wholeRead(a));
    fireEvent.click(screen.getByRole('button', { name: /Request for a settings file/ }));
    expect(screen.getByText('at least 12')).toBeInTheDocument();
  });
});

describe('the flagged list beside the map', () => {
  const list = () => screen.getByTestId('security-map-flagged');
  const entries = () => [...list().querySelectorAll('[data-flagged-entry]')];

  it('lists the newest flagged entries with the hollow mark, what, city and country, time and count; nothing else', () => {
    mount(async () => new Promise(() => {}));
    expect(within(list()).getByText(SECURITY_MAP_WORDS.flaggedFeedTitle)).toBeInTheDocument();
    // The phishing entry is a kind the map does not show: never listed.
    expect(entries()).toHaveLength(1);
    const entry = entries()[0]!;
    expect(entry.textContent).toContain('Sign-in alerts held after too many in one day');
    expect(entry.textContent).toContain('Example Borough, United Kingdom');
    expect(entry.textContent).toContain('21:44 UTC');
    expect(entry.textContent).toContain('at least 4');
    // The same mark a flagged arc starts from: hollow, in its category's colour.
    const mark = entry.querySelector('svg path')!;
    expect(mark.getAttribute('fill')).toBe('none');
    expect(mark.getAttribute('stroke')).toBe(CATEGORY_LOOKS.password_guessing.hex);
    // Where is city and country only: no organization, no source, no link.
    expect(list().textContent).not.toContain('Example Hidden Academy');
    expect(list().textContent).not.toContain(securityEventSourceLabel('api'));
    expect(list().querySelector('a, button')).toBeNull();
    expect(list().textContent).not.toContain(securityEventCategoryLabel('phishing'));
  });

  it('it sits beside the map panel, in the same row', () => {
    mount(async () => new Promise(() => {}));
    const row = list().parentElement!;
    expect(row.className).toContain('lg:grid-cols-');
    expect(row.contains(screen.getByTestId('security-map-mode'))).toBe(true);
  });

  it('nothing flagged: one plain line', () => {
    mount(async () => new Promise(() => {}), wholeRead(answer({ flagged_feed: [] })));
    expect(entries()).toHaveLength(0);
    expect(within(list()).getByText(SECURITY_MAP_WORDS.flaggedFeedEmpty)).toBeInTheDocument();
  });

  it("a poll's flagged entries go first; the whole read's own are kept only before the poll's window", async () => {
    const flaggedAt = (minute: string, city: string) =>
      feedEntry({
        minute,
        category: 'password_guessing',
        outcome: 'flagged',
        reason: 'sign_in_alerts_held',
        country: 'GB',
        city,
        events: 1,
      });
    const whole = answer({
      flagged_feed: [
        flaggedAt('2026-11-23T21:55:00+00:00', 'Example Inside'),
        flaggedAt('2026-11-23T21:44:00+00:00', 'Example Before'),
      ],
    });
    const poll = answer({
      ...liveAnswer(),
      flagged_feed: [flaggedAt('2026-11-23T21:59:00+00:00', 'Example Newest')],
    });
    mount(
      async (input) =>
        (input as { scope: string }).scope === 'whole' ? wholeRead(whole) : recentRead(poll),
      wholeRead(whole),
    );
    await advance(0);
    await advance(30_000);
    expect(entries().map((e) => e.textContent!.match(/Example \w+/)![0])).toEqual([
      'Example Newest',
      'Example Before',
    ]);
    // The poll's numbers replace none of the whole read's.
    expect(
      screen.getByText('Blocked, last 24 hours').parentElement!.querySelector('dd')!.textContent,
    ).toBe('57');
  });
});

describe('when the page stops', () => {
  it('after two failed reads: "Not updating since HH:MM" and nothing moves', async () => {
    mount(async () => SECURITY_MAP_POLL_FAILED);
    await advance(0);
    expect(screen.queryByTestId('security-map-stop')).toBeNull();
    expect(lastGlobe().timing).toBe('replay');
    await advance(60_000);
    expect(screen.getByTestId('security-map-stop').textContent).toMatch(
      /^Not updating since \d\d:\d\d, your time\. The map is stopped and shows what was read then\.$/,
    );
    expect(lastGlobe().timing).toBe('still');
    expect(lastGlobe().mayTurn).toBe(false);
    chooseFlat();
    expect(document.querySelectorAll('.sm-head, .sm-pulse')).toHaveLength(0);
  });

  it('a refused read: "Sign in again" and nothing moves', async () => {
    mount(async () => SECURITY_MAP_POLL_REFUSED);
    await advance(0);
    expect(screen.getByTestId('security-map-stop').textContent).toMatch(/^Sign in again\./);
    expect(lastGlobe().timing).toBe('still');
    expect(lastGlobe().mayTurn).toBe(false);
  });

  it('a first read that failed: every number says "Could not check", never a zero', () => {
    mount(async () => new Promise(() => {}), SECURITY_MAP_POLL_FAILED);
    const values = [...document.querySelectorAll('[data-counter] dd')].map((d) => d.textContent);
    expect(values.filter((v) => v === 'Could not check')).toHaveLength(3);
    expect(values).not.toContain('0');
  });

  it('Pause stops the play and the turning; the reads go on', async () => {
    const { spy } = mount(async () => wholeRead());
    await advance(0);
    fireEvent.click(screen.getByRole('button', { name: SECURITY_MAP_WORDS.pause }));
    expect(screen.getByRole('button', { name: SECURITY_MAP_WORDS.play })).toBeInTheDocument();
    expect(screen.getByTestId('security-map-stop').textContent).toBe(
      'Paused. The numbers still update.',
    );
    expect(lastGlobe().timing).toBe('still');
    expect(lastGlobe().mayTurn).toBe(false);
    await advance(30_000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('a hidden tab stops the globe', () => {
    mount(async () => wholeRead());
    visibility = 'hidden';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(lastGlobe().hidden).toBe(true);
    expect(lastGlobe().timing).toBe('still');
  });
});

describe('the replay', () => {
  it('steps hour by hour, the label on the panel saying which hour', async () => {
    mount(async () => new Promise(() => {}));
    const label = () => screen.getByTestId('security-map-mode').textContent;
    expect(label()).toMatch(
      /^Replay of the last 24 hours: nothing in the last 10 minutes\. Now showing/,
    );
    const first = label();
    const firstArcs = (lastGlobe().arcs as unknown[]).length;
    await advance(SECURITY_MAP_REPLAY_STEP_MS);
    expect(label()).not.toBe(first);
    expect(firstArcs).toBe(2);
    expect((lastGlobe().arcs as unknown[]).length).toBe(1);
  });
});

describe('reduced motion and the globe', () => {
  it('reduced motion: the flat map, still, with the reason; the Globe choice is not offered', () => {
    reduced = true;
    mount(async () => wholeRead());
    expect(screen.queryByTestId('globe-stub')).toBeNull();
    expect(screen.getByTestId('security-map-flat')).toBeInTheDocument();
    expect(document.querySelectorAll('.sm-head, .sm-pulse')).toHaveLength(0);
    expect(screen.getByText(SECURITY_MAP_WORDS.globeReducedMotion)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: SECURITY_MAP_WORDS.globe })).toBeDisabled();
  });

  it('the setting changing while the page is open is followed', () => {
    mount(async () => wholeRead());
    expect(screen.getByTestId('globe-stub')).toBeInTheDocument();
    reduced = true;
    act(() => {
      for (const fn of motionListeners) fn();
    });
    expect(screen.queryByTestId('globe-stub')).toBeNull();
    expect(screen.getByTestId('security-map-flat')).toBeInTheDocument();
  });

  it('a globe that cannot be drawn gives way to the flat map with one plain sentence', () => {
    h.globeFails = 'unavailable';
    mount(async () => wholeRead());
    expect(screen.getByTestId('security-map-flat')).toBeInTheDocument();
    expect(screen.getByText(SECURITY_MAP_WORDS.globeUnavailable)).toBeInTheDocument();
  });

  it('a globe whose drawing context is lost gives way to the flat map with one plain sentence', () => {
    h.globeFails = 'lost';
    mount(async () => wholeRead());
    expect(screen.getByTestId('security-map-flat')).toBeInTheDocument();
    expect(screen.getByText(SECURITY_MAP_WORDS.globeLost)).toBeInTheDocument();
  });

  it('the drawing is hidden from screen readers; the table is the accessible version', () => {
    reduced = true;
    mount(async () => wholeRead());
    expect(screen.getByTestId('security-map-flat').closest('[aria-hidden="true"]')).not.toBeNull();
    expect(
      screen.getByRole('region', { name: 'Blocked and flagged events by country' }),
    ).toBeInTheDocument();
  });
});

describe('the feed', () => {
  it('an organization name that looks like markup is plain text', () => {
    mount(async () => wholeRead());
    fireEvent.click(screen.getAllByRole('button', { name: /Request for a settings file/ })[0]!);
    expect(screen.getByText(MARKUP_NAME, { exact: false })).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(document.body.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('an entry is a disclosure: aria-expanded, and its facts shown only when open', () => {
    mount(async () => wholeRead());
    const button = screen.getAllByRole('button', { name: /Request for a settings file/ })[0]!;
    const details = document.getElementById(button.getAttribute('aria-controls')!)!;
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(details.hidden).toBe(true);
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(details.hidden).toBe(false);
    const link = within(details).getByRole('link', { name: SECURITY_MAP_WORDS.openOrganization });
    expect(link).toHaveAttribute('href', `/platform/orgs/${ORG}`);
    expect(link).toHaveAttribute('data-prefetch', 'false');
  });

  it('is not a live region: an update is never announced', () => {
    mount(async () => wholeRead());
    expect(document.querySelector('[aria-live]')).toBeNull();
    expect(document.querySelector('[role="status"], [role="alert"], [role="log"]')).toBeNull();
  });
});
