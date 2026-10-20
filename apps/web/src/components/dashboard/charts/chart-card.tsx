import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * The Overview's chart card (DESIGN-SPEC 6.17, the reference "Inventory value"
 * card): the flat elevated surface with a hairline and radius 8, and no header
 * bar. Its top row holds the title and the quiet line under it on the left and
 * the card's own controls on the right (they wrap under the title on a narrow
 * card); the chart follows at the card's 18 px gutter.
 *
 * Used by the value card, the movements breakdown and the three analytics
 * panels. Nothing here reads data; every title, line and control is the
 * caller's, unchanged. The cards that hold rows (needs attention, low stock,
 * today's activity) use the shared DetailSection instead.
 */
export interface ChartCardProps extends Omit<React.ComponentProps<'section'>, 'title'> {
  title: React.ReactNode;
  /** h2 on the page, h3 under a section heading (the Analytics panels). */
  headingLevel?: 2 | 3;
  /** The quiet line under the title ("USD · cost basis · all locations"). */
  subtitle?: React.ReactNode;
  /** The card's own controls, top right. */
  controls?: React.ReactNode;
}

export function ChartCard({
  title,
  headingLevel = 2,
  subtitle,
  controls,
  className,
  children,
  ...props
}: ChartCardProps) {
  const Heading = `h${headingLevel}` as 'h2' | 'h3';
  return (
    <section
      data-slot="chart-card"
      className={cn(
        'border-border bg-card text-card-foreground flex min-w-0 flex-col overflow-hidden rounded-lg border',
        className,
      )}
      {...props}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-[18px] pt-4">
        <div className="min-w-0">
          <Heading className="text-foreground text-[13.5px] font-medium leading-5">{title}</Heading>
          {subtitle != null ? (
            <p className="text-muted-foreground mt-0.5 text-[12.5px] leading-[18.75px]">
              {subtitle}
            </p>
          ) : null}
        </div>
        {controls != null ? (
          <div data-slot="chart-card-controls" className="flex flex-wrap items-center gap-2">
            {controls}
          </div>
        ) : null}
      </div>
      {children}
    </section>
  );
}
