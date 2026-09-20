import { describe, expect, it, vi } from 'vitest';

import {
  landingRoute,
  markNavigationClick,
  markNavigationFeedback,
  markNavigationIntent,
  markNavigationUseful,
  onNavigationMeasured,
} from './marks';

/**
 * The no-DOM twin of marks.test.ts. No environment docblock, so this runs in
 * the `node` project exactly as the module does during a server render: there
 * is a global `performance` (Node has one) but no `window` and no `document`.
 * marks.ts is imported by client components that are ALSO rendered on the
 * server, so importing it and calling it there must do nothing at all.
 */
describe('marks on the server', () => {
  it('really is running without a DOM (otherwise this file proves nothing)', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
    expect(typeof performance).toBe('object');
  });

  it('every export is a silent no-op: no throw, no marks, no report', () => {
    const mark = vi.spyOn(performance, 'mark');
    const measure = vi.spyOn(performance, 'measure');
    const listener = vi.fn();

    expect(() => {
      const off = onNavigationMeasured(listener);
      markNavigationIntent('/dashboard/inventory');
      markNavigationClick('/dashboard/inventory', 12);
      markNavigationFeedback();
      markNavigationUseful('/dashboard/inventory');
      markNavigationUseful(null);
      off();
    }).not.toThrow();

    expect(mark).not.toHaveBeenCalled();
    expect(measure).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(landingRoute()).toBeNull();
  });
});
