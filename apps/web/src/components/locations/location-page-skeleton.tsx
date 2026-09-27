import { Skeleton } from '@/components/ui/skeleton';

/**
 * The route skeleton for one location's page (F1-3), in the page's own
 * shape: the back link, the kind line and name, the open-issues panel, and
 * the stock card with its totals line and a few item rows.
 */
export function LocationPageSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div
      className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8"
      aria-busy="true"
      data-testid="location-page-skeleton"
    >
      <span className="sr-only">Loading this location</span>
      <Skeleton className="mb-4 h-4 w-24" />
      <div className="mb-6 space-y-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-64" />
      </div>
      <div className="border-border bg-card mb-6 space-y-2 rounded-xl border px-4 py-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-72 max-w-full" />
      </div>
      <div className="border-border bg-card rounded-xl border">
        <div className="space-y-2 p-6 pb-3">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <div className="divide-border divide-y px-6 pb-4">
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="space-y-1.5 py-3">
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
  );
}
