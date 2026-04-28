'use client';

import { Bell, BookOpen, Search, SlidersHorizontal } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';

import { ThemeToggle } from '@/components/theme/theme-toggle';

import { UserMenu } from './user-menu';

interface TopbarProps {
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  organizationName: string;
}

const CRUMBS: Array<[RegExp, string[]]> = [
  [/^\/dashboard$/, ['Overview']],
  [/^\/dashboard\/inventory\/new$/, ['Inventory', 'Items', 'New']],
  [/^\/dashboard\/inventory\/[^/]+\/edit$/, ['Inventory', 'Items', 'Edit']],
  [/^\/dashboard\/inventory\/[^/]+$/, ['Inventory', 'Items', 'Detail']],
  [/^\/dashboard\/inventory\/import$/, ['Inventory', 'Import']],
  [/^\/dashboard\/inventory$/, ['Inventory', 'Items']],
  [/^\/dashboard\/categories$/, ['Inventory', 'Categories']],
  [/^\/dashboard\/movements$/, ['Inventory', 'Movements']],
  [/^\/dashboard\/purchase-orders\/new$/, ['Inventory', 'Purchase orders', 'New']],
  [/^\/dashboard\/purchase-orders\/[^/]+$/, ['Inventory', 'Purchase orders', 'Detail']],
  [/^\/dashboard\/purchase-orders$/, ['Inventory', 'Purchase orders']],
  [/^\/dashboard\/locations$/, ['Inventory', 'Locations']],
  [/^\/dashboard\/suppliers$/, ['Inventory', 'Suppliers']],
  [/^\/dashboard\/reports$/, ['Inventory', 'Reports']],
  [/^\/dashboard\/notifications$/, ['Workspace', 'Notifications']],
  [/^\/dashboard\/team$/, ['Workspace', 'Team']],
  [/^\/dashboard\/settings\/billing$/, ['Workspace', 'Settings', 'Billing']],
  [/^\/dashboard\/settings$/, ['Workspace', 'Settings']],
];

function useCrumbs(pathname: string): string[] {
  for (const [pattern, crumbs] of CRUMBS) {
    if (pattern.test(pathname)) return crumbs;
  }
  return ['—'];
}

export function Topbar({ email, fullName, avatarUrl, organizationName }: TopbarProps) {
  const pathname = usePathname();
  const crumbs = useCrumbs(pathname);

  return (
    <header
      className="sticky top-0 z-20 flex items-center gap-4 border-b border-border bg-[color-mix(in_oklab,hsl(var(--background))_92%,transparent)] px-5 backdrop-blur-md"
      style={{ height: 52 }}
    >
      <button
        type="button"
        className="grid h-[30px] w-[30px] place-items-center rounded-md text-[var(--ed-ink-3)] transition-colors hover:bg-muted hover:text-foreground"
        aria-label="Toggle sidebar"
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
      </button>

      <nav className="flex items-center gap-2 text-[13px] text-[var(--ed-ink-3)]" aria-label="Breadcrumb">
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="text-[var(--ed-ink-5)]">/</span>}
            <span className={i === crumbs.length - 1 ? 'text-foreground' : ''}>{c}</span>
          </React.Fragment>
        ))}
      </nav>

      <button
        type="button"
        className="ml-auto flex h-[30px] min-w-[260px] items-center gap-2 rounded-md border border-border bg-card px-2.5 text-[12.5px] text-[var(--ed-ink-4)] transition-colors hover:border-[var(--ed-line-strong)]"
        aria-label="Open command palette"
      >
        <Search className="h-3 w-3" />
        <span className="flex-1 text-left">Search items, POs, suppliers…</span>
        <span className="rounded-[3px] border border-border bg-muted px-1.5 py-px font-mono text-[10.5px] text-[var(--ed-ink-3)]">
          ⌘K
        </span>
      </button>

      <Link
        href="/dashboard/notifications"
        className="relative grid h-[30px] w-[30px] place-items-center rounded-md text-[var(--ed-ink-3)] transition-colors hover:bg-muted hover:text-foreground"
        aria-label="Notifications"
      >
        <Bell className="h-3.5 w-3.5" />
        <span
          aria-hidden
          className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-[hsl(var(--destructive))] outline outline-[1.5px] outline-background"
        />
      </Link>

      <button
        type="button"
        className="grid h-[30px] w-[30px] place-items-center rounded-md text-[var(--ed-ink-3)] transition-colors hover:bg-muted hover:text-foreground"
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
