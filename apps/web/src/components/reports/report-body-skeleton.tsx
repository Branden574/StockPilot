import { Skeleton } from '@/components/ui/skeleton';

/**
 * Fallback for a report page's data-dependent body while its (potentially large)
 * DB scan runs. The page's static header streams immediately and this skeleton
 * holds the place of the stat cards + tables until the data resolves. (P14)
 */
export function ReportBodySkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading report data">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="bg-card border-border rounded-md border px-4 py-3">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-6 w-28" />
          </div>
        ))}
      </div>
      <div className="border-border rounded-md border">
        <div className="border-border border-b px-4 py-3">
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="space-y-3 p-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
