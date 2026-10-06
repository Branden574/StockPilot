import { act, type ReactNode } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { vi } from 'vitest';

/**
 * A REAL server render followed by a REAL hydration, with the clock and the
 * time zone each side would have.
 *
 * Production (2026-10-05): React error #418 on /dashboard/movements and
 * /dashboard/returns/[id]. A client component renders on the server first
 * (Vercel: UTC, the server's clock) and again in the browser while it
 * hydrates (the viewer's zone and clock, a minute or more later). Text that
 * depends on either ("3 minutes ago", a toLocaleDateString()) can come out
 * different, and React then discards the server HTML. A plain render() never
 * hydrates, so it cannot see this; this helper does what the browser does.
 */
export interface ClockShift {
  /** The server's clock at its render (ms since the epoch). */
  serverNow: number;
  /** The browser's clock when it hydrates: later than the server, or behind it. */
  browserNow: number;
  /** The server's zone. Default UTC, as on Vercel. */
  serverZone?: string;
  /** The browser's zone. Default America/Los_Angeles, where every organization is today. */
  browserZone?: string;
}

export interface HydrationRun {
  /** The element the server HTML was hydrated into. */
  container: HTMLElement;
  /** The server render. */
  html: string;
  /** Every recoverable error React raised and everything it printed with console.error while hydrating. */
  errors: unknown[];
  unmount: () => void;
}

function setZone(zone: string | undefined) {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
}

/**
 * Runs `fn` with this process in `zone`, then restores the zone: what a
 * browser there would print, e.g. inZone(LA, () => new Date(at).toLocaleDateString()).
 */
export function inZone<T>(zone: string, fn: () => T): T {
  const previous = process.env.TZ;
  setZone(zone);
  try {
    return fn();
  } finally {
    setZone(previous);
  }
}

/** The browser zone hydrateAcrossClockShift uses unless told otherwise. */
export const BROWSER_ZONE = 'America/Los_Angeles';

/**
 * Renders `render()` on the server side of `shift`, puts the HTML in the
 * document, then hydrates a fresh `render()` over it on the browser side, and
 * returns what React reported. The zone and fake clock are restored before
 * returning; text React printed after hydration stays in the DOM to assert on.
 */
export async function hydrateAcrossClockShift(
  render: () => ReactNode,
  shift: ClockShift,
): Promise<HydrationRun> {
  const previousZone = process.env.TZ;
  vi.useFakeTimers({ toFake: ['Date'] });
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = env.IS_REACT_ACT_ENVIRONMENT;
  try {
    setZone(shift.serverZone ?? 'UTC');
    vi.setSystemTime(shift.serverNow);
    const html = renderToString(render());

    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);

    setZone(shift.browserZone ?? BROWSER_ZONE);
    vi.setSystemTime(shift.browserNow);
    const errors: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    // Effects and the post-hydration re-render run inside act(); tell React
    // this is a test so it flushes them without a warning.
    env.IS_REACT_ACT_ENVIRONMENT = true;
    let root: Root | undefined;
    try {
      await act(async () => {
        root = hydrateRoot(container, render(), {
          onRecoverableError: (error) => errors.push(error),
        });
      });
    } finally {
      consoleError.mockRestore();
    }
    return {
      container,
      html,
      errors,
      unmount: () => {
        const before = env.IS_REACT_ACT_ENVIRONMENT;
        env.IS_REACT_ACT_ENVIRONMENT = true;
        try {
          act(() => root?.unmount());
        } finally {
          env.IS_REACT_ACT_ENVIRONMENT = before;
          container.remove();
        }
      },
    };
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    vi.useRealTimers();
    setZone(previousZone);
  }
}
