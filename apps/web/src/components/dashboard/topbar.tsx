'use client';

import { Bell, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { ThemeToggle } from '@/components/theme/theme-toggle';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { UserMenu } from './user-menu';

interface TopbarProps {
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  organizationName: string;
}

export function Topbar({ email, fullName, avatarUrl, organizationName }: TopbarProps) {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border/60 bg-background/80 px-4 backdrop-blur-xl sm:px-6">
      <div className="hidden flex-1 max-w-md md:flex">
        <div className="relative w-full">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search items, SKUs, suppliers…"
            className="h-9 w-full pl-9"
            aria-label="Global search"
          />
          <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 select-none rounded border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">
            ⌘K
          </kbd>
        </div>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <Button asChild variant="default" size="sm" className="hidden sm:inline-flex">
          <Link href="/dashboard/inventory/new">
            <Plus className="h-4 w-4" />
            New item
          </Link>
        </Button>
        <Button asChild variant="ghost" size="icon" aria-label="Notifications">
          <Link href="/dashboard/notifications">
            <Bell className="h-4 w-4" />
          </Link>
        </Button>
        <ThemeToggle />
        <UserMenu
          email={email}
          fullName={fullName}
          avatarUrl={avatarUrl}
          organizationName={organizationName}
        />
      </div>
    </header>
  );
}
