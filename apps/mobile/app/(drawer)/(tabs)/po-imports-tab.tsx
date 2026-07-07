/**
 * Optional bottom-tab route for PO imports (Settings → Customize tab bar).
 *
 * Named po-imports-tab (path /po-imports-tab) — NOT po-imports — deliberately: the
 * drawer already owns /po-imports (app/(drawer)/po-imports.tsx), and a same-path
 * route inside (tabs) would collide and hijack the drawer link into the
 * tabs navigator (the exact route-collision bug the old (tabs)/settings.tsx
 * had). Both routes render the identical shared screen component.
 *
 * Declared in (tabs)/_layout.tsx with href: null when not chosen — hidden
 * from the bar but still mounted/deep-linkable, same mechanism as the
 * cycle-counts tab.
 */
export { default } from '@/screens/po-imports';
