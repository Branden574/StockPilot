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
        'border-border bg-card flex min-h-[136px] flex-col justify-between gap-3 overflow-hidden rounded-lg border px-4 py-4 shadow-[0_10px_34px_rgba(14,15,13,0.04)] transition-colors hover:border-[var(--ed-line-strong)]',
        className,
      )}
    >
      <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--ed-ink-4)]">
        {Icon && <Icon className="h-3 w-3 text-[var(--ed-ink-4)]" />}
        {label}
      </div>

      <div className="flex min-w-0 items-end justify-between gap-3">
        <p className="font-display min-w-0 truncate text-[32px] font-medium tabular-nums leading-[1.05] tracking-[-0.025em]">
          {value}
        </p>
        {series && series.length > 1 && (
          <Sparkline data={series} width={84} height={26} tone={dir} />
        )}
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
