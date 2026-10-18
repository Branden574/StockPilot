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
  // The warehouse picker is the one control that yields: its name truncates,
  // and it gives up its width before the breadcrumb does (shrink 10 to the
  // trail's 1), so on a touch tablet, where every icon button is 44px, the
  // trail stays readable. Before (2026-09-28/29): the buttons shrank to 14px
  // and the account avatar was pushed past the right edge, 13px at 390px and
  // entirely at 768px with the sidebar, clipped by the shell's overflow-hidden
  // (no page scroll).
  //
  // A SOLID bar (DESIGN-SPEC 5.2): the page colour and a hairline, no blur.
  // It stays 56px tall, the height the storefront's --sf-topbar-h assumes. Its
  // gap is the reference 12px from sm up, 8px on a phone, where the bar is
  // narrowest.
  return (
    <header
      className="border-border bg-background @container sticky top-0 z-20 flex shrink-0 items-center gap-2 border-b px-4 sm:gap-3 sm:px-6"
      style={{ height: 56 }}
    >
      <SidebarToggleButton
        className="shrink-0"
        hidden={sidebarHidden}
        onToggle={() => onToggleSidebar?.()}
      />

      {/* The trail keeps its natural width while the search bar yields (down
          to 240px); squeezed further, the parent crumbs give way before the
          page's own name. */}
      <nav aria-label="Breadcrumb" className="@min-[520px]:flex hidden min-w-0">
        <ol className="text-muted-foreground flex min-w-0 items-center gap-2 text-[13.5px] leading-5">
          {crumbs.map((c, i) => {
            const isLast = i === crumbs.length - 1;
            return (
              <li
                key={i}
                className={cn('flex min-w-0 items-center gap-2', isLast ? 'shrink' : 'shrink-[3]')}
              >
                {i > 0 && (
                  <span aria-hidden className="shrink-0 text-[var(--ed-ink-4)]">
                    /
                  </span>
                )}
                {c.href && !isLast ? (
                  <Link
                    href={c.href}
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

      <div className="ml-auto flex min-w-0 shrink-[10] items-center gap-2">
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
          className={cn(ICON_BUTTON, '@min-[680px]:grid hidden')}
          aria-label="Help & Learning"
          title="Help & Learning"
        >
          <BookOpen aria-hidden strokeWidth={1.6} className="size-4" />
        </Link>

        <Link
          href="/dashboard/support"
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
