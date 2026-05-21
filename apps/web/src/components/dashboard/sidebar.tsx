'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import * as React from 'react';

import { DASHBOARD_NAV_HREFS, navForRole, type NavSection } from '@/components/dashboard/nav';
import { NavLinkPending } from '@/components/dashboard/nav-link-pending';
import { OrgSwitcher } from '@/components/dashboard/org-switcher';
import { IconMark } from '@/components/ui/icon-mark';
import { cn } from '@/lib/utils';

import type { Role } from '@stockpilot/core';

interface SidebarProps {
  className?: string;
  organizationId: string;
  organizationName: string;
  organizationLogoUrl?: string | null;
  memberships?: Array<{ id: string; name: string; logoUrl: string | null; role: string }>;
  userName: string | null;
  userRole?: string;
  /** DB role token used to filter nav (admin section is admin-only). */
  role: Role;
  onNavigate?: () => void;
}

export function Sidebar({
  className,
  organizationId,
  organizationName,
  organizationLogoUrl,
  memberships,
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

      <OrgSwitcher
        orgs={
          memberships && memberships.length > 0
            ? memberships
            : [
                {
                  id: organizationId,
                  name: organizationName,
                  logoUrl: organizationLogoUrl ?? null,
                  role,
                },
              ]
        }
        activeId={organizationId}
      />

      {/* Nav */}
      <nav className="scrollbar-thin flex-1 overflow-y-auto px-2 py-3">
        {sections.map((section, idx) => {
          // Active route logic:
          //   - root `/dashboard` highlights only on an exact match (so child
          //     dashboard routes don't all light up "Overview").
          //   - every other entry highlights when the current pathname is the
          //     entry itself OR a deeper sub-route (e.g.
          //     `/dashboard/inventory/abc-123` highlights "Items").
          const isFirstSection = idx === 0;
          return (
            <div
              key={idx}
              className={cn(
                'px-1.5',
                // Tighter top padding for the first section; bigger top
                // breathing room for every subsequent section, plus a 1px
                // hairline divider above the section heading.
                isFirstSection
                  ? 'pb-1 pt-1'
                  : 'border-border mt-3 border-t pb-1 pt-3',
              )}
            >
              {section.label && (
                <div className="text-muted-foreground px-2 pb-2 pt-0.5 text-[10.5px] font-semibold uppercase tracking-[0.12em]">
                  {section.label}
                </div>
              )}
              {section.items.map((item) => {
                const active =
                  item.href === '/dashboard'
                    ? pathname === '/dashboard'
                    : pathname === item.href ||
                      pathname.startsWith(`${item.href}/`);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    // Disabled eager prefetch — the sidebar renders
                    // ~25 links, and eager prefetch fired an RSC
                    // fetch for every one on mount, adding measurable
                    // initial-load drag on every dashboard page.
                    // warmRoute() below already prefetches on hover /
                    // focus / pointer-down, which is what the user
                    // actually clicks.
                    prefetch={false}
                    onFocus={() => warmRoute(item.href)}
                    onPointerEnter={() => warmRoute(item.href)}
                    onPointerDown={() => warmRoute(item.href)}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      // The 3px left padding offset (px-[11px] vs px-2.5) reserves
                      // room for the 2px active-edge accent so non-active rows
                      // line up visually with active ones.
                      'relative flex min-h-8 items-center gap-2.5 rounded-[6px] py-1.5 pl-[11px] pr-2.5 text-[13px] transition-colors',
                      active
                        ? 'bg-card text-foreground border border-[var(--ed-line-strong)] shadow-[0_1px_0_rgba(14,15,13,0.05),_0_8px_22px_rgba(14,15,13,0.05)]'
                        : 'hover:bg-card hover:text-foreground border border-transparent text-[var(--ed-ink-2)]',
                    )}
                  >
                    {active && (
                      <span
                        aria-hidden="true"
                        className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r-full bg-[hsl(var(--accent))]"
                      />
                    )}
                    <item.icon
                      className={cn(
                        'h-4 w-4 shrink-0',
                        active ? 'text-foreground' : 'text-[var(--ed-ink-3)]',
                      )}
                    />
                    <span className="flex-1">{item.label}</span>
                    {/* Pending indicator — turns on at click time via
                        useLinkStatus(), turns off when the new route
                        finishes rendering. Without this, a cold-cache
                        first click sat silent for ~1.2s before the URL
                        even changed. */}
                    <NavLinkPending />
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
          );
        })}
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
