import { Redirect, useLocalSearchParams } from 'expo-router';

/**
 * Deep-link redirect shim. Push notifications carry the WEB path
 * `/dashboard/orders/{id}` (the same `notifications` row also links the web
 * app). The native order screen is `/order/{id}`. On a COLD start (app killed
 * → notification tap), expo-router's `getInitialURL` hands the router this raw
 * web path WITHOUT routing it through `+native-intent`'s `redirectSystemPath`,
 * so without a matching route it dead-ends on "Unmatched Route". This shim
 * makes the web path a real route that immediately redirects to the native
 * screen — covering cold start, warm start, and universal links alike.
 */
export default function OrderDeepLinkRedirect() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Redirect href={{ pathname: '/order/[id]', params: { id } }} />;
}
