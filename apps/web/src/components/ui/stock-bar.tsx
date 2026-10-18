import { cn } from '@/lib/utils';

interface StockBarProps {
  stock: number;
  par: number;
  status: 'ok' | 'warn' | 'crit';
  width?: number;
  className?: string;
}

/**
 * Stock against par, drawn in the coverage-bar look (DESIGN-SPEC 6.11): a 4 px
 * track in the stronger hairline, radius 2, filled in the status colour. The
 * figure is still stock / par exactly as the caller computes it; there is no
 * days-of-cover label (the app has no such number). The reference column draws
 * it 72 wide: callers pass width={72} where their layout takes it (the default
 * stays 80 because the Items table tests find the bar by that width).
 */
export function StockBar({ stock, par, status, width = 80, className }: StockBarProps) {
  const pct = par > 0 ? Math.min(100, Math.max(0, (stock / par) * 100)) : 0;
  return (
    <span
      className={cn(
        'inline-block overflow-hidden rounded-[2px] bg-[var(--ed-line-strong)] align-middle',
        className,
      )}
      style={{ width, height: 4 }}
    >
      <span
        className={cn('block h-full rounded-[2px]', {
          'bg-[hsl(var(--accent))]': status === 'ok',
          'bg-[hsl(var(--warning))]': status === 'warn',
          'bg-[hsl(var(--destructive))]': status === 'crit',
        })}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}
