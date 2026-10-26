'use client';

import { BookOpen, HelpCircle, LifeBuoy, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';

import { openKeyboardShortcutsOverlay } from '@/components/dashboard/keyboard-shortcuts';
import { NotificationBell } from '@/components/dashboard/notification-bell';
import { SidebarToggleButton } from '@/components/dashboard/sidebar-toggle-button';
import type { Density } from '@/components/dashboard/sidebar-pref';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { WarehouseFilterPicker } from '@/components/dashboard/warehouse-filter-picker';
import { WhatsNewButton } from '@/components/updates/whats-new-button';
import { useWarmRoute } from '@/lib/hooks/use-warm-route';
import { cn } from '@/lib/utils';

import type { NavSection } from './nav';
import { applyNavLabelsToCrumbs, crumbsForPathname, navLabelMap } from './topbar-crumbs';
import { TRAIL_MEASURE_SLOT, TRAIL_SLOT, useTrailFit } from './topbar-trail-fit';
import { UserMenu } from './user-menu';

interface TopbarProps {
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  organizationName: string;
  userId: string;
  /** Active org — scopes the notification bell to this workspace. */
  organizationId: string;
  isPlatformAdmin?: boolean;
  onToggleSidebar?: () => void;
  /** Desktop sidebar visibility, for the toggle button's label. */
  sidebarHidden?: boolean;
  /** Pass-through filter UI props — only rendered when warehouses is non-empty. */
  warehouseFilter?: {
    warehouses: Array<{ id: string; name: string }>;
    activeId: string | null;
    warehouseLabel: string;
    warehousePluralLabel?: string;
  };
  /**
   * The org's OVERRIDDEN nav (navForRole output — same pass the Sidebar
   * renders). Breadcrumb segments whose canonical href matches a nav item
   * inherit its per-org renamed label so sidebar + crumbs always agree.
   * Optional: omitted (older callers/tests) → static crumb labels.
   */
  navSections?: NavSection[];
  /** The viewer's table density and its setter, for the account menu. */
  density?: Density;
  onDensityChange?: (density: Density) => void;
}

/** Opens the command palette by synthesizing ⌘K (the palette toggles on this exact event). */
function openCommandPalette() {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
}

/**
 * The top bar's 32px icon buttons (DESIGN-SPEC 5.2): transparent, ink-2, the
 * neutral hover fill; 44px wherever a finger is the pointer (a phone, a
 * tablet). No `display` here: each use says when it is shown.
 */
const ICON_BUTTON =
  'hover:bg-muted hover:text-foreground size-8 shrink-0 place-items-center rounded-md text-[var(--ed-ink-2)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background [@media(pointer:coarse)]:size-11';

export function Topbar({
  email,
  fullName,
  avatarUrl,
  organizationName,
  userId,
  organizationId,
  isPlatformAdmin,
  onToggleSidebar,
  sidebarHidden = false,
  warehouseFilter,
  navSections,
  density,
  onDensityChange,
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
  // How much of the trail the bar has room for (topbar-trail-fit.ts): the
  // whole trail, the current page alone, or none.
  const headerRef = React.useRef<HTMLElement>(null);
  const measureRef = React.useRef<HTMLDivElement>(null);
  const fit = useTrailFit(headerRef, measureRef, crumbs.map((c) => c.label).join('\u0000'));
  const firstShown = fit === 'current' ? crumbs.length - 1 : 0;

  // NO LINK IN THE BAR PREFETCHES ITS PAGE ON SIGHT (PLAN 0.6). The bar is on
  // every dashboard page, so a default <Link> here costs a prefetch (two
  // requests, each a full dynamic render of the dashboard layout) of its page
  // on every page view: Notifications, Help and Support always, and up to two
  // parent crumbs (Settings, Reports, a list). Like the sidebar's links, each
  // is warmed when a person comes to it instead: hover, keyboard focus or
  // pointer-down, through the app's one warm-up (lib/hooks/use-warm-route.ts).
  const warmRoute = useWarmRoute();
  const warmOnApproach = (href: string) => ({
    onFocus: () => warmRoute(href),
    onPointerEnter: () => warmRoute(href),
    onPointerDown: () => warmRoute(href),
  });

  // WHAT FITS IS DECIDED BY THE BAR'S OWN WIDTH (a CSS container query on the
  // header, `@container`), not the window's: beside the 228px desktop sidebar
  // a 768px window leaves the bar 540px. Every button keeps its full size
  // (shrink-0); what does not fit is left out, most expendable first. The
  // widths are the bar's inside width (a container query measures the
  // content box: the bar less its 16px or 24px padding each side):
  //   under 400px  search (as before this change: the old bar had no search
  //                under 768px, where a phone is; ⌘K still opens it);
  //   under 520px  the breadcrumb (the page's own heading names the page);
  //   under 680px  Keyboard shortcuts, Help & Learning, Support & feedback and
  //                the theme switch (the account menu carries Help, Support
  //                and the theme at every width; "?" still opens shortcuts);
  //   under 960px  the search bar is a search icon (same palette).
  // Search starts at 400px so every window that showed it before still does:
  // the narrowest was 768px beside the sidebar (iPad portrait, 768-834px, is
  // touch only, so ⌘K is no substitute). At 400px the icon fits beside the
  // picker's whole "All warehouses" (measured: header-check).
  // Where the trail is shown (520px up) it is the one thing that gives way:
  // the warehouse picker keeps its whole name (shrink-0; a long name up to
  // the label's 160px cap, as before the redesign) and the trail steps down
  // to the current page's name alone, then to nothing, as the room left for
  // it shrinks (useTrailFit). On a touch tablet, where every icon button is
  // 44px, the picker had given up its width first and read "Al…" (P68-01).
  // Under 520px there is no trail, and the picker's name truncates when the
  // bar is too narrow for it, as before (a long name on a phone). Under 358px
  // (a phone narrower than 390px: 375 and 360 are common) the bar packs
  // tighter so "All warehouses" stays whole there too, as it did before the
  // redesign, without shrinking any 44px touch button: its gaps go from 8px
  // to 4px, the account button drops its extra 4px, and the picker leaves out
  // its warehouse icon. At 375px the picker had 143px for the 157px its whole
  // name needs, at 360px 128px. At 320px a name is still cut, as it was. The
  // gap is the bar's own, and a container query never styles its own
  // container (it answers to one around it), so the gap follows the window
  // instead: under 390px. Below 768px the bar is the window's whole width
  // (the sidebar is an overlay there), so that is the bar's 358px inside. Before
  // (2026-09-28/29): the buttons shrank to 14px and the account avatar was
  // pushed past the right edge, 13px at 390px and entirely at 768px with the
  // sidebar, clipped by the shell's overflow-hidden (no page scroll).
  //
  // A SOLID bar (DESIGN-SPEC 5.2): the page colour and a hairline, no blur.
  // It stays 56px tall, the height the storefront's --sf-topbar-h assumes. Its
  // gap is the reference 12px from sm up, 8px on a phone, where the bar is
  // narrowest.
  return (
    <header
      ref={headerRef}
      className="border-border bg-background @container sticky top-0 z-20 flex shrink-0 items-center gap-2 border-b px-4 max-[390px]:gap-1 sm:gap-3 sm:px-6"
      style={{ height: 56 }}
    >
      <SidebarToggleButton
        className="shrink-0"
        hidden={sidebarHidden}
        onToggle={() => onToggleSidebar?.()}
      />

      {/* The trail takes the room the other controls leave (the search bar
          yields down to 240px first): the whole trail, else the current
          page's name alone, else none at all, landmark included. Its crumbs
          still truncate as a last resort, for the moment before the first
          measurement (the server draws the whole trail). */}
      {fit !== 'none' && (
        <nav
          aria-label="Breadcrumb"
          data-slot={TRAIL_SLOT}
          className="@min-[520px]:flex hidden min-w-0"
        >
          <ol className="text-muted-foreground flex min-w-0 items-center gap-2 text-[13.5px] leading-5">
            {crumbs.map((c, i) => {
              if (i < firstShown) return null;
              const isLast = i === crumbs.length - 1;
              return (
                <li
                  key={i}
                  className={cn(
                    'flex min-w-0 items-center gap-2',
                    isLast ? 'shrink' : 'shrink-[3]',
                  )}
                >
                  {i > firstShown && (
                    <span aria-hidden className="shrink-0 text-[var(--ed-ink-4)]">
                      /
                    </span>
                  )}
                  {c.href && !isLast ? (
                    <Link
                      href={c.href}
                      prefetch={false}
                      {...warmOnApproach(c.href)}
                      className="hover:text-foreground truncate underline-offset-2 transition-colors hover:underline"
                    >
                      {c.label}
                    </Link>
                  ) : (
                    <span
                      aria-current={isLast ? 'page' : undefined}
                      className={cn('truncate', isLast && 'text-foreground')}
                    >
                      {c.label}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      )}

      {/* The whole trail's natural width, whichever step is drawn: a copy
          with the trail's type and spacing, out of the flow, invisible,
          hidden from screen readers and clipped to nothing, so it can never
          be clicked or widen the page. */}
      <div
        aria-hidden
        data-slot={TRAIL_MEASURE_SLOT}
        className="pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden"
      >
        <div ref={measureRef} className="flex w-max items-center gap-2 text-[13.5px] leading-5">
          {crumbs.map((c, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span>/</span>}
              <span>{c.label}</span>
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* Where the trail can show (520px up) the picker never shrinks, so
          "All warehouses" and a short name stay whole and a long one keeps
          its 160px; under 520px it is the one control that yields. */}
      <div className="@min-[520px]:shrink-0 ml-auto flex min-w-0 items-center gap-2">
        {warehouseFilter && warehouseFilter.warehouses.length > 0 && (
          <WarehouseFilterPicker
            warehouses={warehouseFilter.warehouses}
            activeId={warehouseFilter.activeId}
            warehouseLabel={warehouseFilter.warehouseLabel}
            warehousePluralLabel={warehouseFilter.warehousePluralLabel}
          />
        )}
      </div>

      <button
        type="button"
        className={cn(ICON_BUTTON, '@min-[400px]:grid @min-[960px]:hidden hidden')}
        aria-label="Open command palette"
        onClick={openCommandPalette}
      >
        <Search aria-hidden strokeWidth={1.8} className="size-4" />
      </button>

      <button
        type="button"
        className="border-border bg-card text-muted-foreground focus-visible:ring-ring focus-visible:ring-offset-background @min-[960px]:flex hidden h-8 min-w-[240px] max-w-[340px] flex-1 items-center gap-2 rounded-md border px-2.5 text-[13px] transition-colors hover:border-[var(--ed-line-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
        aria-label="Open command palette"
        onClick={openCommandPalette}
      >
        <Search aria-hidden strokeWidth={1.8} className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">Search items, POs, suppliers…</span>
        <span className="text-muted-foreground shrink-0 rounded border border-[var(--ed-line-strong)] px-[5px] py-px font-mono text-[11px] leading-4">
          ⌘K
        </span>
      </button>

      {/* The icon cluster sits tight (2px), as one group, apart from the rest. */}
      <div className="flex shrink-0 items-center gap-0.5">
        <NotificationBell userId={userId} organizationId={organizationId} />

        <WhatsNewButton />

        <button
          type="button"
          className={cn(ICON_BUTTON, '@min-[680px]:grid hidden')}
          aria-label="Keyboard shortcuts (?)"
          title="Keyboard shortcuts (?)"
          onClick={() => openKeyboardShortcutsOverlay()}
        >
          <HelpCircle aria-hidden strokeWidth={1.6} className="size-4" />
        </button>

        <Link
          href="/dashboard/help"
          prefetch={false}
          {...warmOnApproach('/dashboard/help')}
          className={cn(ICON_BUTTON, '@min-[680px]:grid hidden')}
          aria-label="Help & Learning"
          title="Help & Learning"
        >
          <BookOpen aria-hidden strokeWidth={1.6} className="size-4" />
        </Link>

        <Link
          href="/dashboard/support"
          prefetch={false}
          {...warmOnApproach('/dashboard/support')}
          className={cn(ICON_BUTTON, '@min-[680px]:grid hidden')}
          aria-label="Support & feedback"
          title="Support & feedback"
        >
          <LifeBuoy aria-hidden strokeWidth={1.6} className="size-4" />
        </Link>

        <div className="@min-[680px]:flex hidden shrink-0">
          <ThemeToggle className={ICON_BUTTON} />
        </div>

        <UserMenu
          email={email}
          fullName={fullName}
          avatarUrl={avatarUrl}
          organizationName={organizationName}
          isPlatformAdmin={isPlatformAdmin}
          density={density}
          onDensityChange={onDensityChange}
        />
      </div>
    </header>
  );
}
