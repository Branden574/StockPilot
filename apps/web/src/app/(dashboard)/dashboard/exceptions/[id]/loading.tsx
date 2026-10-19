import { Skeleton } from '@/components/ui/skeleton';

/**
 * The occurrence page's own skeleton, in the page's final shape: the back
 * link, the header (title, the reference line, the detail, the state chips),
 * then the main column of cards beside the side rail of label / value rows,
 * in one column on a narrow screen. Grey bars only: no words, nothing to
 * misread as data. The Exceptions list keeps relying on the late skeleton
 * (lib/navigation/route-skeletons.ts maps only the list path to 'page'), so
 * this boundary covers the detail alone.
 */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';
const CARD = 'border-border bg-card min-w-0 overflow-hidden rounded-lg border';

function CardSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className={CARD}>
      <div className="border-border flex h-[49px] items-center border-b px-[18px]">
        <Skeleton className="h-3 w-40" />
      </div>
      <div className="space-y-2.5 p-[18px]">
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} className={i === lines - 1 ? 'h-3 w-2/3' : 'h-3 w-full'} />
        ))}
      </div>
    </div>
  );
}

export default function ExceptionDetailLoading() {
  return (
    <div className={PAGE} aria-busy="true">
      <Skeleton className="h-3.5 w-24" />
      <div className="space-y-2.5">
        <Skeleton className="h-7 w-72 max-w-full" />
        <Skeleton className="h-3 w-48" />
        <Skeleton className="h-3.5 w-[420px] max-w-full" />
        <div className="flex gap-1.5">
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-5 w-24 rounded-full" />
        </div>
      </div>
      <div className="@container min-w-0">
        <div className="@min-[856px]:grid-cols-[minmax(0,1.7fr)_minmax(280px,1fr)] grid items-start gap-4">
          <div className="flex min-w-0 flex-col gap-4">
            <CardSkeleton lines={4} />
            <CardSkeleton lines={3} />
            <CardSkeleton lines={5} />
          </div>
          <div className={CARD}>
            <div className="divide-border divide-y">
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between gap-3 px-[18px] py-[11px]"
                >
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-3 w-28" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
