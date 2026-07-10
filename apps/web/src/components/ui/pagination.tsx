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
 * link mode (`hrefForPage`, server pages) or client mode (`onPageChange`, an
 * already-loaded set). Provide `total` + `pageSize` for the row-range text and
 * page count; otherwise pass `totalPages` (or just `hasNext` to degrade to
 * Prev/Next only).
 */
export function Pagination({
  page,
  pageSize,
  total,
  totalPages: totalPagesProp,
  hasNext,
  hrefForPage,
  onPageChange,
  className,
}: {
  page: number;
  pageSize?: number;
  total?: number | null;
  totalPages?: number;
  hasNext?: boolean;
  hrefForPage?: (n: number) => string;
  onPageChange?: (n: number) => void;
  className?: string;
}) {
  const router = useRouter();
  const totalPages =
    total != null && pageSize ? Math.max(1, Math.ceil(total / pageSize)) : totalPagesProp;
  const numbered = typeof totalPages === 'number' && totalPages > 0;
  const safePage = numbered ? Math.min(Math.max(1, page), totalPages as number) : page;
  const prevDisabled = safePage <= 1;
  const nextDisabled = numbered ? safePage >= (totalPages as number) : !hasNext;

  const go = React.useCallback(
    (n: number) => {
      if (onPageChange) onPageChange(n);
      else if (hrefForPage) router.push(hrefForPage(n));
    },
    [onPageChange, hrefForPage, router],
  );

  // Row-range text ("Showing 51–100 of 350") when we know the totals.
  const range =
    total != null && pageSize ? (
      <span>
        Showing <span className="text-foreground font-medium">{(safePage - 1) * pageSize + 1}</span>–
        <span className="text-foreground font-medium">{Math.min(safePage * pageSize, total)}</span>{' '}
        of <span className="text-foreground font-medium">{total}</span>
      </span>
    ) : null;

  return (
    <div
      className={cn('text-muted-foreground flex items-center gap-3 text-[12px]', className)}
    >
      {range}
      <div className="flex items-center gap-1">
        <PageBtn disabled={prevDisabled} href={hrefForPage?.(safePage - 1)} onClick={() => go(safePage - 1)}>
          ← Prev
        </PageBtn>

        {numbered ? (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Jump to page"
                className="hover:text-foreground hover:bg-muted/40 text-muted-foreground cursor-pointer rounded px-2 py-0.5 text-[11.5px] transition-colors"
              >
                Page {safePage} of {totalPages}
              </button>
            </PopoverTrigger>
            <PopoverContent align="center" side="top" className="max-h-[360px] w-auto min-w-[260px] overflow-y-auto p-2">
              <JumpGrid
                totalPages={totalPages as number}
                current={safePage}
                hrefForPage={hrefForPage}
                go={go}
              />
            </PopoverContent>
          </Popover>
        ) : (
          <span className="px-2 tabular-nums">Page {safePage}</span>
        )}

        <PageBtn disabled={nextDisabled} href={hrefForPage?.(safePage + 1)} onClick={() => go(safePage + 1)}>
          Next →
        </PageBtn>
      </div>
    </div>
  );
}

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
      <Button variant="outline" size="sm" disabled>
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

/**
 * The jump target. For a manageable page count, a grid of every page (like
 * Items). For a very large count (a big server-paginated ledger), a "go to
 * page" number input instead of thousands of buttons.
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
    <div className="grid grid-cols-5 gap-1 sm:grid-cols-8">
      {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) =>
        hrefForPage ? (
          <Button
            key={n}
            asChild
            variant={n === current ? 'default' : 'ghost'}
            size="sm"
            className="h-7 w-full px-2 text-[12px]"
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
            className="h-7 w-full px-2 text-[12px]"
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
