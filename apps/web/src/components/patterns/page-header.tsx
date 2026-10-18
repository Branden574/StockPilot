import Link from 'next/link';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * The page header every redesigned dashboard page shares (DESIGN-SPEC 6.1).
 *
 * It only arranges what the page hands it: no data is read here, so the title
 * is whatever the page resolved (an `effectiveNavLabel(...)` result, so Settings
 * > Navigation renames keep reaching the heading, or the page's own static
 * title), and every action keeps the gate the page already applies.
 *
 * Exactly one `<h1>`: the title. Nothing else in the header is a heading, so a
 * page that renders this header must not render another h1.
 *
 * Actions sit on the right, bottom-aligned with the title block, and wrap under
 * it on narrow screens. The hierarchy rule is structural: a page shows at most
 * one ink-filled primary (`commitAction`, committing the work in front of you:
 * Receive stock, Post count) and at most one accent-filled primary
 * (`primaryAction`, page-level create: + New item, + New PO), each in its own
 * slot, after the secondary `actions`.
 *
 * The root is a `<div>`, never a `<header>`: the shell's topbar owns the page's
 * `header` element (print CSS and tours select it).
 */

export type PageHeaderVariant = 'page' | 'greeting' | 'item';

export interface PageHeaderProps {
  /** The page heading, rendered as the page's only `<h1>`. */
  title: React.ReactNode;
  /**
   * `page` (default): list and form pages, Inter Tight 28.
   * `greeting`: Overview, 32 with the eyebrow line above.
   * `item`: a record's own page, 26, beside its 64 px `media`.
   */
  variant?: PageHeaderVariant;
  /** Small uppercase line above the title ("WEDNESDAY, OCTOBER 14 · ALL WAREHOUSES"). */
  eyebrow?: React.ReactNode;
  /**
   * The line under the title. It can carry live stats (the Items "N SKUs · N
   * rows · $ on hand" line with its pending state); wrap a figure in
   * `SublineValue` to print it in ink.
   */
  subline?: React.ReactNode;
  /** Item variant: the meta row under the title (mono SKU · category · status). */
  meta?: React.ReactNode;
  /** On the title line, after the h1 and outside it: a code chip, a status badge. */
  titleAside?: React.ReactNode;
  /** Item variant: the photo (or its placeholder) left of the title block. */
  media?: React.ReactNode;
  /** Anything else that belongs under the title block (a scoped-warehouse notice). */
  children?: React.ReactNode;
  /** A back link above the title; `PageHeaderBackLink` gives the look. */
  back?: React.ReactNode;
  /** The page's tour trigger (`PageTour`); first in the actions row. */
  tour?: React.ReactNode;
  /** Secondary actions: outline buttons, view toggles, filter dropdowns. */
  actions?: React.ReactNode;
  /** At most one ink-filled primary button (committing work in context). */
  commitAction?: React.ReactNode;
  /** At most one accent-filled primary button (page-level create); rightmost. */
  primaryAction?: React.ReactNode;
  /** id on the h1, for an `aria-labelledby` elsewhere on the page. */
  titleId?: string;
  className?: string;
}

const TITLE_CLASS: Record<PageHeaderVariant, string> = {
  page: 'text-[28px] leading-[1.5]',
  greeting: 'text-[32px] leading-[1.15]',
  item: 'text-[26px] leading-[1.2]',
};

export function PageHeader({
  title,
  variant = 'page',
  eyebrow,
  subline,
  meta,
  titleAside,
  media,
  children,
  back,
  tour,
  actions,
  commitAction,
  primaryAction,
  titleId,
  className,
}: PageHeaderProps) {
  const hasActions = Boolean(tour || actions || commitAction || primaryAction);
  return (
    <div data-slot="page-header" className={cn('flex min-w-0 flex-col', className)}>
      {back ? <div className="mb-2">{back}</div> : null}
      <div
        className={cn(
          'flex min-w-0 flex-wrap items-end justify-between gap-4',
          variant === 'greeting' && 'pb-2',
        )}
      >
        <div className={cn('min-w-0 max-w-full', media ? 'flex items-center gap-4' : null)}>
          {media ? <div className="shrink-0">{media}</div> : null}
          <div className="min-w-0">
            {eyebrow ? (
              <div className="text-muted-foreground mb-1.5 text-[11px] font-medium uppercase leading-[16.5px] tracking-[0.1em]">
                {eyebrow}
              </div>
            ) : null}
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <h1
                id={titleId}
                className={cn(
                  'text-foreground min-w-0 font-medium tracking-[-0.025em] [font-family:var(--font-display)] [overflow-wrap:anywhere]',
                  TITLE_CLASS[variant],
                )}
              >
                {title}
              </h1>
              {titleAside}
            </div>
            {meta ? (
              <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px]">
                {meta}
              </div>
            ) : null}
            {subline ? (
              <div
                className={cn(
                  'text-muted-foreground text-[13.5px]',
                  variant === 'greeting' ? 'mt-1' : 'mt-0.5',
                )}
              >
                {subline}
              </div>
            ) : null}
            {children}
          </div>
        </div>
        {hasActions ? (
          <div data-slot="page-header-actions" className="flex flex-wrap items-center gap-2">
            {tour}
            {actions}
            {commitAction}
            {primaryAction}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** A figure inside the subline printed in ink ("$228,261.23 on hand"). */
export function SublineValue({ className, ...props }: React.ComponentProps<'span'>) {
  return <span className={cn('text-foreground font-medium tabular-nums', className)} {...props} />;
}

/**
 * The back link's look. Its words stay the page's own ("← Back to settings"),
 * passed as children unchanged.
 */
export function PageHeaderBackLink({ className, ...props }: React.ComponentProps<typeof Link>) {
  return (
    <Link
      className={cn(
        'text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[13px] transition-colors',
        className,
      )}
      {...props}
    />
  );
}
