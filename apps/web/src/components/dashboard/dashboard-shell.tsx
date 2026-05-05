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
  organizationName: string;
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
  organizationName,
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

  // Lock the body to exact viewport height while the dashboard shell is
  // mounted. Without this, anything Next.js or Vercel injects after the
  // shell (Toaster portal, Vercel preview toolbar, devtools indicator)
  // pushes the body past 100vh — the body itself becomes scrollable past
  // <main>'s scroll, producing a second scrollbar and a "void" below
  // short pages. We restore the original classes on navigation away so
  // marketing pages (long scrolly content) keep their natural scroll.
  React.useEffect(() => {
    const body = document.body;
    const html = document.documentElement;
    const prevBody = body.className;
    const prevHtml = html.className;
    body.classList.remove('min-h-screen');
    body.classList.add('h-screen', 'overflow-hidden');
    html.classList.add('h-screen', 'overflow-hidden');
    return () => {
      body.className = prevBody;
      html.className = prevHtml;
    };
  }, []);

  return (
    <div className="bg-background flex h-screen overflow-hidden">
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
        organizationName={organizationName}
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
              organizationName={organizationName}
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
