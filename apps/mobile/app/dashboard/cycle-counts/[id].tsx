import { Redirect, useLocalSearchParams } from 'expo-router';

/**
 * Deep-link redirect shim for the cycle-count assignment notification, whose
 * link is the WEB path `/dashboard/cycle-counts/{id}` (the same `notifications`
 * row also links the web app). The native screen is `/cycle-count/{id}`.
 * Warm taps already go through web-path-rewrite.ts, but on a COLD start
 * expo-router hands the router the raw web path without `+native-intent`, and
 * with no matching route the tap dead-ended on "Unmatched Route". Same shape
 * as app/dashboard/orders/[id].tsx.
 */
export default function CycleCountDeepLinkRedirect() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Redirect href={{ pathname: '/cycle-count/[id]', params: { id } }} />;
}
