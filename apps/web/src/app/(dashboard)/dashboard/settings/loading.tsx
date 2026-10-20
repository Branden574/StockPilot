import { Skeleton } from '@/components/ui/skeleton';

/**
 * Settings pages while they load, in their own shape (it used to be the
 * dashboard's stat-and-chart skeleton): the settings column, a page header
 * and two settings panels, each a 14 x 18 header over form rows. It renders
 * inside the settings layout, so the sub-nav stays put beside or above it.
 * Grey bars only: no words or numbers to misread as data.
 */
export default function SettingsLoading() {
  return (
    <div className="flex w-full max-w-[944px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
      <div className="min-w-0">
        <div className="flex h-[42px] items-center">
          <Skeleton className="h-[26px] w-[200px]" />
        </div>
        <div className="mt-0.5 flex h-5 items-center">
          <Skeleton className="h-3 w-[300px] max-w-full" />
        </div>
      </div>
      {[3, 2].map((rows, panel) => (
        <div key={panel} className="bg-card rounded-lg border">
          <div className="border-border space-y-2 border-b px-[18px] py-3.5">
            <Skeleton className="h-3.5 w-[140px]" />
            <Skeleton className="h-3 w-[320px] max-w-full" />
          </div>
          <div className="space-y-4 p-[18px]">
            {Array.from({ length: rows }).map((_, row) => (
              <div key={row} className="space-y-2">
                <Skeleton className="h-3 w-[120px]" />
                <Skeleton className="h-8 w-full" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
