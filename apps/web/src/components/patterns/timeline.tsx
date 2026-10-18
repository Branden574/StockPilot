import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * History lists (matrix W-SH-29): the order timeline, an item's activity feed,
 * receipt history, the Overview's recent activity, return history.
 *
 * Two shapes, both an ordered list:
 * - `Timeline` + `TimelineEntry`: a vertical rail. Each entry has a marker (a
 *   tone dot, or an icon in a tone circle) joined to the next by a hairline,
 *   then its title line, a meta line (person · time), optional details, and
 *   an optional right-hand figure.
 * - `Timeline variant="rows"` + `TimelineRow`: the activity row recipe
 *   (DESIGN-SPEC 6.16) for a card body: 10 x 18 rows split by hairlines, the
 *   text on the left, the figure (a delta) on the right.
 *
 * Every word, time and link is the page's own; nothing is read here. Times
 * stay in the caller's hydration-safe components (LocalDateTime and friends).
 */

export type TimelineTone = 'accent' | 'warning' | 'destructive' | 'neutral' | 'muted';

export interface TimelineProps extends React.ComponentProps<'ol'> {
  variant?: 'rail' | 'rows';
}

export function Timeline({ variant = 'rail', className, ...props }: TimelineProps) {
  return (
    <ol
      data-slot="timeline"
      data-variant={variant}
      className={cn('flex min-w-0 flex-col', className)}
      {...props}
    />
  );
}

const DOT_TONE: Record<TimelineTone, string> = {
  accent: 'bg-accent',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  neutral: 'bg-foreground',
  muted: 'bg-muted-foreground',
};

const ICON_TONE: Record<TimelineTone, string> = {
  accent: 'bg-success-wash text-accent',
  warning: 'bg-warning-wash text-warning',
  destructive: 'bg-destructive-wash text-destructive',
  neutral: 'border border-[var(--ed-line-strong)] bg-sunk text-foreground',
  muted: 'border border-border bg-card text-muted-foreground',
};

export interface TimelineEntryProps extends Omit<React.ComponentProps<'li'>, 'title'> {
  /** Line one: what happened ("Order submitted", "Receive · L4L Polo"). */
  title: React.ReactNode;
  /** Line two: who and when. */
  meta?: React.ReactNode;
  /** A figure on the right (a delta, a quantity). */
  aside?: React.ReactNode;
  tone?: TimelineTone;
  /** A 14 px icon in a tone circle; without one the marker is a tone dot. */
  icon?: React.ReactNode;
}

export function TimelineEntry({
  title,
  meta,
  aside,
  tone = 'neutral',
  icon,
  className,
  children,
  ...props
}: TimelineEntryProps) {
  return (
    <li
      data-slot="timeline-entry"
      className={cn('group/entry relative flex min-w-0 gap-3 pb-4 last:pb-0', className)}
      {...props}
    >
      {/* The rail: from the top of this entry (from its marker on the first) to
          the bottom (to its marker on the last); none on a lone entry. */}
      <span
        aria-hidden
        data-slot="timeline-rail"
        className="bg-border absolute bottom-0 left-[13.5px] top-0 w-px group-first/entry:top-3.5 group-last/entry:bottom-auto group-last/entry:h-3.5 group-only/entry:hidden"
      />
      <span
        aria-hidden
        data-slot="timeline-marker"
        className={cn(
          'relative z-[1] grid size-7 shrink-0 place-items-center rounded-full',
          icon ? ICON_TONE[tone] : null,
          '[&_svg]:h-3.5 [&_svg]:w-3.5',
        )}
      >
        {icon ?? (
          <span className={cn('ring-card size-2 rounded-full ring-[3px]', DOT_TONE[tone])} />
        )}
      </span>
      <div className="min-w-0 flex-1 pt-1">
        <div className="text-foreground text-[13.5px] leading-5 [overflow-wrap:anywhere]">
          {title}
        </div>
        {meta != null ? (
          <div className="text-muted-foreground mt-0.5 text-[12px] leading-[18px]">{meta}</div>
        ) : null}
        {children != null ? <div className="mt-1">{children}</div> : null}
      </div>
      {aside != null ? <div className="shrink-0 pt-1">{aside}</div> : null}
    </li>
  );
}

export interface TimelineRowProps extends Omit<React.ComponentProps<'li'>, 'title'> {
  title: React.ReactNode;
  meta?: React.ReactNode;
  aside?: React.ReactNode;
}

/**
 * One activity row (DESIGN-SPEC 6.16), for `Timeline variant="rows"` in a card.
 *
 * The title line ends in an ellipsis, which clips anything drawn outside it,
 * so while a link in the title has keyboard focus the row draws the app's
 * focus ring inside its own edge instead (the row spans a card that clips at
 * its rounded border).
 */
export function TimelineRow({
  title,
  meta,
  aside,
  className,
  children,
  ...props
}: TimelineRowProps) {
  return (
    <li
      data-slot="timeline-row"
      className={cn(
        'border-border has-[[data-slot=timeline-row-title]_a:focus-visible]:ring-ring grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b px-[18px] py-2.5 last:border-b-0 has-[[data-slot=timeline-row-title]_a:focus-visible]:ring-2 has-[[data-slot=timeline-row-title]_a:focus-visible]:ring-inset',
        className,
      )}
      {...props}
    >
      <div className="min-w-0">
        <div
          data-slot="timeline-row-title"
          className="text-foreground truncate text-[13.5px] leading-5 [&_a:focus-visible]:ring-0 [&_a:focus-visible]:ring-offset-0"
        >
          {title}
        </div>
        {meta != null ? (
          <div className="text-muted-foreground mt-0.5 text-[12px] leading-[18px]">{meta}</div>
        ) : null}
        {children != null ? <div className="mt-1">{children}</div> : null}
      </div>
      {aside != null ? <div className="self-start">{aside}</div> : null}
    </li>
  );
}

const LABEL_TONE: Record<TimelineTone, string> = {
  accent: 'text-accent',
  warning: 'text-warning',
  destructive: 'text-destructive',
  neutral: 'text-foreground',
  muted: 'text-[var(--ed-ink-2)]',
};

/** The event type in its tone at weight 500 ("Receive", "Adjust"). */
export function TimelineLabel({
  tone = 'neutral',
  className,
  ...props
}: React.ComponentProps<'span'> & { tone?: TimelineTone }) {
  return <span className={cn('font-medium', LABEL_TONE[tone], className)} {...props} />;
}

/**
 * A signed figure in mono 13: positive in the accent, negative in ink 2 (the
 * reference) or in the destructive tone where the page already reads losses
 * red. The caller formats the number; the sign of `value` picks the tone.
 */
export function DeltaText({
  value,
  negativeTone = 'ink',
  className,
  ...props
}: React.ComponentProps<'span'> & { value: number; negativeTone?: 'ink' | 'destructive' }) {
  return (
    <span
      data-slot="delta"
      className={cn(
        'font-mono text-[13px] tabular-nums',
        value > 0 && 'text-accent',
        value < 0 &&
          (negativeTone === 'destructive' ? 'text-destructive' : 'text-[var(--ed-ink-2)]'),
        value === 0 && 'text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
