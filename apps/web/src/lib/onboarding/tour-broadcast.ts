import * as React from 'react';

/**
 * Tour-active broadcast (client-only, mirrors the mobile pattern in
 * apps/mobile/src/lib/tour-targets.ts): PageTour announces while a tour
 * runs so other client components can adapt — e.g. the Items page renders
 * a labeled SAMPLE row on an empty org so the "here's a row" step has a
 * real element to spotlight. Module-level state is safe here: it only
 * exists in the browser bundle and resets on navigation like any client
 * state.
 */

let activeTourId: string | null = null;
const listeners = new Set<(id: string | null) => void>();

export function setActiveTour(id: string | null): void {
  activeTourId = id;
  listeners.forEach((fn) => fn(id));
}

export function useTourActive(tourId: string): boolean {
  const [active, setActive] = React.useState(activeTourId === tourId);
  React.useEffect(() => {
    const fn = (id: string | null) => setActive(id === tourId);
    listeners.add(fn);
    fn(activeTourId);
    return () => {
      listeners.delete(fn);
    };
  }, [tourId]);
  return active;
}
