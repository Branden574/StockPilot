import { describe, expect, it, vi } from 'vitest';

/**
 * The no-DOM twin of rum.test.ts, in the shape of marks.ssr.test.ts. No
 * environment docblock, so this runs in the `node` project exactly as the
 * module does during a server render: rum.ts is imported by client components
 * that are ALSO rendered on the server, and there it must send nothing.
 */

const { captureMock } = vi.hoisted(() => ({ captureMock: vi.fn() }));

vi.mock('@/lib/analytics', () => ({ capture: captureMock }));

import {
  reportImageError,
  reportImages,
  reportNavigation,
  reportWebVital,
  startPerfRum,
} from './rum';

describe('rum on the server', () => {
  it('really is running without a DOM (otherwise this file proves nothing)', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
  });

  it('every export is a silent no-op: no throw, no capture, no random draw', () => {
    const random = vi.spyOn(Math, 'random');

    expect(() => {
      startPerfRum();
      reportNavigation({
        kind: 'soft-nav',
        fromRoute: '/dashboard',
        toRoute: '/dashboard/orders',
        clickToFeedbackMs: 10,
        clickToUsefulMs: 20,
        intentLeadMs: null,
      });
      reportNavigation({ kind: 'hard-load', route: '/dashboard', usefulMs: 500 });
      reportWebVital({ name: 'LCP', value: 900, delta: 900, rating: 'good' });
      reportImageError('/dashboard', {
        delivery: 'optimizer',
        upstream: 'storage-signed',
        variant: 'thumb',
        requestedWidth: 384,
        requestedQuality: 75,
        signed: true,
      });
      reportImages('/dashboard', [
        {
          delivery: 'optimizer',
          variant: 'thumb',
          durationMs: 40,
          sizesKnown: true,
          cacheHit: false,
        },
      ]);
    }).not.toThrow();

    expect(captureMock).not.toHaveBeenCalled();
    // The sampling decision belongs to a page load, and a server render is not one.
    expect(random).not.toHaveBeenCalled();
  });
});
