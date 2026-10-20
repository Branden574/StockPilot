'use client';

import { X } from 'lucide-react';
import * as React from 'react';

import { CommandPaletteLauncher } from '@/components/dashboard/command-palette-launcher';
import { EdgeSwipeOpener } from '@/components/dashboard/edge-swipe-opener';
import { KeyboardShortcutsProvider } from '@/components/dashboard/keyboard-shortcuts';
import { navForRole } from '@/components/dashboard/nav';
import { NavProgressBar } from '@/components/dashboard/nav-progress-bar';
import { PendingRouteFrame } from '@/components/dashboard/pending-route-skeleton';
import { SessionUserProvider } from '@/components/dashboard/session-user';
import { OrderStatusConfigProvider } from '@/components/orders/order-status-config-provider';
import { ImageDiagnostics } from '@/components/perf/image-diagnostics';
import { PermissionsRealtime } from '@/components/realtime/permissions-realtime';
import { SessionRevocationListener } from '@/components/realtime/session-revocation-listener';
import { Sidebar } from '@/components/dashboard/sidebar';
import {
  collapsedSectionsCookieString,
  defaultCollapsedSections,
  type Density,
  densityCookieString,
  isDesktopViewport,
  isSidebarToggleChord,
  isTypingTarget,
  SIDEBAR_DOM_ID,
  sidebarCookieString,
  subscribeToDesktopViewport,
} from '@/components/dashboard/sidebar-pref';
import { Topbar } from '@/components/dashboard/topbar';
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { UpdateCenter } from '@/components/updates/update-center';
import { identify } from '@/lib/analytics';
import { forgetTourState } from '@/lib/onboarding/tour-state-cache';

import type { ModuleId, NavOverrides, NavSectionKey, Permission, Role } from '@stockpilot/core';

interface DashboardShellProps {
  children: React.ReactNode;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  userId: string;
  organizationId: string;
  organizationName: string;
  organizationLogoUrl?: string | null;
  memberships: Array<{ id: string; name: string; logoUrl: string | null; role: string }>;
  userName: string | null;
  userRole: string;
  role: Role;
  /**
   * The user's effective permissions (role defaults + org overrides), as
   * strings for the RSC boundary. Threaded to the Sidebar so nav links gate on
   * actual access (a revoked permission hides its link).
   */
  permissions?: string[];
  /** True only for platform super-admins — gates the Platform console link. */
  isPlatformAdmin?: boolean;
  /** Module IDs enabled for this org (serialized as strings for the RSC boundary). */
  enabledModules: string[];
  /**
   * Raw per-org `nav_overrides` jsonb from the organizations row. Untrusted —
   * typed `unknown` and validated downstream by `applyNavOverrides` (fails
   * CLOSED to the derived nav on null/garbage).
   */
  navOverrides: unknown;
  /**
   * Raw per-org `order_status_config` jsonb from the organizations row.
   * Untrusted — typed `unknown` and resolved by `OrderStatusConfigProvider`
   * (fails CLOSED to the canonical order status defaults on null/garbage).
   */
  orderStatusConfig: unknown;
  warehouseFilter?: {
    warehouses: Array<{ id: string; name: string }>;
    activeId: string | null;
    warehouseLabel: string;
    /** The org's plural term ("Warehouses", "Backrooms") for "All …". */
    warehousePluralLabel?: string;
  };
  /** Server-read initial value of the desktop sidebar hide preference. */
  initialSidebarHidden?: boolean;
  /** Server-read (sp_density cookie) table density for this viewer. */
  initialDensity?: Density;
  /**
   * Server-read (sp_nav_collapsed cookie) nav sections this viewer collapsed.
   * null or omitted: they never chose, so the role's default applies (Admin
   * collapsed for owners and admins).
   */
  initialCollapsedSections?: NavSectionKey[] | null;
}

/**
 * The organization switcher's trigger (org-switcher.tsx). It is a button only
 * for someone in more than one organization; for everyone else the switcher
 * is a static label.
 */
const ORG_SWITCHER_TRIGGER = 'button[aria-label="Switch organization"]:not(:disabled)';

export function DashboardShell({
  children,
  email,
  fullName,
  avatarUrl,
  userId,
  organizationId,
  organizationName,
  organizationLogoUrl,
  memberships,
  userName,
  userRole,
  role,
  permissions,
  isPlatformAdmin,
  enabledModules,
  navOverrides,
  orderStatusConfig,
  warehouseFilter,
  initialSidebarHidden = false,
  initialDensity = 'comfortable',
  initialCollapsedSections = null,
}: DashboardShellProps) {
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  const [desktopSidebarHidden, setDesktopSidebarHidden] =
    React.useState(initialSidebarHidden);

  // Table density: data-density on the shell root, which globals.css turns
  // into --row-py (table body cell padding only). Chosen in the account menu,
  // remembered per viewer in a cookie the layout reads for the first paint.
  const [density, setDensity] = React.useState<Density>(initialDensity);
  const handleDensityChange = React.useCallback((next: Density) => {
    setDensity(next);
    document.cookie = densityCookieString(next);
  }, []);

  // Collapsed nav sections, shared by the desktop sidebar and the phone
  // drawer's copy so they always agree. null = the viewer never chose: the
  // default follows the role in use (it can change with an org switch).
  const [collapsedPref, setCollapsedPref] = React.useState<NavSectionKey[] | null>(
    initialCollapsedSections,
  );
  const collapsedSections = React.useMemo(
    () => collapsedPref ?? defaultCollapsedSections(role),
    [collapsedPref, role],
  );
  const handleToggleSection = React.useCallback(
    (key: NavSectionKey, collapse: boolean) => {
      const next = collapse
        ? [...new Set([...collapsedSections, key])]
        : collapsedSections.filter((k) => k !== key);
      setCollapsedPref(next);
      document.cookie = collapsedSectionsCookieString(next);
    },
    [collapsedSections],
  );

  // The org's OVERRIDDEN nav — the exact same navForRole pass the Sidebar
  // runs internally, memoized here for the Topbar so breadcrumbs inherit
  // per-org renames (Settings → Navigation) and always agree with the
  // sidebar. Pure + registry-backed: no fetch, and applyNavOverrides inside
  // navForRole fails CLOSED to the derived nav on null/garbage overrides.
  const navSections = React.useMemo(
    () =>
      navForRole(
        role,
        new Set(enabledModules as ModuleId[]),
        (navOverrides as NavOverrides | null) ?? null,
        permissions ? new Set(permissions as Permission[]) : undefined,
      ),
    [role, enabledModules, navOverrides, permissions],
  );

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

  // What that control says follows what it does. On a phone it opens the
  // drawer, so it reads "Show sidebar", collapsed (the drawer is closed
  // whenever the button can be reached: the open drawer hides the page from
  // assistive tech). It used to read "Hide sidebar", expanded, pointing at the
  // desktop sidebar that is not displayed on a phone. Server render and
  // hydration assume a desktop, then the real width takes over.
  const desktopViewport = React.useSyncExternalStore(
    subscribeToDesktopViewport,
    isDesktopViewport,
    () => true,
  );

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
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch lifecycle
    setMounted(true);
  }, []);

  // Where focus lands when the phone drawer opens: where it did before the
  // nav's sections could fold. Radix focuses the first control that is not a
  // link, which was the organization switcher for someone in more than one
  // organization and the drawer's Close for everyone else. The section
  // headings are buttons now, so Radix's own pick would be the first of them
  // (Inventory), mid-nav, where Enter folds the section.
  const drawerCloseRef = React.useRef<HTMLButtonElement>(null);
  const focusDrawerStart = React.useCallback((event: Event) => {
    const drawer = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    const start =
      drawer?.querySelector<HTMLElement>(ORG_SWITCHER_TRIGGER) ?? drawerCloseRef.current;
    if (!start) return; // Radix's own pick
    event.preventDefault();
    start.focus();
  }, []);

  // Identify the signed-in user to PostHog. `identify` is a no-op when
  // analytics is unconfigured (NEXT_PUBLIC_POSTHOG_KEY unset), so this costs
  // nothing until the owner turns analytics on. Sign-out reset() lives in the
  // user-menu sign-out handler.
  React.useEffect(() => {
    identify(userId, { email, organization_id: organizationId });
  }, [userId, email, organizationId]);

  // The tour state is kept for the browser session, keyed by user
  // (lib/onboarding/tour-state-cache.ts). When this shell renders for a
  // different person (a sign-in as someone else in another tab reaches this
  // one on its next navigation), drop the previous person's copy at once.
  React.useEffect(() => {
    forgetTourState(userId);
  }, [userId]);

  // Pin the body to exactly viewport-height-without-overflow. We used to
  // do this with `overflow-hidden + h-dvh`, but on iOS Safari that
  // broke keyboard-dismiss flow: the inner <main> stayed scrolled to
  // wherever the keyboard had pushed it, and the user couldn't scroll
  // back up because the body itself was locked. Switching to
  // `position: fixed; inset: 0` achieves the same "no body scroll past
  // viewport" guarantee — Toaster/devtools-indicator portals are all
  // `position: fixed` themselves so they don't push body height — while
  // letting iOS naturally re-flow the inner scroll container when the
  // keyboard hides.
  //
  // Restored on unmount so the marketing site (long scrollable pages)
  // gets its natural scroll back when the user navigates away.
  //
  // The way back puts back ONLY what this effect changed. It used to restore
  // the whole class and style attributes of <html> and <body> as they were at
  // mount, but next-themes writes the theme class and color-scheme on <html>
  // while the dashboard is open: switching to Light and then signing out put
  // the old Dark class back, and the landing page came up dark.
  React.useEffect(() => {
    const body = document.body;
    const html = document.documentElement;
    const removedClasses = ['min-h-dvh', 'min-h-screen'].filter((c) => body.classList.contains(c));
    const prev = {
      position: body.style.position,
      inset: body.style.inset,
      overflow: body.style.overflow,
      height: html.style.height,
    };
    body.classList.remove(...removedClasses);
    body.style.position = 'fixed';
    body.style.inset = '0';
    body.style.overflow = 'hidden';
    html.style.height = '100%';
    return () => {
      body.classList.add(...removedClasses);
      body.style.position = prev.position;
      body.style.inset = prev.inset;
      body.style.overflow = prev.overflow;
      html.style.height = prev.height;
      if (!body.getAttribute('style')) body.removeAttribute('style');
      if (!html.getAttribute('style')) html.removeAttribute('style');
    };
  }, []);

  return (
    // .sp-shell (globals.css) carries the dashboard chrome type, 13.5px Inter;
    // data-density feeds --row-py to every table in the page.
    <div className="sp-shell bg-background flex h-dvh overflow-hidden" data-density={density}>
      {/* Top progress bar — fires at click time on every internal nav,
          covers links the per-link useLinkStatus indicator can't see
          (topbar, dashboard cards, table rows, breadcrumbs, etc), and
          path navigations the router starts from code. */}
      <NavProgressBar />
      {/* Photo-loading diagnostics for real users: image load failures and
          per-route load timings, reduced to a CLASS ("thumbnail via the
          optimizer") before anything is kept. Never a URL. Dashboard only,
          by living here. Renders nothing. */}
      <ImageDiagnostics />
      {/* Live permission updates: refreshes the dashboard (nav re-gates,
          section layouts re-evaluate) the instant an admin changes this
          user's access. Renders nothing. */}
      <PermissionsRealtime organizationId={organizationId} userId={userId} role={role} />
      <SessionRevocationListener userId={userId} />
      {/*
        Skip link: hidden until keyboard-focused. Lets keyboard / screen-
        reader users jump past the sidebar + topbar straight into the
        main content. Tabbing into a fresh page surfaces this first.
      */}
      <a
        href="#main-content"
        className="bg-foreground text-background focus-visible:outline-foreground/70 sr-only z-50 rounded-md px-3 py-2 text-sm font-medium focus-visible:not-sr-only focus-visible:absolute focus-visible:left-3 focus-visible:top-3 focus-visible:outline focus-visible:outline-2"
      >
        Skip to main content
      </a>

      {!desktopSidebarHidden && (
        <Sidebar
          id={SIDEBAR_DOM_ID}
          className="hidden md:flex"
          organizationId={organizationId}
          organizationName={organizationName}
          organizationLogoUrl={organizationLogoUrl ?? null}
          memberships={memberships}
          userName={userName}
          userRole={userRole}
          role={role}
          permissions={permissions}
          enabledModules={enabledModules}
          navOverrides={navOverrides}
          collapsedSections={collapsedSections}
          onToggleSection={handleToggleSection}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          email={email}
          fullName={fullName}
          avatarUrl={avatarUrl}
          organizationName={organizationName}
          userId={userId}
          organizationId={organizationId}
          isPlatformAdmin={isPlatformAdmin}
          onToggleSidebar={handleToggleSidebar}
          sidebarHidden={desktopViewport ? desktopSidebarHidden : true}
          warehouseFilter={warehouseFilter}
          navSections={navSections}
          density={density}
          onDensityChange={handleDensityChange}
        />
        {/*
          main bg matches the Card bg so any empty area below short
          forms is visually indistinguishable from the Card — no dark
          strip / void. The body-locking useEffect above + the
          min-h-full inner div together kill the second-scrollbar bug.
          Net effect: one scrollbar (main's), no body scroll, and short
          forms fill the whole panel without an obvious cut-off.
        */}
        <main
          id="main-content"
          tabIndex={-1}
          className="bg-card flex-1 overflow-y-auto focus:outline-none"
        >
          <div className="min-h-full">
            {/* The page area. A navigation still waiting after 400 ms
                swaps the page for its destination's skeleton here; the
                frame owns that state, so nothing above re-renders. */}
            <PendingRouteFrame>
              <OrderStatusConfigProvider config={orderStatusConfig}>
                <SessionUserProvider userId={userId}>{children}</SessionUserProvider>
              </OrderStatusConfigProvider>
            </PendingRouteFrame>
          </div>
        </main>
      </div>

      {mounted && (
        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetContent
            side="left"
            hideClose
            className="bg-background w-[280px] max-w-[280px] gap-0 rounded-none p-0"
            aria-describedby={undefined}
            onOpenAutoFocus={focusDrawerStart}
          >
            <SheetTitle className="sr-only">Dashboard navigation</SheetTitle>
            <Sidebar
              className="flex w-full border-r-0"
              organizationId={organizationId}
              organizationName={organizationName}
              organizationLogoUrl={organizationLogoUrl ?? null}
              memberships={memberships}
              userName={userName}
              userRole={userRole}
              role={role}
              permissions={permissions}
              enabledModules={enabledModules}
              navOverrides={navOverrides}
              collapsedSections={collapsedSections}
              onToggleSection={handleToggleSection}
              onNavigate={() => setMobileNavOpen(false)}
            />
            {/* The drawer's own close control, a 44px target in the brand
                row's empty right end (the sheet's built-in one is 16px).
                After the sidebar in the DOM, as the built-in one was, so the
                Tab order is unchanged: from Close, Tab wraps to the brand link
                and then the nav. Where focus starts: focusDrawerStart. */}
            <SheetClose asChild>
              <button
                ref={drawerCloseRef}
                type="button"
                aria-label="Close"
                className="hover:bg-muted hover:text-foreground absolute right-1.5 top-1.5 grid size-11 place-items-center rounded-md text-[var(--ed-ink-2)] transition-colors"
              >
                <X aria-hidden className="size-4" />
              </button>
            </SheetClose>
          </SheetContent>
        </Sheet>
      )}

      {mounted && (
        <EdgeSwipeOpener
          onOpen={() => setMobileNavOpen(true)}
          disabled={mobileNavOpen}
        />
      )}

      <UpdateCenter userId={userId} organizationId={organizationId} />
      {/* Holds only the ⌘K listener; the palette's code arrives on the first
          press or when the browser goes idle, off the hydration path. */}
      <CommandPaletteLauncher />
      <KeyboardShortcutsProvider />
    </div>
  );
}
