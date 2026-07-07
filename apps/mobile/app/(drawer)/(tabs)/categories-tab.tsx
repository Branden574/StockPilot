/**
 * Optional bottom-tab route for Categories (Settings → Customize tab bar).
 *
 * Named categories-tab (path /categories-tab) — NOT categories — deliberately: the
 * drawer already owns /categories (app/(drawer)/categories.tsx), and a same-path
 * route inside (tabs) would collide and hijack the drawer link into the
 * tabs navigator (the exact route-collision bug the old (tabs)/settings.tsx
 * had). Both routes render the identical shared screen component.
 *
 * Declared in (tabs)/_layout.tsx with href: null when not chosen — hidden
 * from the bar but still mounted/deep-linkable, same mechanism as the
 * cycle-counts tab.
 */
export { default } from '@/screens/categories';
