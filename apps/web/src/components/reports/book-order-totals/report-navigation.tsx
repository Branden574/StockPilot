'use client';

import { Loader2, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { BOOK_REPORT_UI, type BookReportQuery } from '@stockpilot/core';

import { bookReportPageHref, withBookReportPage } from './hrefs';

/**
 * One transition for every navigation the report makes: a filter, a sort, a
 * search, Previous and Next, Refresh. The URL is the report's state, so each
 * is a router navigation the server renders; while it runs, the figures on
 * screen stay up, dimmed and marked busy, until the new answer replaces
 * them. Next's router applies only the latest navigation, so an earlier,
 * slower answer can never land on top of a later one.
 *
 * THE LATEST REQUESTED QUERY. Every control builds its next URL from the
 * query last ASKED for, not from the last one the server rendered: while an
 * answer is loading, a second change (a sort after a search, Next after a
 * filter) keeps the first, and the selects show the pending choice instead
 * of flipping back to the old value until the answer lands. Once the server
 * renders a different query (the answer landed, Back or Forward, a reset of
 * an unreadable filter), what the server rendered wins again.
 */

interface BookReportNavigation {
  pending: boolean;
  /** The query to build the next URL from: the one last asked for while
   *  the server still shows the query it was asked from, else the server's.
   *  Null when the provider was given no query. */
  current: BookReportQuery | null;
  navigate: (href: string, opts?: { replace?: boolean; scroll?: boolean }) => void;
  /** Navigate to a report query, remembering it as the latest requested. */
  go: (next: BookReportQuery, opts?: { replace?: boolean; scroll?: boolean }) => void;
  refresh: () => void;
}

const NavigationContext = React.createContext<BookReportNavigation | null>(null);

export function BookReportNavigationProvider({
  query,
  children,
}: {
  /** The query the server rendered (resolved). */
  query?: BookReportQuery;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const serverHref = query ? bookReportPageHref(query) : null;
  // The latest requested query, kept until the server renders a different
  // query (derived state, reset during render: an answer landing, Back or
  // Forward all replace it, so a stale request can never come back).
  const [requested, setRequested] = React.useState<BookReportQuery | null>(null);
  const [renderedHref, setRenderedHref] = React.useState(serverHref);
  if (renderedHref !== serverHref) {
    setRenderedHref(serverHref);
    setRequested(null);
  }
  const current = (renderedHref === serverHref ? requested : null) ?? query ?? null;
  const value = React.useMemo<BookReportNavigation>(() => {
    const push = (href: string, opts: { replace?: boolean; scroll?: boolean }) => {
      startTransition(() => {
        if (opts.replace) router.replace(href, { scroll: opts.scroll ?? false });
        else router.push(href, { scroll: opts.scroll ?? false });
      });
    };
    return {
      pending,
      current,
      navigate: (href, opts = {}) => {
        setRequested(null);
        push(href, opts);
      },
      go: (next, opts = {}) => {
        setRequested(next);
        push(bookReportPageHref(next), opts);
      },
      refresh: () => {
        setRequested(null);
        startTransition(() => {
          router.refresh();
        });
      },
    };
  }, [pending, router, current]);
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

/** The query a control should show and build from: the latest requested one
 *  while its answer loads, else the server's (`fallback` when the provider
 *  was given none). */
export function useCurrentBookReportQuery(fallback: BookReportQuery): BookReportQuery {
  return useBookReportNavigation().current ?? fallback;
}

export function useBookReportNavigation(): BookReportNavigation {
  const value = React.useContext(NavigationContext);
  if (!value) throw new Error('useBookReportNavigation needs BookReportNavigationProvider');
  return value;
}

/**
 * A real link (it opens in a new tab, and works before the script loads)
 * that, on a plain click, navigates inside the report's transition. With
 * `query` (the report query its href encodes) it is remembered as the latest
 * requested, so a change made while it loads keeps it.
 */
export function BookReportLink({
  href,
  query,
  scroll = false,
  children,
  ...rest
}: Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'> & {
  href: string;
  query?: BookReportQuery;
  scroll?: boolean;
}) {
  const { navigate, go } = useBookReportNavigation();
  return (
    <a
      href={href}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
          return;
        }
        e.preventDefault();
        if (query) go(query, { scroll });
        else navigate(href, { scroll });
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

/**
 * Previous or Next. Built from the latest requested query, so paging while
 * a search or filter is still loading pages THAT report instead of dropping
 * it. `enabled` comes from the answer on screen; the server clamps a page
 * past the end.
 */
export function BookReportPagerLink({
  query,
  step,
  enabled,
  rel,
  children,
}: {
  query: BookReportQuery;
  step: 1 | -1;
  enabled: boolean;
  rel: 'prev' | 'next';
  children: React.ReactNode;
}) {
  const current = useCurrentBookReportQuery(query);
  if (!enabled) {
    return (
      <Button variant="outline" size="sm" disabled>
        {children}
      </Button>
    );
  }
  const next = withBookReportPage(current, current.page + step);
  return (
    <Button asChild variant="outline" size="sm">
      <BookReportLink href={bookReportPageHref(next)} query={next} rel={rel} scroll>
        {children}
      </BookReportLink>
    </Button>
  );
}

/** The figures: dimmed and aria-busy while a new answer loads. */
export function BookReportBusyRegion({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { pending } = useBookReportNavigation();
  return (
    <div
      aria-busy={pending}
      data-pending={pending ? 'true' : undefined}
      className={cn('transition-opacity', pending && 'opacity-60', className)}
    >
      {children}
    </div>
  );
}

/** Reads the report again. The router may show a render up to 90 s old
 *  after Back, which is why the generated time is always on screen. */
export function BookReportRefreshButton() {
  const { pending, refresh } = useBookReportNavigation();
  return (
    <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={pending}>
      {pending ? (
        <Loader2 aria-hidden className="animate-spin" />
      ) : (
        <RefreshCw aria-hidden />
      )}
      {BOOK_REPORT_UI.refresh}
    </Button>
  );
}
