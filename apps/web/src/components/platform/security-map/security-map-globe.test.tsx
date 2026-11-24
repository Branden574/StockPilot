import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SECURITY_MAP_WORDS } from '@stockpilot/core';

/**
 * The globe's wrapper (security-map-globe.tsx): it asks the browser for a
 * WebGL 2 context on a canvas of its own BEFORE it loads the renderer, so a
 * browser without one shows the flat map with nothing in its console and
 * never fetches three.js; with one it loads the renderer, hands it the play
 * and the labels, and frees it on unmount. The renderer is a stub here
 * (WebGL cannot run in the test environment). Made-up data only.
 */

type Stub = ReturnType<typeof vi.fn>;
const r = vi.hoisted(() => ({
  imported: 0,
  handle: null as null | {
    show: Stub;
    setRunning: Stub;
    resize: Stub;
    setLabels: Stub;
    dispose: Stub;
  },
}));

/** The renderer's stub; its factory counts each time the renderer is loaded. */
function mockRenderer() {
  vi.doMock('./globe-renderer', () => {
    r.imported += 1;
    return {
      createGlobe: vi.fn(() => {
        r.handle = {
          show: vi.fn(),
          setRunning: vi.fn(),
          resize: vi.fn(),
          setLabels: vi.fn(),
          dispose: vi.fn(),
        };
        return r.handle;
      }),
    };
  });
}

/**
 * The wrapper, loaded afresh for each test (the module registry is reset and
 * the renderer's stub registered again before each), so the stub's factory
 * runs once in each test that loads the renderer, and `r.imported` counts
 * that test's loads alone, whatever order the tests run in (review round 2, N5).
 */
async function wrapper() {
  return (await import('./security-map-globe')).SecurityMapGlobe;
}

const props = (over: Record<string, unknown> = {}) => ({
  arcs: [],
  timing: 'live' as const,
  startedAt: 0,
  stepMs: 2500,
  target: { yaw: 0, pitch: 0.3, sway: 0.2 },
  mayTurn: true,
  still: false,
  hidden: false,
  heat: new Map<string, number>(),
  labels: [{ code: 'DE', from: [10, 51] as const, name: 'Germany', count: '12' }],
  showLabels: true,
  insets: { topLeft: { w: 0, h: 0 }, right: 0, bottom: 0 },
  onUnavailable: vi.fn(),
  onLost: vi.fn(),
  ...over,
});

let gl: unknown = null;
let lost = 0;

beforeEach(() => {
  vi.resetModules();
  mockRenderer();
  r.imported = 0;
  r.handle = null;
  lost = 0;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => gl as RenderingContext | null,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Lets the dynamic import land. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('the globe wrapper', () => {
  it('no WebGL 2: the flat map is asked for, and the renderer (three.js) is never loaded', async () => {
    gl = null;
    const SecurityMapGlobe = await wrapper();
    const p = props();
    render(<SecurityMapGlobe {...p} />);
    await settle();
    expect(p.onUnavailable).toHaveBeenCalledTimes(1);
    expect(r.imported).toBe(0);
    expect(r.handle).toBeNull();
  });

  it('WebGL 2: the test context is given back, the renderer is loaded and handed the play and the labels; freed on unmount', async () => {
    gl = { getExtension: () => ({ loseContext: () => (lost += 1) }) };
    const SecurityMapGlobe = await wrapper();
    const p = props();
    const view = render(<SecurityMapGlobe {...p} />);
    await settle();
    expect(lost).toBe(1);
    expect(r.imported).toBe(1);
    expect(p.onUnavailable).not.toHaveBeenCalled();
    expect(r.handle!.show).toHaveBeenCalledWith(
      expect.objectContaining({
        arcs: [],
        timing: 'live',
        target: { yaw: 0, pitch: 0.3, sway: 0.2 },
        still: false,
      }),
    );
    const labels = r.handle!.setLabels.mock.calls.at(-1)![0] as Array<{ kind: string }>;
    expect(labels.map((l) => l.kind)).toEqual(['stockpilot', 'source']);
    expect(screen.getByTestId('security-map-label-stockpilot').textContent).toBe(
      SECURITY_MAP_WORDS.stockpilot,
    );
    expect(screen.getByTestId('security-map-label-source').textContent).toBe('Germany12');
    // Everything on the canvas and over it is hidden from screen readers.
    expect(screen.getByTestId('security-map-globe').getAttribute('aria-hidden')).toBe('true');
    expect(
      screen.getByTestId('security-map-label-stockpilot').closest('[aria-hidden="true"]'),
    ).not.toBeNull();
    view.unmount();
    expect(r.handle!.dispose).toHaveBeenCalledTimes(1);
  });

  it("no WebGL 2 after a test that loaded the renderer: still never loaded (the count is this test's own)", async () => {
    gl = { getExtension: () => null };
    const First = await wrapper();
    const first = render(<First {...props()} />);
    await settle();
    expect(r.imported).toBe(1);
    first.unmount();
    vi.resetModules();
    mockRenderer();
    r.imported = 0;
    gl = null;
    const SecurityMapGlobe = await wrapper();
    const p = props();
    render(<SecurityMapGlobe {...p} />);
    await settle();
    expect(p.onUnavailable).toHaveBeenCalledTimes(1);
    expect(r.imported).toBe(0);
  });

  it('a phone: no words on the globe', async () => {
    gl = { getExtension: () => null };
    const SecurityMapGlobe = await wrapper();
    render(<SecurityMapGlobe {...props({ showLabels: false })} />);
    await settle();
    expect(r.imported).toBe(1);
    await settle();
    expect(screen.queryByTestId('security-map-label-stockpilot')).toBeNull();
    expect(screen.queryByTestId('security-map-label-source')).toBeNull();
    expect(r.handle!.setLabels.mock.calls.at(-1)![0]).toEqual([]);
  });
});
