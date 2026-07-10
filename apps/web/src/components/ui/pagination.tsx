import Link from 'next/link';

import { cn } from '@/lib/utils';

/**
 * Numbered pagination. Renders First/Prev, a windowed run of page numbers
 * (±`window` around the current page, with ellipses), and Next/Last. Pure +
 * server-friendly — the caller supplies `hrefForPage(n)` so it works with any
 * searchParams scheme. When `totalPages` is unknown (a big ledger where an
 * exact count is too slow), pass `hasNext` instead and it degrades to
 * Prev/Next only.
 */
export function Pagination({
  page,
  totalPages,
  hasNext,
  hrefForPage,
  onPageChange,
  window = 2,
  className,
}: {
  page: number;
  totalPages?: number;
  hasNext?: boolean;
  /** Link mode (server pages). Provide this OR onPageChange. */
  hrefForPage?: (n: number) => string;
  /** Button mode (client-side pagination over an already-loaded set). */
  onPageChange?: (n: number) => void;
  window?: number;
  className?: string;
}) {
  const numbered = typeof totalPages === 'number' && totalPages > 0;
  const last = numbered ? totalPages : undefined;
  const canPrev = page > 1;
  const canNext = numbered ? page < (last as number) : Boolean(hasNext);

  // Windowed page list with ellipsis sentinels (0 = gap).
  const pages: number[] = [];
  if (numbered) {
    const from = Math.max(1, page - window);
    const to = Math.min(last as number, page + window);
    if (from > 1) {
      pages.push(1);
      if (from > 2) pages.push(0);
    }
    for (let n = from; n <= to; n++) pages.push(n);
    if (to < (last as number)) {
      if (to < (last as number) - 1) pages.push(0);
      pages.push(last as number);
    }
  }

  const cell = (n: number, label: string, key: string, current?: boolean, disabled?: boolean) => (
    <PageCell
      key={key}
      href={hrefForPage?.(n)}
      onClick={onPageChange ? () => onPageChange(n) : undefined}
      current={current}
      disabled={disabled}
      ariaLabel={label}
    >
      {label === 'Previous page' ? '←' : label === 'Next page' ? '→' : n}
    </PageCell>
  );

  return (
    <nav
      role="navigation"
      aria-label="Pagination"
      className={cn('flex items-center gap-1', className)}
    >
      {cell(page - 1, 'Previous page', 'prev', false, !canPrev)}

      {numbered ? (
        pages.map((n, i) =>
          n === 0 ? (
            <span key={`gap-${i}`} className="text-muted-foreground px-1.5 text-sm">
              …
            </span>
          ) : (
            cell(n, `Page ${n}`, `p${n}`, n === page)
          ),
        )
      ) : (
        <span className="text-muted-foreground px-2 text-sm tabular-nums">Page {page}</span>
      )}

      {cell(page + 1, 'Next page', 'next', false, !canNext)}
    </nav>
  );
}

function PageCell({
  href,
  onClick,
  children,
  disabled,
  current,
  ariaLabel,
}: {
  href?: string;
  onClick?: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  current?: boolean;
  ariaLabel?: string;
}) {
  const base =
    'inline-flex h-8 min-w-8 items-center justify-center rounded-md border px-2 text-sm tabular-nums transition-colors';
  if (disabled) {
    return (
      <span aria-disabled className={cn(base, 'text-muted-foreground opacity-50')}>
        {children}
      </span>
    );
  }
  const active = current
    ? 'bg-foreground text-background border-foreground font-medium'
    : 'bg-card hover:bg-accent';
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={ariaLabel}
        aria-current={current ? 'page' : undefined}
        className={cn(base, active)}
      >
        {children}
      </button>
    );
  }
  return (
    <Link
      href={href ?? '#'}
      aria-label={ariaLabel}
      aria-current={current ? 'page' : undefined}
      className={cn(base, active)}
    >
      {children}
    </Link>
  );
}
