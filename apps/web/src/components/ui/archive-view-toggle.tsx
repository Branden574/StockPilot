'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

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
 */
export function ArchiveViewToggle({
  basePath,
  view,
  className,
  activeLabel = 'Active',
  archivedLabel = 'Archived',
}: {
  basePath?: string;
  view?: 'active' | 'archived';
  className?: string;
  activeLabel?: string;
  archivedLabel?: string;
}) {
  const pathname = usePathname();
  const params = useSearchParams();

  // Resolve current view: explicit prop wins, otherwise read from URL.
  const current: 'active' | 'archived' =
    view ?? (params.get('view') === 'archived' ? 'archived' : 'active');

  const base = basePath ?? pathname ?? '';

  // Carry over the other search params (e.g. q, cat, wh on procedures)
  // so toggling between views doesn't blow away the user's filter state.
  function buildHref(target: 'active' | 'archived'): string {
    const sp = new URLSearchParams(params.toString());
    sp.delete('view');
    if (target === 'archived') sp.set('view', 'archived');
    // Reset paging when crossing views — the page count for active and
    // archived almost never lines up.
    sp.delete('page');
    const q = sp.toString();
    return q ? `${base}?${q}` : base;
  }

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1 rounded-md border border-border bg-background p-0.5 text-xs',
        className,
      )}
      role="tablist"
      aria-label="View filter"
    >
      <Link
        href={buildHref('active')}
        role="tab"
        aria-selected={current === 'active'}
        className={cn(
          'rounded-sm px-2.5 py-1 transition-colors',
          current === 'active'
            ? 'bg-foreground text-background'
            : 'text-muted-foreground hover:bg-muted',
        )}
      >
        {activeLabel}
      </Link>
      <Link
        href={buildHref('archived')}
        role="tab"
        aria-selected={current === 'archived'}
        className={cn(
          'rounded-sm px-2.5 py-1 transition-colors',
          current === 'archived'
            ? 'bg-foreground text-background'
            : 'text-muted-foreground hover:bg-muted',
        )}
      >
        {archivedLabel}
      </Link>
    </div>
  );
}
