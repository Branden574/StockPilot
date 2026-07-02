'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import * as React from 'react';

import { navForRole, type NavSection } from '@/components/dashboard/nav';
import { NavLinkPending } from '@/components/dashboard/nav-link-pending';
import { OrgSwitcher } from '@/components/dashboard/org-switcher';
import { IconMark } from '@/components/ui/icon-mark';
import { cn } from '@/lib/utils';

import {
  DEFAULT_MODULE_IDS,
  type ModuleId,
  type NavOverrides,
  type Permission,
  type Role,
} from '@stockpilot/core';

interface SidebarProps {
  className?: string;
  /** DOM id applied to the <aside>; lets the topbar toggle reference it via aria-controls. */
  id?: string;
  organizationId: string;
  organizationName: string;
  organizationLogoUrl?: string | null;
  memberships?: Array<{ id: string; name: string; logoUrl: string | null; role: string }>;
  userName: string | null;
  userRole?: string;
  /** DB role token used to filter nav (admin section is admin-only). */
  role: Role;
  /**
   * Module IDs enabled for this org, serialized as plain strings so the
   * server layout can pass them across the RSC boundary. Reconstructed into
   * a `Set<ModuleId>` here. Defaults to the full default module set so the
   * sidebar (and tests that omit it) renders today's grandfathered nav.
   */
  enabledModules?: string[];
  /**
   * Raw per-org `nav_overrides` jsonb (untrusted). Passed straight into
   * `navForRole` → `applyNavOverrides`, which validates it and fails CLOSED to
   * the derived nav on null/garbage. Typed `unknown` because it crosses the RSC
   * boundary as plain JSON from the DB.
   */
  navOverrides?: unknown;
  /**
   * The user's EFFECTIVE permissions (static role defaults + org overrides),
   * serialized as strings across the RSC boundary. When provided, nav links
   * gate on this set so a revoked permission (e.g. purchase_orders:read) hides
   * its link. Omitted → navForRole falls back to the static role permissions.
   */
  permissions?: string[];
  onNavigate?: () => void;
}

export function Sidebar({
  className,
  id,
  organizationId,
  organizationName,
  organizationLogoUrl,
  memberships,
  userName,
  userRole,
  role,
  enabledModules,
  navOverrides,
  permissions,
  onNavigate,
}: SidebarProps) {
  const moduleSet = React.useMemo(
    () => new Set((enabledModules ?? DEFAULT_MODULE_IDS) as ModuleId[]),
    [enabledModules],
  );
  // Effective permissions gate nav links; undefined → navForRole uses the
  // static role map (back-compat for callers/tests that omit it).
  const permissionSet = React.useMemo(
    () => (permissions ? new Set(permissions as Permission[]) : undefined),
    [permissions],
  );
  // `applyNavOverrides` (inside navForRole) validates the override shape and
  // fails CLOSED to the derived nav on null/garbage, so the cast is safe.
  const sections: NavSection[] = React.useMemo(
    () => navForRole(role, moduleSet, (navOverrides as NavOverrides | null) ?? null, permissionSet),
    [role, moduleSet, navOverrides, permissionSet],
  );
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

  // Prefetch warmup — top-5 highest-click routes ONLY (Overview,
  // Inventory, Books, Orders, Movements). Each is a single RSC fetch
  // and these are the routes ~95% of users click first.
  //
  // The previous phase-2 "warm the other ~20 sidebar routes at idle"
  // was removed on purpose (perf plan 2026-07-02 P1b): every warmed
  // route is a FULL dynamic RSC render server-side — ~20 lambda
  // invocations + ~20 middleware auth round-trips + on the order of
  // 150 DB queries fired within seconds of every hard landing, all
  // competing with the page the user is actually reading. And with
  // `staleTimes.dynamic = 90`, any entry not clicked within 90s was
  // re-fetched on navigation anyway. Rarely-clicked tabs are covered
  // by the hover/focus/pointer-down warmRoute below plus their
  // route-true loading.tsx skeletons.
  const TOP_ROUTES = React.useMemo(
    () => [
      '/dashboard',
      '/dashboard/inventory',
      '/dashboard/books',
      '/dashboard/orders',
      '/dashboard/movements',
    ],
    [],
  );

  React.useEffect(() => {
    TOP_ROUTES.forEach((href) => warmRoute(href));
  }, [warmRoute, TOP_ROUTES]);

  return (
    <aside
      id={id}
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
