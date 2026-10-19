import { Skeleton } from '@/components/ui/skeleton';

/**
 * The Tags route's skeleton in the page's own shape: the shared header (a
 * 28 px title on its 42 px line, the subline, New tag on the right) and the
 * list card, one row per tag with its colour dot, name and usage count. Grey
 * bars only: no words or numbers to misread as data.
 */
export function TagsPageSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div
      className="mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7"
      aria-busy="true"
      data-testid="tags-page-skeleton"
    >
      <span className="sr-only">Loading tags</span>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="flex h-[42px] items-center">
            <Skeleton className="h-[26px] w-28" />
          </div>
          <div className="mt-0.5 flex h-5 items-center">
            <Skeleton className="h-3 w-[420px] max-w-[70vw]" />
          </div>
        </div>
        <Skeleton className="h-8 w-24" />
      </div>
      <div className="border-border bg-card divide-border divide-y overflow-hidden rounded-lg border">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex min-h-[52px] items-center gap-3 px-[18px] py-2">
            <Skeleton className="h-2.5 w-2.5 rounded-full" />
            <Skeleton className="h-3.5 w-40 max-w-[50%]" />
            <span className="flex-1" />
            <Skeleton className="h-3 w-14" />
          </div>
        ))}
      </div>
    </div>
  );
}
