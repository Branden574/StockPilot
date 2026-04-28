import { cn } from '@/lib/utils';

interface StockBarProps {
  stock: number;
  par: number;
  status: 'ok' | 'warn' | 'crit';
  width?: number;
  className?: string;
}

export function StockBar({ stock, par, status, width = 80, className }: StockBarProps) {
  const pct = par > 0 ? Math.min(100, Math.max(0, (stock / par) * 100)) : 0;
  return (
    <span
      className={cn('inline-block align-middle overflow-hidden rounded-full bg-muted', className)}
      style={{ width, height: 6 }}
    >
      <span
        className={cn('block h-full rounded-full', {
          'bg-[hsl(var(--accent))]': status === 'ok',
          'bg-[hsl(var(--warning))]': status === 'warn',
          'bg-[hsl(var(--destructive))]': status === 'crit',
        })}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}
