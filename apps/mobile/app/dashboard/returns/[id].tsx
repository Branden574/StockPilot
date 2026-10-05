import { Redirect, useLocalSearchParams } from 'expo-router';

/**
 * Deep-link redirect shim for the RMA workbench (returns RX-1). Staff pushes
 * carry the WEB path `/dashboard/returns/<rma>?order=/dashboard/orders/<id>`
 * (the dual link, returns plan C-3). On a COLD start expo-router hands the
 * router this raw path WITHOUT running it through `+native-intent`, so this
 * route makes it real and redirects to the native screen, `/returns/<rma>`.
 * The `order` query (there for bundles that predate this route) is dropped.
 */
export default function ReturnDeepLinkRedirect() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Redirect href={{ pathname: '/returns/[id]', params: { id } }} />;
}
