import { cn } from '@/lib/utils';

/** A loading placeholder: radius 6 in the hairline tone, which reads on both the
 *  page and the card surface in either theme (the hover fill was nearly
 *  invisible on the dark card). */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('animate-pulse rounded-md bg-[var(--ed-line)]', className)} {...props} />
  );
}
