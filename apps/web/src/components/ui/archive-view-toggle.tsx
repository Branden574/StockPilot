'use client';

import { usePathname, useSearchParams } from 'next/navigation';

import { SegmentedTabs } from '@/components/patterns/segmented-tabs';
import { cn } from '@/lib/utils';

/**
 * Small pill toggle for the Active / Archived view on manager pages.
 *
 * Reads `?view=archived` from the URL — anything else (or absent) means
 * the Active view. Renders two real `<Link>`s so the toggle is
 * bookmarkable, copy-pasteable, and survives reloads.
 *
 * Designed to be drop-in for both client components (uses `useSearchParams`
 * to read state) and pages that pass an explicit `view` prop. Pages can
 * also pass `basePath` to override navigation away from the current
 * pathname (rare — used when the toggle should always link to the
 * canonical list URL even if the current page nests under one).
 *
 * Brief calls for this convention across every manager so users learn it
 * once, in one shape.
 *
 * Drawn by P2.6's SegmentedTabs (the one segmented control, PLAN P2.2 "One
 * look per pattern"): the view-toggle size, link mode and tablist semantics,
 * so it is still a "View filter" tablist of two `role="tab"` links with
 * `aria-selected`, the same hrefs and words, and Next's default prefetch and
 * scroll (the toggle passes no link options, as before).
 *
 * The track is `shrink-0`: SegmentedTabs makes it a sideways-scrolling strip,
 * which as a flex item could shrink until the Archived tab was hidden (the
 * Categories header at 390 px squeezed it to 73 px). The two-tab toggle never
 * shrinks below its content, as before the redesign.
 */
export function ArchiveViewToggle({
  basePath,
  view,
  className,
  activeLabel = 'Active',
  archivedLabel = 'Archived',
  paramName = 'view',
  archivedValue = 'archived',
  archivedOnlyParams,
}: {
  basePath?: string;
  view?: 'active' | 'archived';
  className?: string;
  activeLabel?: string;
  archivedLabel?: string;
  /**
   * URL search param this toggle reads / writes. Defaults to 'view'
   * (the legacy shape used by most manager pages). Inventory and Books
   * already use 'status' for the lifecycle filter, so they pass
   * paramName="status" to drive the same URL the page already parses.
   */
  paramName?: string;
  /**
   * Value to set on `paramName` for the archived state. Defaults to
   * 'archived'. Same value for both 'view' and 'status' params today,
   * but keeping it overridable so future filters that use different
   * vocabulary can still use this toggle.
   */
  archivedValue?: string;
  /**
   * Search params that only mean something on the archived view, dropped by
   * the Active link (the Archived link keeps them). Items and Books pass
   * ['auto']: their "Auto-archived only" chip narrows the list to rows the
   * zero-stock job archived, no active row is one, so an Active link that
   * carried it opened an empty list.
   */
  archivedOnlyParams?: readonly string[];
}) {
  const pathname = usePathname();
  const params = useSearchParams();

  // Resolve current view: explicit prop wins, otherwise read from URL.
  const current: 'active' | 'archived' =
    view ?? (params.get(paramName) === archivedValue ? 'archived' : 'active');

  const base = basePath ?? pathname ?? '';

  // Carry over the other search params (e.g. q, cat, wh on procedures)
  // so toggling between views doesn't blow away the user's filter state.
  function buildHref(target: 'active' | 'archived'): string {
    const sp = new URLSearchParams(params.toString());
    sp.delete(paramName);
    if (target === 'archived') sp.set(paramName, archivedValue);
    else for (const name of archivedOnlyParams ?? []) sp.delete(name);
    // Reset paging when crossing views — the page count for active and
    // archived almost never lines up.
    sp.delete('page');
    const q = sp.toString();
    return q ? `${base}?${q}` : base;
  }

  return (
    <SegmentedTabs
      aria-label="View filter"
      size="sm"
      className={cn('shrink-0', className)}
      activeId={current}
      items={[
        { id: 'active', label: activeLabel, href: buildHref('active') },
        { id: 'archived', label: archivedLabel, href: buildHref('archived') },
      ]}
    />
  );
}
