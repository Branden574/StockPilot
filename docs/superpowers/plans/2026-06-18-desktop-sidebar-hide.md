# Hide-able Desktop Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let desktop users fully hide the dashboard sidebar (and bring it back) via a topbar button and a Cmd/Ctrl+\ shortcut, with the choice remembered across reloads.

**Architecture:** A cookie (`sp_sidebar_hidden`) read server-side in the `(dashboard)` layout seeds an `initialSidebarHidden` prop on the client `DashboardShell`, which holds the live state, conditionally renders the desktop `<Sidebar>`, and persists the choice back to the cookie. A single always-visible topbar button is viewport-aware: desktop toggles the sidebar, mobile opens the existing drawer. Pure logic (cookie parse/serialize, viewport check, keyboard chord, typing-target guard) is isolated in a helper module for deterministic unit tests.

**Tech Stack:** Next.js (App Router, RSC), React client components, TypeScript, Tailwind, lucide-react icons, Vitest + @testing-library/react (happy-dom env).

## Global Constraints

- **Desktop web only.** Do not change the mobile `Sheet` drawer, `EdgeSwipeOpener`, or `mobileNavOpen` logic. Do not touch the native mobile app — this is the documented "web-only by nature" exception to web→mobile parity.
- **No new dependencies.** Use existing `cn` (`@/lib/utils`), `lucide-react`, and `next/headers` `cookies()`.
- **Commit messages must NOT include any `Co-Authored-By: Claude` (or Anthropic) trailer.** Plain Conventional Commits only.
- **Cookie name:** `sp_sidebar_hidden`; value `"1"` = hidden, absent/`"0"`/anything else = shown. `path=/; max-age=31536000; samesite=lax`.
- **Viewport breakpoint:** desktop = `(min-width: 768px)` (Tailwind `md`).
- Follow the existing editorial styling tokens already used in `topbar.tsx` (e.g. `text-[var(--ed-ink-3)]`, `hover:bg-muted`).
- Each task must leave `pnpm typecheck`, `pnpm lint`, and `pnpm test` green. All commands run from `apps/web` unless noted.

---

### Task 1: Pure preference + input helpers

**Files:**
- Create: `apps/web/src/components/dashboard/sidebar-pref.ts`
- Test: `apps/web/src/components/dashboard/sidebar-pref.test.ts`

**Interfaces:**
- Produces:
  - `SIDEBAR_HIDDEN_COOKIE: string` (= `'sp_sidebar_hidden'`)
  - `parseSidebarHidden(value: string | null | undefined): boolean`
  - `sidebarCookieString(hidden: boolean): string`
  - `isDesktopViewport(): boolean`
  - `isSidebarToggleChord(e: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'key'>): boolean`
  - `isTypingTarget(el: Element | null): boolean`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/dashboard/sidebar-pref.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SIDEBAR_HIDDEN_COOKIE,
  isDesktopViewport,
  isSidebarToggleChord,
  isTypingTarget,
  parseSidebarHidden,
  sidebarCookieString,
} from './sidebar-pref';

afterEach(() => vi.restoreAllMocks());

describe('parseSidebarHidden', () => {
  it('is hidden only for exactly "1"', () => {
    expect(parseSidebarHidden('1')).toBe(true);
    expect(parseSidebarHidden('0')).toBe(false);
    expect(parseSidebarHidden('')).toBe(false);
    expect(parseSidebarHidden(undefined)).toBe(false);
    expect(parseSidebarHidden(null)).toBe(false);
    expect(parseSidebarHidden('true')).toBe(false);
  });
});

describe('sidebarCookieString', () => {
  it('persists "1" for a year when hidden', () => {
    const s = sidebarCookieString(true);
    expect(s).toContain(`${SIDEBAR_HIDDEN_COOKIE}=1`);
    expect(s).toContain('path=/');
    expect(s).toContain('max-age=31536000');
    expect(s).toContain('samesite=lax');
  });
  it('clears the cookie when shown', () => {
    const s = sidebarCookieString(false);
    expect(s).toContain(`${SIDEBAR_HIDDEN_COOKIE}=;`);
    expect(s).toContain('max-age=0');
  });
});

describe('isDesktopViewport', () => {
  it('mirrors matchMedia(min-width: 768px).matches', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (q: string) => ({ matches: true, media: q } as MediaQueryList),
    );
    expect(isDesktopViewport()).toBe(true);
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (q: string) => ({ matches: false, media: q } as MediaQueryList),
    );
    expect(isDesktopViewport()).toBe(false);
  });
});

describe('isSidebarToggleChord', () => {
  it('matches Cmd+\\ and Ctrl+\\ only', () => {
    expect(isSidebarToggleChord({ metaKey: true, ctrlKey: false, key: '\\' })).toBe(true);
    expect(isSidebarToggleChord({ metaKey: false, ctrlKey: true, key: '\\' })).toBe(true);
    expect(isSidebarToggleChord({ metaKey: false, ctrlKey: false, key: '\\' })).toBe(false);
    expect(isSidebarToggleChord({ metaKey: true, ctrlKey: false, key: 'k' })).toBe(false);
  });
});

describe('isTypingTarget', () => {
  it('detects text-entry elements', () => {
    expect(isTypingTarget(document.createElement('input'))).toBe(true);
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true);
    expect(isTypingTarget(document.createElement('select'))).toBe(true);
    expect(isTypingTarget(document.createElement('div'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm test src/components/dashboard/sidebar-pref.test.ts`
Expected: FAIL — `Failed to resolve import "./sidebar-pref"`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/components/dashboard/sidebar-pref.ts`:

```ts
/**
 * Pure helpers for the desktop sidebar hide/show preference. Kept free of
 * React + DOM-rendering so they can be unit-tested deterministically and
 * reused by both the server layout (cookie read) and the client shell.
 */

/** Cookie that persists the per-device preference. "1" = hidden. */
export const SIDEBAR_HIDDEN_COOKIE = 'sp_sidebar_hidden';

/** Parse the persisted preference. Hidden only when the value is exactly "1". */
export function parseSidebarHidden(value: string | null | undefined): boolean {
  return value === '1';
}

/** `document.cookie` string that persists (1y) or clears the preference. */
export function sidebarCookieString(hidden: boolean): string {
  return hidden
    ? `${SIDEBAR_HIDDEN_COOKIE}=1; path=/; max-age=31536000; samesite=lax`
    : `${SIDEBAR_HIDDEN_COOKIE}=; path=/; max-age=0; samesite=lax`;
}

/** True when the viewport is desktop-width (Tailwind `md`, ≥768px). */
export function isDesktopViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches;
}

/** The chord that toggles the sidebar: Cmd+\ (mac) / Ctrl+\ (win/linux). */
export function isSidebarToggleChord(
  e: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'key'>,
): boolean {
  return (e.metaKey || e.ctrlKey) && e.key === '\\';
}

/** Whether focus is in a text-entry element (so we never swallow a typed "\"). */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return (el as HTMLElement).isContentEditable;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && pnpm test src/components/dashboard/sidebar-pref.test.ts`
Expected: PASS (5 describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/dashboard/sidebar-pref.ts apps/web/src/components/dashboard/sidebar-pref.test.ts
git commit -m "feat(sidebar): pure helpers for hide/show preference"
```

---

### Task 2: Sidebar toggle button

**Files:**
- Create: `apps/web/src/components/dashboard/sidebar-toggle-button.tsx`
- Test: `apps/web/src/components/dashboard/sidebar-toggle-button.test.tsx`

**Interfaces:**
- Produces: `SidebarToggleButton(props: { hidden: boolean; onToggle: () => void; className?: string }): JSX.Element`
  - Renders a `<button>` with a `PanelLeft` icon; `aria-expanded={!hidden}`; `aria-label` = `hidden ? 'Show sidebar' : 'Hide sidebar'`; calls `onToggle` on click.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/dashboard/sidebar-toggle-button.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SidebarToggleButton } from './sidebar-toggle-button';

describe('SidebarToggleButton', () => {
  it('labels itself "Hide sidebar" + aria-expanded true when shown', () => {
    render(<SidebarToggleButton hidden={false} onToggle={() => {}} />);
    const btn = screen.getByRole('button', { name: 'Hide sidebar' });
    expect(btn).toHaveAttribute('aria-expanded', 'true');
  });

  it('labels itself "Show sidebar" + aria-expanded false when hidden', () => {
    render(<SidebarToggleButton hidden={true} onToggle={() => {}} />);
    const btn = screen.getByRole('button', { name: 'Show sidebar' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('calls onToggle when clicked', () => {
    const onToggle = vi.fn();
    render(<SidebarToggleButton hidden={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm test src/components/dashboard/sidebar-toggle-button.test.tsx`
Expected: FAIL — `Failed to resolve import "./sidebar-toggle-button"`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/components/dashboard/sidebar-toggle-button.tsx`:

```tsx
'use client';

import { PanelLeft } from 'lucide-react';

import { cn } from '@/lib/utils';

interface SidebarToggleButtonProps {
  /** Desktop sidebar visibility — drives the label/expanded state. */
  hidden: boolean;
  onToggle: () => void;
  className?: string;
}

/**
 * The single topbar control for the sidebar. Always rendered; the parent
 * decides what `onToggle` does per viewport (desktop hides/shows the sidebar,
 * mobile opens the drawer).
 */
export function SidebarToggleButton({ hidden, onToggle, className }: SidebarToggleButtonProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!hidden}
      aria-label={hidden ? 'Show sidebar' : 'Hide sidebar'}
      className={cn(
        'hover:bg-muted hover:text-foreground grid h-[30px] w-[30px] place-items-center rounded-md text-[var(--ed-ink-3)] transition-colors',
        className,
      )}
    >
      <PanelLeft className="h-4 w-4" />
    </button>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && pnpm test src/components/dashboard/sidebar-toggle-button.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/dashboard/sidebar-toggle-button.tsx apps/web/src/components/dashboard/sidebar-toggle-button.test.tsx
git commit -m "feat(sidebar): topbar toggle button component"
```

---

### Task 3: Topbar uses the always-visible toggle

**Files:**
- Modify: `apps/web/src/components/dashboard/topbar.tsx`

**Interfaces:**
- Consumes: `SidebarToggleButton` (Task 2); `onToggleSidebar?: () => void` (existing prop).
- Produces: `Topbar` now also accepts `sidebarHidden?: boolean` (default `false`) and renders `<SidebarToggleButton hidden={sidebarHidden} onToggle={onToggleSidebar} />` at all widths instead of the old `md:hidden` hamburger.

- [ ] **Step 1: Replace the import block's icon usage and add the button import**

In `apps/web/src/components/dashboard/topbar.tsx`, change the lucide import line (currently `import { BookOpen, HelpCircle, Menu, Search } from 'lucide-react';`) to drop `Menu`:

```tsx
import { BookOpen, HelpCircle, Search } from 'lucide-react';
```

Add this import alongside the other component imports (e.g. under the `NotificationBell` import):

```tsx
import { SidebarToggleButton } from '@/components/dashboard/sidebar-toggle-button';
```

- [ ] **Step 2: Add the `sidebarHidden` prop**

In the `TopbarProps` interface, add (after `onToggleSidebar?: () => void;`):

```tsx
  /** Desktop sidebar visibility, for the toggle button's label. */
  sidebarHidden?: boolean;
```

In the `Topbar({ ... })` destructure, add `sidebarHidden = false,` next to `onToggleSidebar,`.

- [ ] **Step 3: Swap the hamburger for the always-visible toggle**

Replace the existing mobile-only button JSX:

```tsx
      <button
        type="button"
        className="hover:bg-muted hover:text-foreground grid h-[30px] w-[30px] place-items-center rounded-md text-[var(--ed-ink-3)] transition-colors md:hidden"
        aria-label="Open dashboard navigation"
        onClick={onToggleSidebar}
      >
        <Menu className="h-4 w-4" />
      </button>
```

with:

```tsx
      <SidebarToggleButton hidden={sidebarHidden} onToggle={() => onToggleSidebar?.()} />
```

- [ ] **Step 4: Verify types + lint**

Run: `cd apps/web && pnpm typecheck && pnpm lint`
Expected: PASS, no unused-`Menu` error, no missing-prop error (prop is optional).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/dashboard/topbar.tsx
git commit -m "feat(sidebar): always-visible toggle in the topbar"
```

---

### Task 4: Wire state, persistence, and toggle into DashboardShell

**Files:**
- Modify: `apps/web/src/components/dashboard/dashboard-shell.tsx`
- Test: `apps/web/src/components/dashboard/dashboard-shell.test.tsx`

**Interfaces:**
- Consumes: `parseSidebarHidden` is NOT needed here (the layout already parses); shell consumes `sidebarCookieString`, `isDesktopViewport`, `isSidebarToggleChord`, `isTypingTarget` (Task 1); `SidebarToggleButton` reaches the DOM via `Topbar` (Task 3).
- Produces: `DashboardShell` now accepts `initialSidebarHidden?: boolean` (default `false`). Behavior: desktop `<Sidebar>` is conditionally rendered (`!desktopSidebarHidden`); the topbar toggle + Cmd/Ctrl+\ flip `desktopSidebarHidden` on desktop and persist via cookie; on mobile the toggle opens the existing `Sheet`.

- [ ] **Step 1: Write the failing integration test**

Create `apps/web/src/components/dashboard/dashboard-shell.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Heavy / native-dependency children are stubbed so we can exercise the
// shell's own toggle wiring with the REAL Topbar + SidebarToggleButton.
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@/lib/analytics', () => ({ identify: vi.fn() }));
vi.mock('@/components/dashboard/sidebar', () => ({
  Sidebar: () => <div data-testid="desktop-sidebar" />,
}));
vi.mock('@/components/ui/sheet', () => ({
  Sheet: () => null,
  SheetContent: () => null,
  SheetTitle: () => null,
}));
vi.mock('@/components/dashboard/command-palette', () => ({ CommandPalette: () => null }));
vi.mock('@/components/dashboard/edge-swipe-opener', () => ({ EdgeSwipeOpener: () => null }));
vi.mock('@/components/dashboard/nav-progress-bar', () => ({ NavProgressBar: () => null }));
vi.mock('@/components/version-notifier', () => ({ VersionNotifier: () => null }));
vi.mock('@/components/dashboard/notification-bell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/dashboard/user-menu', () => ({ UserMenu: () => null }));
vi.mock('@/components/dashboard/warehouse-filter-picker', () => ({
  WarehouseFilterPicker: () => null,
}));
vi.mock('@/components/theme/theme-toggle', () => ({ ThemeToggle: () => null }));
vi.mock('@/components/dashboard/keyboard-shortcuts', () => ({
  KeyboardShortcutsProvider: () => null,
  openKeyboardShortcutsOverlay: vi.fn(),
}));
vi.mock('@/components/orders/order-status-config-provider', () => ({
  OrderStatusConfigProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { DashboardShell } from './dashboard-shell';

const baseProps = {
  email: 'a@b.com',
  fullName: 'Test User',
  avatarUrl: null,
  userId: 'u1',
  initialUnreadNotifications: 0,
  organizationId: 'o1',
  organizationName: 'Org',
  memberships: [],
  userName: 'Test User',
  userRole: 'Owner · Org',
  role: 'owner' as const,
  enabledModules: [] as string[],
  navOverrides: null,
  orderStatusConfig: null,
};

function setViewport(desktop: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (q: string) => ({ matches: desktop, media: q } as MediaQueryList),
  );
}

beforeEach(() => {
  document.cookie = 'sp_sidebar_hidden=; path=/; max-age=0';
});
afterEach(() => vi.restoreAllMocks());

describe('DashboardShell sidebar hide', () => {
  it('desktop: toggle hides the sidebar and persists the cookie', () => {
    setViewport(true);
    render(<DashboardShell {...baseProps}>body</DashboardShell>);
    expect(screen.getByTestId('desktop-sidebar')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }));

    expect(screen.queryByTestId('desktop-sidebar')).not.toBeInTheDocument();
    expect(document.cookie).toContain('sp_sidebar_hidden=1');

    fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }));
    expect(screen.getByTestId('desktop-sidebar')).toBeInTheDocument();
  });

  it('desktop: Cmd/Ctrl+\\ toggles the sidebar', () => {
    setViewport(true);
    render(<DashboardShell {...baseProps}>body</DashboardShell>);
    expect(screen.getByTestId('desktop-sidebar')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: '\\', ctrlKey: true });
    expect(screen.queryByTestId('desktop-sidebar')).not.toBeInTheDocument();
  });

  it('starts hidden when initialSidebarHidden is true', () => {
    setViewport(true);
    render(
      <DashboardShell {...baseProps} initialSidebarHidden>
        body
      </DashboardShell>,
    );
    expect(screen.queryByTestId('desktop-sidebar')).not.toBeInTheDocument();
  });

  it('mobile: the toggle does not hide the desktop sidebar or set the cookie', () => {
    setViewport(false);
    render(<DashboardShell {...baseProps}>body</DashboardShell>);
    // Desktop sidebar is still rendered (CSS hides it at mobile width, not the DOM).
    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }));
    expect(screen.getByTestId('desktop-sidebar')).toBeInTheDocument();
    expect(document.cookie).not.toContain('sp_sidebar_hidden=1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm test src/components/dashboard/dashboard-shell.test.tsx`
Expected: FAIL — currently there is no `initialSidebarHidden` prop, no toggle wiring (the "Hide sidebar" button doesn't exist yet because the shell doesn't pass `sidebarHidden`/`onToggleSidebar` for desktop), and the desktop sidebar is always rendered.

- [ ] **Step 3: Add the prop + state + persistence + handler**

In `apps/web/src/components/dashboard/dashboard-shell.tsx`:

(a) Add the import near the other dashboard imports:

```tsx
import {
  isDesktopViewport,
  isSidebarToggleChord,
  isTypingTarget,
  sidebarCookieString,
} from '@/components/dashboard/sidebar-pref';
```

(b) Add the prop to `DashboardShellProps` (after `warehouseFilter?` block or anywhere in the interface):

```tsx
  /** Server-read initial value of the desktop sidebar hide preference. */
  initialSidebarHidden?: boolean;
```

(c) Add `initialSidebarHidden = false,` to the destructured params.

(d) Below the existing `const [mobileNavOpen, setMobileNavOpen] = React.useState(false);` add:

```tsx
  const [desktopSidebarHidden, setDesktopSidebarHidden] =
    React.useState(initialSidebarHidden);

  // Persist to the cookie whenever the preference changes (skip the very
  // first render so we don't rewrite the server-provided value on mount).
  const firstPrefRender = React.useRef(true);
  React.useEffect(() => {
    if (firstPrefRender.current) {
      firstPrefRender.current = false;
      return;
    }
    document.cookie = sidebarCookieString(desktopSidebarHidden);
  }, [desktopSidebarHidden]);

  // Single topbar control: desktop toggles the pinned sidebar; mobile opens
  // the drawer (today's behavior). Decided at click time via matchMedia.
  const handleToggleSidebar = React.useCallback(() => {
    if (isDesktopViewport()) setDesktopSidebarHidden((v) => !v);
    else setMobileNavOpen(true);
  }, []);

  // Cmd/Ctrl+\ toggles on desktop; ignored while typing so a literal "\"
  // in a text field is never swallowed.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!isSidebarToggleChord(e)) return;
      if (isTypingTarget(document.activeElement)) return;
      if (!isDesktopViewport()) return;
      e.preventDefault();
      setDesktopSidebarHidden((v) => !v);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
```

(e) Make the desktop `<Sidebar>` conditional. Replace:

```tsx
      <Sidebar
        className="hidden md:flex"
        organizationId={organizationId}
```

…through its closing `/>` with the same element wrapped in a guard:

```tsx
      {!desktopSidebarHidden && (
        <Sidebar
          className="hidden md:flex"
          organizationId={organizationId}
          organizationName={organizationName}
          organizationLogoUrl={organizationLogoUrl ?? null}
          memberships={memberships}
          userName={userName}
          userRole={userRole}
          role={role}
          enabledModules={enabledModules}
          navOverrides={navOverrides}
        />
      )}
```

(f) Update the `<Topbar … />` call: change `onToggleSidebar={() => setMobileNavOpen(true)}` to use the new handler and pass `sidebarHidden`:

```tsx
        <Topbar
          email={email}
          fullName={fullName}
          avatarUrl={avatarUrl}
          organizationName={organizationName}
          userId={userId}
          initialUnreadNotifications={initialUnreadNotifications}
          isPlatformAdmin={isPlatformAdmin}
          onToggleSidebar={handleToggleSidebar}
          sidebarHidden={desktopSidebarHidden}
          warehouseFilter={warehouseFilter}
        />
```

(Leave the mobile `Sheet` block, `EdgeSwipeOpener`, and `mobileNavOpen` exactly as they are.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && pnpm test src/components/dashboard/dashboard-shell.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + lint**

Run: `cd apps/web && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/dashboard/dashboard-shell.tsx apps/web/src/components/dashboard/dashboard-shell.test.tsx
git commit -m "feat(sidebar): hide/show state, persistence, and keyboard toggle in shell"
```

---

### Task 5: Read the preference server-side (flash-free)

**Files:**
- Modify: `apps/web/src/app/(dashboard)/layout.tsx`

**Interfaces:**
- Consumes: `SIDEBAR_HIDDEN_COOKIE`, `parseSidebarHidden` (Task 1); `DashboardShell` `initialSidebarHidden` prop (Task 4).
- Produces: the layout passes `initialSidebarHidden` so the first server render already reflects the stored preference (no flash).

- [ ] **Step 1: Add the cookie read**

In `apps/web/src/app/(dashboard)/layout.tsx`:

(a) Add to the `next/headers` import — it currently imports `{ headers }`; change to:

```tsx
import { cookies, headers } from 'next/headers';
```

(b) Add the helper import near the other `@/` imports:

```tsx
import { SIDEBAR_HIDDEN_COOKIE, parseSidebarHidden } from '@/components/dashboard/sidebar-pref';
```

(c) After `const platformAdmin = await currentUserIsPlatformAdmin();` add:

```tsx
  const cookieStore = await cookies();
  const initialSidebarHidden = parseSidebarHidden(
    cookieStore.get(SIDEBAR_HIDDEN_COOKIE)?.value,
  );
```

(d) Pass it into the `<DashboardShell … >` props (add next to `role={ctx.role}`):

```tsx
        initialSidebarHidden={initialSidebarHidden}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && pnpm typecheck`
Expected: PASS. (`parseSidebarHidden` correctness is already covered by Task 1; this glue is verified by types + the production build in Task 7.)

- [ ] **Step 3: Lint**

Run: `cd apps/web && pnpm lint`
Expected: PASS (no unused imports).

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(dashboard)/layout.tsx"
git commit -m "feat(sidebar): read hide preference cookie server-side (no flash)"
```

---

### Task 6: Surface the shortcut in the help overlay

**Files:**
- Modify: `apps/web/src/components/dashboard/keyboard-shortcuts.tsx`
- Test: `apps/web/src/components/dashboard/keyboard-shortcuts.shortcut-row.test.ts`

**Interfaces:**
- Consumes: the existing `__TEST__.SHORTCUT_ROWS` export.
- Produces: a new display-only row for the sidebar toggle under a new `View` section. (The actual handler lives in the shell from Task 4 — this is documentation only.)

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/dashboard/keyboard-shortcuts.shortcut-row.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { __TEST__ } from './keyboard-shortcuts';

describe('keyboard shortcuts overlay', () => {
  it('documents the sidebar toggle (Cmd/Ctrl+\\)', () => {
    const row = __TEST__.SHORTCUT_ROWS.find((r) => r.keys.includes('\\'));
    expect(row).toBeTruthy();
    expect(row?.description.toLowerCase()).toContain('sidebar');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm test src/components/dashboard/keyboard-shortcuts.shortcut-row.test.ts`
Expected: FAIL — no row contains `'\\'`.

- [ ] **Step 3: Add the row + section**

In `apps/web/src/components/dashboard/keyboard-shortcuts.tsx`:

(a) Extend the `Section` union type — change:

```tsx
type Section = 'Navigation' | 'New things' | 'Help' | 'Search';
```

to:

```tsx
type Section = 'Navigation' | 'New things' | 'Search' | 'View' | 'Help';
```

(b) Add a row to `SHORTCUT_ROWS` (place it just before the `'?'` Help row):

```tsx
  { keys: ['⌘', '\\'], description: 'Hide/show the sidebar (Ctrl+\\ on Windows)', section: 'View' },
```

(c) Add `'View'` to `SECTION_ORDER` (before `'Help'`):

```tsx
const SECTION_ORDER: Section[] = ['Navigation', 'New things', 'Search', 'View', 'Help'];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && pnpm test src/components/dashboard/keyboard-shortcuts.shortcut-row.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `cd apps/web && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/dashboard/keyboard-shortcuts.tsx apps/web/src/components/dashboard/keyboard-shortcuts.shortcut-row.test.ts
git commit -m "feat(sidebar): document the Cmd/Ctrl+\\ toggle in the shortcuts overlay"
```

---

### Task 7: Full verification

**Files:** none (verification + manual smoke).

- [ ] **Step 1: Run the full web suite + types + lint**

Run: `cd apps/web && pnpm typecheck && pnpm lint && pnpm test`
Expected: all PASS (new tests green, no regressions).

- [ ] **Step 2: Production build sanity (catches RSC/`cookies()` issues the unit env can't)**

Run: `cd apps/web && pnpm build`
Expected: build succeeds (the `(dashboard)/layout.tsx` `cookies()` call compiles and renders).

- [ ] **Step 3: Manual smoke (dev server)**

Run: `cd apps/web && pnpm dev`
Verify in a desktop-width browser at `/dashboard`:
1. The topbar shows the toggle (≡/panel) on the left; clicking it hides the sidebar and the content goes full-width; clicking again restores it.
2. `Cmd+\` (or `Ctrl+\`) toggles it; typing `\` in the search box does NOT toggle.
3. Hide it, then hard-reload (Cmd+Shift+R) — it stays hidden with **no flash** of the sidebar.
4. Narrow the window below 768px — the toggle opens the slide-in drawer as before (unchanged).
5. Open the shortcuts overlay (`?`) — a "View" section lists the sidebar toggle.

- [ ] **Step 4: Finalize the branch**

Use superpowers:finishing-a-development-branch to merge `feat/desktop-sidebar-hide` (or open a PR). Do not add any Claude/Anthropic co-author trailer to the merge/commit.

---

## Self-Review

**Spec coverage:**
- Full-hide on desktop → Task 4 (conditional `<Sidebar>` render). ✓
- Topbar ≡ always-visible, viewport-aware → Tasks 2, 3, 4. ✓
- Cmd/Ctrl+\ shortcut + ignore-while-typing → Tasks 1 (`isSidebarToggleChord`/`isTypingTarget`), 4 (listener). ✓
- Discoverable in shortcuts overlay → Task 6. ✓
- Flash-free server-read cookie persistence → Tasks 1 (`parse`/`cookieString`), 5 (layout read), 4 (cookie write). ✓
- Accessibility (aria-label/aria-expanded) → Task 2. ✓
- Mobile/native untouched → Tasks 3–4 leave `Sheet`/`EdgeSwipeOpener`/`mobileNavOpen` intact; mobile branch of `handleToggleSidebar` preserved; test asserts mobile no-op. ✓
- Tests for hide/show, persistence, shortcut, mobile-no-regression → Tasks 1, 2, 4, 6. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code; commands have expected output. ✓

**Type consistency:** `desktopSidebarHidden`/`setDesktopSidebarHidden`, `initialSidebarHidden`, `sidebarHidden` (Topbar prop), `handleToggleSidebar`, and the `sidebar-pref` exports are used identically across Tasks 1–6. The conditional-render approach replaces the spec's "className flip" (functionally equivalent, cleaner to test and truly reclaims layout). ✓
