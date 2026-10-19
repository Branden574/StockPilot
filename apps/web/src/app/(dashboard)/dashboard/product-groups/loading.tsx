import { Skeleton } from '@/components/ui/skeleton';

/** The page area every redesigned page draws (DESIGN-SPEC 4 and 5.3). */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

/** Per-section loading UI — the app-wide nav perf convention: every dashboard
 *  section streams its own skeleton rather than blocking the shell. It draws
 *  the page as it lands (the shared page header, then one card of group rows,
 *  each a chevron, a name, an identity line and the roll-up on the right) in
 *  grey bars only: no words and no numbers. */
export default function ProductGroupsLoading() {
  return (
    <div className={PAGE} aria-busy="true">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="flex h-[42px] items-center">
            <Skeleton className="h-[26px] w-[220px] max-w-full" />
          </div>
          <div className="mt-0.5 flex h-5 items-center">
            <Skeleton className="h-3 w-[360px] max-w-full" />
          </div>
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-[112px]" />
          <Skeleton className="h-8 w-[184px]" />
        </div>
      </div>
      <div className="border-border bg-card divide-border divide-y overflow-hidden rounded-lg border">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="h-6 w-6 shrink-0" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3.5 w-[200px] max-w-full" />
              <Skeleton className="h-3 w-[140px] max-w-full" />
            </div>
            <div className="hidden shrink-0 space-y-2 sm:block">
              <Skeleton className="ml-auto h-3.5 w-[150px]" />
              <Skeleton className="ml-auto h-3 w-[180px]" />
            </div>
            <Skeleton className="h-7 w-[64px] shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}
