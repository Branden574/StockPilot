'use client';

import Link, { useLinkStatus } from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import * as React from 'react';

import { cn } from '@/lib/utils';

import { type DetailTabId } from './item-detail-tabs-shared';

// Re-export so existing call sites that import { DetailTabId, ItemDetailTabs }
// from this file continue to work without a sweep. parseDetailTab lives in
// the shared module and must be imported from there for server-component use.
export type { DetailTabId };

const TABS: ReadonlyArray<{ id: DetailTabId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'movements', label: 'Movements' },
  { id: 'activity', label: 'Activity' },
];

/** The tab the person clicked, and the URL they clicked it on. */
interface OptimisticTab {
  tab: DetailTabId;
  href: string;
}

/**
 * Client-side tab strip for the item detail page. Renders `Link` rows so
 * deep-linking to ?tab=activity works on the very first paint (no client
 * round-trip needed), and the URL stays canonical for sharing.
 *
 * INSTANT FEEDBACK (owner report 2026-09-22: Movements/Activity took ~10 s and
 * he clicked about ten times). A tab is a query-only navigation that re-renders
 * the whole item page on the server, and that render makes its Supabase calls
 * in series, so one stalled call stalls the tab. The underline used to follow
 * `activeTab`, which only changes when the server's answer lands: in the logged
 * incidents that was 3.6-6.6 s with nothing on screen, because the top progress
 * bar skipped same-path navigations too, and no loading.tsx fallback can show
 * for a query-only change (Next keys the page's React tree WITHOUT the query,
 * layout-router.js `createRouterCacheKey(activeSegment, true)`, so the page
 * stays mounted inside a transition). So:
 *
 *   1. The clicked tab is shown selected at once, and its underline pulses for
 *      as long as next/link reports that navigation pending (useLinkStatus).
 *   2. A click on the tab already shown selected does nothing. Next treats a
 *      link to the exact current URL as "refresh this page"
 *      (segment-cache/navigation.js `isSamePageNavigation`), which re-ran every
 *      server read to render the same thing; and a repeat click on the tab that
 *      is still loading restarted its navigation from zero.
 *   3. The optimistic tab never outlives the navigation it stands for. It is
 *      tied to the URL it was clicked on, so once the URL moves (the navigation
 *      landed, Back was pressed) the URL decides again; and when next/link says
 *      the navigation is over while the URL has NOT moved (another link took
 *      over), it is dropped and the real tab shows again.
 */
export function ItemDetailTabs({ activeTab }: { activeTab: DetailTabId }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams?.toString() ?? '';
  const currentHref = query ? `${pathname}?${query}` : pathname;

  const [optimistic, setOptimistic] = React.useState<OptimisticTab | null>(null);
  // The URL moved, so whatever was clicked on the old one is settled. Reset
  // during render (React's "adjusting state when a prop changes" pattern) so no
  // frame shows a stale choice, and so going Back to the URL a tab was clicked
  // on can never bring that old choice back.
  if (optimistic !== null && optimistic.href !== currentHref) setOptimistic(null);
  const shownTab =
    optimistic !== null && optimistic.href === currentHref ? optimistic.tab : activeTab;

  // Called by a tab's underline when next/link reports its navigation over.
  // Only the tab still being waited on is dropped: after a quick second click
  // the first tab's navigation ends (superseded) while the second is current.
  const settle = React.useCallback((tab: DetailTabId) => {
    setOptimistic((current) => (current !== null && current.tab === tab ? null : current));
  }, []);

  // Preserve any other query params (filters, etc.) when swapping tabs.
  function hrefFor(tab: DetailTabId) {
    // The tab the server rendered links to the page exactly as it is, so its
    // href and the address bar agree even when the URL spells the tab another
    // way (?tab=overview, an unknown ?tab=) or encodes other params another
    // way. NavProgressBar compares the two to decide whether a click is a
    // navigation at all.
    if (tab === activeTab) return currentHref;
    const params = new URLSearchParams(query);
    if (tab === 'overview') {
      params.delete('tab');
    } else {
      params.set('tab', tab);
    }
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  function onTabClick(event: React.MouseEvent<HTMLAnchorElement>, tab: DetailTabId) {
    // Modified clicks open a new tab or window: next/link leaves them to the
    // browser (link.js isModifiedEvent), and so does this page.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    if (tab === shownTab) {
      // next/link skips its navigation when the default is already prevented.
      event.preventDefault();
      return;
    }
    setOptimistic({ tab, href: currentHref });
  }

  return (
    <div role="tablist" aria-label="Item detail sections" className="border-border border-b">
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div className="flex w-max gap-1 sm:w-auto">
          {TABS.map((t) => {
            const isShown = t.id === shownTab;
            return (
              <Link
                key={t.id}
                id={`item-detail-tab-${t.id}`}
                href={hrefFor(t.id)}
                role="tab"
                aria-selected={isShown}
                aria-controls={`item-detail-panel-${t.id}`}
                scroll={false}
                onClick={(event) => onTabClick(event, t.id)}
                className={cn(
                  'relative inline-flex h-10 items-center px-3 text-sm font-medium transition-colors',
                  isShown ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t.label}
                <TabUnderline tab={t.id} shown={isShown} onSettled={settle} />
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * The tab's underline. It lives INSIDE the Link because useLinkStatus reads
 * the nearest Link's status. `pending` is true from the click until the new
 * page is rendered (Next resolves it with the navigation's own transition), so
 * the pulse lasts exactly as long as the wait, and its true -> false edge is
 * how the strip learns that a navigation it was showing early is over.
 */
function TabUnderline({
  tab,
  shown,
  onSettled,
}: {
  tab: DetailTabId;
  shown: boolean;
  onSettled: (tab: DetailTabId) => void;
}) {
  const { pending } = useLinkStatus();
  const wasPending = React.useRef(false);
  React.useEffect(() => {
    if (pending) {
      wasPending.current = true;
      return;
    }
    if (!wasPending.current) return;
    wasPending.current = false;
    onSettled(tab);
  }, [pending, tab, onSettled]);
  return (
    <span
      aria-hidden
      className={cn(
        'absolute inset-x-2 bottom-0 h-0.5 rounded-full transition-colors',
        shown ? 'bg-foreground' : 'bg-transparent',
        shown && pending && 'motion-safe:animate-pulse',
      )}
    />
  );
}
