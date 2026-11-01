import { type Href, Redirect } from 'expo-router';

/**
 * Cold-start shim for a web /dashboard/orders/manage-items link (ordering
 * visibility, 0413; design 8.6). On a COLD start expo-router hands the router
 * the raw web path without +native-intent, and the path reached the
 * order/[id] shim beside this file with id "manage-items". Static beats
 * dynamic, so this file wins and redirects to the native management screen.
 * Warm links go through web-path-rewrite.ts.
 */
export default function ManageOrderItemsDeepLinkRedirect() {
  return <Redirect href={'/order/manage-items' as Href} />;
}
