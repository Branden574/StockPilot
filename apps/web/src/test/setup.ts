import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Silence the `audit.write_failed` stderr that floods tests not running
// inside a Next request scope. audit() calls `next/headers#headers()`,
// which throws outside a request, then routes the error to reportError
// (loud stderr). This default no-op stub keeps every test green and
// quiet; the few tests that ASSERT on audit (profile.test.ts,
// shipments.test.ts) provide their own per-file vi.mock which Vitest
// hoists ahead of this setup, so their assertions still work.
vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
}));

// Most React tests use happy-dom via the environmentMatchGlobs in vitest.config.
// Only land DOM-flavoured polyfills when a window exists.
if (typeof window !== 'undefined') {
  // ResizeObserver: radix + headless components depend on it.
  if (!('ResizeObserver' in window)) {
    class ResizeObserverPolyfill {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (window as unknown as { ResizeObserver: typeof ResizeObserverPolyfill }).ResizeObserver =
      ResizeObserverPolyfill;
  }
  // matchMedia stub for components that read prefers-color-scheme etc.
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
  }
  // scrollIntoView is missing in happy-dom and used by radix Select etc.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
}

// Reset module mocks + DOM between tests so suites stay isolated.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
