import { Skeleton } from '@/components/ui/skeleton';

/**
 * Fallback for a report page's data-dependent body while its (potentially large)
 * DB scan runs. The page's static header streams immediately and this skeleton
 * holds the place of the stat cards + tables until the data resolves. (P14)
 *
 * It draws the report body's own shape: the stat strip (three cells in one
 * card, DESIGN-SPEC 6.8) and a table card with its 49 px header and rows, so
 * nothing jumps when the figures arrive.
 */
export function ReportBodySkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading report data">
      <div className="border-border bg-card grid grid-cols-1 overflow-hidden rounded-lg border sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="border-border border-b px-[18px] py-4 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0"
          >
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-3 h-6 w-28" />
          </div>
        ))}
      </div>
      <div className="border-border bg-card overflow-hidden rounded-lg border">
        <div className="border-border flex h-[49px] items-center border-b px-[18px]">
          <Skeleton className="h-3.5 w-40" />
        </div>
        <div className="divide-border divide-y">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="px-4 py-3">
              <Skeleton className="h-4 w-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
