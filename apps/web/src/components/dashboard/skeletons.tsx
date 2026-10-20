import { cn } from '@/lib/utils';

/**
 * Loading skeletons in the redesign's page shapes (DESIGN-SPEC 4, 6.1, 6.8,
 * 6.9): the page container (max 1320, 28 / 32 / 64 padding, 16 px gutters on a
 * phone), the page header (a 28 px title on a 42 px line, a subline, 32 px
 * actions bottom-aligned on the right), radius-8 hairline cards and the table
 * card. They draw only grey bars: no words, no numbers, nothing to misread as
 * data, and `animate-pulse` stops under reduced motion (globals.css).
 */

/** The page area every skeleton sits in, the same box the pages use. */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

/** A card: radius 8, hairline border, the elevated surface. */
const CARD = 'border-border bg-card rounded-lg border';

function PageHeaderSkeleton({ actions = 2 }: { actions?: number }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {/* The title's 42px line box, then its 20px subline. */}
        <div className="flex h-[42px] items-center">
          <Bar w={220} h={26} />
        </div>
        <div className="mt-0.5 flex h-5 items-center">
          <Bar w={300} h={12} />
        </div>
      </div>
      <div className="flex gap-2">
        {Array.from({ length: actions }).map((_, i) => (
          <Bar key={i} w={i === actions - 1 ? 112 : 96} h={32} radius={6} />
        ))}
      </div>
    </div>
  );
}

export function PageSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn(PAGE, className)}>
      <PageHeaderSkeleton actions={3} />

      {/* Stat strip: one card, cells divided by hairlines (DESIGN-SPEC 6.8).
          The 1px gaps over the border colour draw the dividers, so a wrapped
          row never doubles a line against the card's own border. */}
      <div className={cn(CARD, 'overflow-hidden')}>
        <div className="bg-border grid grid-cols-2 gap-px lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-card space-y-2.5 px-[18px] py-4">
              <Bar w={96} h={11} />
              <Bar w={84} h={22} />
              <Bar w={120} h={10} />
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className={cn(CARD, 'lg:col-span-8')}>
          <div className="border-border flex items-center justify-between border-b px-[18px] py-3.5">
            <Bar w={160} h={13} />
            <Bar w={72} h={11} />
          </div>
          <div className="p-[18px]">
            <Bar w="100%" h={240} radius={6} />
          </div>
        </div>
        <div className={cn(CARD, 'lg:col-span-4')}>
          <div className="border-border border-b px-[18px] py-3.5">
            <Bar w={140} h={13} />
          </div>
          {/* Key-value rows, 9 x 18 (DESIGN-SPEC 6.7). */}
          <div className="divide-border divide-y">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between gap-3 px-[18px] py-[11px]">
                <Bar w={80} h={11} />
                <Bar w={96} h={11} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function TablePageSkeleton({ rows = 8, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn(PAGE, className)}>
      <PageHeaderSkeleton />
      {/* The toolbar: a segmented track on the left, the search and filter
          triggers on the right, wrapping on a narrow screen. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="bg-sunk flex h-9 items-center gap-1 rounded-lg p-[3px]">
          {[72, 88, 80].map((w, i) => (
            <Bar key={i} w={w} h={28} radius={5} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Bar w={240} h={32} radius={6} />
          {Array.from({ length: 3 }).map((_, i) => (
            <Bar key={i} w={92} h={32} radius={6} />
          ))}
        </div>
      </div>
      <TableBodySkeleton rows={rows} />
    </div>
  );
}

/**
 * Just the table card of TablePageSkeleton (no header or toolbar). Used as the
 * <Suspense fallback> for a streamed data table (staging, categories) so the
 * page chrome paints immediately while only the rows stream in. Rows and the
 * column grid mirror TablePageSkeleton so the in-page fallback matches the
 * full-page skeleton. Items and Books do not use it: they reveal once (see
 * their pages).
 *
 * The body rows pad by var(--row-py), so a compact viewer's skeleton is as
 * tall as their table. Each body row carries its column template inline and
 * the header row does not: the late-skeleton and loading tests count rows by
 * that inline style.
 */
export function TableBodySkeleton({ rows = 8, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn(CARD, 'overflow-hidden', className)}>
      <div className="min-w-[720px]">
        {/* Header: 11px uppercase labels on a 37px row. Same columns as the
            body rows below, written as a class so it is not counted as one. */}
        <div className="border-border grid h-[37px] grid-cols-[36px_minmax(0,2.4fr)_1fr_1fr_72px_96px_96px_72px] items-center gap-3 border-b pl-4 pr-4">
          <span />
          {[48, 64, 60, 48, 56, 44, 52].map((w, i) => (
            <Bar key={i} w={w} h={8} />
          ))}
        </div>
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="border-border grid items-center gap-3 border-b pl-4 pr-4 last:border-0"
            style={{
              gridTemplateColumns: '36px minmax(0,2.4fr) 1fr 1fr 72px 96px 96px 72px',
              paddingTop: 'var(--row-py, 11px)',
              paddingBottom: 'var(--row-py, 11px)',
            }}
          >
            {/* The row checkbox: the owner-tested 20px box, radius 5. */}
            <Bar w={20} h={20} radius={5} />
            <div className="flex min-w-0 items-center gap-3">
              <Bar w={34} h={34} radius={6} />
              <div className="min-w-0 space-y-1.5">
                <Bar w={150} h={12} />
                <Bar w={84} h={10} />
              </div>
            </div>
            <Bar w={88} h={11} />
            <Bar w={72} h={11} />
            <div className="flex justify-end">
              <Bar w={36} h={12} />
            </div>
            <Bar w={72} h={4} radius={2} />
            <Bar w={72} h={20} radius={999} />
            <div className="flex justify-end">
              <Bar w={44} h={11} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Bar({ w, h, radius = 4 }: { w: number | string; h: number; radius?: number }) {
  return (
    <div
      className="bg-muted max-w-full shrink-0 animate-pulse"
      style={{
        width: typeof w === 'number' ? `${w}px` : w,
        height: h,
        borderRadius: radius,
      }}
    />
  );
}
