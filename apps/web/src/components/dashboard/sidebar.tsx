'use client';

import { ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import * as React from 'react';

import { DASHBOARD_NAV_HREFS, navForRole, type NavSection } from '@/components/dashboard/nav';
import { IconMark } from '@/components/ui/icon-mark';
import { cn } from '@/lib/utils';

import type { Role } from '@stockpilot/core';

interface SidebarProps {
  className?: string;
  organizationName: string;
  userName: string | null;
  userRole?: string;
  /** DB role token used to filter nav (admin section is admin-only). */
  role: Role;
  onNavigate?: () => void;
}

export function Sidebar({
  className,
  organizationName,
  userName,
  userRole,
  role,
  onNavigate,
}: SidebarProps) {
  const sections: NavSection[] = navForRole(role);
  const pathname = usePathname();
  const router = useRouter();
  const initials = (userName || 'U')
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('');

  const warmRoute = React.useCallback(
    (href: string) => {
      if (href !== pathname) router.prefetch(href);
    },
    [pathname, router],
  );

  React.useEffect(() => {
    const warmAllRoutes = () => {
      DASHBOARD_NAV_HREFS.forEach((href) => warmRoute(href));
    };
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    if (typeof idleWindow.requestIdleCallback === 'function') {
      const idleId = idleWindow.requestIdleCallback(warmAllRoutes, { timeout: 1600 });
      return () => idleWindow.cancelIdleCallback?.(idleId);
    }

    const timeoutId = globalThis.setTimeout(warmAllRoutes, 450);
    return () => globalThis.clearTimeout(timeoutId);
  }, [warmRoute]);

  return (
    <aside
      className={cn(
        'border-border flex h-screen w-[244px] shrink-0 flex-col border-r bg-[color-mix(in_oklab,hsl(var(--background))_94%,hsl(var(--foreground))_3%)]',
        className,
      )}
    >
      {/* Brand head */}
      <div
        className="h-13 border-border flex items-center gap-2.5 border-b px-3.5"
        style={{ height: 52 }}
      >
        <Link href="/dashboard" onClick={onNavigate}>
          <IconMark size={22} />
        </Link>
      </div>

      {/* Org pill — currently a static label; will become an org-switcher
          once multi-org membership lands. Marked as a label rather than
          a button so a screen reader doesn't promise interactive
          behavior we don't have yet. */}
      <div
        role="presentation"
        className="border-border bg-card mx-3 mt-3 flex items-center gap-2 rounded-md border px-2.5 py-2 text-[12px] text-[var(--ed-ink-2)]"
      >
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--accent))]" />
        <span className="flex-1 truncate text-left">
          <span className="sr-only">Organization: </span>
          {organizationName}
        </span>
        <ChevronDown aria-hidden className="h-3 w-3 opacity-60" />
      </div>

      {/* Nav */}
      <nav className="scrollbar-thin flex-1 overflow-y-auto px-2 py-2.5">
        {sections.map((section, idx) => (
          <div key={idx} className="px-1.5 pb-1 pt-2.5">
            {section.label && (
              <div className="px-2 pb-1.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--ed-ink-4)]">
                {section.label}
              </div>
            )}
            {section.items.map((item) => {
              const active =
                pathname === item.href ||
                (pathname.startsWith(item.href) && item.href !== '/dashboard');
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  prefetch
                  onFocus={() => warmRoute(item.href)}
                  onPointerEnter={() => warmRoute(item.href)}
                  onPointerDown={() => warmRoute(item.href)}
                  onClick={onNavigate}
                  className={cn(
                    'flex min-h-8 items-center gap-2.5 rounded-[6px] px-2.5 py-1.5 text-[13px] transition-colors',
                    active
                      ? 'bg-card text-foreground border border-[var(--ed-line-strong)] shadow-[0_1px_0_rgba(14,15,13,0.05),_0_8px_22px_rgba(14,15,13,0.05)]'
                      : 'hover:bg-card hover:text-foreground border border-transparent text-[var(--ed-ink-2)]',
                  )}
                >
                  <item.icon
                    className={cn(
                      'h-4 w-4 shrink-0',
                      active ? 'text-foreground' : 'text-[var(--ed-ink-3)]',
                    )}
                  />
                  <span className="flex-1">{item.label}</span>
                  {item.badge != null && (
                    <span
                      className={cn(
                        'shrink-0 rounded-[3px] border px-1.5 py-px font-mono text-[10.5px]',
                        item.alert
                          ? 'border-transparent bg-[hsl(var(--destructive)/0.16)] text-[hsl(var(--destructive))]'
                          : 'border-border bg-muted text-[var(--ed-ink-3)]',
                      )}
                    >
                      {item.badge}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* User foot */}
      <div className="border-border flex items-center gap-2.5 border-t px-3 py-2.5">
        <span className="bg-foreground text-background grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full text-[11px] font-semibold">
          {initials}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] leading-tight">{userName ?? '—'}</div>
          <div className="truncate text-[11px] text-[var(--ed-ink-4)]">{userRole ?? 'Member'}</div>
        </div>
      </div>
    </aside>
  );
}
