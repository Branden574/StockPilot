'use client';

import { BookOpen, HelpCircle, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';

import { openKeyboardShortcutsOverlay } from '@/components/dashboard/keyboard-shortcuts';
import { NotificationBell } from '@/components/dashboard/notification-bell';
import { SidebarToggleButton } from '@/components/dashboard/sidebar-toggle-button';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { WarehouseFilterPicker } from '@/components/dashboard/warehouse-filter-picker';
import { cn } from '@/lib/utils';

import type { NavSection } from './nav';
import { applyNavLabelsToCrumbs, crumbsForPathname, navLabelMap } from './topbar-crumbs';
import { UserMenu } from './user-menu';

interface TopbarProps {
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  organizationName: string;
  userId: string;
  /** Active org — scopes the notification bell to this workspace. */
  organizationId: string;
  initialUnreadNotifications: number;
  isPlatformAdmin?: boolean;
  onToggleSidebar?: () => void;
  /** Desktop sidebar visibility, for the toggle button's label. */
  sidebarHidden?: boolean;
  /** Pass-through filter UI props — only rendered when warehouses is non-empty. */
  warehouseFilter?: {
    warehouses: Array<{ id: string; name: string }>;
    activeId: string | null;
    warehouseLabel: string;
  };
  /**
   * The org's OVERRIDDEN nav (navForRole output — same pass the Sidebar
   * renders). Breadcrumb segments whose canonical href matches a nav item
   * inherit its per-org renamed label so sidebar + crumbs always agree.
   * Optional: omitted (older callers/tests) → static crumb labels.
   */
  navSections?: NavSection[];
}

export function Topbar({
  email,
  fullName,
  avatarUrl,
  organizationName,
  userId,
  organizationId,
  initialUnreadNotifications,
  isPlatformAdmin,
  onToggleSidebar,
  sidebarHidden = false,
  warehouseFilter,
  navSections,
}: TopbarProps) {
  const pathname = usePathname();
  // Static crumb trail + per-org rename overlay. The map is derived from the
  // ALREADY-overridden nav the shell passes down (no extra fetch); crumbs
  // whose href isn't in it keep their static label (fail-closed).
  const labelByHref = React.useMemo(() => navLabelMap(navSections ?? []), [navSections]);
  const crumbs = React.useMemo(
    () => applyNavLabelsToCrumbs(crumbsForPathname(pathname), labelByHref),
    [pathname, labelByHref],
  );

  return (
    <header
      className="border-border sticky top-0 z-20 flex items-center gap-3 border-b bg-[color-mix(in_oklab,hsl(var(--background))_92%,transparent)] px-4 backdrop-blur-md sm:gap-4 sm:px-5"
      style={{ height: 56 }}
    >
      <SidebarToggleButton hidden={sidebarHidden} onToggle={() => onToggleSidebar?.()} />

      <nav
        className="flex min-w-0 items-center gap-2 text-[13px] text-[var(--ed-ink-3)]"
        aria-label="Breadcrumb"
      >
        {crumbs.map((c, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <React.Fragment key={i}>
              {i > 0 && <span className="text-[var(--ed-ink-5)]">/</span>}
              {c.href && !isLast ? (
                <Link
                  href={c.href}
                  className="hover:text-foreground truncate transition-colors hover:underline underline-offset-2"
                >
                  {c.label}
                </Link>
              ) : (
                <span className={cn('truncate', isLast ? 'text-foreground' : '')}>{c.label}</span>
              )}
            </React.Fragment>
          );
        })}
      </nav>

      <div className="ml-auto flex items-center gap-2">
        {warehouseFilter && warehouseFilter.warehouses.length > 0 && (
          <WarehouseFilterPicker
            warehouses={warehouseFilter.warehouses}
            activeId={warehouseFilter.activeId}
            warehouseLabel={warehouseFilter.warehouseLabel}
          />
        )}
      </div>

      <button
        type="button"
        className="border-border bg-card hidden h-8 min-w-[240px] max-w-[460px] flex-1 items-center gap-2 rounded-md border px-2.5 text-[12.5px] text-[var(--ed-ink-4)] shadow-[0_1px_0_rgba(14,15,13,0.03)] transition-colors hover:border-[var(--ed-line-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background md:flex"
        aria-label="Open command palette"
        onClick={() => {
          // Synthesize a ⌘K so we don't need a global store. The palette
          // toggles on this exact event.
          window.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }),
          );
        }}
      >
        <Search className="h-3 w-3" aria-hidden />
        <span className="flex-1 text-left">Search items, POs, suppliers…</span>
        <span className="border-border bg-muted rounded-[3px] border px-1.5 py-px font-mono text-[10.5px] text-[var(--ed-ink-3)]">
          ⌘K
        </span>
      </button>

      <NotificationBell
        userId={userId}
        organizationId={organizationId}
        initialUnread={initialUnreadNotifications}
      />

      <button
        type="button"
        className="hover:bg-muted hover:text-foreground grid h-[30px] w-[30px] place-items-center rounded-md text-[var(--ed-ink-3)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        aria-label="Keyboard shortcuts (?)"
        title="Keyboard shortcuts (?)"
        onClick={() => openKeyboardShortcutsOverlay()}
      >
        <HelpCircle className="h-3.5 w-3.5" aria-hidden />
      </button>

      <button
        type="button"
        className="hover:bg-muted hover:text-foreground grid h-[30px] w-[30px] place-items-center rounded-md text-[var(--ed-ink-3)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        aria-label="Help"
      >
        <BookOpen className="h-3.5 w-3.5" aria-hidden />
      </button>

      <ThemeToggle />

      <UserMenu
        email={email}
        fullName={fullName}
        avatarUrl={avatarUrl}
        organizationName={organizationName}
        isPlatformAdmin={isPlatformAdmin}
      />
    </header>
  );
}
