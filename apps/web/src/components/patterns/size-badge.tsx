import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * The size-count badge (DESIGN-SPEC 6.13) beside a family's name. The caller
 * passes whichever real label applies, unchanged: "N sizes" (a name-derived
 * run), "N variants" (a stored group) or "N variants · N pairs total" (a
 * stored group with a counting unit).
 *
 * `placement="table"`: an outlined pill after the name in a row.
 * `placement="grid"`: a filled pill for a grid card's media corner.
 */
export interface SizeBadgeProps extends React.ComponentProps<'span'> {
  placement?: 'table' | 'grid';
}

export function SizeBadge({ placement = 'table', className, ...props }: SizeBadgeProps) {
  return (
    <span
      data-slot="size-badge"
      className={cn(
        'inline-flex shrink-0 items-center whitespace-nowrap rounded-full',
        placement === 'table'
          ? 'text-muted-foreground border border-[var(--ed-line-strong)] px-1.5 text-[11px] leading-[16.5px]'
          : 'bg-card px-2 py-px text-[11.5px] leading-[17.25px] text-[var(--ed-ink-2)]',
        className,
      )}
      {...props}
    />
  );
}
