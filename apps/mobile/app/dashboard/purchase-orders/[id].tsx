import { Redirect, useLocalSearchParams } from 'expo-router';

/**
 * Deep-link redirect shim for purchase-order notifications. The server emits
 * the WEB path `/dashboard/purchase-orders/{id}`; the native screen is
 * `/po/{id}`. See orders/[id].tsx for why a real route (not just the
 * notification tap handler or `+native-intent`) is required to survive a
 * cold-start notification tap.
 */
export default function PurchaseOrderDeepLinkRedirect() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Redirect href={{ pathname: '/po/[id]', params: { id } }} />;
}
