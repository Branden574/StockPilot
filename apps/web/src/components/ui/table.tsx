import * as React from 'react';

import { cn } from '@/lib/utils';

import { TableScroll } from './table-scroll';

export interface TableProps extends React.HTMLAttributes<HTMLTableElement> {
  /**
   * Names the scroll wrapper as a `region` ("Orders"), so a screen reader
   * says which table the scroll area holds. The table's own attributes
   * (`aria-label` included) still go to the <table>.
   */
  scrollLabel?: string;
  /** The id of a visible heading that names the scroll wrapper (instead of `scrollLabel`). */
  scrollLabelledBy?: string;
}

/**
 * Table (DESIGN-SPEC 6.9): header cells 11 px / 500, uppercase, +0.06em in the
 * muted ink; body cells pad by the density variable (--row-py: 11 px
 * comfortable, 6 px compact; phones stay comfortable) and 12 px across, 16 px
 * on the first and last cell; the whole row takes the neutral hover fill. A
 * wide table scrolls inside its own wrapper, never the page. A cell holding a
 * checkbox keeps no right padding, so the checkbox column stays narrow.
 *
 * While the table is wider than the wrapper and holds no link, button or field
 * of its own, the wrapper is a Tab stop so the arrow keys can scroll it
 * (TableScroll, the one client part; rows and cells stay server-renderable).
 * Pass `scrollLabel` or `scrollLabelledBy` to name it; every table that can
 * overflow should.
 */
export const Table = React.forwardRef<HTMLTableElement, TableProps>(
  ({ className, scrollLabel, scrollLabelledBy, ...props }, ref) => (
    <TableScroll label={scrollLabel} labelledBy={scrollLabelledBy}>
      <table
        ref={ref}
        className={cn('w-full caption-bottom text-[13.5px]', className)}
        {...props}
      />
    </TableScroll>
  ),
);
Table.displayName = 'Table';

export const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn('[&_tr]:border-b', className)} {...props} />
));
TableHeader.displayName = 'TableHeader';

export const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn('[&_tr:last-child]:border-0', className)} {...props} />
));
TableBody.displayName = 'TableBody';

export const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot
    ref={ref}
    className={cn('bg-sunk border-t font-medium [&>tr]:last:border-b-0', className)}
    {...props}
  />
));
TableFooter.displayName = 'TableFooter';

export const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn(
      'hover:bg-muted data-[state=selected]:bg-success-wash border-b transition-colors',
      className,
    )}
    {...props}
  />
));
TableRow.displayName = 'TableRow';

export const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      'text-muted-foreground px-3 py-2.5 text-left align-middle text-[11px] font-medium uppercase leading-[16.5px] tracking-[0.06em] first:pl-4 last:pr-4 [&:has([role=checkbox])]:pr-0',
      className,
    )}
    {...props}
  />
));
TableHead.displayName = 'TableHead';

export const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td
    ref={ref}
    className={cn(
      'px-3 py-[var(--row-py)] align-middle first:pl-4 last:pr-4 [&:has([role=checkbox])]:pr-0',
      className,
    )}
    {...props}
  />
));
TableCell.displayName = 'TableCell';

export const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption
    ref={ref}
    className={cn('text-muted-foreground mt-4 text-[12.5px]', className)}
    {...props}
  />
));
TableCaption.displayName = 'TableCaption';
