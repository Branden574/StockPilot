import {
  CheckCircle2,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';

import { cn } from '@/lib/utils';

/**
 * Shared presentational bits used by more than one dashboard widget. These
 * were previously local helpers inside dashboard/page.tsx; moved here so each
 * widget module can compose them while keeping the page a thin orchestrator.
 *
 * Nothing here fetches data — every value arrives via props.
 */

// ── Needs-attention hero ────────────────────────────────────────────────────

export interface AttentionItem {
  id: string;
  icon: LucideIcon;
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
 * Vertically-stacked attention list. Each row is a journalistic
 * "headline + dek + take a look →" so the operator can scan top-to-bottom
 * without having to parse a grid of pill counters. Renders the "all clear"
 * card when the items array is empty.
 */
export function NeedsAttentionHero({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) {
    return (
      <div className="border-border bg-card flex items-center gap-4 rounded-xl border p-5 shadow-[0_10px_34px_rgba(14,15,13,0.045)]">
        <span
          aria-hidden
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--accent)/0.16)]"
        >
          <CheckCircle2 className="h-5 w-5 text-[hsl(var(--accent-foreground))]" />
        </span>
        <div className="min-w-0">
          <div className="font-display text-[15px] font-medium tracking-[-0.01em]">
            All clear — nothing needs attention today.
          </div>
          <p className="text-[12.5px] text-[var(--ed-ink-3)]">
            No low stock, no overdue POs, no pending approvals, no open counts, no
            orders awaiting signature. The numbers below are just context.
          </p>
        </div>
      </div>
    );
  }
  return (
    <ul className="border-border bg-card divide-y divide-border overflow-hidden rounded-xl border shadow-[0_10px_34px_rgba(14,15,13,0.045)]">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <li key={item.id}>
            <Link
              href={item.href}
              className="hover:bg-muted/60 group flex items-start gap-4 px-5 py-4 transition-colors"
            >
              <span
                aria-hidden
                className={cn(
                  'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                  item.tone === 'danger' && 'bg-[hsl(var(--destructive)/0.14)]',
                  item.tone === 'warn' && 'bg-[hsl(var(--warning)/0.18)]',
                  item.tone === 'neutral' && 'bg-muted',
                )}
              >
                <Icon
                  className={cn(
                    'h-4 w-4',
                    item.tone === 'danger' && 'text-[hsl(var(--destructive))]',
                    item.tone === 'warn' && 'text-[hsl(var(--warning-foreground))]',
                    item.tone === 'neutral' && 'text-[var(--ed-ink-3)]',
                  )}
                />
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-display text-[14.5px] font-medium tracking-[-0.005em]">
                  {item.title}
                </div>
                <p className="mt-0.5 text-[12.5px] text-[var(--ed-ink-3)]">{item.detail}</p>
              </div>
              <span className="mt-1 inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-[var(--ed-ink-2)] group-hover:text-foreground">
                Take a look <ChevronRight className="h-3.5 w-3.5" />
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

// ── Trends-header status metric ─────────────────────────────────────────────

export function StatusMetric({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'good' | 'warn' | 'danger';
}) {
  return (
    <div className="border-border bg-card rounded-md border px-3 py-2.5">
      <div className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--ed-ink-4)]">
        {label}
      </div>
      <div
        className={cn(
          'mt-1 font-mono text-[18px] font-medium tabular-nums leading-none',
          // Use the standalone hue vars (`--accent`, `--warning`) not the
          // *-foreground vars — those are designed for text painted ON a
          // colored background and are near-black/near-white, which goes
          // invisible when used as standalone text on the card surface.
          tone === 'good' && 'text-[hsl(var(--accent))]',
          tone === 'warn' && 'text-[hsl(var(--warning))]',
          tone === 'danger' && 'text-[hsl(var(--destructive))]',
        )}
      >
        {value}
      </div>
    </div>
  );
}

// ── Shift-command bits ──────────────────────────────────────────────────────

export function MiniReadout({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2.5">
      <div className="font-mono text-[16px] font-medium tabular-nums leading-none">{value}</div>
      <div className="mt-1 text-[10.5px] uppercase tracking-[0.08em] text-[var(--ed-ink-4)]">
        {label}
      </div>
    </div>
  );
}

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
      className="border-border bg-background hover:bg-muted flex min-h-9 items-center justify-between gap-3 rounded-md border px-3 text-[12.5px] transition-colors hover:border-[var(--ed-line-strong)]"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--ed-ink-3)]" />
        <span className="truncate">{label}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {badge && (
          <span className="border-border bg-card text-foreground inline-flex h-5 min-w-[20px] items-center justify-center rounded-full border px-1.5 font-mono text-[10.5px] tabular-nums">
            {badge}
          </span>
        )}
        <ChevronRight className="h-3.5 w-3.5 text-[var(--ed-ink-4)]" />
      </span>
    </Link>
  );
}

// ── Card chrome (shared by value-chart, movements-breakdown, recent-activity)

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'border-border bg-card overflow-hidden rounded-lg border shadow-[0_10px_34px_rgba(14,15,13,0.045)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHead({
  title,
  subtitle,
  chips,
  action,
}: {
  title: string;
  subtitle?: string;
  chips?: string[];
  action?: React.ReactNode;
}) {
  return (
    <div className="border-border flex flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b px-5 py-3.5 sm:items-center">
      <div className="min-w-0">
        <div className="font-display text-[14px] font-medium tracking-[-0.01em]">{title}</div>
        {subtitle && <div className="text-[12px] text-[var(--ed-ink-3)]">{subtitle}</div>}
      </div>
      {chips && (
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          {chips.map((c) => (
            <span
              key={c}
              className={cn(
                'inline-flex h-6 shrink-0 items-center rounded-full border px-2.5 text-[11.5px]',
                c.startsWith('+')
                  ? 'border-border border-dashed text-[var(--ed-ink-3)]'
                  : 'border-border bg-background text-[var(--ed-ink-2)]',
              )}
            >
              {c}
            </span>
          ))}
        </div>
      )}
      {action}
    </div>
  );
}
