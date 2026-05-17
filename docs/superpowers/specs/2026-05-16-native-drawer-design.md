# Native Mobile Drawer — Design

**Date:** 2026-05-16
**Owner:** Branden
**Status:** Design — ready for implementation

## Problem

On the Expo native app (`apps/mobile`), a left-edge swipe is interpreted by React Navigation's Stack as an iOS-back gesture. The user expected it to open a sidebar menu the way most modern productivity apps do (Slack, Discord, Gmail). Today the app only has bottom tabs — no drawer exists.

## Goal

Add a left drawer to the native app that opens with a left-edge swipe or via a hamburger button, contains a full nav menu plus an account section, and does not break the existing back-swipe gesture on modal/detail screens.

## Non-goals

- No web-feature fallbacks. Drawer lists only features that already have native screens.
- No drawer search, collapsed mode, or other customization.
- No new screens — only restructuring how existing ones are navigated.
- No org switcher (multi-org is web-only for now).
- The mobile app's web view (Expo Router `web` target) is out of scope. The web app got its own edge-swipe handler in commit `12c7138`.

## Approach

Wrap the existing bottom-tabs navigator in a Drawer using `@react-navigation/drawer`. Tabs stay; the drawer is an additional surface on top of them. Modal screens (item detail, scan-po, cycle-count scan, bundles) remain at the root Stack, **above** the drawer in the navigator tree, so back-swipe on those screens still works.

### File-tree change

Before:

```
apps/mobile/app/
  _layout.tsx          # Root Stack
  (auth)/_layout.tsx   # auth flow
  (tabs)/_layout.tsx   # bottom tabs
  item/[id]/           # modal: item detail
  scan-po/             # modal: PO scan
  cycle-count/scan/[id]/  # fullScreenModal
  bundles/             # modal: bundles list + detail
```

After:

```
apps/mobile/app/
  _layout.tsx          # Root Stack — modals + (drawer) group
  (auth)/_layout.tsx   # unchanged
  (drawer)/
    _layout.tsx        # NEW — Drawer wrapping the tabs
    (tabs)/_layout.tsx # MOVED — content unchanged
  item/[id]/           # unchanged, stays at root
  scan-po/             # unchanged
  cycle-count/scan/[id]/ # unchanged
  bundles/             # unchanged
```

`(drawer)` is a parenthesized Expo Router group — does not appear in the URL/segment path. Routes inside `(drawer)/(tabs)` retain their existing paths (`/`, `/inventory`, `/receive`, `/cycle-counts`, `/scan`, `/settings`).

### Components to add

1. **`apps/mobile/app/(drawer)/_layout.tsx`** — new file. Renders `<Drawer>` from `expo-router/drawer` with one screen entry for `(tabs)` and a `drawerContent` prop pointing at the custom component below.

2. **`apps/mobile/src/components/drawer-content.tsx`** — new file. Renders the drawer's contents using `DrawerContentScrollView` and `DrawerItem` from `@react-navigation/drawer`:
   - **Top section (nav):** Home, Inventory, Receive, Cycle Counts, Scan, Bundles, PO imports, Settings. Each item navigates into the tabs group (`router.push('/inventory')` style) and closes the drawer via `props.navigation.closeDrawer()`. Active item highlighted using `useSegments()`.
   - **Bottom section (account):** user avatar (initials fallback) + name + email pulled from `useAuth().session.user`; warehouse chip read from a `useWarehouseFilter` hook (or the existing storage key); org name read from `useAuth()` or the current snapshot context; "Sign out" button calling `signOut()` from the existing auth context.

### Library install

```bash
pnpm --filter @stockpilot/mobile add @react-navigation/drawer
```

All peer deps (`react-native-gesture-handler`, `react-native-reanimated`, `react-native-screens`, `react-native-safe-area-context`) are already installed.

## Gestures

- `@react-navigation/drawer` provides a left-edge swipe-to-open out of the box with `edgeWidth ~20px` and `drawerType: 'front'` (slide-over) as the default. Configure to match.
- iOS's interactive back-swipe is a Stack-level gesture; it doesn't apply on root-level tab screens (the tabs aren't pushed — they're the root view of the drawer screen). No conflict.
- Modal screens (item, scan-po, cycle-count, bundles) live in the parent Stack above the drawer. On those screens, the back-swipe still navigates back to the tabs. The drawer's edge-swipe does not fire there because the drawer navigator is not the current focused navigator.
- The Stack's `gestureEnabled` defaults stay as they are — no per-screen overrides needed.

## Data flow

| Field | Source |
|---|---|
| User name + email + avatar | `useAuth()` from `apps/mobile/src/lib/auth-context.ts` → `session.user.email` / user metadata |
| Active warehouse | Existing warehouse filter storage key (whichever `apps/mobile/src/lib` module owns it today; will be discovered during implementation) |
| Org name | From `useAuth()` session or the sync snapshot — whichever is wired today |
| Sign out | `signOut()` from `useAuth()` |

If the warehouse / org sources don't exist on mobile yet, the drawer's bottom section gracefully omits those rows (show only what's available) rather than blocking the feature.

## Error handling

- Drawer is read-only navigation; no mutations to fail.
- Sign-out failure: existing auth context already toasts on error — no change.
- If the drawer fails to render (e.g., one of the bottom-section data sources throws), wrap each section in an error boundary that logs to the existing reporter and shows a minimal placeholder. Don't crash the app.

## Testing

The mobile app currently has no test infrastructure; adding one is out of scope. Verification is manual:

1. Launch app on iOS simulator + Android emulator.
2. Sign in → land on Home tab.
3. Swipe from left edge → drawer slides in.
4. Tap each drawer nav item → navigates to corresponding tab, drawer closes.
5. Open item detail (push onto Stack) → back-swipe goes back, drawer not openable from this screen.
6. Open cycle-count scan (fullScreenModal) → modal works as today, drawer not interfering.
7. Tap Sign Out in drawer → returns to auth flow.
8. Hamburger-button equivalent: tap-target in top-left of each tab screen (drawer header button auto-rendered by `@react-navigation/drawer` when `headerShown: true`, or via `navigation.openDrawer()` from a custom header button). Existing tabs use `headerShown: false`, so we'll add a small in-page hamburger button to each tab's header bar — implementation can choose the cleanest spot.

## Rollout

Single commit, single deploy. Mobile is sideloaded / TestFlight, not auto-updated, so no migration gates needed. No data changes, no DB changes.

## Out of scope (explicit YAGNI)

- Drawer search bar.
- Linking out to web-only features (no `Linking.openURL`).
- Org switcher in the drawer (multi-org is rare today).
- Right drawer / dual drawers.
- Drawer-only nav (no removing the bottom tabs).
- Customizing the drawer per role (manager vs staff sees same items; existing tab screens already gate their own content).
