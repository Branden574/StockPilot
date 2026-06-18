# Hide-able Desktop Sidebar — Design

- **Date:** 2026-06-18
- **Status:** Approved (pending spec review)
- **Surface:** Web dashboard, **desktop only** (≥768px)

## Summary

The dashboard sidebar is permanently visible on desktop today. Give users a way to
**fully hide** it (content goes edge-to-edge) and bring it back, via a topbar toggle
button and a keyboard shortcut. The choice is remembered across reloads and new tabs.

## Goals

- A one-click control to hide the always-on desktop sidebar and reclaim its ~244px.
- A matching control to bring it back.
- The hidden/shown preference persists per browser, with **no flash** of the sidebar
  on a hard reload when the stored preference is "hidden".
- A discoverable keyboard shortcut (**Cmd/Ctrl + \\**).

## Non-goals

- **No icon-rail / collapse mode.** We chose full-hide over a narrow icon rail.
- **No mobile changes.** Web-mobile (<768px) already hides nav behind a `Sheet`
  drawer + edge-swipe; the native app uses a drawer too. This feature is
  **web-only by its nature** — the documented exception to the web→mobile parity rule
  (`feedback_web_features_default_to_mobile`).
- No per-org or server-side persistence (it's a personal, per-device UI preference).

## Current state

- `DashboardShell` ([apps/web/src/components/dashboard/dashboard-shell.tsx](../../../apps/web/src/components/dashboard/dashboard-shell.tsx)) is a
  client component. It renders:
  - the desktop sidebar `<Sidebar className="hidden md:flex" … />` (always visible ≥768px),
  - a mobile `<Sheet>` containing a second `<Sidebar>` opened via `mobileNavOpen` state,
  - `<Topbar onToggleSidebar={() => setMobileNavOpen(true)} … />`.
- `Topbar` ([apps/web/src/components/dashboard/topbar.tsx](../../../apps/web/src/components/dashboard/topbar.tsx)) has a `Menu` (≡) button styled
  `md:hidden` that calls `onToggleSidebar` — i.e. it currently only appears on mobile and
  only opens the mobile sheet.
- The `(dashboard)` server layout renders `DashboardShell` and feeds it org/user props.

## Design

### 1. State & persistence (flash-free)

- A cookie **`sp_sidebar_hidden`** stores the preference (`"1"` = hidden, absent/`"0"` = shown).
- The `(dashboard)` **server layout** reads it with `cookies()` from `next/headers` and passes
  `initialSidebarHidden: boolean` into `DashboardShell`. Reading it server-side means the
  first server render already emits the correct layout — **no hydration flash** on hard reload
  or a new tab.
- `DashboardShell` holds `const [desktopSidebarHidden, setDesktopSidebarHidden] =
  useState(initialSidebarHidden)`. Toggling writes the cookie client-side:
  `document.cookie = "sp_sidebar_hidden=1; path=/; max-age=31536000; samesite=lax"`
  (or `=0` / delete when shown). Cookie value is a single char — negligible request overhead.

### 2. Layout

- The desktop sidebar's className becomes conditional:
  - shown → `"hidden md:flex"` (today's behavior: hidden on mobile, flex on desktop),
  - hidden → `"hidden"` (never rendered visible at any width).
- Because the sidebar is a flex child with a fixed width, dropping it lets the sibling
  `<div className="flex min-w-0 flex-1 flex-col">` (topbar + main) expand to full width.
- The mobile `<Sheet>` drawer, `EdgeSwipeOpener`, and all `mobileNavOpen` logic are **unchanged**.

### 3. Controls

- **Topbar ≡ button:** remove `md:hidden` so it is always visible. The handler becomes
  viewport-aware (decided at click time):
  - desktop (`window.matchMedia('(min-width: 768px)').matches`) → `setDesktopSidebarHidden(v => !v)`,
  - mobile → `setMobileNavOpen(true)` (today's behavior).
  - This keeps a single button; `DashboardShell` owns the handler and passes it as
    `onToggleSidebar`.
- **Accessibility:** the button gets a dynamic `aria-label` ("Hide sidebar" when shown /
  "Show sidebar" when hidden on desktop; "Open navigation" on mobile) and `aria-expanded`
  reflecting visibility. It controls the sidebar region (`aria-controls` pointing at the
  sidebar's id).
- **Keyboard shortcut:** **Cmd/Ctrl + \\** toggles `desktopSidebarHidden`. Implemented as a
  `keydown` listener in `DashboardShell` (it owns the state); the combo is ignored when focus
  is in an input/textarea/contenteditable to avoid stealing typed backslashes. An entry is
  added to the existing keyboard-shortcuts overlay (`keyboard-shortcuts.tsx`) for discoverability.

### Behavior matrix

| Viewport | ≡ click | Cmd/Ctrl + \\ | Sidebar render |
|----------|---------|----------------|----------------|
| Desktop (≥768px) | toggles hidden/shown (persisted) | toggles hidden/shown | `hidden` or `hidden md:flex` |
| Mobile (<768px) | opens the `Sheet` drawer (unchanged) | no-op (shortcut is desktop-only) | always `hidden` (drawer handles nav) |

## Files to change

- `apps/web/src/app/(dashboard)/layout.tsx` — read `sp_sidebar_hidden` cookie, pass
  `initialSidebarHidden` to `DashboardShell`.
- `apps/web/src/components/dashboard/dashboard-shell.tsx` — add `initialSidebarHidden` prop,
  `desktopSidebarHidden` state + cookie writer, viewport-aware `onToggleSidebar`, the
  Cmd/Ctrl+\\ keydown listener, and the conditional sidebar className.
- `apps/web/src/components/dashboard/topbar.tsx` — make the ≡ button always-visible; dynamic
  `aria-label` / `aria-expanded`; accept `sidebarHidden` so it can label correctly.
- `apps/web/src/components/dashboard/keyboard-shortcuts.tsx` — register the Cmd/Ctrl+\\ entry
  in the shortcuts overlay (display only; the handler lives in the shell).

## Testing

- Interaction test (`dashboard-shell` / testing-library, jsdom at desktop width):
  - clicking ≡ hides the sidebar and writes `sp_sidebar_hidden=1`;
  - clicking again shows it and clears the cookie;
  - Cmd/Ctrl+\\ toggles it; the combo is ignored while typing in an input;
  - rendering with `initialSidebarHidden` starts hidden.
- Mobile-width test: a ≡ click still opens the `Sheet` (no regression).
- `tsc` + `eslint` clean; full web suite green.

## Edge cases & decisions

- **Flash-free** requires the server-read cookie; a localStorage-only approach (the rejected
  alternative) would flash the sidebar for one frame on hard reload before hydration corrected
  it. Client-side nav keeps the shell mounted, so either way there is no flicker between pages.
- **Shortcut while typing:** guarded so a literal `\` in a text field is never swallowed.
- **Prefetch warmup:** when hidden, the desktop `<Sidebar>` (and its route-prefetch effect)
  isn't mounted; this is fine — links aren't visible to click. Showing it again re-runs warmup.
- **No layout shift for the topbar:** the ≡ button already occupies that slot on mobile; making
  it always-visible just fills an empty desktop slot on the left of the breadcrumb.
