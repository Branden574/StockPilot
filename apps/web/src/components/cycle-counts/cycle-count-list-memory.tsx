'use client';

import Link from 'next/link';
import * as React from 'react';

import {
  CYCLE_COUNT_LIST_PATH,
  cycleCountListHref,
  cycleCountListHrefFromQuery,
} from './cycle-count-list-href';

/**
 * The history list's search, status and page, remembered for this browser
 * tab so the detail page's "Back to cycle counts" returns to the same view.
 * (The browser's own Back button already does, because the list keeps its
 * state in the URL.) sessionStorage only: per tab, never shared, and every
 * read and write tolerates storage being unavailable.
 */
const STORAGE_KEY = 'stockpilot:cycle-counts:list-query';

/** Rendered by the list page: records the view it is showing. */
export function RememberCycleCountListView({
  q,
  status,
  page,
}: {
  q: string;
  status: string | null;
  page: number;
}) {
  React.useEffect(() => {
    const href = cycleCountListHref({ q, status, page });
    const query = href.slice(CYCLE_COUNT_LIST_PATH.length);
    try {
      if (query) window.sessionStorage.setItem(STORAGE_KEY, query);
      else window.sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable: the back link falls back to the plain list */
    }
  }, [q, status, page]);
  return null;
}

/** The remembered view's URL, or the plain list when there is none or storage
 *  cannot be read. A string, so React can compare snapshots by value. */
function readRememberedHref(): string {
  try {
    return cycleCountListHrefFromQuery(window.sessionStorage.getItem(STORAGE_KEY));
  } catch {
    return CYCLE_COUNT_LIST_PATH;
  }
}

/** Nothing to subscribe to: the value only matters when the link renders. */
function subscribeNever(): () => void {
  return () => {};
}

/** Rendered by the detail page: links back to the remembered view. The server
 *  render (and a browser without storage) links to the plain list. */
export function BackToCycleCounts({ className }: { className?: string }) {
  const href = React.useSyncExternalStore(
    subscribeNever,
    readRememberedHref,
    () => CYCLE_COUNT_LIST_PATH,
  );
  return (
    <Link href={href} className={className}>
      ← Back to cycle counts
    </Link>
  );
}
