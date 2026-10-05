import { Redirect, useLocalSearchParams } from 'expo-router';

/**
 * Deep-link redirect shim for the RMA workbench (returns RX-1). Staff pushes
 * carry the WEB path `/dashboard/returns/<rma>?order=/dashboard/orders/<id>`
 * (the dual link, returns plan C-3). A push tap is rewritten by
 * use-push-notifications.ts before it is opened, and this expo-router passes
 * an initial URL through `+native-intent` too (web-path-rewrite.returns.test.ts
 * pins both), so this route is the belt: should the raw web path ever reach
 * the router (an older router that skipped `+native-intent` on a cold start,
 * or an in-app link), it redirects to the native screen, `/returns/<rma>`.
 * The `order` query (there for bundles that predate this route) is dropped.
 */
export default function ReturnDeepLinkRedirect() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Redirect href={{ pathname: '/returns/[id]', params: { id } }} />;
}
