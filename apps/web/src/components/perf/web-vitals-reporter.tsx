'use client';

import { usePathname } from 'next/navigation';
import { useReportWebVitals } from 'next/web-vitals';
import { useEffect } from 'react';

import { reportWebVital, startPerfRum } from '@/lib/perf/rum';
import { isSharePath } from '@/lib/share-paths';

/**
 * MODULE-LEVEL ON PURPOSE. `useReportWebVitals` re-subscribes whenever the
 * function it is given changes identity, and a new subscriber is replayed
 * every metric collected so far (Next docs, use-report-web-vitals: "ensure
 * that the callback function reference does not change"). An inline arrow
 * would therefore re-send TTFB, FCP and LCP on every render of this component,
 * which sits in the root layout and re-renders on every navigation.
 *
 * It forwards the metric to `reportWebVital`, which reads five scalar fields
 * and nothing else. In particular it never touches `metric.entries`: the LCP
 * entry's `url` is a signed photo URL.
 */
type ReportWebVitalsCallback = Parameters<typeof useReportWebVitals>[0];
const handleWebVital: ReportWebVitalsCallback = (metric) => {
  reportWebVital(metric);
};

function Reporter() {
  useReportWebVitals(handleWebVital);
  // The one performance component present on every route, so it is also where
  // the navigation marks get connected to analytics. Idempotent.
  useEffect(() => {
    startPerfRum();
  }, []);
  return null;
}

/**
 * Real-user web vitals (TTFB, FCP, LCP, CLS, INP) and the navigation-timing
 * listener. Mounted once, in the root layout, next to the PostHog provider.
 * Renders nothing.
 *
 * Never subscribes on a share path (`/r/<token>`, `/m/<token>`): analytics is
 * not initialized on those URLs (see posthog-provider.tsx), so there is nowhere
 * for a metric to go, and `rum.ts` refuses to send from one anyway. Hooks cannot
 * be conditional, hence the inner component.
 */
export function WebVitalsReporter() {
  const pathname = usePathname();
  if (isSharePath(pathname)) return null;
  return <Reporter />;
}
