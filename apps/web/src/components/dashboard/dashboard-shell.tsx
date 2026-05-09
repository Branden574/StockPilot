'use client';

import * as React from 'react';

import { CommandPalette } from '@/components/dashboard/command-palette';
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
  organizationId: string;
  organizationName: string;
  organizationLogoUrl?: string | null;
  memberships: Array<{ id: string; name: string; logoUrl: string | null; role: string }>;
  userName: string | null;
  userRole: string;
  role: Role;
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
  organizationId,
  organizationName,
  organizationLogoUrl,
  memberships,
  userName,
  userRole,
  role,
  warehouseFilter,
}: DashboardShellProps) {
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
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
        className="hidden lg:flex"
        organizationId={organizationId}
        organizationName={organizationName}
        organizationLogoUrl={organizationLogoUrl ?? null}
        memberships={memberships}
        userName={userName}
        userRole={userRole}
        role={role}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          email={email}
          fullName={fullName}
          avatarUrl={avatarUrl}
          organizationName={organizationName}
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
          <div className="min-h-full">{children}</div>
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
              onNavigate={() => setMobileNavOpen(false)}
            />
          </SheetContent>
        </Sheet>
      )}

      <VersionNotifier />
      <CommandPalette />
    </div>
  );
}
