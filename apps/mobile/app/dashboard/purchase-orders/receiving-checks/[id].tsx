import { type Href, Redirect, useLocalSearchParams } from 'expo-router';

import { isUuid } from '@stockpilot/core';

/**
 * Cold-start shim for a web link to one receipt's receiving checklist
 * (/dashboard/purchase-orders/receiving-checks/<id>, F4-1). On a COLD start
 * expo-router hands the router the raw web path without +native-intent, and
 * with no matching route the link showed "Unmatched Route". A malformed id
 * goes home, as web-path-rewrite.ts sends it on a warm link.
 */
export default function ReceivingCheckDeepLinkRedirect() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Redirect href={(isUuid(id) ? `/receiving-check/${id}` : '/') as Href} />;
}
