import { cn } from '@/lib/utils';

/**
 * How far through its lines a count is, drawn as the reference's count
 * progress (DESIGN-SPEC 6.11): a 4 px track in the stronger hairline, radius 2,
 * filled in the accent. It only pictures figures the page already prints next
 * to it ("x of y counted"), so it is hidden from assistive technology and adds
 * no number of its own.
 */
export function CountProgressBar({
  counted,
  total,
  className,
}: {
  counted: number;
  total: number;
  className?: string;
}) {
  const pct = total > 0 ? Math.min(100, Math.max(0, (counted / total) * 100)) : 0;
  return (
    <span
      aria-hidden
      data-slot="count-progress"
      className={cn('bg-line-strong block h-1 overflow-hidden rounded-[2px]', className)}
    >
      <span className="bg-accent block h-full rounded-[2px]" style={{ width: `${pct}%` }} />
    </span>
  );
}
