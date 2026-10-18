import Link from 'next/link';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * A titled card on a record's page or the Overview (DESIGN-SPEC 6.7): the
 * elevated surface with a hairline and radius 8, a 14 x 18 header with the
 * title on the left and either quiet meta or a link on the right, then the
 * body. The body pads 18 by default; `flush` leaves the padding to rows that
 * carry their own (key-value rows, list rows, a timeline, a table).
 *
 * The title is a real heading (h2 by default) so the page outline reads the
 * way the cards do. Anything the page passes keeps its own gates and words.
 *
 * The header is 49 px whether its right side is quiet text, a link or a small
 * (28 px) button, so cards side by side keep their header lines level; a
 * taller control or a wrapped header grows it.
 */
export interface DetailSectionProps extends Omit<React.ComponentProps<'section'>, 'title'> {
  title?: React.ReactNode;
  headingLevel?: 2 | 3 | 4;
  /** Right side of the header: `DetailSectionMeta` text or a `DetailSectionLink`. */
  aside?: React.ReactNode;
  /** A footer bar under the body (totals, the card's commit button). */
  footer?: React.ReactNode;
  /** Rows bring their own padding: no body padding. */
  flush?: boolean;
  /** Extra classes for the body wrapper. */
  bodyClassName?: string;
}

export function DetailSection({
  title,
  headingLevel = 2,
  aside,
  footer,
  flush = false,
  className,
  bodyClassName,
  children,
  ...props
}: DetailSectionProps) {
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4';
  const hasHeader = title != null || aside != null;
  return (
    <section
      data-slot="detail-section"
      className={cn(
        'border-border bg-card text-card-foreground min-w-0 overflow-hidden rounded-lg border',
        className,
      )}
      {...props}
    >
      {hasHeader ? (
        <div
          data-slot="detail-section-header"
          className="border-border flex min-h-[49px] flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-[18px] py-2.5"
        >
          {title != null ? (
            <Heading className="text-foreground min-w-0 text-[13.5px] font-medium leading-5">
              {title}
            </Heading>
          ) : (
            <span />
          )}
          {aside}
        </div>
      ) : null}
      <div data-slot="detail-section-body" className={cn(flush ? null : 'p-[18px]', bodyClassName)}>
        {children}
      </div>
      {footer != null ? (
        <div
          data-slot="detail-section-footer"
          className="border-border flex flex-wrap items-center justify-between gap-3 border-t px-[18px] py-3.5"
        >
          {footer}
        </div>
      ) : null}
    </section>
  );
}

/** Quiet header meta ("Most urgent first"). */
export function DetailSectionMeta({ className, ...props }: React.ComponentProps<'span'>) {
  return <span className={cn('text-muted-foreground text-[12px]', className)} {...props} />;
}

/** A header link ("View all 18", "All movements"): accent, ink on hover. */
export function DetailSectionLink({ className, ...props }: React.ComponentProps<typeof Link>) {
  return (
    <Link
      className={cn('text-accent hover:text-foreground text-[12.5px] transition-colors', className)}
      {...props}
    />
  );
}
