/**
 * Optional bottom-tab route for Locations (Settings → Customize tab bar).
 *
 * Named locations-tab (path /locations-tab) — NOT locations — deliberately: the
 * drawer already owns /locations (app/(drawer)/locations.tsx), and a same-path
 * route inside (tabs) would collide and hijack the drawer link into the
 * tabs navigator (the exact route-collision bug the old (tabs)/settings.tsx
 * had). Both routes render the identical shared screen component.
 *
 * Declared in (tabs)/_layout.tsx with href: null when not chosen — hidden
 * from the bar but still mounted/deep-linkable, same mechanism as the
 * cycle-counts tab.
 */
export { default } from '@/screens/locations';
