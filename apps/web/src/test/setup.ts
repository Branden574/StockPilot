import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Silence the `audit.write_failed` stderr that floods tests not running
// inside a Next request scope. audit() calls `next/headers#headers()`,
// which throws outside a request, then routes the error to reportError
// (loud stderr). This default no-op stub keeps every test green and
// quiet; the few tests that ASSERT on audit (profile.test.ts) provide
// their own per-file vi.mock which Vitest hoists ahead of this setup,
// so their assertions still work.
vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
  auditMany: vi.fn(async (payloads: readonly unknown[]) => ({
    written: payloads.length,
    lost: 0,
  })),
  // Hands the row to the (mocked) admin client exactly as the call sites did
  // before they used this helper, so tests that capture audit rows through
  // their admin-client mock keep asserting the same rows. Like the real
  // helper it never throws. The real one is tested in services/audit.test.ts.
  insertAuditRowReported: vi.fn(async (row: unknown) => {
    try {
      const { createAdminClient } = await import('@/lib/supabase/admin');
      const res = (await createAdminClient().from('audit_logs').insert(row as never)) as
        | { error?: unknown }
        | undefined;
      return !res?.error;
    } catch {
      return false;
    }
  }),
}));

// Same reason, same shape: every service stock write now calls
// invalidateInventoryListAfterWrite, whose real revalidateTag throws outside a
// Next request scope ("static generation store missing") and is then logged —
// one console.warn per write in every service test. Only that never-throwing
// wrapper is stubbed; inventoryListTag / revalidateInventoryList stay real so
// the loader's own tests (which mock next/cache) still exercise them. A test
// that asserts on the invalidation imports this vi.fn and inspects it, or
// declares its own vi.mock of the module to run the real wrapper.
vi.mock('@/server/services/lib/inventory-list-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/lib/inventory-list-cache')>()),
  invalidateInventoryListAfterWrite: vi.fn(),
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
//
// THIS IS THE ONLY GLOBAL MOCK RESET FOR ~1,700 vi.mock SITES. Every file in
// the web suite leans on it: a vi.fn() set up in a vi.mock factory, given a
// mockResolvedValue in one test, must be back to its factory implementation
// with zero recorded calls by the next test.
//
// WHY TWO CALLS (the Vitest 4 upgrade, 2026-09):
// On Vitest 3, vi.restoreAllMocks() alone did all of that. It walked every
// mock ever created and called mockRestore() on it, and mockRestore() was
// mockReset() plus putting a vi.spyOn() property back
// (@vitest/spy 3.2.7: `stub.mockRestore = () => { stub.mockReset();
// state.restore(); }`). So one call cleared calls/results, dropped
// mockImplementation / mockReturnValue / the *Once queues, sent a
// vi.fn(impl) back to `impl`, and un-patched every vi.spyOn.
//
// Vitest 4 split that apart. vi.restoreAllMocks() now ONLY puts vi.spyOn
// properties back (@vitest/spy 4.1.11: `for (const restore of MOCK_RESTORE)
// restore();`) and leaves every mock's calls and implementation alone; the
// migration guide says it "no longer resets the state of spies and only
// restores spies created manually with vi.spyOn". Left as the single call,
// 62 web tests in 18 files failed on the upgrade, on call counts and on
// mockResolvedValue overrides leaking from one test into the next.
//
// vi.resetAllMocks() is the other half: mockReset() on every registered mock,
// which clears state and sets the implementation back to what the mock was
// created with (vi.fn(impl) -> impl, vi.fn() / automock -> undefined, vi.spyOn
// -> call-through). Both together give each test the isolation it had on
// Vitest 3. Do NOT reduce this to one call.
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});
