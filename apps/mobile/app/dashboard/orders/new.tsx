import { type Href, Redirect } from 'expo-router';

/**
 * Cold-start shim for a web /dashboard/orders/new link (phone ordering PO-4).
 * On a COLD start expo-router hands the router the raw web path without
 * +native-intent, and the path reached the order/[id] shim beside this file
 * with id "new" (audit D9). Static beats dynamic, so this file wins and
 * redirects to the native storefront. Warm links go through
 * web-path-rewrite.ts.
 */
export default function NewOrderDeepLinkRedirect() {
  return <Redirect href={'/order/new' as Href} />;
}
