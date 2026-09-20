import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sidebar link's spinner is click FEEDBACK, and the performance mark for
 * it (lib/perf/marks.ts) must not land before the spinner has been painted.
 * Same DOUBLE requestAnimationFrame as NavProgressBar, pinned the same way:
 * frames are a queue this test turns by hand. See nav-progress-bar.test.tsx
 * for the reasoning behind "one frame late at worst, never early".
 */

const { statusRef, markNavigationFeedback } = vi.hoisted(() => ({
  statusRef: { pending: false },
  markNavigationFeedback: vi.fn(),
}));

vi.mock('next/link', () => ({ useLinkStatus: () => ({ pending: statusRef.pending }) }));
vi.mock('@/lib/perf/marks', () => ({ markNavigationFeedback }));

import { NavLinkPending } from './nav-link-pending';

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

beforeEach(() => {
  markNavigationFeedback.mockReset();
  statusRef.pending = false;
  frames = new Map();
  nextHandle = 1;
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
});

describe('<NavLinkPending /> feedback mark', () => {
  it('renders nothing and arms no frame while the link is idle', () => {
    const { container } = render(<NavLinkPending />);
    expect(container.innerHTML).toBe('');
    expect(frames.size).toBe(0);
    frame();
    expect(markNavigationFeedback).not.toHaveBeenCalled();
  });

  it('marks feedback on the SECOND frame after the spinner mounts: never before it was painted', () => {
    statusRef.pending = true;
    const { container } = render(<NavLinkPending />);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(markNavigationFeedback).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);

    frame(); // the frame that PAINTS the spinner: its rAF callbacks run before the paint
    expect(markNavigationFeedback).not.toHaveBeenCalled();
    expect(frames.size).toBe(1); // the inner frame is armed

    frame(); // the frame after: the spinner has been on screen
    expect(markNavigationFeedback).toHaveBeenCalledTimes(1);

    frame();
    expect(markNavigationFeedback).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });

  it('a re-render while still pending does not arm a second pair of frames', () => {
    statusRef.pending = true;
    const { rerender } = render(<NavLinkPending />);
    rerender(<NavLinkPending />);
    frame();
    rerender(<NavLinkPending />);
    expect(frames.size).toBe(1);
    frame();
    expect(markNavigationFeedback).toHaveBeenCalledTimes(1);
  });

  it('cancels the OUTER frame when the navigation finishes before any frame (a warm route)', () => {
    statusRef.pending = true;
    const { rerender } = render(<NavLinkPending />);
    statusRef.pending = false;
    rerender(<NavLinkPending />);

    expect(frames.size).toBe(0);
    frame();
    frame();
    expect(markNavigationFeedback).not.toHaveBeenCalled();
  });

  it('cancels the INNER frame when the navigation finishes between the two frames', () => {
    statusRef.pending = true;
    const { rerender } = render(<NavLinkPending />);
    frame();
    expect(frames.size).toBe(1);

    // The spinner is gone: a mark now would be feedback nobody was shown.
    statusRef.pending = false;
    rerender(<NavLinkPending />);

    expect(frames.size).toBe(0);
    frame();
    expect(markNavigationFeedback).not.toHaveBeenCalled();
  });

  it('cancels both frames on unmount, at either stage', () => {
    statusRef.pending = true;
    const first = render(<NavLinkPending />);
    first.unmount();
    expect(frames.size).toBe(0);

    const second = render(<NavLinkPending />);
    frame();
    second.unmount();
    expect(frames.size).toBe(0);

    frame();
    expect(markNavigationFeedback).not.toHaveBeenCalled();
  });

  it('marks again for the next navigation through the same link', () => {
    statusRef.pending = true;
    const { rerender } = render(<NavLinkPending />);
    frame();
    frame();
    statusRef.pending = false;
    rerender(<NavLinkPending />);
    statusRef.pending = true;
    rerender(<NavLinkPending />);
    frame();
    frame();
    expect(markNavigationFeedback).toHaveBeenCalledTimes(2);
  });
});
