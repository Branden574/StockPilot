import { Skeleton } from '@/components/ui/skeleton';

/**
 * The Zendesk page's own shape while it loads: the logo and heading, then the
 * Connection and "Open your Zendesk" cards, in the same page box as the page.
 * Grey bars only: no words.
 */
export default function ZendeskLoading() {
  return (
    <div
      aria-busy="true"
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7"
    >
      <div className="flex items-center gap-4">
        <Skeleton className="size-11 rounded-lg" />
        <div className="min-w-0">
          <div className="flex h-[42px] items-center">
            <Skeleton className="h-[26px] w-36" />
          </div>
          <Skeleton className="mt-1 h-3 w-28" />
        </div>
      </div>
      {[3, 2].map((lines, i) => (
        <div key={i} className="border-border bg-card overflow-hidden rounded-lg border">
          <div className="border-border flex min-h-[49px] items-center border-b px-[18px]">
            <Skeleton className="h-3.5 w-32" />
          </div>
          <div className="space-y-3 p-[18px]">
            {Array.from({ length: lines }).map((_, j) => (
              <Skeleton key={j} className={j === 0 ? 'h-3 w-3/4' : 'h-8 w-40'} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
