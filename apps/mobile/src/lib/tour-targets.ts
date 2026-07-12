import * as React from 'react';
import type { View } from 'react-native';

/**
 * Tour target registry (mobile spotlight v2). RN has no CSS selectors, so
 * screens explicitly register the views a tour may highlight:
 *
 *   const searchRef = useTourTarget('inventory-search');
 *   <View ref={searchRef}>…</View>
 *
 * The engine measures registered targets with measureInWindow at step time —
 * coordinates are window-global, so it works regardless of scroll position
 * or nesting. Unregistered / unmeasurable targets degrade to a plain
 * (un-spotlit) step, never an error: tours must survive any org state.
 */

const registry = new Map<string, React.RefObject<View | null>>();

export function useTourTarget(id: string): React.RefObject<View | null> {
  const ref = React.useRef<View | null>(null);
  React.useEffect(() => {
    registry.set(id, ref);
    return () => {
      // Another instance may have re-registered (list re-mounts) — only
      // delete if we still own the slot.
      if (registry.get(id) === ref) registry.delete(id);
    };
  }, [id]);
  return ref;
}

export interface TargetRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function measureTarget(id: string): Promise<TargetRect | null> {
  return new Promise((resolve) => {
    const node = registry.get(id)?.current;
    if (!node) {
      resolve(null);
      return;
    }
    // measureInWindow never rejects; guard with a timeout in case the view
    // is unmounted mid-measure (callback then simply never fires).
    const timer = setTimeout(() => resolve(null), 300);
    node.measureInWindow((x, y, width, height) => {
      clearTimeout(timer);
      // Zero-size = not laid out (display:none equivalents); treat as absent.
      if (!width || !height || !Number.isFinite(x) || !Number.isFinite(y)) {
        resolve(null);
      } else {
        resolve({ x, y, width, height });
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* Tour-active broadcast: screens subscribe so they can adapt while a  */
/* tour runs (e.g. render a labeled SAMPLE row when the list is empty  */
/* so the "tap an item" step has something real to highlight).         */
/* ------------------------------------------------------------------ */

const activeListeners = new Set<(id: string | null) => void>();
let activeTourId: string | null = null;

export function setActiveTour(id: string | null): void {
  activeTourId = id;
  activeListeners.forEach((fn) => fn(id));
}

export function useTourActive(tourId: string): boolean {
  const [active, setActive] = React.useState(activeTourId === tourId);
  React.useEffect(() => {
    const fn = (id: string | null) => setActive(id === tourId);
    activeListeners.add(fn);
    fn(activeTourId);
    return () => {
      activeListeners.delete(fn);
    };
  }, [tourId]);
  return active;
}
