import { act, render, screen } from '@testing-library/react';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The "useful" marker is the END of every navigation timing, so the two ways
 * it can lie are the ones pinned here: firing more than once per mount (a
 * re-render would restart or double-close a navigation) and firing where no
 * person is looking (a server render). marks.ts is mocked: what it does with
 * the call is marks.test.ts's business.
 */

const { markNavigationUseful } = vi.hoisted(() => ({ markNavigationUseful: vi.fn() }));

vi.mock('@/lib/perf/marks', () => ({ markNavigationUseful }));

import { PerfUseful, usePerfUseful } from './perf-useful';

const UUID = '3f2c1a9e-7b4d-4c1e-9a2f-0d5e6f7a8b9c';

// The marker waits two animation frames (so it lands after the paint). These
// tests are about WHEN IT FIRES AND HOW OFTEN, so frames run at once here; the
// "two frames" describe block below turns them by hand.
const runFramesAtOnce = () =>
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });

beforeEach(() => {
  markNavigationUseful.mockReset();
  window.history.replaceState(null, '', '/dashboard/inventory');
  runFramesAtOnce();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('two frames', () => {
  let frames: Array<FrameRequestCallback | null>;
  const turnFrame = () => {
    const due = frames;
    frames = [];
    act(() => due.forEach((cb) => cb?.(0)));
  };
  beforeEach(() => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
      if (handle > 0) frames[handle - 1] = null;
    });
  });

  it('marks after the SECOND frame, never in the effect: an effect runs before its commit is painted', () => {
    render(<PerfUseful />);
    expect(markNavigationUseful).not.toHaveBeenCalled();
    turnFrame();
    expect(markNavigationUseful).not.toHaveBeenCalled();
    turnFrame();
    expect(markNavigationUseful).toHaveBeenCalledTimes(1);
    expect(markNavigationUseful).toHaveBeenCalledWith('/dashboard/inventory');
  });

  it('reports the path it MOUNTED on, even if the URL has moved by the second frame', () => {
    render(<PerfUseful />);
    turnFrame();
    window.history.replaceState(null, '', '/dashboard/orders');
    turnFrame();
    expect(markNavigationUseful).toHaveBeenCalledWith('/dashboard/inventory');
  });

  it('marks nothing for content that was gone before it could be seen', () => {
    const view = render(<PerfUseful />);
    turnFrame();
    view.unmount();
    turnFrame();
    expect(markNavigationUseful).not.toHaveBeenCalled();
  });
});

describe('<PerfUseful />', () => {
  it('marks useful on mount, exactly once, with the pathname on screen', () => {
    render(<PerfUseful />);
    expect(markNavigationUseful).toHaveBeenCalledTimes(1);
    expect(markNavigationUseful).toHaveBeenCalledWith('/dashboard/inventory');
  });

  it('does not mark again when it re-renders, with or without new children', () => {
    const { rerender } = render(
      <PerfUseful>
        <p>30 rows</p>
      </PerfUseful>,
    );
    rerender(
      <PerfUseful>
        <p>30 rows</p>
      </PerfUseful>,
    );
    rerender(
      <PerfUseful>
        <p>4,812 rows</p>
      </PerfUseful>,
    );
    rerender(<PerfUseful />);
    expect(markNavigationUseful).toHaveBeenCalledTimes(1);
  });

  it('renders its children untouched and adds no markup of its own', () => {
    const { container } = render(
      <PerfUseful>
        <section aria-label="Empty state">
          <h2>No items yet</h2>
        </section>
      </PerfUseful>,
    );
    expect(screen.getByRole('heading', { name: 'No items yet' })).toBeInTheDocument();
    expect(container.innerHTML).toBe(
      '<section aria-label="Empty state"><h2>No items yet</h2></section>',
    );
  });

  it('renders nothing at all when it is used as a sibling marker', () => {
    const { container } = render(<PerfUseful />);
    expect(container.innerHTML).toBe('');
  });

  it('hands over the PATHNAME only: the query string (search terms, filters) never leaves the address bar', () => {
    window.history.replaceState(null, '', `/dashboard/inventory/${UUID}?q=acme+widget#photos`);
    render(<PerfUseful />);
    expect(markNavigationUseful).toHaveBeenCalledWith(`/dashboard/inventory/${UUID}`);
  });

  it('a new mount is a new arrival: unmounting and mounting again marks again', () => {
    const first = render(<PerfUseful />);
    first.unmount();
    window.history.replaceState(null, '', '/dashboard/orders');
    render(<PerfUseful />);
    expect(markNavigationUseful.mock.calls).toEqual([
      ['/dashboard/inventory'],
      ['/dashboard/orders'],
    ]);
  });

  it('does NOT mark during a server render: nobody is looking at a string of HTML', () => {
    const html = renderToString(
      <PerfUseful>
        <p>30 rows</p>
      </PerfUseful>,
    );
    expect(html).toContain('30 rows');
    expect(markNavigationUseful).not.toHaveBeenCalled();
  });
});

describe('usePerfUseful()', () => {
  function Table({ rows }: { rows: number }) {
    usePerfUseful();
    const [selected, setSelected] = React.useState(0);
    return (
      <button type="button" onClick={() => setSelected((n) => n + 1)}>
        {rows} rows, {selected} selected
      </button>
    );
  }

  it('marks once when the host mounts, and stays quiet through prop AND state re-renders', () => {
    // The inventory table adopting its streamed dataset is a state change on a
    // mounted instance. First rows first: that must not count as a second arrival.
    const { rerender } = render(<Table rows={30} />);
    expect(markNavigationUseful).toHaveBeenCalledTimes(1);

    rerender(<Table rows={4812} />);
    act(() => screen.getByRole('button').click());
    act(() => screen.getByRole('button').click());

    expect(screen.getByRole('button')).toHaveTextContent('4812 rows, 2 selected');
    expect(markNavigationUseful).toHaveBeenCalledTimes(1);
  });

  it('causes no render of its own: the host renders once on mount', () => {
    let renders = 0;
    function Counted() {
      renders += 1;
      usePerfUseful();
      return null;
    }
    render(<Counted />);
    expect(renders).toBe(1);
    expect(markNavigationUseful).toHaveBeenCalledTimes(1);
  });

  it('does not mark during a server render', () => {
    expect(renderToString(<Table rows={30} />)).toContain('30');
    expect(markNavigationUseful).not.toHaveBeenCalled();
  });
});
