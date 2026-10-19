import { TableBodySkeleton } from '@/components/dashboard/skeletons';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The Team page's own shape while it loads: the page header with its one
 * action, then the Members card (its 49 px header and the table rows), in
 * the same page box as the page. Grey bars only.
 */
export default function TeamLoading() {
  return (
    <div
      aria-busy="true"
      className="mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7"
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="flex h-[42px] items-center">
            <Skeleton className="h-[26px] w-32" />
          </div>
          <Skeleton className="mt-1 h-3 w-72 max-w-full" />
        </div>
        <Skeleton className="h-8 w-32" />
      </div>
      <div className="border-border bg-card overflow-hidden rounded-lg border">
        <div className="border-border flex min-h-[49px] items-center border-b px-[18px]">
          <Skeleton className="h-3.5 w-28" />
        </div>
        <TableBodySkeleton rows={6} className="rounded-none border-0" />
      </div>
    </div>
  );
}
