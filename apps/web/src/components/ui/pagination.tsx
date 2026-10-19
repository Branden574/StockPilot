'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/**
 * Numbered pagination matching the Items pager: "Showing X–Y of Z", Prev, a
 * "Page N of M" popover to jump to any page, and Next. Works in two modes —
 * link mode (server pages) or client mode (`onPageChange`, an
 * already-loaded set). Provide `total` + `pageSize` for the row-range text and
 * page count; otherwise pass `totalPages` (or just `hasNext` to degrade to
 * Prev/Next only).
 *
 * Link mode comes in two flavors:
 * - `basePath` (+ optional `baseParams`/`pageParamName`) — SERIALIZABLE, the
 *   only flavor a React Server Component may use. The pager builds each page
 *   href itself: `baseParams` verbatim, then `pageParamName` appended for
 *   pages > 1 (page 1 gets no page param — canonical URLs stay clean).
 * - `hrefForPage` — a function, CLIENT COMPONENTS ONLY. Passing a function
 *   across the RSC boundary throws `Functions cannot be passed directly to
 *   Client Components` at runtime (digest 3969804129) and the error boundary
 *   eats the whole page; nothing at build time catches it (the maintenance
 *   list shipped that crash — 2026-08-05 walk, BUG 1).
 */
export function Pagination({
  page,
  pageSize,
  total,
  totalPages: totalPagesProp,
  hasNext,
  hrefForPage,
  basePath,
  baseParams,
  pageParamName = 'page',
  onPageChange,
  className,
}: {
  page: number;
  pageSize?: number;
  total?: number | null;
  totalPages?: number;
  hasNext?: boolean;
  hrefForPage?: (n: number) => string;
  basePath?: string;
  baseParams?: Record<string, string>;
  pageParamName?: string;
  onPageChange?: (n: number) => void;
  className?: string;
}) {
  const router = useRouter();
  // Resolve the link flavor once: an explicit function wins (client call
  // sites), else build one from the serializable props (server call sites).
  const linkForPage = React.useMemo<((n: number) => string) | undefined>(() => {
    if (hrefForPage) return hrefForPage;
    if (!basePath) return undefined;
    return (n: number) => {
      const usp = new URLSearchParams(baseParams);
      usp.delete(pageParamName);
      if (n > 1) usp.set(pageParamName, String(n));
      const qs = usp.toString();
      return qs ? `${basePath}?${qs}` : basePath;
    };
  }, [hrefForPage, basePath, baseParams, pageParamName]);
  const totalPages =
    total != null && pageSize ? Math.max(1, Math.ceil(total / pageSize)) : totalPagesProp;
  const numbered = typeof totalPages === 'number' && totalPages > 0;
  const safePage = numbered ? Math.min(Math.max(1, page), totalPages as number) : page;
  const prevDisabled = safePage <= 1;
  const nextDisabled = numbered ? safePage >= (totalPages as number) : !hasNext;

  const go = React.useCallback(
    (n: number) => {
      if (onPageChange) onPageChange(n);
      else if (linkForPage) router.push(linkForPage(n));
    },
    [onPageChange, linkForPage, router],
  );

  // Row-range text ("Showing 51–100 of 350") when we know the totals and
  // there is at least one row: a total of 0 prints no range (it read
  // "Showing 1–0 of 0").
  const range =
    total != null && total > 0 && pageSize ? (
      <span>
        Showing <span className="text-foreground font-medium">{(safePage - 1) * pageSize + 1}</span>–
        <span className="text-foreground font-medium">{Math.min(safePage * pageSize, total)}</span>{' '}
        of <span className="text-foreground font-medium">{total}</span>
      </span>
    ) : null;

  return (
    <div className={cn('text-muted-foreground flex items-center gap-3 text-[12.5px]', className)}>
      {range}
      <div className="flex items-center gap-2">
        <PageBtn disabled={prevDisabled} href={linkForPage?.(safePage - 1)} onClick={() => go(safePage - 1)}>
          ← Prev
        </PageBtn>

        {numbered ? (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Jump to page"
                className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring inline-flex h-7 cursor-pointer items-center rounded-md px-2 text-[12.5px] tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2"
              >
                Page {safePage} of {totalPages}
              </button>
            </PopoverTrigger>
            <PopoverContent align="center" side="top" className="max-h-[360px] w-auto min-w-[260px] overflow-y-auto p-2">
              <JumpGrid
                totalPages={totalPages as number}
                current={safePage}
                hrefForPage={linkForPage}
                go={go}
              />
            </PopoverContent>
          </Popover>
        ) : (
          <span className="px-2 tabular-nums">Page {safePage}</span>
        )}

        <PageBtn disabled={nextDisabled} href={linkForPage?.(safePage + 1)} onClick={() => go(safePage + 1)}>
          Next →
        </PageBtn>
      </div>
    </div>
  );
}

/** The pager recipe (DESIGN-SPEC 6.2): an enabled Prev/Next is the 28 px
 *  secondary button; a disabled one goes quiet (no fill, the plain hairline,
 *  the faint ink) instead of fading. */
const PAGE_BTN_DISABLED =
  'disabled:opacity-100 disabled:border-border disabled:bg-transparent disabled:text-[var(--ed-ink-4)]';

/** Prev/Next control — a Link in href mode, a button in client mode. */
function PageBtn({
  disabled,
  href,
  onClick,
  children,
}: {
  disabled: boolean;
  href?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <Button variant="outline" size="sm" disabled className={PAGE_BTN_DISABLED}>
        {children}
      </Button>
    );
  }
  if (href) {
    return (
      <Button asChild variant="outline" size="sm">
        <Link href={href}>{children}</Link>
      </Button>
    );
  }
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      {children}
    </Button>
  );
}

/** The jump grid: five columns, eight from sm up, but five again on a coarse
 *  pointer (an iPad) so every column stays at least 44 px wide. */
const JUMP_GRID = 'grid grid-cols-5 gap-1 sm:grid-cols-8 pointer-coarse:grid-cols-5';
/** A page button: 28 px on desktop, a full 44 px target where Button grows its
 *  touch area (below sm and on coarse pointers). */
const JUMP_TARGET =
  'h-7 w-full px-2 text-[12.5px] tabular-nums max-sm:h-11 pointer-coarse:h-11';

/**
 * The jump target. For a manageable page count, a grid of every page (like
 * Items). For a very large count (a big server-paginated ledger), a "go to
 * page" number input instead of thousands of buttons.
 *
 * Below sm and on coarse pointers each page button is a real 44 px target and
 * the grid keeps five columns (each at least 44 px wide in the 260 px popover).
 * At 28 px with 4 px gaps, Button's 44 px touch area reached over the row
 * above, so a tap on the bottom of page 1 opened page 6.
 */
function JumpGrid({
  totalPages,
  current,
  hrefForPage,
  go,
}: {
  totalPages: number;
  current: number;
  hrefForPage?: (n: number) => string;
  go: (n: number) => void;
}) {
  const [value, setValue] = React.useState('');
  if (totalPages > 120) {
    const submit = () => {
      const n = Math.min(Math.max(1, Math.floor(Number(value) || 0)), totalPages);
      if (n) go(n);
    };
    return (
      <div className="flex items-center gap-2 p-1">
        <Input
          type="number"
          min={1}
          max={totalPages}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder={`1–${totalPages}`}
          className="h-8 w-28"
          aria-label="Go to page"
          autoFocus
        />
        <Button size="sm" onClick={submit}>
          Go
        </Button>
      </div>
    );
  }
  return (
    <div className={JUMP_GRID}>
      {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) =>
        hrefForPage ? (
          <Button
            key={n}
            asChild
            variant={n === current ? 'default' : 'ghost'}
            size="sm"
            className={JUMP_TARGET}
          >
            <Link href={hrefForPage(n)} aria-current={n === current ? 'page' : undefined}>
              {n}
            </Link>
          </Button>
        ) : (
          <Button
            key={n}
            variant={n === current ? 'default' : 'ghost'}
            size="sm"
            className={JUMP_TARGET}
            onClick={() => go(n)}
            aria-current={n === current ? 'page' : undefined}
          >
            {n}
          </Button>
        ),
      )}
    </div>
  );
}
