import { Redirect, useLocalSearchParams } from 'expo-router';

/**
 * Deep-link redirect shim. Notifications carry the WEB path
 * `/dashboard/orders/{id}` (the same `notifications` row also links the web
 * app). The native order screen is `/order/{id}`. A push tap no longer
 * reaches the router as a URL, cold start included: notification-link.ts
 * parses it and the notification host opens `/order/{id}` inside the app. A
 * raw web URL that does reach the router (a `stockpilot:///dashboard/...`
 * link) goes through `+native-intent`'s `redirectSystemPath` on this
 * expo-router, the initial URL included. This shim is the belt for one that
 * ever arrives unrewritten: it makes the web path a real route that
 * immediately redirects to the native screen.
 */
export default function OrderDeepLinkRedirect() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Redirect href={{ pathname: '/order/[id]', params: { id } }} />;
}
