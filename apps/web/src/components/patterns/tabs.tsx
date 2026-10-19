'use client';

import Link, { useLinkStatus } from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * The in-page tab strip for a record's own page (item Overview / Movements /
 * Activity, rentals Activity / Items, a settings sub-nav): `role="tablist"`,
 * an underline on the current tab.
 *
 * LINK DRIVEN (every item has an `href`): the URL is the state, so `?tab=`
 * deep links keep working and the server renders the right tab on first paint.
 * The page passes each tab's own href (other query params carried along, as
 * the item page does). The tab the server rendered (`activeId`) links to the
 * address bar exactly as it is instead, however the URL spells that tab
 * (`?tab=overview`, an unknown `?tab=`, params in another order), so its href
 * and the URL agree: NavProgressBar compares the two to decide whether a
 * click is a navigation at all, and would otherwise start a bar for a click
 * this strip cancels (rule 2). This strip then gives instant feedback the
 * same way the item page's tabs do (owner report 2026-09-22, a tab showed
 * nothing for 3.6-6.6 s):
 *   1. the clicked tab shows selected at once, and its underline pulses while
 *      next/link reports the navigation pending (useLinkStatus);
 *   2. a click on the tab already shown does nothing (Next would treat a link
 *      to the current URL as a refresh and re-run every server read);
 *   3. the early choice never outlives its navigation: it is tied to the URL
 *      it was clicked on, and dropped when next/link says the navigation ended
 *      while the URL has not moved (another link took over).
 * Modified clicks (open in a new tab) are left to the browser.
 *
 * BUTTON DRIVEN (no `href`): a controlled strip; `onSelect` gets the id and
 * the page moves `activeId`.
 *
 * `idPrefix` gives each tab the id its panel names (`{idPrefix}-tab-{id}`) and
 * an `aria-controls` of `{idPrefix}-panel-{id}`.
 *
 * FOCUS: the strip scrolls sideways on a phone and each tab fills its height,
 * so a focused tab draws the app's focus ring inside its own edge.
 *
 * It reads the current URL (usePathname / useSearchParams), as the item
 * page's strip does: fine on the dashboard's dynamic pages; a statically
 * rendered page would need a Suspense boundary around it.
 */

export interface TabItem {
  id: string;
  label: React.ReactNode;
  href?: string;
  /** A count the page already has. Absent: nothing is printed. */
  count?: React.ReactNode;
}

export interface TabsProps {
  items: readonly TabItem[];
  /**
   * The tab the server rendered (link mode: it links to the current URL as it
   * is) or the chosen one (button mode).
   */
  activeId: string;
  'aria-label': string;
  idPrefix?: string;
  /** next/link `scroll`; false keeps the page where it is on a tab switch. */
  scroll?: boolean;
  prefetch?: boolean | 'auto' | null;
  /** Button mode: called with the id of the clicked tab. */
  onSelect?(id: string): void;
  /**
   * Link mode: the current tab keeps its own `href` instead of the address
   * bar, so clicking it goes back to that tab's plain URL (a section strip
   * whose current tab resets the view's filters and paging, as the rentals
   * Activity / Items strip always did). A click while the address bar
   * already IS that href still does nothing, as rule 2 below says.
   */
  activeLinksToHref?: boolean;
  className?: string;
}

/** The tab the person clicked, and the URL they clicked it on. */
interface OptimisticTab {
  id: string;
  href: string;
}

export function Tabs({
  items,
  activeId,
  'aria-label': ariaLabel,
  idPrefix,
  scroll,
  prefetch,
  onSelect,
  activeLinksToHref = false,
  className,
}: TabsProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams?.toString() ?? '';
  const currentHref = query ? `${pathname}?${query}` : (pathname ?? '');

  const [optimistic, setOptimistic] = React.useState<OptimisticTab | null>(null);
  // The URL moved, so whatever was clicked on the old one is settled. Reset
  // during render (React's "adjusting state when a prop changes" pattern) so no
  // frame shows a stale choice, and so going Back to the URL a tab was clicked
  // on can never bring that old choice back.
  if (optimistic !== null && optimistic.href !== currentHref) setOptimistic(null);
  const shownId = optimistic !== null && optimistic.href === currentHref ? optimistic.id : activeId;

  // Called by a tab's underline when next/link reports its navigation over.
  // Only the tab still being waited on is dropped: after a quick second click
  // the first tab's navigation ends (superseded) while the second is current.
  const settle = React.useCallback((id: string) => {
    setOptimistic((current) => (current !== null && current.id === id ? null : current));
  }, []);

  function onLinkClick(event: React.MouseEvent<HTMLAnchorElement>, id: string, href: string) {
    // Modified clicks open a new tab or window: next/link leaves them to the
    // browser, and so does this strip.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    if (id === shownId) {
      // activeLinksToHref: the tab the server rendered leads to its plain URL,
      // so a click while the address bar is elsewhere navigates there (and
      // resets the view). A tab still loading from a click keeps rule 2.
      if (activeLinksToHref && id === activeId && href !== currentHref) return;
      // next/link skips its navigation when the default is already prevented.
      event.preventDefault();
      return;
    }
    setOptimistic({ id, href: currentHref });
  }

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      data-slot="tabs"
      className={cn('border-border border-b', className)}
    >
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div className="flex w-max gap-1 sm:w-auto">
          {items.map((item) => {
            const isShown = item.id === shownId;
            const ids = idPrefix
              ? {
                  id: `${idPrefix}-tab-${item.id}`,
                  'aria-controls': `${idPrefix}-panel-${item.id}`,
                }
              : {};
            const tabClass = cn(
              'relative inline-flex h-10 items-center gap-1.5 whitespace-nowrap px-3 text-[13.5px] font-medium transition-colors focus-visible:ring-inset focus-visible:ring-offset-0 max-sm:min-h-11 pointer-coarse:min-h-11',
              isShown ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            );
            const count =
              item.count != null ? (
                <span
                  data-slot="tab-count"
                  className="text-muted-foreground font-mono text-[11px] font-medium tabular-nums"
                >
                  {item.count}
                </span>
              ) : null;

            if (item.href != null) {
              const href =
                item.id === activeId && pathname && !activeLinksToHref ? currentHref : item.href;
              return (
                <Link
                  key={item.id}
                  href={href}
                  role="tab"
                  aria-selected={isShown}
                  scroll={scroll}
                  prefetch={prefetch}
                  onClick={(event) => onLinkClick(event, item.id, href)}
                  className={tabClass}
                  {...ids}
                >
                  {item.label}
                  {count}
                  <TabUnderline id={item.id} shown={isShown} onSettled={settle} />
                </Link>
              );
            }
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={isShown}
                onClick={() => onSelect?.(item.id)}
                className={tabClass}
                {...ids}
              >
                {item.label}
                {count}
                <span
                  aria-hidden
                  className={cn(
                    'absolute inset-x-2 bottom-0 h-0.5 rounded-full transition-colors',
                    isShown ? 'bg-foreground' : 'bg-transparent',
                  )}
                />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * A link tab's underline. It lives INSIDE the Link because useLinkStatus reads
 * the nearest Link's status. `pending` is true from the click until the new
 * page is rendered, so the pulse lasts exactly as long as the wait, and its
 * true -> false edge is how the strip learns that a navigation it was showing
 * early is over.
 */
function TabUnderline({
  id,
  shown,
  onSettled,
}: {
  id: string;
  shown: boolean;
  onSettled: (id: string) => void;
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
    onSettled(id);
  }, [pending, id, onSettled]);
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
