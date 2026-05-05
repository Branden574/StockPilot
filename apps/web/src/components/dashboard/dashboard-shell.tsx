'use client';

import * as React from 'react';

import { Sidebar } from '@/components/dashboard/sidebar';
import { Topbar } from '@/components/dashboard/topbar';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';

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

  return (
    <div className="bg-background flex h-screen overflow-hidden">
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
          The inner min-h-full div is critical: without it, short page
          content (e.g. the new-item form on a tall display) ends mid-
          viewport and `main`'s overflow-y-auto lets the user scroll
          past it into uncolored space — looked like a broken void.
          Forcing the wrapper to always be ≥ main's visible height
          means there's never scrollable empty space past page content,
          and bg-muted/30 paints any genuinely empty area as panel.
        */}
        <main className="flex-1 overflow-y-auto bg-muted/30">
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
    </div>
  );
}
