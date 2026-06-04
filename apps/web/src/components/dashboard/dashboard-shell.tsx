'use client';

import * as React from 'react';

import { BootSplash } from '@/components/dashboard/boot-splash';
import { CommandPalette } from '@/components/dashboard/command-palette';
import { EdgeSwipeOpener } from '@/components/dashboard/edge-swipe-opener';
import { KeyboardShortcutsProvider } from '@/components/dashboard/keyboard-shortcuts';
import { NavProgressBar } from '@/components/dashboard/nav-progress-bar';
import { OrderStatusConfigProvider } from '@/components/orders/order-status-config-provider';
import { Sidebar } from '@/components/dashboard/sidebar';
import { Topbar } from '@/components/dashboard/topbar';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { VersionNotifier } from '@/components/version-notifier';

import type { Role } from '@stockpilot/core';

interface DashboardShellProps {
  children: React.ReactNode;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  userId: string;
  initialUnreadNotifications: number;
  organizationId: string;
  organizationName: string;
  organizationLogoUrl?: string | null;
  memberships: Array<{ id: string; name: string; logoUrl: string | null; role: string }>;
  userName: string | null;
  userRole: string;
  role: Role;
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
  };
}

export function DashboardShell({
  children,
  email,
  fullName,
  avatarUrl,
  userId,
  initialUnreadNotifications,
  organizationId,
  organizationName,
  organizationLogoUrl,
  memberships,
  userName,
  userRole,
  role,
  enabledModules,
  navOverrides,
  orderStatusConfig,
  warehouseFilter,
}: DashboardShellProps) {
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch lifecycle
    setMounted(true);
  }, []);

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
  React.useEffect(() => {
    const body = document.body;
    const html = document.documentElement;
    const prev = {
      bodyClass: body.className,
      htmlClass: html.className,
      bodyStyle: body.getAttribute('style') ?? '',
      htmlStyle: html.getAttribute('style') ?? '',
    };
    body.classList.remove('min-h-dvh', 'min-h-screen');
    body.style.position = 'fixed';
    body.style.inset = '0';
    body.style.overflow = 'hidden';
    html.style.height = '100%';
    return () => {
      body.className = prev.bodyClass;
      html.className = prev.htmlClass;
      if (prev.bodyStyle) body.setAttribute('style', prev.bodyStyle);
      else body.removeAttribute('style');
      if (prev.htmlStyle) html.setAttribute('style', prev.htmlStyle);
      else html.removeAttribute('style');
    };
  }, []);

  return (
    <div className="bg-background flex h-dvh overflow-hidden">
      {/* Top progress bar — fires at click time on every internal nav,
          covers links the per-link useLinkStatus indicator can't see
          (topbar, dashboard cards, table rows, breadcrumbs, etc). */}
      <NavProgressBar />
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

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          email={email}
          fullName={fullName}
          avatarUrl={avatarUrl}
          organizationName={organizationName}
          userId={userId}
          initialUnreadNotifications={initialUnreadNotifications}
          onToggleSidebar={() => setMobileNavOpen(true)}
          warehouseFilter={warehouseFilter}
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
            <OrderStatusConfigProvider config={orderStatusConfig}>
              {children}
            </OrderStatusConfigProvider>
          </div>
        </main>
      </div>

      {mounted && (
        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetContent
            side="left"
            className="w-[280px] max-w-[280px] gap-0 p-0"
            aria-describedby={undefined}
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
              enabledModules={enabledModules}
              navOverrides={navOverrides}
              onNavigate={() => setMobileNavOpen(false)}
            />
          </SheetContent>
        </Sheet>
      )}

      {mounted && (
        <EdgeSwipeOpener
          onOpen={() => setMobileNavOpen(true)}
          disabled={mobileNavOpen}
        />
      )}

      <VersionNotifier />
      <CommandPalette />
      <KeyboardShortcutsProvider />

      {/*
        Branded cold-load boot screen. Rendered LAST (on top) as a fixed overlay
        that cross-dissolves to reveal the shell underneath — the shell mounts /
        hydrates behind it during the hold, so nothing is gated on the splash's
        animation. Self-managing: shows once per genuine page load, then renders
        null (never on client-side route changes). See BootSplash for details.
      */}
      <BootSplash workspaceName={organizationName} />
    </div>
  );
}
