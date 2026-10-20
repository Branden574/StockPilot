import { ArrowDown, ArrowUp, CheckCircle2, ChevronRight, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { DetailSection, DetailSectionMeta } from '@/components/patterns/detail-section';
import { cn } from '@/lib/utils';

import type { DeltaToken } from './types';

/**
 * Shared presentational bits used by more than one dashboard widget, drawn in
 * the redesign's Overview language (DESIGN-SPEC 6.7, 6.16, 7.1).
 *
 * Nothing here fetches data: every value arrives via props.
 */

// ── Needs attention ─────────────────────────────────────────────────────────

export interface AttentionItem {
  id: string;
  title: string;
  detail: string;
  href: string;
  /**
   * Priority rank — lower wins. Encodes the spec order: low-stock,
   * overdue POs, pending approvals, in-progress cycle counts, orders
   * awaiting signature. When multiple categories have non-zero counts the list
   * sorts by this rank, so the lead row is always the most urgent
   * surface (stockouts first, paperwork last).
   */
  rank: number;
  tone: 'danger' | 'warn' | 'neutral';
}

/**
 * The row marker (DESIGN-SPEC 6.16): an 8 px dot in the item's tone on the
 * card, danger for stock that ran out, caution for low stock, overdue POs and
 * approvals, muted ink for counts and signatures. It sits on the card itself,
 * never on a tint, so it keeps 3:1 in both themes (the old warn icon put the
 * on-fill --warning-foreground over a warning tint and read 1.48:1 in dark).
 * The title's words always say what the row is; the dot is never the only cue.
 */
export const ATTENTION_DOT: Record<AttentionItem['tone'], string> = {
  danger: 'bg-destructive',
  warn: 'bg-warning',
  neutral: 'bg-muted-foreground',
};

/**
 * The "Needs attention" card: one link row per item (dot, title, detail,
 * "Take a look"), most urgent first, or the "All clear" message when nothing
 * needs a click.
 */
export function NeedsAttentionHero({ items }: { items: AttentionItem[] }) {
  return (
    <DetailSection
      title="Needs attention"
      aside={
        items.length > 0 ? <DetailSectionMeta>Most urgent first</DetailSectionMeta> : undefined
      }
      flush
    >
      {items.length === 0 ? (
        <div className="flex items-center gap-4 px-[18px] py-4">
          <span
            aria-hidden
            className="bg-success-wash text-accent flex size-9 shrink-0 items-center justify-center rounded-full"
          >
            <CheckCircle2 className="size-[18px]" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <p className="text-foreground text-[13.5px] font-medium leading-5">
              All clear — nothing needs attention today.
            </p>
            <p className="text-muted-foreground mt-0.5 text-[12.5px] leading-[18.75px]">
              No low stock, no overdue POs, no pending approvals, no open counts, no orders awaiting
              signature. The numbers below are just context.
            </p>
          </div>
        </div>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.id} className="border-border border-b last:border-b-0">
              <Link
                href={item.href}
                data-tone={item.tone}
                className="hover:bg-muted group grid grid-cols-[8px_minmax(0,1fr)] items-start gap-x-3.5 gap-y-1.5 px-[18px] py-[13px] transition-colors focus-visible:ring-inset focus-visible:ring-offset-0 sm:grid-cols-[8px_minmax(0,1fr)_auto] sm:items-center"
              >
                <span
                  aria-hidden
                  data-slot="attention-dot"
                  className={cn('mt-1.5 size-2 rounded-full sm:mt-0', ATTENTION_DOT[item.tone])}
                />
                <span className="min-w-0">
                  <span className="text-foreground block text-[13.5px] font-medium leading-5">
                    {item.title}
                  </span>
                  <span className="text-muted-foreground mt-0.5 block text-[12.5px] leading-[18.75px] [text-wrap:pretty]">
                    {item.detail}
                  </span>
                </span>
                <span className="text-ink-2 group-hover:text-foreground col-start-2 inline-flex items-center gap-1 text-[12.5px] font-medium sm:col-start-auto">
                  Take a look
                  <ChevronRight
                    aria-hidden
                    className="text-muted-foreground size-3.5"
                    strokeWidth={1.8}
                  />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </DetailSection>
  );
}

// ── Section heading (30-day trends, Analytics, Recent activity) ─────────────

export function WidgetHeading({
  title,
  description,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <h2 className="text-foreground font-display text-[15px] font-medium leading-[22px] tracking-[-0.01em]">
        {title}
      </h2>
      {description != null ? (
        <p className="text-muted-foreground text-[12.5px] leading-[18.75px]">{description}</p>
      ) : null}
    </div>
  );
}

// ── Delta token (key stats, value card) ─────────────────────────────────────

const DELTA_TONE: Record<DeltaToken['direction'], string> = {
  up: 'text-accent',
  down: 'text-destructive',
  flat: 'text-muted-foreground',
};

/**
 * A delta in mono with its arrow: accent when the figure got better, the
 * destructive tone when it got worse, muted when flat. The direction is the
 * caller's (for low / out of stock a rise is "down").
 */
export function TrendDelta({ delta, className }: { delta: DeltaToken; className?: string }) {
  return (
    <span
      data-slot="trend-delta"
      data-direction={delta.direction}
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 font-mono text-[11.5px] tabular-nums',
        DELTA_TONE[delta.direction],
        className,
      )}
    >
      {delta.direction === 'up' && <ArrowUp aria-hidden className="size-2.5" />}
      {delta.direction === 'down' && <ArrowDown aria-hidden className="size-2.5" />}
      {delta.label}
    </span>
  );
}

// ── Shift-command quick action ──────────────────────────────────────────────

export function QuickAction({
  href,
  icon: Icon,
  label,
  badge,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  /** Optional count pill rendered before the chevron (e.g. open PO count). */
  badge?: string;
}) {
  return (
    <Link
      href={href}
      className="border-border hover:border-line-strong hover:bg-muted flex min-h-9 items-center justify-between gap-3 rounded-md border px-3 text-[13px] transition-colors max-sm:min-h-11"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon aria-hidden className="text-muted-foreground size-3.5 shrink-0" strokeWidth={1.6} />
        <span className="truncate">{label}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {badge && (
          <span
            data-slot="quick-action-count"
            className="border-line-strong bg-sunk text-ink-2 inline-flex h-[18px] min-w-5 items-center justify-center rounded-full border px-1.5 font-mono text-[11px] tabular-nums"
          >
            {badge}
          </span>
        )}
        <ChevronRight aria-hidden className="text-ink-4 size-3.5" />
      </span>
    </Link>
  );
}
