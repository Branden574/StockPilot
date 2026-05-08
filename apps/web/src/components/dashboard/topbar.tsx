'use client';

import { Bell, BookOpen, Search, SlidersHorizontal } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';

import { ThemeToggle } from '@/components/theme/theme-toggle';
import { WarehouseFilterPicker } from '@/components/dashboard/warehouse-filter-picker';
import { cn } from '@/lib/utils';

import { UserMenu } from './user-menu';

interface TopbarProps {
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  organizationName: string;
  onToggleSidebar?: () => void;
  /** Pass-through filter UI props — only rendered when warehouses is non-empty. */
  warehouseFilter?: {
    warehouses: Array<{ id: string; name: string }>;
    activeId: string | null;
    warehouseLabel: string;
  };
}

interface Crumb {
  label: string;
  /** When non-null, the segment renders as a clickable Link. The current
      page (last segment) and section labels with no canonical URL stay
      as plain text. */
  href: string | null;
}

const SECTION_INVENTORY: Crumb = { label: 'Inventory', href: null };
const SECTION_WORKSPACE: Crumb = { label: 'Workspace', href: null };
const ITEMS_LIST: Crumb = { label: 'Items', href: '/dashboard/inventory' };
const POS_LIST: Crumb = { label: 'Purchase orders', href: '/dashboard/purchase-orders' };
const SETTINGS_LIST: Crumb = { label: 'Settings', href: '/dashboard/settings' };

const CRUMBS: Array<[RegExp, Crumb[]]> = [
  [/^\/dashboard$/, [{ label: 'Overview', href: null }]],
  [/^\/dashboard\/inventory\/new$/, [SECTION_INVENTORY, ITEMS_LIST, { label: 'New', href: null }]],
  [
    /^\/dashboard\/inventory\/[^/]+\/edit$/,
    [SECTION_INVENTORY, ITEMS_LIST, { label: 'Edit', href: null }],
  ],
  [
    /^\/dashboard\/inventory\/[^/]+$/,
    [SECTION_INVENTORY, ITEMS_LIST, { label: 'Detail', href: null }],
  ],
  [
    /^\/dashboard\/inventory\/import$/,
    [SECTION_INVENTORY, ITEMS_LIST, { label: 'Import', href: null }],
  ],
  [/^\/dashboard\/inventory$/, [SECTION_INVENTORY, { label: 'Items', href: null }]],
  [/^\/dashboard\/categories$/, [SECTION_INVENTORY, { label: 'Categories', href: null }]],
  [/^\/dashboard\/movements$/, [SECTION_INVENTORY, { label: 'Movements', href: null }]],
  [
    /^\/dashboard\/purchase-orders\/new$/,
    [SECTION_INVENTORY, POS_LIST, { label: 'New', href: null }],
  ],
  [
    /^\/dashboard\/purchase-orders\/[^/]+$/,
    [SECTION_INVENTORY, POS_LIST, { label: 'Detail', href: null }],
  ],
  [/^\/dashboard\/purchase-orders$/, [SECTION_INVENTORY, { label: 'Purchase orders', href: null }]],
  [/^\/dashboard\/locations$/, [SECTION_INVENTORY, { label: 'Locations', href: null }]],
  [/^\/dashboard\/suppliers$/, [SECTION_INVENTORY, { label: 'Suppliers', href: null }]],
  [/^\/dashboard\/reports$/, [SECTION_INVENTORY, { label: 'Reports', href: null }]],
  [/^\/dashboard\/notifications$/, [SECTION_WORKSPACE, { label: 'Notifications', href: null }]],
  [/^\/dashboard\/team$/, [SECTION_WORKSPACE, { label: 'Team', href: null }]],
  [
    /^\/dashboard\/settings\/billing$/,
    [SECTION_WORKSPACE, SETTINGS_LIST, { label: 'Billing', href: null }],
  ],
  [/^\/dashboard\/settings$/, [SECTION_WORKSPACE, { label: 'Settings', href: null }]],
];

function useCrumbs(pathname: string): Crumb[] {
  for (const [pattern, crumbs] of CRUMBS) {
    if (pattern.test(pathname)) return crumbs;
  }
  return [{ label: '—', href: null }];
}

export function Topbar({
  email,
  fullName,
  avatarUrl,
  organizationName,
  onToggleSidebar,
  warehouseFilter,
}: TopbarProps) {
  const pathname = usePathname();
  const crumbs = useCrumbs(pathname);

  return (
    <header
      className="border-border sticky top-0 z-20 flex items-center gap-3 border-b bg-[color-mix(in_oklab,hsl(var(--background))_92%,transparent)] px-4 backdrop-blur-md sm:gap-4 sm:px-5"
      style={{ height: 56 }}
    >
      <button
        type="button"
        className="hover:bg-muted hover:text-foreground grid h-[30px] w-[30px] place-items-center rounded-md text-[var(--ed-ink-3)] transition-colors lg:hidden"
        aria-label="Open dashboard navigation"
        onClick={onToggleSidebar}
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
      </button>

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
        className="border-border bg-card hidden h-8 min-w-[240px] max-w-[460px] flex-1 items-center gap-2 rounded-md border px-2.5 text-[12.5px] text-[var(--ed-ink-4)] shadow-[0_1px_0_rgba(14,15,13,0.03)] transition-colors hover:border-[var(--ed-line-strong)] md:flex"
        aria-label="Open command palette"
        onClick={() => {
          // Synthesize a ⌘K so we don't need a global store. The palette
          // toggles on this exact event.
          window.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }),
          );
        }}
      >
        <Search className="h-3 w-3" />
        <span className="flex-1 text-left">Search items, POs, suppliers…</span>
        <span className="border-border bg-muted rounded-[3px] border px-1.5 py-px font-mono text-[10.5px] text-[var(--ed-ink-3)]">
          ⌘K
        </span>
      </button>

      <Link
        href="/dashboard/notifications"
        className="hover:bg-muted hover:text-foreground relative grid h-[30px] w-[30px] place-items-center rounded-md text-[var(--ed-ink-3)] transition-colors"
        aria-label="Notifications"
      >
        <Bell className="h-3.5 w-3.5" />
        <span
          aria-hidden
          className="outline-background absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-[hsl(var(--destructive))] outline outline-[1.5px]"
        />
      </Link>

      <button
        type="button"
        className="hover:bg-muted hover:text-foreground grid h-[30px] w-[30px] place-items-center rounded-md text-[var(--ed-ink-3)] transition-colors"
        aria-label="Help"
      >
        <BookOpen className="h-3.5 w-3.5" />
      </button>

      <ThemeToggle />

      <UserMenu
        email={email}
        fullName={fullName}
        avatarUrl={avatarUrl}
        organizationName={organizationName}
      />
    </header>
  );
}
