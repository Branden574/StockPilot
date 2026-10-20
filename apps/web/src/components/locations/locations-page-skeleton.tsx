import { Skeleton } from '@/components/ui/skeleton';

/** The table's columns: Name, Type, Warehouse, Notes and the actions. */
const COLUMNS = 'grid-cols-[minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1.4fr)_88px]';

/**
 * The Locations route's skeleton in the list's own shape: the shared header
 * (a 28 px title on its 42 px line, the subline, the Active / Archived toggle
 * and New location on the right), the Sites / Racks & shelves / System track,
 * then the table card with a header row and one row per location. Grey bars
 * only: no words or numbers to misread as data.
 */
export function LocationsPageSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div
      className="mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7"
      aria-busy="true"
      data-testid="locations-page-skeleton"
    >
      <span className="sr-only">Loading locations</span>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="flex h-[42px] items-center">
            <Skeleton className="h-[26px] w-36" />
          </div>
          <div className="mt-0.5 flex h-5 items-center">
            <Skeleton className="h-3 w-[400px] max-w-[70vw]" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-9 w-32 rounded-lg" />
          <Skeleton className="h-8 w-32" />
        </div>
      </div>
      <div
        data-testid="locations-skeleton-groups"
        className="border-border bg-sunk flex h-9 w-fit max-w-full items-center gap-0.5 rounded-lg border p-[3px]"
      >
        <Skeleton className="h-7 w-16 rounded-[5px]" />
        <Skeleton className="h-7 w-32 rounded-[5px]" />
        <Skeleton className="h-7 w-20 rounded-[5px]" />
      </div>
      <div className="border-border bg-card overflow-hidden rounded-lg border">
        <div className="min-w-[640px]">
          <div
            className={`border-border grid h-[37px] items-center gap-3 border-b px-4 ${COLUMNS}`}
          >
            <Skeleton className="h-2 w-12" />
            <Skeleton className="h-2 w-10" />
            <Skeleton className="h-2 w-16" />
            <Skeleton className="h-2 w-12" />
            <Skeleton className="h-2 w-14 justify-self-end" />
          </div>
          {Array.from({ length: rows }).map((_, i) => (
            <div
              key={i}
              data-testid="locations-skeleton-row"
              className={`border-border grid min-h-[55px] items-center gap-3 border-b px-4 last:border-0 ${COLUMNS}`}
            >
              <Skeleton className="h-3.5 w-36 max-w-full" />
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-40 max-w-full" />
              <div className="flex items-center justify-end gap-2">
                <Skeleton className="h-8 w-11" />
                <Skeleton className="h-8 w-8" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
