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
 * fill has no radius of its own: the track (overflow hidden) rounds its start
 * and its end is square, as the reference draws it (FX13). The
 * figure is still stock / par exactly as the caller computes it; there is no
 * days-of-cover label (the app has no such number). 72 x 4 by default, the
 * reference column's size; a caller can still pass its own width.
 */
export function StockBar({ stock, par, status, width = 72, className }: StockBarProps) {
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
        className={cn('block h-full', {
          'bg-[hsl(var(--accent))]': status === 'ok',
          'bg-[hsl(var(--warning))]': status === 'warn',
          'bg-[hsl(var(--destructive))]': status === 'crit',
        })}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}
