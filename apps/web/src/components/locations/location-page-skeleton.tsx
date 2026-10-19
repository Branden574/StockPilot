import { Skeleton } from '@/components/ui/skeleton';

/**
 * The route skeleton for one location's page (F1-3), in the page's own
 * shape: the back link, the kind line and name, then the stock card (its
 * totals line and a few item rows) beside the open-issues card, one column on
 * a narrow screen with the open issues first, as the page draws them.
 */
export function LocationPageSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div
      className="mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7"
      aria-busy="true"
      data-testid="location-page-skeleton"
    >
      <span className="sr-only">Loading this location</span>
      <div>
        <Skeleton className="mb-2 h-4 w-24" />
        <Skeleton className="mb-1.5 h-3 w-40" />
        <div className="flex h-[42px] items-center">
          <Skeleton className="h-[26px] w-64 max-w-full" />
        </div>
      </div>
      <div className="@container min-w-0">
        <div className="@min-[856px]:grid-cols-[minmax(0,1.7fr)_minmax(280px,1fr)] grid items-start gap-4">
          <div className="border-border bg-card @min-[856px]:col-start-2 @min-[856px]:row-start-1 rounded-lg border">
            <div className="border-border border-b px-[18px] py-4">
              <Skeleton className="h-4 w-32" />
            </div>
            <div className="space-y-2 p-[18px]">
              <Skeleton className="h-3 w-72 max-w-full" />
              <Skeleton className="h-3 w-40" />
            </div>
          </div>
          <div className="border-border bg-card @min-[856px]:col-start-1 @min-[856px]:row-start-1 rounded-lg border">
            <div className="border-border flex items-center justify-between border-b px-[18px] py-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-7 w-36" />
            </div>
            <div className="border-border border-b px-[18px] py-3">
              <Skeleton className="h-4 w-96 max-w-full" />
            </div>
            <div className="divide-border divide-y">
              {Array.from({ length: rows }).map((_, i) => (
                <div key={i} className="space-y-1.5 px-[18px] py-3">
                  <div className="flex items-center justify-between gap-3">
                    <Skeleton className="h-4 w-48 max-w-[60%]" />
                    <Skeleton className="h-4 w-16" />
                  </div>
                  <Skeleton className="h-3 w-80 max-w-full" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
