import { Skeleton } from '@/components/ui/skeleton';

/** A titled card's header (DESIGN-SPEC 6.7): 49 px, the title's bar on the
 *  left, `width` its Tailwind width class. */
function CardHeader({ width }: { width: string }) {
  return (
    <div className="border-border flex min-h-[49px] items-center border-b px-[18px]">
      <Skeleton className={`h-3.5 ${width}`} />
    </div>
  );
}

/**
 * The route skeleton for one warehouse's page (the section has no index page,
 * so warehouses/loading.tsx only ever covers /dashboard/warehouses/[id]), in
 * the page's own shape: the back link, the name with its code chip and status,
 * Updated, Edit and New order from here on the right; the four-figure stat
 * strip; Address & contact beside Manager once the content holds two cards;
 * then Charters serviced with a few rows. Grey bars only: no words or numbers
 * to misread as data.
 */
export function WarehousePageSkeleton() {
  return (
    <div
      className="mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7"
      aria-busy="true"
      data-testid="warehouse-page-skeleton"
    >
      <span className="sr-only">Loading this warehouse</span>
      <div>
        <div className="mb-2 flex h-5 items-center">
          <Skeleton className="h-3 w-36" />
        </div>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <div className="flex h-[42px] items-center gap-3">
              <Skeleton className="h-[26px] w-48 max-w-[50vw]" />
              <Skeleton className="h-5 w-12" />
              <Skeleton className="h-5 w-14 rounded-full" />
            </div>
            <div className="mt-0.5 flex h-5 items-center">
              <Skeleton className="h-3 w-32" />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Skeleton className="h-8 w-14" />
            <Skeleton className="h-8 w-44" />
          </div>
        </div>
      </div>
      <div className="border-border bg-card overflow-hidden rounded-lg border">
        <div className="[&>*]:border-border -mb-px -mr-px grid grid-cols-[repeat(auto-fit,minmax(min(100%,150px),1fr))] [&>*:last-child]:border-r-0 [&>*]:border-b [&>*]:border-r">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              data-testid="warehouse-skeleton-stat"
              className="space-y-2.5 px-[18px] py-3.5"
            >
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-6 w-16" />
              <Skeleton className="h-2.5 w-36 max-w-full" />
            </div>
          ))}
        </div>
      </div>
      <div className="@container min-w-0">
        <div className="@min-[856px]:grid-cols-2 grid items-start gap-4">
          <div
            data-testid="warehouse-skeleton-card"
            className="border-border bg-card rounded-lg border"
          >
            <CardHeader width="w-32" />
            <div className="space-y-2 p-[18px]">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-3.5 w-48" />
              <Skeleton className="h-3.5 w-10" />
              <div className="border-border mt-3 space-y-2 border-t pt-3">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-3 w-40" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
          </div>
          <div
            data-testid="warehouse-skeleton-card"
            className="border-border bg-card rounded-lg border"
          >
            <CardHeader width="w-20" />
            <div className="flex items-start gap-3 p-[18px]">
              <Skeleton className="size-9 shrink-0 rounded-full" />
              <div className="min-w-0 space-y-2">
                <Skeleton className="h-3.5 w-36" />
                <Skeleton className="h-3 w-44 max-w-full" />
              </div>
            </div>
          </div>
        </div>
      </div>
      <div
        data-testid="warehouse-skeleton-card"
        className="border-border bg-card rounded-lg border"
      >
        <CardHeader width="w-36" />
        <div className="divide-border divide-y">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between gap-3 px-[18px] py-[13px]">
              <Skeleton className="h-3.5 w-48 max-w-[60%]" />
              <Skeleton className="h-3 w-10" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
