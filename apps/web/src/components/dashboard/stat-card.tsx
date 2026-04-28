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

export function StatCard({ label, value, delta, series, foot, icon: Icon, className }: StatCardProps) {
  const dir = delta?.direction ?? 'flat';
  return (
    <div
      className={cn(
        'flex flex-col gap-2.5 overflow-hidden rounded-[10px] border border-border bg-card px-4 py-4 transition-colors hover:border-[var(--ed-line-strong)]',
        className,
      )}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--ed-ink-4)]">
        {Icon && <Icon className="h-3 w-3 text-[var(--ed-ink-4)]" />}
        {label}
      </div>

      <div className="flex items-end justify-between gap-3">
        <p className="font-display text-[30px] font-medium leading-[1.05] tracking-[-0.025em] tabular-nums">
          {value}
        </p>
        {series && series.length > 1 && <Sparkline data={series} width={84} height={26} tone={dir} />}
      </div>

      {(foot || delta) && (
        <div className="flex items-center justify-between text-[11.5px]">
          <span className="text-[var(--ed-ink-3)]">{foot}</span>
          {delta && (
            <span
              className={cn(
                'inline-flex items-center gap-0.5 font-mono text-[11px] tabular-nums',
                dir === 'up' && 'text-[hsl(var(--accent-foreground))]',
                dir === 'down' && 'text-[hsl(var(--destructive))]',
                dir === 'flat' && 'text-[var(--ed-ink-3)]',
              )}
            >
              {dir === 'up' && <ArrowUp className="h-2.5 w-2.5" />}
              {dir === 'down' && <ArrowDown className="h-2.5 w-2.5" />}
              {delta.value}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
