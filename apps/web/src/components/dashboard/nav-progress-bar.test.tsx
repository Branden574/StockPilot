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

const { pathnameRef, markNavigationClick, markNavigationFeedback } = vi.hoisted(() => ({
  pathnameRef: { value: '/dashboard' },
  markNavigationClick: vi.fn(),
  markNavigationFeedback: vi.fn(),
}));

vi.mock('next/navigation', () => ({ usePathname: () => pathnameRef.value }));
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
