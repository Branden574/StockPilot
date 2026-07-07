/**
 * Optional bottom-tab route for Purchase orders (Settings → Customize tab bar).
 *
 * Named purchase-orders-tab (path /purchase-orders-tab) — NOT purchase-orders — deliberately: the
 * drawer already owns /purchase-orders (app/(drawer)/purchase-orders.tsx), and a same-path
 * route inside (tabs) would collide and hijack the drawer link into the
 * tabs navigator (the exact route-collision bug the old (tabs)/settings.tsx
 * had). Both routes render the identical shared screen component.
 *
 * Declared in (tabs)/_layout.tsx with href: null when not chosen — hidden
 * from the bar but still mounted/deep-linkable, same mechanism as the
 * cycle-counts tab.
 */
export { default } from '@/screens/purchase-orders';
