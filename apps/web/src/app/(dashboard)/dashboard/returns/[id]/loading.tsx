import { cn } from '@/lib/utils';

/**
 * The workbench's own skeleton (returns RX-1), in the workbench's shape so
 * nothing jumps when it arrives: the back link, the RMA number with its three
 * badges and the "Against order" line, the next-step bar, one RETURNING card
 * (the photo, the line, the disposition and destination choices) and the
 * history card, in the same 1040 px column. A route with its own loading.tsx
 * stays out of lib/navigation/route-skeletons.ts (the late-skeleton guard
 * refuses an entry that would stack on it).
 *
 * The bars follow the shared skeletons' recipe (components/dashboard/
 * skeletons.tsx, whose Bar is not exported): grey bars only, no words or
 * numbers to misread as data, and `animate-pulse` stops under reduced motion
 * (globals.css).
 */

/** The page area every skeleton and page sits in. */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

/** A card: radius 8, hairline border, the elevated surface. */
const CARD = 'border-border bg-card overflow-hidden rounded-lg border';

function Bar({
  w,
  h,
  radius = 4,
  className,
}: {
  w?: number | string;
  h?: number;
  radius?: number;
  className?: string;
}) {
  return (
    <div
      className={cn('bg-muted max-w-full shrink-0 animate-pulse', className)}
      style={{
        ...(w === undefined ? {} : { width: typeof w === 'number' ? `${w}px` : w }),
        ...(h === undefined ? {} : { height: h }),
        borderRadius: radius,
      }}
    />
  );
}

export default function ReturnWorkbenchLoading() {
  return (
    <div className={PAGE}>
      <div className="flex w-full max-w-[1040px] flex-col gap-4">
        {/* The header: the back link, the 28 px RMA number on its 42 px line
            beside its status, type and source badges, then the order line. */}
        <div className="min-w-0" data-slot="workbench-loading-header">
          <div className="mb-2 flex h-5 items-center">
            <Bar w={112} h={12} />
          </div>
          <div className="flex min-h-[42px] flex-wrap items-center gap-x-3 gap-y-1">
            <Bar w={280} h={26} />
            <div className="flex flex-wrap items-center gap-1.5">
              <Bar w={76} h={20} radius={999} />
              <Bar w={56} h={20} radius={999} />
              <Bar w={150} h={20} radius={999} />
            </div>
          </div>
          <div className="mt-0.5 flex h-5 items-center">
            <Bar w={300} h={12} />
          </div>
        </div>

        {/* The next-step bar: the ink primary and the secondaries on one
            wrapping row, "The item is here" at its end. */}
        <div className={cn(CARD, 'px-[18px] py-3.5')} data-slot="workbench-loading-next-step">
          <div className="flex flex-wrap items-center gap-2">
            <Bar w={124} h={32} radius={6} />
            <Bar w={64} h={32} radius={6} />
            <Bar w={112} h={32} radius={6} />
            <div className="flex min-w-0 items-start gap-2.5 sm:ml-auto">
              <Bar w={36} h={20} radius={999} />
              <div className="space-y-1.5 pt-0.5">
                <Bar w={110} h={12} />
                <Bar w={230} h={10} />
              </div>
            </div>
          </div>
        </div>

        {/* RETURNING: its label, then one returned line's card. */}
        <div className="space-y-2.5">
          <div className="flex h-[20.5px] items-end">
            <Bar w={72} h={9} />
          </div>
          <div
            className={cn(
              CARD,
              'grid grid-cols-[64px_minmax(0,1fr)] gap-4 p-4 sm:grid-cols-[96px_minmax(0,1fr)]',
            )}
            data-slot="workbench-loading-returning"
          >
            <Bar radius={8} className="size-16 sm:size-24" />
            <div className="min-w-0 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-2">
                  <Bar w={180} h={14} />
                  <Bar w={120} h={11} />
                  <Bar w={96} h={12} />
                </div>
                <Bar w={64} h={20} radius={999} />
              </div>
              <div className="space-y-2">
                <Bar w={120} h={9} />
                <div className="flex flex-wrap gap-2">
                  <Bar w={100} h={36} radius={6} />
                  <Bar w={84} h={36} radius={6} />
                </div>
              </div>
              <div className="space-y-2">
                <Bar w={160} h={9} />
                <Bar w="100%" h={38} radius={6} />
                <Bar w="100%" h={38} radius={6} />
              </div>
            </div>
          </div>
        </div>

        {/* History: the card header, then activity rows (what happened on the
            left, when on the right). */}
        <div className={CARD} data-slot="workbench-loading-history">
          <div className="border-border flex min-h-[49px] items-center border-b px-[18px]">
            <Bar w={64} h={13} />
          </div>
          {[260, 180, 220].map((w, i) => (
            <div
              key={i}
              className="border-border flex items-center justify-between gap-4 border-b px-[18px] py-3 last:border-b-0"
            >
              <Bar w={w} h={12} />
              <Bar w={72} h={10} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
