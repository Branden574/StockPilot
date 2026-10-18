import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface EmptyStateProps {
  /**
   * Lucide icon shown in a soft circular badge at the top of the empty
   * state. Required — every empty state should have one to ground the
   * page visually instead of rendering a flat block of text.
   */
  icon: LucideIcon;
  /** Short headline. 3-6 words. */
  title: string;
  /** One sentence: why is this empty + what to do next. */
  description: string;
  /**
   * Primary call to action. Rendered as a real `<Link>` (via
   * `<Button asChild>`) so it's a navigable href, not a JS handler.
   * Omit for filter-empty states where there's nothing to "do" except
   * clear filters.
   */
  cta?: {
    label: string;
    href: string;
  };
  /**
   * An action that is NOT a navigation — a button that runs something and stays
   * on the page. Used where the way out of an empty state is clearing a stored
   * preference rather than going somewhere. Rendered instead of `cta`.
   */
  action?: React.ReactNode;
  /**
   * `sm` is for empty states tucked inside a smaller card (~200px tall),
   * `md` is for full-page empty states (~360px tall). Defaults to `md`.
   */
  size?: 'sm' | 'md';
  /** Optional extra classes if a caller needs to tweak spacing. */
  className?: string;
}

/**
 * The quiet empty state (DESIGN-SPEC 6.21): a dashed hairline box with no fill,
 * a neutral icon chip, the page's own words, and the flat accent CTA (the
 * `gradient` Button variant is the flat accent primary in the redesign).
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  cta,
  size = 'md',
  className,
}: EmptyStateProps) {
  const isSm = size === 'sm';
  return (
    <div
      className={cn(
        'flex w-full flex-col items-center justify-center rounded-lg border border-dashed text-center',
        isSm ? 'min-h-[200px] gap-2 px-4 py-8' : 'min-h-[360px] gap-3 px-6 py-16',
        className,
      )}
    >
      <div
        className={cn(
          'bg-sunk text-muted-foreground flex items-center justify-center rounded-full border border-[var(--ed-line-strong)]',
          isSm ? 'p-2' : 'p-3',
        )}
        aria-hidden="true"
      >
        <Icon className={isSm ? 'h-4 w-4' : 'h-5 w-5'} />
      </div>
      <h3 className={cn('text-foreground font-medium', isSm ? 'text-[13.5px]' : 'text-[15px]')}>
        {title}
      </h3>
      <p className="text-muted-foreground max-w-md text-[13px]">{description}</p>
      {action ? (
        <div className={isSm ? 'mt-1' : 'mt-3'}>{action}</div>
      ) : cta ? (
        <div className={isSm ? 'mt-1' : 'mt-3'}>
          <Button asChild variant="gradient" size={isSm ? 'sm' : 'default'}>
            <Link href={cta.href}>{cta.label}</Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
