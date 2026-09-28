'use client';

import { Loader2, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { BOOK_REPORT_UI } from '@stockpilot/core';

/**
 * One transition for every navigation the report makes: a filter, a sort, a
 * search, Previous and Next, Refresh. The URL is the report's state, so each
 * is a router navigation the server renders; while it runs, the figures on
 * screen stay up, dimmed and marked busy, until the new answer replaces
 * them. Next's router applies only the latest navigation, so an earlier,
 * slower answer can never land on top of a later one.
 */

interface BookReportNavigation {
  pending: boolean;
  navigate: (href: string, opts?: { replace?: boolean; scroll?: boolean }) => void;
  refresh: () => void;
}

const NavigationContext = React.createContext<BookReportNavigation | null>(null);

export function BookReportNavigationProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const value = React.useMemo<BookReportNavigation>(
    () => ({
      pending,
      navigate: (href, opts = {}) => {
        startTransition(() => {
          if (opts.replace) router.replace(href, { scroll: opts.scroll ?? false });
          else router.push(href, { scroll: opts.scroll ?? false });
        });
      },
      refresh: () => {
        startTransition(() => {
          router.refresh();
        });
      },
    }),
    [pending, router],
  );
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useBookReportNavigation(): BookReportNavigation {
  const value = React.useContext(NavigationContext);
  if (!value) throw new Error('useBookReportNavigation needs BookReportNavigationProvider');
  return value;
}

/**
 * A real link (it opens in a new tab, and works before the script loads)
 * that, on a plain click, navigates inside the report's transition.
 */
export function BookReportLink({
  href,
  scroll = false,
  children,
  ...rest
}: Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'> & {
  href: string;
  scroll?: boolean;
}) {
  const { navigate } = useBookReportNavigation();
  return (
    <a
      href={href}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
          return;
        }
        e.preventDefault();
        navigate(href, { scroll });
      }}
      {...rest}
    >
      {children}
    </a>
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
