'use client';

import { Check, Minus, X } from 'lucide-react';

import { useInView } from '@/lib/hooks/use-in-view';
import { cn } from '@/lib/utils';

type Cell = 'yes' | 'partial' | 'no';

interface Row {
  feature: string;
  stockpilot: Cell;
  others: Cell;
  sheets: Cell;
}

// Honest, defensible comparison. The middle column is generic ("other inventory
// apps") on purpose — naming a specific competitor with "✗" marks is legal
// exposure. "partial" = some apps have some of this. StockPilot column reflects
// what's actually shipped.
const ROWS: Row[] = [
  { feature: 'Real-time web + native mobile sync', stockpilot: 'yes', others: 'partial', sheets: 'no' },
  { feature: 'Live delivery tracking on a map', stockpilot: 'yes', others: 'no', sheets: 'no' },
  { feature: 'Lot / expiry (FEFO) tracking', stockpilot: 'yes', others: 'partial', sheets: 'no' },
  { feature: 'Purchase orders + 3-way match', stockpilot: 'yes', others: 'partial', sheets: 'no' },
  { feature: 'Audit-grade cycle counts', stockpilot: 'yes', others: 'partial', sheets: 'no' },
  { feature: 'Returns / RMA workflow', stockpilot: 'yes', others: 'no', sheets: 'no' },
  { feature: 'AI insights briefing', stockpilot: 'yes', others: 'no', sheets: 'no' },
  { feature: 'Webhooks · Slack · Teams', stockpilot: 'yes', others: 'partial', sheets: 'no' },
  { feature: 'Public API + API keys', stockpilot: 'yes', others: 'partial', sheets: 'no' },
  { feature: 'QuickBooks export', stockpilot: 'yes', others: 'yes', sheets: 'no' },
  { feature: 'Multi-tenant + role / RLS security', stockpilot: 'yes', others: 'partial', sheets: 'no' },
  { feature: 'Full audit log on every change', stockpilot: 'yes', others: 'no', sheets: 'no' },
];

function Mark({ cell }: { cell: Cell }) {
  if (cell === 'yes')
    return <Check className="mx-auto h-[18px] w-[18px] text-foreground" strokeWidth={2.4} aria-label="Yes" />;
  if (cell === 'partial')
    return <Minus className="mx-auto h-[18px] w-[18px] text-[var(--ed-ink-4)]" strokeWidth={2.2} aria-label="Partial" />;
  return <X className="mx-auto h-[16px] w-[16px] text-[var(--ed-ink-4)] opacity-50" strokeWidth={2} aria-label="No" />;
}

export function ComparisonTable() {
  const { ref, inView } = useInView<HTMLDivElement>();
  return (
    <section className="mx-auto max-w-[1280px] px-8 py-[72px]">
      <p className="mb-4 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--ed-ink-4)]">
        — How we compare
      </p>
      <h2 className="max-w-3xl font-display text-[clamp(32px,4vw,48px)] font-medium leading-[1.05] tracking-[-0.03em] text-balance">
        Everything a real operation needs.{' '}
        <span className="font-serif-italic text-[var(--ed-ink-3)]">Most tools stop short.</span>
      </h2>

      <div ref={ref} className="mt-9 overflow-hidden rounded-[12px] border border-border">
        {/* Header */}
        <div className="grid grid-cols-[1.6fr_repeat(3,minmax(72px,1fr))] items-center gap-2 border-b border-border bg-card px-4 py-3.5 sm:grid-cols-[2fr_repeat(3,minmax(96px,1fr))] sm:px-6">
          <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--ed-ink-4)]">
            Capability
          </div>
          <div className="rounded-md bg-foreground px-2 py-1 text-center text-[11px] font-semibold text-background sm:text-[12px]">
            StockPilot
          </div>
          <div className="text-center text-[11px] font-medium text-[var(--ed-ink-3)] sm:text-[12px]">
            Other apps
          </div>
          <div className="text-center text-[11px] font-medium text-[var(--ed-ink-3)] sm:text-[12px]">
            Spreadsheets
          </div>
        </div>

        {/* Rows */}
        {ROWS.map((r, i) => (
          <div
            key={r.feature}
            className={cn(
              'reveal-up grid grid-cols-[1.6fr_repeat(3,minmax(72px,1fr))] items-center gap-2 border-b border-border bg-background px-4 py-3 last:border-b-0 sm:grid-cols-[2fr_repeat(3,minmax(96px,1fr))] sm:px-6',
              inView && 'is-in',
            )}
            style={{ transitionDelay: `${Math.min(i * 35, 350)}ms` }}
          >
            <div className="text-[13px] leading-snug sm:text-[13.5px]">{r.feature}</div>
            <div className="bg-[color-mix(in_oklab,_hsl(var(--foreground))_4%,_transparent)]">
              <Mark cell={r.stockpilot} />
            </div>
            <div>
              <Mark cell={r.others} />
            </div>
            <div>
              <Mark cell={r.sheets} />
            </div>
          </div>
        ))}
      </div>

      <p className="mt-3 text-[11.5px] text-[var(--ed-ink-4)]">
        <Check className="mb-0.5 inline h-3.5 w-3.5" strokeWidth={2.4} /> included ·{' '}
        <Minus className="mb-0.5 inline h-3.5 w-3.5" strokeWidth={2.2} /> varies by app /
        tier ·{' '}
        <X className="mb-0.5 inline h-3 w-3 opacity-50" strokeWidth={2} /> not available
      </p>
    </section>
  );
}
