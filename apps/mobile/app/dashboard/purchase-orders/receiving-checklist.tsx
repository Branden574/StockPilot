import { type Href, Redirect } from 'expo-router';

/**
 * Cold-start shim for a web receiving checklist link (F4-1; the What's New
 * entry links here). On a COLD start expo-router hands the router the raw web
 * path without +native-intent; without this static route the PO shim beside
 * it (app/dashboard/purchase-orders/[id].tsx) would take "receiving-checklist"
 * for a PO id and open "Could not load this PO". Warm links go through
 * web-path-rewrite.ts to the same screen.
 */
export default function ReceivingChecklistDeepLinkRedirect() {
  return <Redirect href={'/receiving-checklist' as Href} />;
}
