import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The performance marks this component owns (lib/perf/marks.ts): CLICK, from
 * its document-level listener, and FEEDBACK, once the bar has been PAINTED.
 *
 * "Painted" is a DOUBLE requestAnimationFrame: the first callback runs before
 * the frame that paints the bar, the second at the start of the frame after
 * it. One frame late at worst, never early, and the same convention as the
 * external harness (tests/perf/collector.ts), so a budget check errs toward
 * the slower number. Frames are a queue the test turns by hand, so "after the
 * first frame, not yet" is an exact assertion and not a race.
 */

const { pathnameRef, searchRef, markNavigationClick, markNavigationFeedback } = vi.hoisted(() => ({
  pathnameRef: { value: '/dashboard' },
  searchRef: { value: '' },
  markNavigationClick: vi.fn(),
  markNavigationFeedback: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.value,
  useSearchParams: () => new URLSearchParams(searchRef.value),
}));
vi.mock('@/lib/perf/marks', () => ({ markNavigationClick, markNavigationFeedback }));

import { NavProgressBar } from './nav-progress-bar';

let frames = new Map<number, FrameRequestCallback>();
let nextHandle = 1;

/** One browser frame: runs what was queued BEFORE it began, like the real thing. */
function frame(): void {
  const due = [...frames.values()];
  frames = new Map();
  act(() => {
    for (const callback of due) callback(0);
  });
}

function link(href: string, attrs: Record<string, string> = {}): HTMLAnchorElement {
  const a = document.createElement('a');
  a.setAttribute('href', href);
  for (const [name, value] of Object.entries(attrs)) a.setAttribute(name, value);
  a.textContent = 'Inventory';
  // The component never prevents the default; stop the test DOM from navigating.
  a.addEventListener('click', (event) => event.preventDefault());
  document.body.appendChild(a);
  return a;
}

function bar(): Element | null {
  return document.querySelector('[aria-hidden="true"].fixed');
}

beforeEach(() => {
  markNavigationClick.mockReset();
  markNavigationFeedback.mockReset();
  frames = new Map();
  nextHandle = 1;
  pathnameRef.value = '/dashboard';
  searchRef.value = '';
  window.history.replaceState(null, '', '/dashboard');
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const handle = nextHandle;
    nextHandle += 1;
    frames.set(handle, callback);
    return handle;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    frames.delete(handle);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('<NavProgressBar /> performance marks', () => {
  it('marks the click with the destination PATHNAME and the event timestamp', () => {
    render(<NavProgressBar />);
    const a = link('/dashboard/inventory?q=acme+widget#photos');
    fireEvent.click(a);

    expect(markNavigationClick).toHaveBeenCalledTimes(1);
    const [href, timeStamp] = markNavigationClick.mock.calls[0] as [string, number];
    expect(href).toBe('/dashboard/inventory'); // no query: a search term never reaches marks.ts
    expect(typeof timeStamp).toBe('number');
    expect(bar()).not.toBeNull();
  });

  it.each([
    ['a modified click (new tab)', '/dashboard/inventory', {}, { metaKey: true }],
    ['a link that opens elsewhere', '/dashboard/inventory', { target: '_blank' }, {}],
    ['a download', '/dashboard/inventory', { download: '' }, {}],
    ['a hash link', '#section', {}, {}],
    ['a protocol link', 'mailto:ops@example.com', {}, {}],
    ['the page already on screen', '/dashboard', {}, {}],
  ])('does not mark %s', (_label, href, attrs, init) => {
    render(<NavProgressBar />);
    fireEvent.click(link(href, attrs), init);
    frame();
    frame();
    expect(markNavigationClick).not.toHaveBeenCalled();
    expect(markNavigationFeedback).not.toHaveBeenCalled();
  });

  it('marks feedback on the SECOND frame after the bar mounts: never before it was painted', () => {
    render(<NavProgressBar />);
    fireEvent.click(link('/dashboard/inventory'));
    expect(markNavigationFeedback).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);

    frame(); // the frame that PAINTS the bar: its rAF callbacks run before the paint
    expect(markNavigationFeedback).not.toHaveBeenCalled();
    expect(frames.size).toBe(1); // the inner frame is armed

    frame(); // the frame after: the bar has been on screen
    expect(markNavigationFeedback).toHaveBeenCalledTimes(1);

    frame();
    frame();
    expect(markNavigationFeedback).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });

  it('cancels the OUTER frame when the route commits before any frame (a cached route)', () => {
    const { rerender } = render(<NavProgressBar />);
    fireEvent.click(link('/dashboard/inventory'));

    pathnameRef.value = '/dashboard/inventory';
    rerender(<NavProgressBar />);

    expect(frames.size).toBe(0);
    frame();
    frame();
    expect(markNavigationFeedback).not.toHaveBeenCalled();
  });

  it('cancels the INNER frame when the route commits between the two frames', () => {
    const { rerender } = render(<NavProgressBar />);
    fireEvent.click(link('/dashboard/inventory'));
    frame();
    expect(frames.size).toBe(1);

    // The bar is leaving 'climbing': feedback for it now would be stamped
    // after the content, for a bar the person is no longer waiting on.
    pathnameRef.value = '/dashboard/inventory';
    rerender(<NavProgressBar />);

    expect(frames.size).toBe(0);
    frame();
    expect(markNavigationFeedback).not.toHaveBeenCalled();
  });

  it('cancels both frames on unmount, at either stage', () => {
    const first = render(<NavProgressBar />);
    fireEvent.click(link('/dashboard/inventory'));
    first.unmount();
    expect(frames.size).toBe(0);

    const second = render(<NavProgressBar />);
    fireEvent.click(link('/dashboard/orders'));
    frame();
    second.unmount();
    expect(frames.size).toBe(0);

    frame();
    expect(markNavigationFeedback).not.toHaveBeenCalled();
  });

  it('a second click while the bar is still climbing does not arm a second pair of frames', () => {
    render(<NavProgressBar />);
    fireEvent.click(link('/dashboard/inventory'));
    fireEvent.click(link('/dashboard/orders'));
    expect(markNavigationClick).toHaveBeenCalledTimes(2);
    expect(frames.size).toBe(1);
    frame();
    frame();
    // marks.ts keeps the first feedback per click; this component asks once per bar.
    expect(markNavigationFeedback).toHaveBeenCalledTimes(1);
  });
});

/**
 * Query-only navigations (owner report 2026-09-22: an item tab click showed
 * nothing for 3.6-6.6 s, because the bar skipped every same-PATH click). The
 * bar now covers them, one task after the click and only if the URL has not
 * moved by then (the Inventory table's instant mode answers some of these in
 * place), and without performance marks (a query change never remounts the
 * page's content, so no "useful" mark would ever close the click).
 */
describe('<NavProgressBar /> query-only navigations', () => {
  const ITEM = '/dashboard/inventory/abc';

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    pathnameRef.value = ITEM;
    window.history.replaceState(null, '', ITEM);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Runs the task queued by the click (the deferred start). */
  function nextTask(): void {
    act(() => {
      vi.advanceTimersByTime(0);
    });
  }

  function climbing(): boolean {
    return bar()?.firstElementChild?.className.includes('nav-progress-climb') ?? false;
  }

  it('starts the bar for a query-only change (an item tab) and completes it when the query moves', () => {
    const { rerender } = render(<NavProgressBar />);
    fireEvent.click(link(`${ITEM}?tab=movements`));
    nextTask();
    expect(climbing()).toBe(true);

    // The server answered: the router commits the new query.
    window.history.replaceState(null, '', `${ITEM}?tab=movements`);
    searchRef.value = 'tab=movements';
    rerender(<NavProgressBar />);
    expect(bar()?.firstElementChild?.className).toContain('nav-progress-complete');
  });

  it('marks neither a click nor feedback for it', () => {
    render(<NavProgressBar />);
    fireEvent.click(link(`${ITEM}?tab=activity`));
    nextTask();
    expect(climbing()).toBe(true);
    expect(frames.size).toBe(0);
    frame();
    frame();
    expect(markNavigationClick).not.toHaveBeenCalled();
    expect(markNavigationFeedback).not.toHaveBeenCalled();
  });

  it('shows no bar when the click was answered in place (instant mode pushState in the click handler)', () => {
    render(<NavProgressBar />);
    const a = link(`${ITEM}?page=2`);
    a.addEventListener('click', () => window.history.pushState(null, '', `${ITEM}?page=2`));
    fireEvent.click(a);
    nextTask();
    expect(bar()).toBeNull();
  });

  it.each([
    ['the exact URL on screen (the selected tab)', '?tab=movements', '?tab=movements'],
    ['the same params spelled differently', '?q=acme+widget', '?q=acme%20widget'],
  ])('does nothing for a link to %s', (_label, onScreen, href) => {
    window.history.replaceState(null, '', `${ITEM}${onScreen}`);
    searchRef.value = onScreen.slice(1);
    render(<NavProgressBar />);
    fireEvent.click(link(`${ITEM}${href}`));
    nextTask();
    expect(bar()).toBeNull();
  });

  it('a path click right after a query-only click wins: it is marked and starts the bar at once', () => {
    render(<NavProgressBar />);
    fireEvent.click(link(`${ITEM}?tab=movements`));
    fireEvent.click(link('/dashboard/orders'));
    expect(climbing()).toBe(true);
    expect(markNavigationClick).toHaveBeenCalledTimes(1);
    expect(markNavigationClick.mock.calls[0]?.[0]).toBe('/dashboard/orders');
    nextTask();
    frame();
    frame();
    expect(markNavigationFeedback).toHaveBeenCalledTimes(1);
  });

  it('still gives up after 8 s when a query-only navigation never lands', () => {
    render(<NavProgressBar />);
    fireEvent.click(link(`${ITEM}?tab=movements`));
    nextTask();
    expect(climbing()).toBe(true);
    act(() => {
      vi.advanceTimersByTime(8001);
    });
    expect(bar()).toBeNull();
  });

  it('a deferred start never fires after the bar has unmounted', () => {
    const view = render(<NavProgressBar />);
    fireEvent.click(link(`${ITEM}?tab=movements`));
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
