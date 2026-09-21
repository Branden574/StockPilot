// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetForTests,
  landingRoute,
  markNavigationClick,
  markNavigationFeedback,
  markNavigationIntent,
  markNavigationUseful,
  onNavigationMeasured,
  PERF_MARK,
  PERF_MEASURE,
  type NavigationSummary,
} from './marks';

/**
 * The state machine for ONE in-flight navigation. Time is a variable here, not
 * a wait: `performance.now()` is pinned and moved by hand, so every assertion
 * is an exact number and the suite cannot flake on a slow CI box.
 *
 * This file lives under src/lib (the `node` project) and opts into a DOM with
 * the docblock above; marks.ssr.test.ts is its no-DOM twin.
 */

const UUID = '3f2c1a9e-7b4d-4c1e-9a2f-0d5e6f7a8b9c';

let clock = 0;
let visibility: DocumentVisibilityState = 'visible';
let landedOn: string | null = null;
let summaries: NavigationSummary[] = [];

function at(ms: number): void {
  clock = ms;
}

function goTo(path: string): void {
  window.history.replaceState(null, '', path);
}

function setVisibility(state: DocumentVisibilityState): void {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

function routesOf(markName: string): unknown[] {
  return performance.getEntriesByName(markName).map((entry) => (entry as PerformanceMark).detail);
}

beforeEach(() => {
  __resetForTests();
  performance.clearMarks();
  performance.clearMeasures();
  clock = 0;
  visibility = 'visible';
  landedOn = null;
  summaries = [];
  goTo('/dashboard');
  // setup.ts restores every spy after each test, so they are re-made here.
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  // Only the Navigation Timing answer is faked; marks and measures are real.
  const realGetEntriesByType = performance.getEntriesByType.bind(performance);
  vi.spyOn(performance, 'getEntriesByType').mockImplementation((type: string) => {
    if (type !== 'navigation') return realGetEntriesByType(type);
    return landedOn === null
      ? []
      : ([{ name: `http://localhost:3000${landedOn}` }] as unknown as PerformanceEntryList);
  });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  onNavigationMeasured((summary) => summaries.push(summary));
});

describe('click -> feedback -> useful', () => {
  it('measures the happy path and reports templates, never the paths it was given', () => {
    at(1_000);
    markNavigationIntent('/dashboard/inventory');
    at(1_400);
    markNavigationClick(`/dashboard/inventory`);
    at(1_432);
    markNavigationFeedback();
    goTo('/dashboard/inventory');
    at(2_150);
    markNavigationUseful('/dashboard/inventory');

    expect(summaries).toEqual([
      {
        kind: 'soft-nav',
        fromRoute: '/dashboard',
        toRoute: '/dashboard/inventory',
        clickToFeedbackMs: 32,
        clickToUsefulMs: 750,
        intentLeadMs: 400,
      },
    ]);
  });

  it('puts the four marks and the two measures on the timeline, with { route } as the only detail', () => {
    at(100);
    markNavigationIntent(`/dashboard/inventory/${UUID}?q=acme+widget`);
    at(300);
    markNavigationClick(`/dashboard/inventory/${UUID}?q=acme+widget`);
    at(340);
    markNavigationFeedback();
    at(900);
    markNavigationUseful(`/dashboard/inventory/${UUID}`);

    const detail = { route: '/dashboard/inventory/[id]' };
    expect(routesOf(PERF_MARK.intent)).toEqual([detail]);
    expect(routesOf(PERF_MARK.click)).toEqual([detail]);
    expect(routesOf(PERF_MARK.feedback)).toEqual([detail]);
    expect(routesOf(PERF_MARK.useful)).toEqual([detail]);

    const [toFeedback] = performance.getEntriesByName(PERF_MEASURE.clickToFeedback);
    const [toUseful] = performance.getEntriesByName(PERF_MEASURE.clickToUseful);
    expect(toFeedback?.duration).toBe(40);
    expect(toUseful?.duration).toBe(600);

    // Nothing that was passed in survives anywhere on the timeline.
    const everything = JSON.stringify(
      [...performance.getEntriesByType('mark'), ...performance.getEntriesByType('measure')].map(
        (entry) => [entry.name, (entry as PerformanceMark).detail],
      ),
    );
    expect(everything).not.toContain(UUID);
    expect(everything).not.toContain('acme');
  });

  it('only the FIRST feedback after a click counts', () => {
    at(1_000);
    markNavigationClick('/dashboard/orders');
    at(1_020);
    markNavigationFeedback(); // the link spinner
    at(1_090);
    markNavigationFeedback(); // the progress bar, a few frames later
    at(1_500);
    markNavigationUseful('/dashboard/orders');

    expect(summaries[0]).toMatchObject({ clickToFeedbackMs: 20 });
    expect(performance.getEntriesByName(PERF_MARK.feedback)).toHaveLength(1);
  });

  it('feedback with no click in flight is ignored', () => {
    at(500);
    markNavigationFeedback();
    expect(performance.getEntriesByName(PERF_MARK.feedback)).toHaveLength(0);
  });

  it('reports "no feedback seen" as null, never as zero', () => {
    at(1_000);
    markNavigationClick('/dashboard/orders');
    at(1_010);
    markNavigationUseful('/dashboard/orders'); // a cached route: content beat the first frame
    expect(summaries[0]).toMatchObject({ clickToFeedbackMs: null, clickToUsefulMs: 10 });
  });

  it('believes the click event timeStamp when it is recent, so input delay counts', () => {
    at(1_080); // the handler ran 80ms after the input, on a busy main thread
    markNavigationClick('/dashboard/orders', 1_000);
    at(1_500);
    markNavigationUseful('/dashboard/orders');
    expect(summaries[0]).toMatchObject({ clickToUsefulMs: 500 });
  });

  it('falls back to now for a timeStamp from another clock (epoch ms, the future, junk)', () => {
    for (const bogus of [1_789_000_000_000, 9_999, -5, Number.NaN, 0]) {
      summaries = [];
      at(2_000);
      markNavigationClick('/dashboard/orders', bogus);
      at(2_250);
      markNavigationUseful('/dashboard/orders');
      expect(summaries[0]).toMatchObject({ clickToUsefulMs: 250 });
    }
  });
});

describe('a navigation only finishes on the route that was clicked', () => {
  it('ignores useful for any other route, and still finishes when the right one arrives', () => {
    at(1_000);
    markNavigationClick('/dashboard/orders');
    at(1_200);
    // Late content streaming into the page being LEFT.
    markNavigationUseful('/dashboard/inventory');
    expect(summaries).toEqual([]);

    at(1_900);
    markNavigationUseful('/dashboard/orders');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ toRoute: '/dashboard/orders', clickToUsefulMs: 900 });
  });

  it('matches on the TEMPLATE, so any item id finishes a click on an item', () => {
    at(1_000);
    markNavigationClick(`/dashboard/inventory/${UUID}`);
    at(1_300);
    markNavigationUseful(`/dashboard/inventory/${UUID}`);
    expect(summaries[0]).toMatchObject({ toRoute: '/dashboard/inventory/[id]' });
  });

  it('a second click REPLACES an unfinished first one', () => {
    at(1_000);
    markNavigationClick('/dashboard/orders');
    at(1_050);
    markNavigationFeedback();
    at(1_400);
    markNavigationClick('/dashboard/movements'); // changed their mind
    at(2_000);
    markNavigationUseful('/dashboard/orders'); // the abandoned destination: nothing to finish
    expect(summaries).toEqual([]);

    at(2_100);
    markNavigationUseful('/dashboard/movements');
    expect(summaries).toEqual([
      {
        kind: 'soft-nav',
        fromRoute: '/dashboard',
        toRoute: '/dashboard/movements',
        clickToFeedbackMs: null, // the first click's feedback does not carry over
        clickToUsefulMs: 700,
        intentLeadMs: null,
      },
    ]);
  });

  it('keeps ONE navigation on the timeline: a new click clears the previous story', () => {
    at(1_000);
    markNavigationClick('/dashboard/orders');
    at(1_500);
    markNavigationUseful('/dashboard/orders');
    at(5_000);
    markNavigationClick('/dashboard/movements');

    expect(routesOf(PERF_MARK.click)).toEqual([{ route: '/dashboard/movements' }]);
    expect(performance.getEntriesByName(PERF_MARK.useful)).toHaveLength(0);
    expect(performance.getEntriesByName(PERF_MEASURE.clickToUseful)).toHaveLength(0);
  });
});

describe('garbage is dropped, not reported', () => {
  it('drops a navigation during which the tab was hidden, even if it came back', () => {
    at(1_000);
    markNavigationClick('/dashboard/orders');
    setVisibility('hidden');
    setVisibility('visible');
    at(1_600);
    markNavigationUseful('/dashboard/orders');
    expect(summaries).toEqual([]);

    // The flag belongs to that navigation: the next one is measured normally.
    at(3_000);
    markNavigationClick('/dashboard/movements');
    at(3_400);
    markNavigationUseful('/dashboard/movements');
    expect(summaries).toHaveLength(1);
  });

  it('drops a navigation that finishes while the tab is hidden', () => {
    at(1_000);
    markNavigationClick('/dashboard/orders');
    visibility = 'hidden'; // no event delivered: the state itself is checked too
    at(1_600);
    markNavigationUseful('/dashboard/orders');
    expect(summaries).toEqual([]);
  });

  it('drops anything over 60 seconds: the laptop slept, nobody waited a minute for a page', () => {
    at(1_000);
    markNavigationClick('/dashboard/orders');
    at(61_001);
    markNavigationUseful('/dashboard/orders');
    expect(summaries).toEqual([]);
  });

  it('reports exactly 60 seconds, the boundary', () => {
    at(1_000);
    markNavigationClick('/dashboard/orders');
    at(61_000);
    markNavigationUseful('/dashboard/orders');
    expect(summaries[0]).toMatchObject({ clickToUsefulMs: 60_000 });
  });
});

describe('intent', () => {
  it('the FIRST signal of an approach sets the clock: pointer-enter, not the pointer-down after it', () => {
    at(1_000);
    markNavigationIntent('/dashboard/orders'); // pointer-enter
    at(1_450);
    markNavigationIntent('/dashboard/orders'); // pointer-down
    at(1_455);
    markNavigationIntent('/dashboard/orders'); // focus
    at(1_520);
    markNavigationClick('/dashboard/orders');
    at(1_900);
    markNavigationUseful('/dashboard/orders');

    expect(summaries[0]).toMatchObject({ intentLeadMs: 520 });
    expect(performance.getEntriesByName(PERF_MARK.intent)).toHaveLength(1);
  });

  it('is per route: hovering Orders says nothing about a click on Movements', () => {
    at(1_000);
    markNavigationIntent('/dashboard/orders');
    at(1_300);
    markNavigationClick('/dashboard/movements');
    at(1_600);
    markNavigationUseful('/dashboard/movements');
    expect(summaries[0]).toMatchObject({ intentLeadMs: null });
  });

  it('a hover from long ago is not credited to a click now', () => {
    at(1_000);
    markNavigationIntent('/dashboard/orders');
    at(40_000);
    markNavigationClick('/dashboard/orders'); // a breadcrumb: no fresh intent
    at(40_300);
    markNavigationUseful('/dashboard/orders');
    expect(summaries[0]).toMatchObject({ intentLeadMs: null });
  });

  it('a new approach after the window replaces the old time', () => {
    at(1_000);
    markNavigationIntent('/dashboard/orders');
    at(50_000);
    markNavigationIntent('/dashboard/orders');
    at(50_200);
    markNavigationClick('/dashboard/orders');
    at(50_500);
    markNavigationUseful('/dashboard/orders');
    expect(summaries[0]).toMatchObject({ intentLeadMs: 200 });
  });

  it('is consumed by the click: the next visit needs its own', () => {
    at(1_000);
    markNavigationIntent('/dashboard/orders');
    at(1_200);
    markNavigationClick('/dashboard/orders');
    at(1_500);
    markNavigationUseful('/dashboard/orders');
    at(2_000);
    markNavigationClick('/dashboard/orders');
    at(2_300);
    markNavigationUseful('/dashboard/orders');
    expect(summaries.map((s) => (s.kind === 'soft-nav' ? s.intentLeadMs : 'n/a'))).toEqual([
      200,
      null,
    ]);
  });

  it('remembers a bounded number of routes (a keyboard user tabs through the whole sidebar)', () => {
    const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
    letters.forEach((letter, i) => {
      at(1_000 + i);
      markNavigationIntent(`/dashboard/${letter}${letter}`);
    });
    // The oldest fell off the end...
    at(2_000);
    markNavigationClick('/dashboard/aa');
    at(2_100);
    markNavigationUseful('/dashboard/aa');
    // ...the newest is still there.
    at(2_200);
    markNavigationClick('/dashboard/zz');
    at(2_300);
    markNavigationUseful('/dashboard/zz');

    expect(summaries.map((s) => (s.kind === 'soft-nav' ? s.intentLeadMs : 'n/a'))).toEqual([
      null,
      2_200 - 1_025,
    ]);
  });
});

describe('hard load', () => {
  it('reports the landing route once, timed from navigation start', () => {
    landedOn = '/dashboard/inventory';
    goTo('/dashboard/inventory');
    at(1_850);
    markNavigationUseful('/dashboard/inventory');
    at(1_900);
    markNavigationUseful('/dashboard/inventory'); // StrictMode, or a second marker on the page

    expect(summaries).toEqual([{ kind: 'hard-load', route: '/dashboard/inventory', usefulMs: 1_850 }]);
    // The mark itself is emitted every time; only the REPORT is once.
    expect(performance.getEntriesByName(PERF_MARK.useful)).toHaveLength(2);
  });

  it('is not a hard load when the content is for a different route than the document landed on', () => {
    landedOn = '/dashboard/settings';
    at(9_000);
    markNavigationUseful('/dashboard/inventory'); // got here by router.push, no click
    expect(summaries).toEqual([]);
  });

  it('closes for good at the first click: a back-button return is never a multi-minute "load"', () => {
    landedOn = '/dashboard/inventory';
    at(800);
    markNavigationClick('/dashboard/orders'); // left before inventory finished
    at(1_200);
    markNavigationUseful('/dashboard/orders');
    summaries = [];

    at(30_000);
    markNavigationUseful('/dashboard/inventory'); // history.back(): no click, nothing in flight
    expect(summaries).toEqual([]);
  });

  it('drops a load that was hidden before its content arrived (a background tab)', () => {
    landedOn = '/dashboard/inventory';
    setVisibility('hidden');
    setVisibility('visible');
    at(4_000);
    markNavigationUseful('/dashboard/inventory');
    expect(summaries).toEqual([]);
  });

  it('drops a load over 60 seconds', () => {
    landedOn = '/dashboard/inventory';
    at(60_001);
    markNavigationUseful('/dashboard/inventory');
    expect(summaries).toEqual([]);
  });

  it('still reports when the browser has no Navigation Timing entry to compare with', () => {
    landedOn = null;
    at(1_500);
    markNavigationUseful('/dashboard/inventory');
    expect(summaries).toEqual([{ kind: 'hard-load', route: '/dashboard/inventory', usefulMs: 1_500 }]);
  });

  it('landingRoute() is a template', () => {
    landedOn = `/dashboard/inventory/${UUID}?q=acme`;
    expect(landingRoute()).toBe('/dashboard/inventory/[id]');
  });
});

describe('listeners', () => {
  it('holds a measurement taken before anyone was listening, and delivers it once', () => {
    __resetForTests(); // drop the beforeEach listener: nobody is listening now
    landedOn = '/dashboard/inventory';
    at(1_234);
    markNavigationUseful('/dashboard/inventory');

    const late: NavigationSummary[] = [];
    onNavigationMeasured((s) => late.push(s));
    expect(late).toEqual([{ kind: 'hard-load', route: '/dashboard/inventory', usefulMs: 1_234 }]);

    const later: NavigationSummary[] = [];
    onNavigationMeasured((s) => later.push(s));
    expect(later).toEqual([]);
  });

  it('unsubscribes', () => {
    const seen: NavigationSummary[] = [];
    const off = onNavigationMeasured((s) => seen.push(s));
    off();
    at(1_000);
    markNavigationClick('/dashboard/orders');
    at(1_100);
    markNavigationUseful('/dashboard/orders');
    expect(seen).toEqual([]);
    expect(summaries).toHaveLength(1);
  });

  it('a listener that throws breaks neither the page nor the next listener', () => {
    const seen: NavigationSummary[] = [];
    onNavigationMeasured(() => {
      throw new Error('boom');
    });
    onNavigationMeasured((s) => seen.push(s));
    at(1_000);
    markNavigationClick('/dashboard/orders');
    at(1_100);
    expect(() => markNavigationUseful('/dashboard/orders')).not.toThrow();
    expect(seen).toHaveLength(1);
  });
});

describe('never throws', () => {
  it('survives a Performance API that refuses everything', () => {
    vi.spyOn(performance, 'mark').mockImplementation(() => {
      throw new Error('SyntaxError: mark refused');
    });
    vi.spyOn(performance, 'measure').mockImplementation(() => {
      throw new Error('measure refused');
    });
    vi.spyOn(performance, 'clearMarks').mockImplementation(() => {
      throw new Error('clear refused');
    });

    expect(() => {
      at(1_000);
      markNavigationIntent('/dashboard/orders');
      at(1_100);
      markNavigationClick('/dashboard/orders');
      at(1_150);
      markNavigationFeedback();
      at(1_600);
      markNavigationUseful('/dashboard/orders');
    }).not.toThrow();
    // The arithmetic does not depend on the timeline accepting entries.
    expect(summaries[0]).toMatchObject({ clickToFeedbackMs: 50, clickToUsefulMs: 500 });
  });

  it('survives rubbish input', () => {
    expect(() => {
      markNavigationIntent(undefined as unknown as string);
      markNavigationClick(null as unknown as string);
      markNavigationUseful(undefined);
      markNavigationUseful(42 as unknown as string);
      onNavigationMeasured(null as unknown as () => void)();
    }).not.toThrow();
  });
});
