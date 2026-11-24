import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SECURITY_EVENT_CATEGORIES,
  SECURITY_MAP_MARK_WORDS,
  SECURITY_MAP_POLL_FAILED,
  SECURITY_MAP_POLL_REFUSED,
  SECURITY_MAP_READ_LIMIT_MS,
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
 * says "Sign in again" and nothing moves; right after the page opens the
 * island reads the whole window once more, with the viewer's day start (the
 * server's read cannot carry it: QUESTIONS Q22), then the last ten minutes
 * every 30 seconds and the whole window every 5 minutes, at the viewer's
 * midnight and when the replay begins on an old read, never while the tab is
 * hidden; a read of the last
 * ten minutes never replaces the window's table; a shortened window says so
 * and is never labelled as the whole one; a number the database calls a
 * floor says "at least", and no other; the flagged list beside the map shows
 * flagged entries only, with the hollow mark, city and country and nothing
 * else of where; reduced motion draws the globe still (no flight, no pulse,
 * no turning) and the pill says so; a globe that
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

import { CATEGORY_LOOKS, HIDDEN_KIND_LOOK, PANEL, localDayStart } from './map-model';
import { SecurityMapClient } from './security-map-client';
import {
  FEED_VISIBLE,
  FLAGGED_VISIBLE,
  LABEL_LOOK,
  MARK_TILE,
  STAGE_CSS,
} from './security-map-panels';

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
        events: 2,
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
/** The layout's widths: from 1100 px the flagged list is in the stage; from 640 px the stage carries more than the pill. */
let wide = false;
let notPhone = false;
const motionListeners = new Set<() => void>();
let visibility: 'visible' | 'hidden' = 'visible';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-11-23T22:00:05Z'));
  h.globeProps = [];
  h.globeFails = null;
  reduced = false;
  wide = false;
  notPhone = false;
  motionListeners.clear();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  window.matchMedia = ((query: string) => ({
    get matches() {
      if (query.includes('reduced-motion')) return reduced;
      if (query.includes('1100px')) return wide;
      if (query.includes('640px')) return notPhone;
      return false;
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
  it("right after it opens the island reads the whole window once more, with the viewer's day start (Q22); then the last ten minutes every 30 seconds, and the whole window 5 minutes on", async () => {
    const { spy } = mount(async (input) =>
      (input as { scope: string }).scope === 'whole' ? dayRead()(input) : recentRead(liveAnswer()),
    );
    await advance(0);
    // At once: the server's read could not carry the viewer's midnight.
    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      { scope: 'whole', dayStart: localDayStart(new Date()) },
    ]);
    const first = spy.mock.calls[0]![0] as { dayStart: string };
    expect(new Date(first.dayStart).getHours()).toBe(0);
    await advance(30_000);
    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      { scope: 'whole', dayStart: localDayStart(new Date()) },
      { scope: 'recent', dayStart: null },
    ]);
    // Each read is scheduled when the one before it has landed.
    for (let i = 0; i < 9; i += 1) await advance(30_000);
    expect(spy.mock.calls.map((c) => (c[0] as { scope: string }).scope)).toEqual([
      'whole',
      ...Array.from({ length: 9 }, () => 'recent'),
      'whole',
    ]);
  });

  it("the day's counter: 'Not counted yet' until the island's first read of the whole window lands with the day start, a moment after the page opens, then its number", async () => {
    let release: (v: unknown) => void = () => {};
    const { spy } = mount((input) =>
      (input as { scope: string }).scope === 'whole'
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(recentRead(liveAnswer())),
    );
    expect(today()).toBe('Not counted yet');
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(1);
    const whole = spy.mock.calls[0]![0] as { scope: string };
    expect(whole.scope).toBe('whole');
    expect(today()).toBe('Not counted yet');
    await act(async () => {
      release(dayRead()(whole));
    });
    expect(today()).toBe('9');
  });

  it("the whole window is read again at the viewer's midnight, with the new day, between the 30-second reads", async () => {
    // Opened at 23:52:50: the island reads the whole window at once, and again at 23:57:50.
    vi.setSystemTime(new Date(2026, 10, 23, 23, 52, 50));
    const { spy } = mount(async (input) =>
      (input as { scope: string }).scope === 'whole' ? dayRead()(input) : recentRead(liveAnswer()),
    );
    await advance(0);
    for (let i = 0; i < 14; i += 1) await advance(30_000);
    expect(today()).toBe('9');
    // 23:59:50 was the last read; midnight is 10 seconds on, before the next 30-second read.
    await advance(10_000);
    const calls = spy.mock.calls.map((c) => c[0] as { scope: string; dayStart: string | null });
    expect(calls.map((c) => c.scope)).toEqual([
      'whole',
      ...Array.from({ length: 9 }, () => 'recent'),
      'whole',
      'recent',
      'recent',
      'recent',
      'recent',
      'whole',
    ]);
    expect(new Date(calls[0]!.dayStart!).getDate()).toBe(23);
    expect(new Date(calls[10]!.dayStart!).getDate()).toBe(23);
    const next = new Date(calls[15]!.dayStart!);
    expect([next.getDate(), next.getHours(), next.getMinutes()]).toEqual([24, 0, 0]);
    expect(today()).toBe('9');
  });

  it("past midnight, before the new day is read, the day's counter says 'Not counted yet', never the old day's number", async () => {
    vi.setSystemTime(new Date(2026, 10, 23, 23, 59, 30));
    let wholeReads = 0;
    mount(async (input) => {
      if ((input as { scope: string }).scope !== 'whole') return recentRead(liveAnswer());
      wholeReads += 1;
      return wholeReads === 1 ? dayRead()(input) : SECURITY_MAP_POLL_FAILED;
    });
    // The island's first read of the whole window, at 23:59:30, counts the 23rd.
    await advance(0);
    expect(wholeReads).toBe(1);
    expect(today()).toBe('9');
    // The read at midnight fails.
    await advance(30_000);
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
    // 90 seconds after the island's whole read, the last ten minutes come back empty: the replay begins.
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
    const { spy } = mount(async (input) =>
      (input as { scope: string }).scope === 'whole' ? wholeRead() : recentRead(liveAnswer()),
    );
    await advance(30_000);
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

  it('one read at a time: a read still out holds the next one back, up to the read limit, however often the page draws again', async () => {
    // A new poll function on each draw runs the effect that schedules reads
    // again while the first read is out (review round 2, N4): without the
    // check of a read in flight, that sends a second one at once.
    const calls = vi.fn((_input: unknown) => new Promise(() => {}));
    const initial = wholeRead();
    const view = render(<SecurityMapClient initial={initial} poll={(input) => calls(input)} />);
    await advance(0);
    expect(calls).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 19; i += 1) {
      view.rerender(<SecurityMapClient initial={initial} poll={(input) => calls(input)} />);
      await advance(1_000);
    }
    expect(calls).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('security-map-stop')).toBeNull();
  });

  it('a read with no answer in 20 seconds is counted out: "Not updating since", the play stops, and its late answer is ignored', async () => {
    let release: (v: unknown) => void = () => {};
    // The island's first read (of the whole window) lands; the next, of the last ten minutes, does not.
    const { spy } = mount((input) =>
      spy.mock.calls.length === 2
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(
            (input as { scope: string }).scope === 'whole'
              ? dayRead()(input)
              : recentRead(liveAnswer()),
          ),
    );
    await advance(0);
    await advance(30_000);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(lastGlobe().timing).toBe('replay');
    await advance(SECURITY_MAP_READ_LIMIT_MS - 1);
    expect(screen.queryByTestId('security-map-stop')).toBeNull();
    await advance(1);
    expect(screen.getByTestId('security-map-stop').textContent).toMatch(
      /^Not updating since \d\d:\d\d, your time\. The map is stopped and shows what was read then\.$/,
    );
    expect(lastGlobe().timing).toBe('still');
    expect(lastGlobe().mayTurn).toBe(false);
    // The late answer would make the play live: it belongs to no read, and is ignored.
    await act(async () => {
      release(recentRead(liveAnswer()));
    });
    expect(screen.getByTestId('security-map-stop')).toBeInTheDocument();
    expect(lastGlobe().timing).toBe('still');
    // The next read goes after the back-off; a good one starts the play again.
    await advance(119_000);
    expect(spy).toHaveBeenCalledTimes(2);
    await advance(1_000);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId('security-map-stop')).toBeNull();
    expect(lastGlobe().timing).toBe('live');
  });

  it('a failed read of the whole window: the last ten minutes go on, and the next try waits 2, then 4 minutes; the totals say they may be out of date', async () => {
    const at: Array<[string, number]> = [];
    const opened = Date.now();
    mount(async (input) => {
      const scope = (input as { scope: string }).scope;
      at.push([scope, (Date.now() - opened) / 1000]);
      return scope === 'whole' ? SECURITY_MAP_POLL_FAILED : recentRead(liveAnswer());
    });
    for (let i = 0; i < 24; i += 1) await advance(30_000);
    // The island's read at once fails; the next waits 2 minutes from it, then 4.
    expect(at.filter(([scope]) => scope === 'whole').map(([, s]) => s)).toEqual([0, 120, 360]);
    // Never two reads of the whole window in a row: the last ten minutes in between, every time.
    const scopes = at.map(([scope]) => scope);
    expect(scopes.some((scope, i) => scope === 'whole' && scopes[i + 1] === 'whole')).toBe(false);
    expect(scopes.filter((scope) => scope === 'recent').length).toBeGreaterThan(15);
    expect(
      screen.getByText(
        /^Totals and table as of \d\d:\d\d, your time\. The newest count could not be read/,
      ),
    ).toBeInTheDocument();
    // The last ten minutes stay live, against the last good whole read.
    expect(lastGlobe().timing).toBe('live');
    expect(screen.queryByTestId('security-map-stop')).toBeNull();
  });

  it("no good read of the whole window yet: the last ten minutes run alone, the page says the day's picture is incomplete, and the whole window is tried 2 minutes on", async () => {
    const at: Array<[string, number]> = [];
    const opened = Date.now();
    mount(async (input) => {
      const scope = (input as { scope: string }).scope;
      at.push([scope, (Date.now() - opened) / 1000]);
      return scope === 'whole' ? dayRead()(input) : recentRead(liveAnswer());
    }, SECURITY_MAP_POLL_FAILED);
    expect(screen.getByText(SECURITY_MAP_WORDS.wholeUnread)).toBeInTheDocument();
    await advance(0);
    expect(at).toEqual([['recent', 0]]);
    for (let i = 0; i < 4; i += 1) await advance(30_000);
    expect(at).toEqual([
      ['recent', 0],
      ['recent', 30],
      ['recent', 60],
      ['recent', 90],
      ['whole', 120],
    ]);
    expect(screen.queryByText(SECURITY_MAP_WORDS.wholeUnread)).toBeNull();
    expect(today()).toBe('9');
  });

  it('one read at a time: a tab hidden and shown while a read is out sends no second read', async () => {
    const { spy } = mount(() => new Promise(() => {}));
    // The read right after it opens is out (not yet counted out at 20 seconds).
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
    for (let i = 0; i < 19; i += 1) await advance(1_000);
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
    mount(async () => wholeRead());
    chooseFlat();
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
      /^Replay of the last 3 hours 52 minutes\. Nothing to draw from the last 10 minutes\./,
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
    // Every kind is listed: the password-guessing entry, then the flagged sign-in alert.
    expect(entries()).toHaveLength(2);
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
  });

  it('a flagged entry of a kind the map does not draw: its plain name, the grey mark, city and country, time and count; never its kind', () => {
    mount(async () => new Promise(() => {}));
    const entry = entries()[1]!;
    expect(entry.textContent).toContain('Sign-in from a new country');
    expect(entry.textContent).toContain('Example Falls, United States');
    expect(entry.textContent).toContain('21:40 UTC');
    expect(entry.textContent).toContain('2');
    const mark = entry.querySelector('svg path')!;
    expect(mark.getAttribute('fill')).toBe('none');
    expect(mark.getAttribute('stroke')).toBe(HIDDEN_KIND_LOOK.hex);
    expect(HIDDEN_KIND_LOOK.hex).not.toBe(CATEGORY_LOOKS.phishing.hex);
    expect(Object.values(CATEGORY_LOOKS).map((l) => l.hex)).not.toContain(HIDDEN_KIND_LOOK.hex);
    // The split, said in one line with the grey mark.
    const split = screen.getByTestId('security-map-flagged-split');
    expect(split.textContent).toBe(SECURITY_MAP_WORDS.flaggedFeedSplit);
    expect(split.querySelector('svg path')!.getAttribute('stroke')).toBe(HIDDEN_KIND_LOOK.hex);
  });

  it('the words Phishing and Malware appear nowhere on the page, the flagged sign-in alert listed', () => {
    mount(async () => new Promise(() => {}));
    expect(entries()).toHaveLength(2);
    for (const view of ['globe', 'flat'] as const) {
      if (view === 'flat') chooseFlat();
      const page = document.body.innerHTML;
      expect(page).not.toMatch(/phishing|malware/i);
    }
  });

  it('the globe, the flat map, the legend and the counters still carry nothing of the hidden kind', () => {
    mount(async () => new Promise(() => {}));
    expect(entries()[1]!.textContent).toContain('Sign-in from a new country');
    for (const props of h.globeProps) {
      const arcs = props.arcs as Array<{ arc: { category: string; country: string } }>;
      expect(arcs.some((a) => a.arc.category === 'phishing' || a.arc.country === 'US')).toBe(false);
    }
    chooseFlat();
    expect(document.querySelectorAll('[data-arc*="phishing"], [data-arc^="US:"]')).toHaveLength(0);
    const legend = [...document.querySelectorAll('[data-legend]')].map((li) =>
      li.getAttribute('data-legend'),
    );
    expect(legend).toEqual(['password_guessing', 'exploit', 'bots']);
    expect(
      [...document.querySelectorAll('[data-counter]')].map((c) => c.getAttribute('data-counter')),
    ).toEqual(['blocked_today', 'blocked_window', 'flagged_window']);
  });

  it('a flagged reason this build does not know: neutral words, never the code', () => {
    const odd = { ...answer().flagged_feed[1]!, reason: 'sign_in_from_the_moon' };
    mount(async () => new Promise(() => {}), wholeRead(answer({ flagged_feed: [odd] })));
    expect(entries()[0]!.textContent).toContain('Flagged sign-in event');
    expect(list().textContent).not.toContain('sign_in_from_the_moon');
  });

  it("on a wide screen it is a panel inside the stage, on the stage's dark glass; narrower, a card under the stage", () => {
    wide = true;
    notPhone = true;
    const { unmount } = mount(async () => new Promise(() => {}));
    expect(screen.getByTestId('security-map-stage').getAttribute('data-layout')).toBe('wide');
    expect(screen.getByTestId('security-map-stage').contains(list())).toBe(true);
    expect(list().getAttribute('data-tone')).toBe('stage');
    unmount();
    wide = false;
    mount(async () => new Promise(() => {}));
    expect(screen.getByTestId('security-map-stage').getAttribute('data-layout')).toBe('medium');
    expect(screen.getByTestId('security-map-stage').contains(list())).toBe(false);
    expect(list().getAttribute('data-tone')).toBe('page');
    // Under the stage and its caption.
    const caption = screen.getByTestId('security-map-caption');
    expect(caption.compareDocumentPosition(list()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  const noFlagged = () => {
    const totals = answer().totals;
    totals.password_guessing.flagged = 0;
    return totals;
  };

  it('nothing flagged: one plain line', () => {
    mount(
      async () => new Promise(() => {}),
      wholeRead(answer({ flagged_feed: [], totals: noFlagged(), flagged_window: 0 })),
    );
    expect(entries()).toHaveLength(0);
    expect(within(list()).getByText(SECURITY_MAP_WORDS.flaggedFeedEmpty)).toBeInTheDocument();
  });

  it('none listed while the window holds flagged events: never "Nothing was flagged"', () => {
    mount(async () => new Promise(() => {}), wholeRead(answer({ flagged_feed: [] })));
    expect(entries()).toHaveLength(0);
    expect(screen.getByTestId('security-map-flagged-words').textContent).toBe(
      SECURITY_MAP_WORDS.flaggedFeedNoneListed,
    );
    expect(within(list()).queryByText(SECURITY_MAP_WORDS.flaggedFeedEmpty)).toBeNull();
  });

  it("more: the kept list's events add up to less than the window's flagged events; a poll that fills the gap clears it", async () => {
    // Listed 4 + 2 = 6 of the window's 7 flagged events.
    const whole = answer({ flagged_window: 7 });
    const newer = {
      ...answer().flagged_feed[0]!,
      minute: '2026-11-23T21:59:00+00:00',
      city: 'Example Newest',
      events: 1,
      at_least: false,
    };
    mount(
      async (input) =>
        (input as { scope: string }).scope === 'whole'
          ? wholeRead(whole)
          : recentRead(answer({ ...liveAnswer(), flagged_feed: [newer] })),
      wholeRead(whole),
    );
    expect(entries()).toHaveLength(2);
    expect(screen.getByTestId('security-map-flagged-words').textContent).toBe(
      SECURITY_MAP_WORDS.flaggedFeedMore,
    );
    await advance(0);
    await advance(30_000);
    expect(entries()).toHaveLength(3);
    expect(screen.queryByTestId('security-map-flagged-words')).toBeNull();
  });

  it('all of them listed: no such words', () => {
    mount(async () => new Promise(() => {}));
    expect(screen.queryByTestId('security-map-flagged-words')).toBeNull();
  });

  it('the whole window not read: "Could not check", never "Nothing was flagged"', () => {
    mount(async () => new Promise(() => {}), SECURITY_MAP_POLL_FAILED);
    expect(screen.getByTestId('security-map-flagged-words').textContent).toBe('Could not check.');
  });

  it('a flagged entry from the whole-window answer is still listed after three polls that do not carry it', async () => {
    // Inside the polls' ten minutes (21:50:30 on): a poll that does not carry it does not take it away.
    const inside = { ...answer().flagged_feed[0]!, minute: '2026-11-23T21:55:00+00:00' };
    const empty = answer({ ...liveAnswer(), feed: [], flagged_feed: [] });
    const { spy } = mount(
      async (input) =>
        (input as { scope: string }).scope === 'whole'
          ? dayRead({ flagged_feed: [inside] })(input)
          : recentRead(empty),
      wholeRead(answer({ flagged_feed: [inside] })),
    );
    await advance(0);
    for (let i = 0; i < 3; i += 1) await advance(30_000);
    expect(spy.mock.calls.map((c) => (c[0] as { scope: string }).scope)).toEqual([
      'whole',
      'recent',
      'recent',
      'recent',
    ]);
    expect(entries()).toHaveLength(1);
    expect(entries()[0]!.textContent).toContain('Example Borough, United Kingdom');
    expect(entries()[0]!.textContent).toContain('21:55 UTC');
    // The plain feed too: its entry from the whole read is still there.
    expect(screen.getAllByRole('button', { name: /Request for a settings file/ })).toHaveLength(1);
  });

  it('a poll that pushes entries past the 20 kept: the list says it leaves some out', async () => {
    // Twenty flagged entries of one event each, and 20 flagged events: all of them listed.
    const twenty = Array.from({ length: 20 }, (_, i) => ({
      ...answer().flagged_feed[0]!,
      minute: `2026-11-23T21:${String(10 + i).padStart(2, '0')}:00+00:00`,
      events: 1,
      at_least: false,
    }));
    const totals = answer().totals;
    totals.password_guessing.flagged = 20;
    const whole = answer({ flagged_feed: twenty, totals, flagged_window: 20 });
    const newer = { ...twenty[0]!, minute: '2026-11-23T21:59:00+00:00', city: 'Example Newest' };
    mount(
      async (input) =>
        (input as { scope: string }).scope === 'whole'
          ? wholeRead(whole)
          : recentRead(answer({ ...liveAnswer(), flagged_feed: [newer] })),
      wholeRead(whole),
    );
    await advance(0);
    // The first FLAGGED_VISIBLE show; "Show all 20" shows the rest.
    expect(entries()).toHaveLength(FLAGGED_VISIBLE);
    fireEvent.click(within(list()).getByRole('button', { name: SECURITY_MAP_WORDS.showAll(20) }));
    expect(entries()).toHaveLength(20);
    expect(screen.queryByTestId('security-map-flagged-words')).toBeNull();
    await advance(30_000);
    expect(entries()).toHaveLength(20);
    expect(entries()[0]!.textContent).toContain('Example Newest');
    expect(screen.getByTestId('security-map-flagged-words').textContent).toBe(
      SECURITY_MAP_WORDS.flaggedFeedMore,
    );
  });

  it('a new read of the whole window starts both lists again from its own', async () => {
    let wholeReads = 0;
    mount(async (input) => {
      if ((input as { scope: string }).scope !== 'whole') {
        return recentRead(answer({ ...liveAnswer(), feed: [], flagged_feed: [] }));
      }
      wholeReads += 1;
      // The island's read of the whole window no longer holds either entry of the server's.
      return dayRead({ feed: [], flagged_feed: [] })(input);
    });
    // The server's read, before the island's own lands.
    expect(entries()).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /Request for a settings file/ })).toHaveLength(1);
    await advance(0);
    expect(wholeReads).toBe(1);
    expect(entries()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Request for a settings file/ })).toBeNull();
  });

  it("a poll's flagged entries are merged in, newest first; the whole read's own all stay", async () => {
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
      'Example Inside',
      'Example Before',
    ]);
    // The poll's numbers replace none of the whole read's.
    expect(
      screen.getByText('Blocked, last 24 hours').parentElement!.querySelector('dd')!.textContent,
    ).toBe('57');
  });
});

describe('when the page stops', () => {
  it('the stop words are announced: "Not updating since" and "Sign in again" land in a polite status region that was there before', async () => {
    mount(async () => SECURITY_MAP_POLL_FAILED);
    const region = screen.getByRole('status');
    expect(region.textContent).toBe('');
    await advance(30_000);
    await advance(60_000);
    expect(screen.getByRole('status')).toBe(region);
    expect(within(region).getByTestId('security-map-stop').textContent).toMatch(
      /^Not updating since /,
    );
    expect(region.getAttribute('aria-live')).toBeNull();
  });

  it('after two failed reads: "Not updating since HH:MM" and nothing moves', async () => {
    mount(async () => SECURITY_MAP_POLL_FAILED);
    await advance(30_000);
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
    await advance(30_000);
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
    const { spy } = mount(async (input) =>
      (input as { scope: string }).scope === 'whole' ? wholeRead() : recentRead(quietAnswer()),
    );
    await advance(0);
    fireEvent.click(screen.getByRole('button', { name: SECURITY_MAP_WORDS.pause }));
    expect(screen.getByRole('button', { name: SECURITY_MAP_WORDS.play })).toBeInTheDocument();
    expect(screen.getByTestId('security-map-stop').textContent).toBe(
      'Paused. The numbers still update.',
    );
    expect(lastGlobe().timing).toBe('still');
    expect(lastGlobe().mayTurn).toBe(false);
    expect(screen.getByTestId('security-map-pill').textContent).toBe(SECURITY_MAP_WORDS.pillPaused);
    expect(spy).toHaveBeenCalledTimes(1);
    await advance(30_000);
    expect(spy).toHaveBeenCalledTimes(2);
    await advance(30_000);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('security-map-stop').textContent).toBe(
      'Paused. The numbers still update.',
    );
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
      /^Replay of the last 24 hours\. Nothing to draw from the last 10 minutes\. Now showing/,
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
  it('reduced motion: the globe drawn still (no flight, no pulse, no turning of its own), and the pill and the caption say so', () => {
    reduced = true;
    mount(async () => wholeRead());
    expect(screen.getByTestId('globe-stub')).toBeInTheDocument();
    expect(lastGlobe().still).toBe(true);
    expect(lastGlobe().timing).toBe('still');
    expect(lastGlobe().mayTurn).toBe(false);
    expect(screen.getByTestId('security-map-pill').textContent).toBe(
      SECURITY_MAP_WORDS.pillReducedMotion,
    );
    expect(screen.getByTestId('security-map-stop').textContent).toMatch(/^Not moving: /);
    // The flat map stays a choice, and is still too.
    expect(screen.getByRole('button', { name: SECURITY_MAP_WORDS.globe })).toBeEnabled();
    chooseFlat();
    expect(screen.getByTestId('security-map-flat')).toBeInTheDocument();
    expect(document.querySelectorAll('.sm-head, .sm-pulse')).toHaveLength(0);
  });

  it('the setting changing while the page is open is followed', () => {
    mount(async () => wholeRead());
    expect(lastGlobe().still).toBe(false);
    expect(lastGlobe().timing).toBe('replay');
    reduced = true;
    act(() => {
      for (const fn of motionListeners) fn();
    });
    expect(screen.getByTestId('globe-stub')).toBeInTheDocument();
    expect(lastGlobe().still).toBe(true);
    expect(lastGlobe().timing).toBe('still');
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
    mount(async () => wholeRead());
    expect(screen.getByTestId('globe-stub').closest('[aria-hidden="true"]')).not.toBeNull();
    chooseFlat();
    expect(screen.getByTestId('security-map-flat').closest('[aria-hidden="true"]')).not.toBeNull();
    expect(
      screen.getByRole('region', { name: 'Blocked and flagged events by country' }),
    ).toBeInTheDocument();
  });
});

describe('the stage', () => {
  it('a phone: the pill alone on the stage; the controls, the legend and the flagged list under it; no words on the globe', () => {
    mount(async () => new Promise(() => {}));
    const stage = screen.getByTestId('security-map-stage');
    expect(stage.getAttribute('data-layout')).toBe('phone');
    expect(within(stage).getByTestId('security-map-pill')).toBeInTheDocument();
    expect(stage.contains(screen.getByTestId('security-map-controls'))).toBe(false);
    expect(within(stage).queryByTestId('security-map-stage-legend')).toBeNull();
    expect(within(stage).queryByTestId('security-map-ticker')).toBeNull();
    expect(stage.contains(screen.getByTestId('security-map-flagged'))).toBe(false);
    expect(lastGlobe().showLabels).toBe(false);
  });

  it('wider: the controls, the legend and the ticker on the stage; the labels on the globe', () => {
    notPhone = true;
    mount(async () => new Promise(() => {}));
    const stage = screen.getByTestId('security-map-stage');
    expect(stage.contains(screen.getByTestId('security-map-controls'))).toBe(true);
    const legend = within(stage).getByTestId('security-map-stage-legend');
    expect(legend.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(legend.textContent).toContain(SECURITY_MAP_WORDS.legendBlocked);
    expect(legend.textContent).toContain(SECURITY_MAP_WORDS.legendFlagged);
    expect(legend.textContent).not.toMatch(/phishing|malware/i);
    expect(lastGlobe().showLabels).toBe(true);
  });

  it("the pill: the play's mode in a few words, hidden from screen readers (the caption says it in full)", async () => {
    mount(async (input) =>
      (input as { scope: string }).scope === 'whole' ? dayRead()(input) : recentRead(liveAnswer()),
    );
    const pill = () => screen.getByTestId('security-map-pill');
    expect(pill().getAttribute('data-kind')).toBe('replay');
    expect(pill().textContent).toMatch(/^Replay \d\d:\d\d to \d\d:\d\d$/);
    expect(pill().getAttribute('aria-hidden')).toBe('true');
    await advance(0);
    await advance(30_000);
    expect(pill().getAttribute('data-kind')).toBe('live');
    expect(pill().textContent).toBe(SECURITY_MAP_WORDS.pillLive);
  });

  it('the pill says when the page is not updating', async () => {
    mount(async () => SECURITY_MAP_POLL_FAILED);
    await advance(0);
    await advance(60_000);
    const pill = screen.getByTestId('security-map-pill');
    expect(pill.getAttribute('data-kind')).toBe('not_updating');
    expect(pill.textContent).toMatch(/^Not updating since \d\d:\d\d$/);
  });

  it('the ticker: the newest feed entry the stage draws, never one it does not', async () => {
    notPhone = true;
    const live = answer({
      ...liveAnswer(),
      feed: [
        // Newest, but Germany is not drawn in the live play.
        feedEntry({ minute: '2026-11-23T21:59:00+00:00', country: 'DE', city: 'Example Town' }),
        feedEntry({ minute: '2026-11-23T21:58:00+00:00', country: 'CN', city: 'Example Harbour' }),
      ],
    });
    mount(async (input) =>
      (input as { scope: string }).scope === 'whole' ? dayRead()(input) : recentRead(live),
    );
    await advance(0);
    await advance(30_000);
    expect(lastGlobe().timing).toBe('live');
    const ticker = screen.getByTestId('security-map-ticker');
    expect(ticker.textContent).toContain('Example Harbour, China');
    expect(ticker.textContent).toContain('21:58 UTC');
    expect(ticker.textContent).not.toContain('Example Town');
    expect(ticker.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it("the globe is handed the top sources' labels, where to face, and the countries' glow", () => {
    notPhone = true;
    mount(async () => new Promise(() => {}));
    const props = lastGlobe();
    const labels = props.labels as Array<{ code: string; name: string; count: string }>;
    expect(labels.map((l) => [l.code, l.name, l.count])).toEqual([
      ['DE', 'Germany', '12'],
      ['BR', 'Brazil', '3'],
    ]);
    const target = props.target as { yaw: number; pitch: number; sway: number };
    expect(Object.keys(target).sort()).toEqual(['pitch', 'sway', 'yaw']);
    for (const v of Object.values(target)) expect(Number.isFinite(v)).toBe(true);
    expect([...(props.heat as Map<string, number>).keys()]).toEqual(['DE', 'BR']);
  });

  it('a count that is a floor: "at least" small, the number large', () => {
    mount(async () => new Promise(() => {}));
    const flagged = screen.getByText('Flagged, last 24 hours').parentElement!;
    expect(flagged.querySelector('[data-part="at-least"]')!.textContent).toBe('at least');
    expect(flagged.querySelector('[data-part="number"]')!.textContent).toBe('5');
    expect(flagged.querySelector('[data-part="number"]')!.className).toContain('font-mono');
  });

  it('the view controls show a focus ring of their own (the base rule turns outlines off)', () => {
    notPhone = true;
    mount(async () => new Promise(() => {}));
    for (const name of [
      SECURITY_MAP_WORDS.pause,
      SECURITY_MAP_WORDS.globe,
      SECURITY_MAP_WORDS.flat,
    ]) {
      const button = screen.getByRole('button', { name });
      expect(button.className).toContain('focus-visible:outline-solid');
      expect(button.className).toContain('focus-visible:outline-offset-2');
    }
    const entry = screen.getAllByRole('button', { name: /Request for a settings file/ })[0]!;
    expect(entry.className).toContain('focus-visible:outline-solid');
    expect(entry.className).toContain('focus-visible:-outline-offset-2');
  });
});

describe('the controls and the flagged entries line up', () => {
  it('Pause and the Globe / Flat map pair: one row, both boxes the same height, the pair filling its frame', () => {
    notPhone = true;
    mount(async () => new Promise(() => {}));
    const pause = screen.getByRole('button', { name: SECURITY_MAP_WORDS.pause });
    const pair = screen.getByRole('group', { name: SECURITY_MAP_WORDS.viewLabel });
    expect(pause.parentElement).toBe(pair.parentElement);
    expect(pause.className.split(' ')).toContain('h-8');
    expect(pair.className.split(' ')).toContain('h-8');
    expect(pair.className.split(' ')).toContain('items-stretch');
    // The pair's buttons take no height of their own: a taller one would stick out of the frame.
    for (const name of [SECURITY_MAP_WORDS.globe, SECURITY_MAP_WORDS.flat]) {
      const button = within(pair).getByRole('button', { name });
      expect(button.className).not.toMatch(/(^|\s)h-/);
    }
  });

  it("a flagged entry's time and count stay together on one line, beside the map and under it", () => {
    for (const layout of ['wide', 'phone'] as const) {
      wide = layout === 'wide';
      notPhone = layout === 'wide';
      const { unmount } = mount(async () => new Promise(() => {}));
      // The first entry's count is a floor: "21:44 UTC · at least 4".
      const entry = screen
        .getByTestId('security-map-flagged')
        .querySelector('[data-flagged-entry]')!;
      const timeAndCount = [...entry.querySelectorAll('span')].find((el) =>
        /^\d\d:\d\d UTC · at least 4$/.test(el.textContent ?? ''),
      );
      expect(timeAndCount, layout).toBeDefined();
      expect(timeAndCount!.className.split(' '), layout).toContain('whitespace-nowrap');
      unmount();
    }
  });
});

describe('lab walk 2', () => {
  it('the ticker shows no organization and no source, only outcome, reason, city and country, and time (N6)', async () => {
    notPhone = true;
    const live = answer({
      ...liveAnswer(),
      feed: [
        feedEntry({
          minute: '2026-11-23T21:58:00+00:00',
          country: 'CN',
          city: 'Example Harbour',
          source: 'edge',
          organization_id: ORG,
          organization_name: 'Example Hidden Academy',
          organizations: 1,
        }),
      ],
    });
    mount(async (input) =>
      (input as { scope: string }).scope === 'whole' ? dayRead()(input) : recentRead(live),
    );
    await advance(0);
    await advance(30_000);
    const ticker = screen.getByTestId('security-map-ticker');
    expect(ticker.textContent).toContain('Example Harbour, China');
    expect(ticker.textContent).not.toContain('Example Hidden Academy');
    expect(ticker.textContent).not.toContain(ORG);
    expect(ticker.textContent).not.toContain(securityEventSourceLabel('edge'));
    expect(ticker.querySelector('a, button')).toBeNull();
  });

  it("the ticker never cuts the place: the reason's words give way first, the place keeps up to 32 characters (F7)", async () => {
    notPhone = true;
    const live = answer({
      ...liveAnswer(),
      feed: [
        feedEntry({ minute: '2026-11-23T21:58:00+00:00', country: 'CN', city: 'Example Harbour' }),
      ],
    });
    mount(async (input) =>
      (input as { scope: string }).scope === 'whole' ? dayRead()(input) : recentRead(live),
    );
    await advance(0);
    await advance(30_000);
    const ticker = screen.getByTestId('security-map-ticker');
    const reason = ticker.querySelector('[data-part="reason"]')!;
    const place = ticker.querySelector('[data-part="place"]')!;
    expect(place.textContent).toBe('Example Harbour, China');
    expect(reason.className.split(' ')).toEqual(expect.arrayContaining(['min-w-0', 'truncate']));
    expect(place.className.split(' ')).toEqual(
      expect.arrayContaining(['shrink-0', 'max-w-[32ch]', 'truncate']),
    );
    expect(place.className.split(' ')).not.toContain('min-w-0');
  });

  it('the stage legend says what the numbers by a country count (N1)', () => {
    notPhone = true;
    mount(async () => new Promise(() => {}));
    expect(screen.getByTestId('security-map-legend-counts').textContent).toBe(
      SECURITY_MAP_WORDS.legendCounts,
    );
    expect(SECURITY_MAP_WORDS.legendCounts).toContain('events in this play');
  });

  it('a country label reads over the brightest land: its backdrop at least 88% opaque, its text at least 7:1 (F5), with a leader line on its side (F4)', () => {
    const rgba = (css: string) => {
      const m = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(css)!;
      return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], alpha: Number(m[4]) };
    };
    const hex = (rgb: number[]) =>
      `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
    const luminance = (h: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const c = parseInt(h.slice(i, i + 2), 16) / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const contrast = (a: string, b: string) => {
      const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
      return (x! + 0.05) / (y! + 0.05);
    };
    for (const backdrop of [LABEL_LOOK.background, LABEL_LOOK.homeBackground]) {
      const { rgb, alpha } = rgba(backdrop);
      expect(alpha).toBeGreaterThanOrEqual(0.88);
      // Over the brightest land dot (white) and over the dark sea alike.
      for (const under of [255, 0]) {
        const seen = hex(rgb.map((v) => v * alpha + under * (1 - alpha)));
        expect(contrast(LABEL_LOOK.text, seen), `${backdrop} over ${under}`).toBeGreaterThanOrEqual(
          7,
        );
        expect(
          contrast(LABEL_LOOK.count, seen),
          `${backdrop} over ${under}`,
        ).toBeGreaterThanOrEqual(7);
        expect(contrast(PANEL.stockpilot, seen)).toBeGreaterThanOrEqual(7);
      }
    }
    expect(STAGE_CSS).toContain(`background:${LABEL_LOOK.background}`);
    for (const side of ['right', 'left', 'above', 'below']) {
      expect(STAGE_CSS).toContain(`.sm-label[data-side=${side}]::before{display:block;`);
    }
  });

  it('more happened than the map can draw: said of the play on screen only, never beside a live play that draws everything (item 6)', async () => {
    notPhone = true;
    const cut = answer({ timeline_truncated: true });
    mount(
      async (input) =>
        (input as { scope: string }).scope === 'whole' ? wholeRead(cut) : recentRead(liveAnswer()),
      wholeRead(cut),
    );
    // The replay on screen was cut: it says so, naming the replay.
    expect(document.body.textContent).toContain(SECURITY_MAP_WORDS.cutReplay);
    await advance(0);
    await advance(30_000);
    expect(lastGlobe().timing).toBe('live');
    // The live play draws all of its arcs: no word of the replay's cut.
    expect(document.body.textContent).not.toContain('More happened');
  });

  it('the stage is made shorter so the caption ends above the fold (F1), but never under 420 px', () => {
    notPhone = true;
    wide = true;
    const heightWas = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    const boxes: Record<string, { top: number; bottom: number }> = {
      'security-map-stage': { top: 244, bottom: 856 },
      'security-map-caption': { top: 864, bottom: 949 },
    };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const box = boxes[this.dataset.testid ?? ''] ?? { top: 0, bottom: 0 };
      return {
        ...box,
        left: 0,
        right: 0,
        width: 0,
        height: box.bottom - box.top,
        x: 0,
        y: box.top,
        toJSON: () => ({}),
      } as DOMRect;
    });
    try {
      mount(async () => new Promise(() => {}));
      // 800 - 244 - (949 - 856) - 8 = 455.
      expect(screen.getByTestId('security-map-stage').style.height).toBe('455px');
    } finally {
      vi.restoreAllMocks();
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: heightWas });
    }
  });
});

describe('long lists', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      feedEntry({
        minute: `2026-11-23T21:${String(10 + i).padStart(2, '0')}:00+00:00`,
        city: `Example Town ${i}`,
      }),
    );

  it(`the feed shows its first ${FEED_VISIBLE}, fading out, and "Show all N" shows the rest and back`, () => {
    mount(async () => new Promise(() => {}), wholeRead(answer({ feed: many(11) })));
    const entries = () => screen.getAllByRole('button', { name: /Request for a settings file/ });
    expect(entries()).toHaveLength(FEED_VISIBLE);
    const more = screen.getByRole('button', { name: SECURITY_MAP_WORDS.showAll(11) });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    const list = document.getElementById(more.getAttribute('aria-controls')!)!;
    expect(list.className).toContain('sm-fade-bottom');
    fireEvent.click(more);
    expect(entries()).toHaveLength(11);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(more.textContent).toBe(SECURITY_MAP_WORDS.showFewer);
    expect(list.className).not.toContain('sm-fade-bottom');
    fireEvent.click(more);
    expect(entries()).toHaveLength(FEED_VISIBLE);
  });

  it('a short list: no "Show all", no fade', () => {
    mount(async () => new Promise(() => {}), wholeRead(answer({ feed: many(3) })));
    expect(screen.queryByRole('button', { name: /^Show all/ })).toBeNull();
    expect(document.querySelector('.sm-fade-bottom')).toBeNull();
  });
});

describe('the marks on a light page', () => {
  /** WCAG relative luminance and contrast. */
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
  };

  it('every mark, the grey one too, stands on its dark tile at 3:1 or more', () => {
    for (const look of [...Object.values(CATEGORY_LOOKS), HIDDEN_KIND_LOOK]) {
      expect(contrast(look.hex, MARK_TILE), look.hex).toBeGreaterThanOrEqual(3);
    }
    mount(async () => new Promise(() => {}));
    const grey = screen.getByTestId('security-map-flagged-split').querySelector('svg')!;
    expect(grey.getAttribute('style')).toContain('background');
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

  it('is not a live region: an update is never announced; the stop words are the one status region on the page', () => {
    mount(async () => wholeRead());
    expect(document.querySelector('[aria-live]')).toBeNull();
    expect(document.querySelectorAll('[role="status"], [role="alert"], [role="log"]')).toHaveLength(
      1,
    );
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('data-testid', 'security-map-stop-status');
    // Nothing is moving that has stopped: the region is there, and says nothing.
    expect(region.textContent).toBe('');
    expect(region.contains(screen.getByText(SECURITY_MAP_WORDS.feedTitle))).toBe(false);
  });
});
