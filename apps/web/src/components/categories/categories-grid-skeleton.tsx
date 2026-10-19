import { Skeleton } from '@/components/ui/skeleton';

/**
 * The category cards while the list streams (and on the route's skeleton): a
 * grid of hairline cards, each with its colour dot, name and description bars.
 * Grey bars only: no words or numbers to misread as data.
 */
export function CategoriesGridSkeleton({ cards = 6 }: { cards?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
      <span className="sr-only">Loading categories</span>
      {Array.from({ length: cards }).map((_, i) => (
        <div
          key={i}
          className="border-border bg-card flex min-h-[76px] items-start gap-3 rounded-lg border p-4"
        >
          <Skeleton className="mt-1 h-2.5 w-2.5 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-32 max-w-full" />
            <Skeleton className="h-3 w-48 max-w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** The whole route's skeleton: the header's shape, then the card grid. */
export function CategoriesPageSkeleton() {
  return (
    <div
      className="mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7"
      data-testid="categories-page-skeleton"
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="flex h-[42px] items-center">
            <Skeleton className="h-[26px] w-40" />
          </div>
          <div className="mt-0.5 flex h-5 items-center">
            <Skeleton className="h-3 w-72 max-w-[70vw]" />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-8 w-36" />
          <Skeleton className="h-8 w-32" />
        </div>
      </div>
      <CategoriesGridSkeleton />
    </div>
  );
}
