'use client';

import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';

import { navForRole, type NavItem, type NavSection } from '@/components/dashboard/nav';
import { NavLinkPending } from '@/components/dashboard/nav-link-pending';
import { OrgSwitcher } from '@/components/dashboard/org-switcher';
import { defaultCollapsedSections } from '@/components/dashboard/sidebar-pref';
import { IconMark } from '@/components/ui/icon-mark';
import { useWarmRoute } from '@/lib/hooks/use-warm-route';
import { cn } from '@/lib/utils';

import {
  DEFAULT_MODULE_IDS,
  type ModuleId,
  type NavOverrides,
  type NavSectionKey,
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
  /**
   * The nav sections this viewer has collapsed, by registry section key (the
   * shell keeps them in the sp_nav_collapsed cookie). Omitted: the role's
   * default, Admin collapsed for owners and admins.
   */
  collapsedSections?: readonly NavSectionKey[];
  /**
   * Called when the viewer opens (collapse=false) or closes (collapse=true) a
   * section, so the shell can remember it and keep its two sidebars (desktop
   * and the phone drawer) in step. Omitted: this sidebar keeps the state itself.
   */
  onToggleSection?: (key: NavSectionKey, collapse: boolean) => void;
  onNavigate?: () => void;
}

/**
 * Active route: `/dashboard` only on an exact match (so child dashboard routes
 * don't all light up "Overview"); every other entry when the pathname is the
 * entry itself OR a deeper sub-route (`/dashboard/inventory/abc-123` lights
 * "Items"). A parent and its child both light up on the child's page (Purchase
 * orders and PO imports on /dashboard/purchase-orders/imports): that nested
 * double highlight is intended, and sidebar.test.tsx pins it.
 */
function isActiveHref(href: string, pathname: string): boolean {
  return href === '/dashboard'
    ? pathname === '/dashboard'
    : pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The highest-click routes (Overview, Inventory, Books, Orders, Movements),
 * warmed once after a hard landing. See the warm-up effect below.
 */
const TOP_ROUTES = [
  '/dashboard',
  '/dashboard/inventory',
  '/dashboard/books',
  '/dashboard/orders',
  '/dashboard/movements',
];

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
  collapsedSections,
  onToggleSection,
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
  const initials = (userName || 'U')
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('');

  // The app's one route warm-up (lib/hooks/use-warm-route.ts), shared with
  // IntentLink. `intent` is for the performance mark only: hover, focus and
  // pointer-down are a PERSON signalling where they are about to go. The
  // staggered top-5 warm-up below passes false, because a timer is not intent:
  // marking it would credit every early click on those routes with a head
  // start nobody's pointer gave it.
  const warmRoute = useWarmRoute();

  // Prefetch warmup — top-5 highest-click routes ONLY (Overview,
  // Inventory, Books, Orders, Movements). These are the routes ~95% of
  // users click first. Each warm is TWO requests under Next 16.3.5's
  // segment cache (route tree + segments to the nearest loading.tsx;
  // measured by the perf harness, 2.0 requests per route, before
  // Overview, Items, Books and Orders dropped their loading.tsx), so the
  // four routes warmed on a hard load cost 8 requests. Kept on purpose
  // (2026-09-22): staggered, bounded at four, and the only BULK warm-up
  // left in the app. Every link grid, list and table row warms on intent
  // through IntentLink instead (components/ui/intent-link.tsx).
  //
  // Only the routes this person's sidebar actually shows: an org with Books
  // turned off, or a viewer without Movements, used to warm those pages too,
  // a full server render of a page they cannot open, on every hard landing.
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
  // route-true loading.tsx skeletons (or, for a page without one, the
  // late skeleton: components/dashboard/pending-route-skeleton.tsx).
  const warmTargets = React.useMemo(() => {
    const shown = new Set(sections.flatMap((s) => s.items.map((i) => i.href)));
    return TOP_ROUTES.filter((href) => shown.has(href));
  }, [sections]);

  // STAGGERED, not simultaneous: five concurrent prefetches on a hard
  // landing all race the same (possibly cold) lambda, so a fast human
  // click within the first second queued behind 5 in-flight RSC
  // renders. A 150ms gap keeps the pipeline mostly-one-deep while
  // still warming all five within ~1s. The current route is skipped
  // (nothing to warm), and pending timers are cleared on unmount /
  // route change so a navigation mid-burst can't fire stale prefetches.
  React.useEffect(() => {
    const timers = warmTargets
      .filter((href) => href !== pathname)
      .map((href, i) => setTimeout(() => warmRoute(href, false), i * 150));
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [warmRoute, pathname, warmTargets]);

  // ── Collapsible sections ────────────────────────────────────────────────
  // Stored state: the shell's (cookie-backed) list, or this sidebar's own when
  // it is used alone. Shown state adds one rule: the section holding the page
  // on screen opens on arrival even when it is stored collapsed, so the active
  // link is never hidden; collapsing it by hand while there holds until the
  // viewer moves to another page.
  const [ownCollapsed, setOwnCollapsed] = React.useState<readonly NavSectionKey[]>(
    () => collapsedSections ?? defaultCollapsedSections(role),
  );
  const stored = onToggleSection
    ? (collapsedSections ?? defaultCollapsedSections(role))
    : ownCollapsed;
  const [closedHere, setClosedHere] = React.useState<{ path: string; key: NavSectionKey } | null>(
    null,
  );
  // The hold ends when the viewer moves to another page, so coming back to
  // this one later (Back, a crumb, the palette) opens its section again, as
  // arriving on any other page in it does. Cleared during render, React's
  // pattern for adjusting state when an input changes: no effect, and no
  // frame drawn with a stale hold.
  if (closedHere !== null && closedHere.path !== pathname) setClosedHere(null);
  const sectionIdPrefix = React.useId();

  // Arriving on a page whose link sits below the fold of a long nav (an admin
  // page, a renamed custom link), the nav scrolls just enough to show it, so
  // the sidebar always says where you are. Its own scroll position only: the
  // page is never moved, and a link already in view is left where it is.
  const navRef = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('a[aria-current="page"]');
    if (!nav || !active) return;
    const box = nav.getBoundingClientRect();
    const link = active.getBoundingClientRect();
    if (link.top < box.top || link.bottom > box.bottom) {
      nav.scrollTop += link.top - box.top - box.height / 3;
    }
  }, [pathname]);

  function toggleSection(key: NavSectionKey, open: boolean, holdsActive: boolean) {
    const collapse = open;
    if (onToggleSection) onToggleSection(key, collapse);
    else
      setOwnCollapsed((prev) =>
        collapse ? [...new Set([...prev, key])] : prev.filter((k) => k !== key),
      );
    if (collapse && holdsActive) setClosedHere({ path: pathname, key });
    else if (!collapse && closedHere?.key === key) setClosedHere(null);
  }

  return (
    <aside
      id={id}
      className={cn(
        'border-border bg-background flex h-full w-[228px] shrink-0 flex-col border-r',
        className,
      )}
    >
      {/* Brand row: the same 56px as the top bar, so their hairlines meet. */}
      <div className="border-border flex h-14 shrink-0 items-center border-b px-[18px]">
        <Link href="/dashboard" onClick={onNavigate} className="text-foreground rounded-md">
          <IconMark size={22} />
        </Link>
      </div>

      <div className="shrink-0 px-3 pb-1 pt-3">
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
      </div>

      {/* Nav: the registry's sections, each under its own label. */}
      <nav
        ref={navRef}
        className="scrollbar-thin flex flex-1 flex-col gap-3.5 overflow-y-auto px-3 pb-3 pt-1"
      >
        {sections.map((section) => {
          // A section whose items were all hidden by the org's overrides has
          // nothing to show; a bare heading would be a dead control.
          if (section.items.length === 0) return null;
          const holdsActive = section.items.some((item) => isActiveHref(item.href, pathname));
          if (!section.label) {
            return (
              <NavList
                key={section.key}
                items={section.items}
                pathname={pathname}
                warmRoute={warmRoute}
                onNavigate={onNavigate}
              />
            );
          }
          const isStoredCollapsed = stored.includes(section.key);
          const heldClosed =
            closedHere !== null && closedHere.path === pathname && closedHere.key === section.key;
          const open = isStoredCollapsed ? holdsActive && !heldClosed : true;
          const listId = `${sectionIdPrefix}-${section.key}`;
          return (
            <div key={section.key} className="flex flex-col gap-px">
              <button
                type="button"
                aria-expanded={open}
                aria-controls={listId}
                onClick={() => toggleSection(section.key, open, holdsActive)}
                className="text-muted-foreground hover:text-foreground group flex w-full items-center gap-1.5 rounded-md px-2.5 pb-1 pt-2 text-left text-[10.5px] font-medium uppercase leading-4 tracking-[0.1em] transition-colors [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:py-0"
              >
                <span className="min-w-0 flex-1">{section.label}</span>
                {/* The chevron is what says a folded heading opens, so it
                    keeps 3:1 against the page (WCAG 1.4.11): ink 4, the
                    faintest ink DESIGN-SPEC 2.4 allows for an arrow (3.19:1
                    light, 3.61:1 dark), never a fade of it. */}
                <ChevronRight
                  aria-hidden
                  strokeWidth={2}
                  className={cn(
                    'group-hover:text-foreground size-3 shrink-0 text-[var(--ed-ink-4)] transition-transform',
                    open && 'rotate-90',
                  )}
                />
              </button>
              <div id={listId}>
                {open ? (
                  <NavList
                    items={section.items}
                    pathname={pathname}
                    warmRoute={warmRoute}
                    onNavigate={onNavigate}
                  />
                ) : null}
              </div>
            </div>
          );
        })}
      </nav>

      {/* Identity foot: who is signed in, and as what. Not interactive (the
          account menu in the top bar holds the actions). */}
      <div className="border-border flex shrink-0 items-center gap-2.5 border-t px-4 py-3">
        <span
          aria-hidden
          className="bg-sunk text-foreground grid size-8 shrink-0 place-items-center rounded-full border border-[var(--ed-line-strong)] text-[11px] font-semibold"
        >
          {initials}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-foreground truncate text-[13px] font-medium leading-[1.3]">
            {userName ?? '—'}
          </div>
          <div className="text-muted-foreground truncate text-[11.5px] leading-[1.3]">
            {userRole ?? 'Member'}
          </div>
        </div>
      </div>
    </aside>
  );
}

function NavList({
  items,
  pathname,
  warmRoute,
  onNavigate,
}: {
  items: NavItem[];
  pathname: string;
  warmRoute: (href: string, intent?: boolean) => void;
  onNavigate?: () => void;
}) {
  return (
    <ul role="list" className="flex flex-col gap-px">
      {items.map((item) => {
        const active = isActiveHref(item.href, pathname);
        return (
          <li key={item.href}>
            <Link
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
                // 32px rows (min-h-8), 44px wherever a finger is the
                // pointer (the phone drawer, a tablet). A renamed label that
                // runs long wraps onto a second line instead of being cut off.
                'group/item flex min-h-8 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13.5px] leading-5 transition-colors [@media(pointer:coarse)]:min-h-11',
                active
                  ? 'bg-muted text-foreground font-medium'
                  : 'hover:bg-muted hover:text-foreground text-[var(--ed-ink-2)]',
              )}
            >
              <item.icon
                aria-hidden
                strokeWidth={1.6}
                className={cn(
                  'size-4 shrink-0',
                  active
                    ? 'text-foreground'
                    : 'text-muted-foreground group-hover/item:text-foreground',
                )}
              />
              <span className="min-w-0 flex-1">{item.label}</span>
              {/* Pending indicator — turns on at click time via
                  useLinkStatus(), turns off when the new route
                  finishes rendering. Without this, a cold-cache
                  first click sat silent for ~1.2s before the URL
                  even changed. */}
              <NavLinkPending />
              {item.badge != null && (
                <span
                  className={cn(
                    'shrink-0 rounded-full px-1.5 font-mono text-[11px] font-normal leading-4',
                    item.alert
                      ? 'bg-destructive-wash text-destructive'
                      : 'bg-sunk text-[var(--ed-ink-2)]',
                  )}
                >
                  {item.badge}
                </span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
