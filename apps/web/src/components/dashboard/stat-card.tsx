import { ArrowDown, ArrowUp, type LucideIcon } from 'lucide-react';

import { Sparkline } from '@/components/ui/sparkline';
import { cn } from '@/lib/utils';

interface StatCardProps {
  label: string;
  value: string | number;
  delta?: { value: string; direction?: 'up' | 'down' | 'flat' };
  series?: number[];
  foot?: string;
  icon?: LucideIcon;
  className?: string;
}

/**
 * One figure in its own card (Overview stat row, purchase orders, warehouse
 * detail), drawn as a cell of the reference's stat strip (DESIGN-SPEC 6.8):
 * a flat hairline card, the label quiet at 12.5, the figure in Inter Tight
 * 24 / 500, the foot line at 12, and the delta in mono, accent when it rises
 * and destructive when it falls. Props and every consumer are unchanged.
 *
 * Label and figure stack from the top like a strip cell (106.75 px with a
 * foot line) and the foot sits at the bottom, so in a row of cards the
 * figures line up even when one foot wraps to two lines or a card has none.
 * The figure keeps every digit: the sparkline beside it narrows first, and
 * the figure only ends in an ellipsis when it alone is wider than the card.
 */
export function StatCard({
  label,
  value,
  delta,
  series,
  foot,
  icon: Icon,
  className,
}: StatCardProps) {
  const dir = delta?.direction ?? 'flat';
  return (
    <div
      className={cn(
        'border-border bg-card flex min-h-[106px] min-w-0 flex-col overflow-hidden rounded-lg border px-[18px] py-4',
        className,
      )}
    >
      <div className="text-muted-foreground flex items-center gap-1.5 text-[12.5px] leading-[18.75px]">
        {Icon && <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" strokeWidth={1.6} />}
        {label}
      </div>

      <div className="flex min-w-0 items-end justify-between gap-3">
        <p className="text-foreground max-w-full shrink-0 truncate text-[24px] font-medium tabular-nums leading-9 tracking-[-0.02em] [font-family:var(--font-display)]">
          {value}
        </p>
        {series && series.length > 1 && (
          <Sparkline data={series} width={72} height={22} tone={dir} className="min-w-0 shrink" />
        )}
      </div>

      {(foot || delta) && (
        <div className="mt-auto flex items-center justify-between gap-2 text-[12px] leading-[18px]">
          <span className="text-muted-foreground min-w-0">{foot}</span>
          {delta && (
            <span
              className={cn(
                'inline-flex shrink-0 items-center gap-0.5 font-mono text-[11.5px] tabular-nums',
                dir === 'up' && 'text-accent',
                dir === 'down' && 'text-destructive',
                dir === 'flat' && 'text-muted-foreground',
              )}
            >
              {dir === 'up' && <ArrowUp aria-hidden className="h-2.5 w-2.5" />}
              {dir === 'down' && <ArrowDown aria-hidden className="h-2.5 w-2.5" />}
              {delta.value}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
