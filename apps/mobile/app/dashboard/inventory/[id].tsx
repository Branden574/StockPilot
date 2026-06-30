import { Redirect, useLocalSearchParams } from 'expo-router';

/**
 * Deep-link redirect shim for inventory-item notifications. The server emits
 * the WEB path `/dashboard/inventory/{id}`; the native screen is `/item/{id}`.
 * See orders/[id].tsx for why a real route is required to survive a
 * cold-start notification tap.
 */
export default function ItemDeepLinkRedirect() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Redirect href={{ pathname: '/item/[id]', params: { id } }} />;
}
