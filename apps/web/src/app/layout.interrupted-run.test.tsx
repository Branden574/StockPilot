import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The root layout runs InterruptedRunExpiry on every page, so a record an
 * interrupted run kept in this tab (lib/interrupted-run) goes once it is over
 * an hour old wherever the tab is, the sign-in page a session that expired
 * left it on above all. The layout's other parts are stood in for: only what
 * it mounts is checked here.
 */

vi.mock('next/font/google', () => {
  const font = () => ({ variable: 'font-var', className: 'font' });
  return { Inter: font, Inter_Tight: font, Instrument_Serif: font, JetBrains_Mono: font };
});
vi.mock('./globals.css', () => ({}));
vi.mock('@/components/analytics/posthog-provider', () => ({
  PostHogProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/theme/theme-provider', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/perf/web-vitals-reporter', () => ({ WebVitalsReporter: () => null }));
vi.mock('@/components/ui/sonner', () => ({ Toaster: () => null }));

import { INTERRUPTED_RUN_PREFIX, INTERRUPTED_RUN_TTL_MS } from '@/lib/interrupted-run';
import {
  fakeBroadcastChannels,
  interruptedRunKeys,
  seedInterruptedRuns,
} from '@/test/interrupted-run-fixtures';

import RootLayout from './layout';

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('root layout: what interrupted runs kept in this tab', () => {
  it('removes a record over an hour old on any page, and keeps a fresh one', () => {
    // The layout owns <html> and <body>; rendered inside the test's container,
    // React warns about the nesting. That is the test's arrangement.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const now = Date.now();
    const record = (at: number) =>
      JSON.stringify({ v: 1, userId: 'user-1', organizationId: 'org-1', at, payload: {} });
    sessionStorage.setItem(
      `${INTERRUPTED_RUN_PREFIX}old`,
      record(now - INTERRUPTED_RUN_TTL_MS - 60_000),
    );
    sessionStorage.setItem(`${INTERRUPTED_RUN_PREFIX}fresh`, record(now - 60_000));

    render(
      <RootLayout>
        <p>the page</p>
      </RootLayout>,
    );

    expect(interruptedRunKeys()).toEqual([`${INTERRUPTED_RUN_PREFIX}fresh`]);
  });

  it('on any page, a sign-out in another tab of this browser removes what this tab kept', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const tabs = fakeBroadcastChannels();
    seedInterruptedRuns();

    render(
      <RootLayout>
        <p>the page</p>
      </RootLayout>,
    );
    tabs.otherTab().postMessage({ type: 'purge' });
    tabs.deliver();

    expect(interruptedRunKeys()).toEqual([]);
  });
});
