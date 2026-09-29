import { type Href, Redirect, useLocalSearchParams } from 'expo-router';

import { bookReportNativePathFromParams } from '@/lib/book-order-totals-link';

/**
 * Cold-start shim for a web Book Order Totals link. On a COLD start
 * expo-router hands the router the raw web path without +native-intent, and
 * with no matching route a link dead-ended on "Unmatched Route" (the
 * app/dashboard/cycle-counts/[id].tsx pattern). Warm links go through
 * web-path-rewrite.ts; both keep only the filters core's
 * parseBookReportQuery accepts (bookReportNativePathFromParams).
 */
export default function BookOrderTotalsDeepLinkRedirect() {
  const params = useLocalSearchParams() as Record<string, string | string[] | undefined>;
  return <Redirect href={bookReportNativePathFromParams(params) as Href} />;
}
