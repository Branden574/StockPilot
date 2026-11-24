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
 * whole window every 5 minutes, never while the tab is hidden; a read of the
 * last ten minutes never replaces the window's table; reduced motion shows
 * the flat map, still; a globe that cannot be drawn, or loses its context,
 * gives way to the flat map with one plain sentence. Made-up data only.
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
    },
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
      { country: 'XK', category: 'exploit', outcome: 'blocked', events: 5 },
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
    organization_id: null,
    organization_name: null,
    organizations: 0,
    ...over,
  };
}

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
    },
    timeline: [cell('2026-11-23T21:59:00+00:00', 60, 'CN', 'exploit', 'blocked', 4)],
    by_country: [],
  });

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
const chooseFlat = () =>
  fireEvent.click(screen.getByRole('button', { name: SECURITY_MAP_WORDS.flat }));

/* ────────────────────────────────── tests ────────────────────────────────── */

describe('the reads', () => {
  it("the first read is the whole window with the viewer's day start, at once; then the last ten minutes every 30 seconds; the whole window every 5 minutes", async () => {
    const { spy } = mount(async (input) =>
      (input as { scope: string }).scope === 'whole'
        ? wholeRead(answer({ day_start: '2026-11-23T08:00:00+00:00', blocked_since_day_start: 9 }))
        : recentRead(liveAnswer()),
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
    mount(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const today = () =>
      screen.getByText('Blocked since midnight, your time').parentElement!.querySelector('dd')!
        .textContent;
    expect(today()).toBe('Not counted yet');
    await advance(0);
    await act(async () => {
      release(
        wholeRead(answer({ day_start: '2026-11-23T08:00:00+00:00', blocked_since_day_start: 9 })),
      );
    });
    expect(today()).toBe('9');
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
        'Not on the map: 5 events come from a place the map has no point for (XK). They are in the table.',
      ),
    ).toBeInTheDocument();
    chooseFlat();
    expect(document.querySelectorAll('[data-arc^="XK:"]')).toHaveLength(0);
  });
});

describe('flagged against blocked', () => {
  it('in words: the counters, the legend and the table say "flagged, not blocked"; the flagged sum says "at least"', () => {
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
