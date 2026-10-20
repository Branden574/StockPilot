import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * A console table in its card (DESIGN-SPEC 6.9): the card IS the scroll
 * container, so a table wider than the screen scrolls sideways inside it and
 * never clips a column or widens the page. That matters most on an org's
 * Users tab, where the last column holds the only way to disable or re-enable
 * an account: its wrapper used to be `overflow-hidden`, which cut the Actions
 * column off on a phone.
 *
 * The card is a named region a keyboard can reach (Tab focuses it, the arrow
 * keys scroll it), because a scrollable box with no focusable content in view
 * is otherwise unreachable without a mouse. `minWidth` is the width below
 * which the table scrolls instead of squeezing its cells.
 *
 * Rows, headers and cells are the shared Table parts from components/ui.
 */
export function PlatformTable({
  label,
  minWidth,
  className,
  children,
}: {
  /** The region's accessible name ("Organizations", "Members"). */
  label: string;
  minWidth?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      data-slot="platform-table"
      className={cn(
        'border-border bg-card w-full min-w-0 overflow-x-auto rounded-lg border',
        'focus-visible:ring-ring focus-visible:ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
        className,
      )}
    >
      <table
        className="w-full caption-bottom text-[13.5px]"
        style={minWidth ? { minWidth } : undefined}
      >
        {children}
      </table>
    </div>
  );
}
