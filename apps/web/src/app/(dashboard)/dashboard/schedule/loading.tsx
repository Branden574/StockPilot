import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * The team calendar's own shape while it loads: the page header, the month
 * toolbar and the 7 x 6 month grid, in the same page box as the page, so the
 * reveal does not jump. Grey bars only: no words, no numbers.
 */
export default function ScheduleLoading() {
  return (
    <div
      aria-busy="true"
      className="mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7"
    >
      <div className="min-w-0">
        <Skeleton className="h-3 w-40" />
        <div className="mt-2 flex h-[42px] items-center">
          <Skeleton className="h-[26px] w-56" />
        </div>
        <Skeleton className="mt-1 h-3 w-full max-w-xl" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <Skeleton className="h-8 w-8" />
          <Skeleton className="h-8 w-8" />
          <Skeleton className="ml-1 h-7 w-14" />
        </div>
        <Skeleton className="h-5 w-36" />
        <Skeleton className="h-8 w-28" />
      </div>
      <div className="border-border bg-card overflow-hidden rounded-lg border">
        <div className="overflow-x-auto">
          <div className="min-w-[640px]">
            <div className="border-border bg-sunk grid h-[37px] grid-cols-7 items-center border-b">
              {Array.from({ length: 7 }).map((_, i) => (
                <Skeleton key={i} className="mx-auto h-2 w-8" />
              ))}
            </div>
            <div className="grid grid-cols-7">
              {Array.from({ length: 42 }).map((_, i) => (
                <div
                  key={i}
                  className={cn(
                    'border-border min-h-[112px] border-b border-r p-1.5',
                    i % 7 === 6 && 'border-r-0',
                    i >= 35 && 'border-b-0',
                  )}
                >
                  <Skeleton className="h-4 w-5" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
