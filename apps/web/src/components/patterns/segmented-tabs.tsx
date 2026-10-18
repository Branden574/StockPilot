import Link from 'next/link';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Segmented view tabs on a sunk track (DESIGN-SPEC 6.5): the Items "All items /
 * Low + critical / Out of stock" views, a status strip, the List / Grid toggle.
 *
 * LINK BASED: a tab with an `href` is a real `next/link`, so the URL stays the
 * state (bookmarkable, shareable, survives a reload) and modified clicks open a
 * new tab. Per-tab `prefetch`, `scroll`, `replace` and `onClick` pass straight
 * to the link, so a page that intercepts a click today (Items' instant-mode
 * shallow push) keeps doing so. A tab without an `href` is a button that calls
 * `onSelect` (a client-held choice such as a stored view preference).
 *
 * SEMANTICS, as today's strips:
 * - `tablist` (default): `role="tablist"` with `role="tab"` items and
 *   `aria-selected`, like ArchiveViewToggle and the rentals tabs.
 * - `nav`: a `<nav aria-label>` of links with `aria-current="page"` on the
 *   current one, like the status strips ("Filter by status"; the Orders tour
 *   targets `nav[aria-label="Status"]`). A strip in which no tab has an
 *   `href` (a set of `aria-pressed` toggles such as On hand: Total / Placed
 *   only) navigates nowhere, so it is a named `role="group"` instead of a
 *   navigation landmark.
 * Every tab stays in the Tab order, as today (no roving focus).
 *
 * FOCUS: the track scrolls sideways, which clips anything drawn outside it,
 * so a focused tab draws the app's focus ring inside its own edge.
 *
 * SIZE: 28 px segments (26 for `sm`) on a 36 (32) px track, and 44 px
 * segments below sm, the same rule as the search field and filter triggers
 * in the row, so a toolbar on a touch tablet stays one height. The track
 * clips anything drawn outside it, so a segment's tap area reaches the
 * track's full inner height instead of growing past it.
 *
 * COUNTS: `count` prints only when the page passes one, and a page passes one
 * only where it already has the figure (owner decision O2: no new counts).
 *
 * No hooks and no data. Link tabs without an `onClick` render in server and
 * client components alike; button mode (an `onClick` on every button) and a
 * per-tab `onClick` hand functions to their elements, so those strips need a
 * client component parent.
 */

type DataAttributes = { [key: `data-${string}`]: string | undefined };

export interface SegmentedTabItem extends DataAttributes {
  /** Stable key; `activeId` and `onSelect` refer to it. */
  id: string;
  label: React.ReactNode;
  /** Link mode: the URL this tab opens. */
  href?: string;
  /** A count the page already has. Absent: nothing is printed. */
  count?: React.ReactNode;
  /** A 14 px icon before the label (List / Grid). */
  icon?: React.ReactNode;
  title?: string;
  ariaLabel?: string;
  prefetch?: boolean | 'auto' | null;
  scroll?: boolean;
  replace?: boolean;
  /** Link mode: runs before next/link navigates; preventDefault() stops it. */
  onClick?(event: React.MouseEvent<HTMLAnchorElement>): void;
}

export interface SegmentedTabsProps {
  items: readonly SegmentedTabItem[];
  /** The tab shown as current; null or an unknown id shows none. */
  activeId: string | null | undefined;
  /** Names the strip for assistive technology ("View filter", "Filter by status"). */
  'aria-label': string;
  semantics?: 'tablist' | 'nav';
  /** `md` (default): view tabs, 36 px track. `sm`: the List / Grid toggle, 32 px. */
  size?: 'md' | 'sm';
  /** Button mode: called with the id of a tab that has no `href`. */
  onSelect?(id: string, event: React.MouseEvent<HTMLButtonElement>): void;
  id?: string;
  className?: string;
}

const TRACK: Record<NonNullable<SegmentedTabsProps['size']>, string> = {
  md: 'gap-0.5 rounded-lg p-[3px]',
  sm: 'gap-0.5 rounded-md p-0.5',
};

// Each segment's ::before spans the track's padding above and below it (3 px
// on `md`, 2 px on `sm`), so the whole inner height of the track is the tap
// area without overflowing the scrolling track.
const SEGMENT: Record<NonNullable<SegmentedTabsProps['size']>, string> = {
  md: 'h-7 gap-1.5 rounded-[5px] px-2.5 text-[13px] before:-inset-y-[3px]',
  sm: 'h-[26px] gap-1.5 rounded px-2 text-[12.5px] before:-inset-y-0.5 [&_svg]:h-3.5 [&_svg]:w-3.5',
};

function dataAttributesOf(item: SegmentedTabItem): DataAttributes {
  const out: DataAttributes = {};
  for (const key of Object.keys(item)) {
    if (key.startsWith('data-')) out[key as `data-${string}`] = item[key as `data-${string}`];
  }
  return out;
}

export function SegmentedTabs({
  items,
  activeId,
  'aria-label': ariaLabel,
  semantics = 'tablist',
  size = 'md',
  onSelect,
  id,
  className,
}: SegmentedTabsProps) {
  const trackClass = cn(
    'border-border bg-sunk inline-flex w-fit max-w-full items-center overflow-x-auto border [scrollbar-width:thin]',
    TRACK[size],
    className,
  );

  const tabs = items.map((item) => {
    const active = item.id === activeId;
    const segmentClass = cn(
      "relative inline-flex shrink-0 items-center whitespace-nowrap font-medium transition-colors before:absolute before:inset-x-0 before:content-[''] focus-visible:ring-inset focus-visible:ring-offset-0 max-sm:min-h-11 [&_svg]:shrink-0",
      SEGMENT[size],
      active
        ? 'bg-card text-foreground shadow-[0_0_0_1px_var(--ed-line-strong)]'
        : 'text-muted-foreground hover:text-foreground',
    );
    const content = (
      <>
        {item.icon}
        <span>{item.label}</span>
        {item.count != null ? (
          <span
            data-slot="segmented-tab-count"
            className="text-muted-foreground font-mono text-[11px] font-medium tabular-nums"
          >
            {item.count}
          </span>
        ) : null}
      </>
    );
    const shared = {
      ...dataAttributesOf(item),
      title: item.title,
      'aria-label': item.ariaLabel,
      'data-state': active ? 'active' : 'inactive',
      className: segmentClass,
    };

    if (item.href != null) {
      const a11y =
        semantics === 'tablist'
          ? { role: 'tab' as const, 'aria-selected': active }
          : { 'aria-current': active ? ('page' as const) : undefined };
      return (
        <Link
          key={item.id}
          href={item.href}
          prefetch={item.prefetch}
          scroll={item.scroll}
          replace={item.replace}
          onClick={item.onClick}
          {...shared}
          {...a11y}
        >
          {content}
        </Link>
      );
    }

    const a11y =
      semantics === 'tablist'
        ? { role: 'tab' as const, 'aria-selected': active }
        : { 'aria-pressed': active };
    return (
      <button
        key={item.id}
        type="button"
        onClick={(event) => onSelect?.(item.id, event)}
        {...shared}
        {...a11y}
      >
        {content}
      </button>
    );
  });

  if (semantics === 'nav') {
    if (!items.some((item) => item.href != null)) {
      return (
        <div
          id={id}
          role="group"
          aria-label={ariaLabel}
          data-slot="segmented-tabs"
          className={trackClass}
        >
          {tabs}
        </div>
      );
    }
    return (
      <nav id={id} aria-label={ariaLabel} data-slot="segmented-tabs" className={trackClass}>
        {tabs}
      </nav>
    );
  }
  return (
    <div
      id={id}
      role="tablist"
      aria-label={ariaLabel}
      data-slot="segmented-tabs"
      className={trackClass}
    >
      {tabs}
    </div>
  );
}
