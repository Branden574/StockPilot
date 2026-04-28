import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

interface StatCardProps {
  label: string;
  value: string | number;
  delta?: { value: string; positive?: boolean };
  icon?: LucideIcon;
  className?: string;
}

export function StatCard({ label, value, delta, icon: Icon, className }: StatCardProps) {
  return (
    <div
      className={cn(
        'rounded-xl border bg-card p-5 shadow-sm transition-shadow hover:shadow-md',
        className,
      )}
    >
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
        {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
      {delta && (
        <p
          className={cn(
            'mt-1 text-xs font-medium',
            delta.positive === false ? 'text-destructive' : 'text-success',
          )}
        >
          {delta.value}
        </p>
      )}
    </div>
  );
}
