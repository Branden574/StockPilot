import { cn } from '@/lib/utils';

/**
 * The Returns list while its page of RMAs loads, in the page's own shape so
 * nothing jumps when it arrives: the header (the title and its two-line
 * explanation), the search, the nine filter chips, and the table card (RMA,
 * Order, Type, Requester, Returning, Status, Created). The page area and the
 * bars follow the shared skeletons' recipe (components/dashboard/
 * skeletons.tsx, whose Bar is not exported): grey bars only, no words or
 * numbers to misread as data, and `animate-pulse` stops under reduced motion
 * (globals.css). On a phone the search and the chips are 44 px, as they are.
 */

/** The page area every skeleton and page sits in. */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

/** The table's columns: RMA, Order, Type, Requester, Returning, Status, Created. */
const COLUMNS =
  'minmax(150px,1.2fr) 96px minmax(110px,0.9fr) minmax(100px,0.9fr) minmax(200px,1.7fr) minmax(100px,0.8fr) 96px';

/** The nine filter chips' widths, in their order (All ... Closed). */
const CHIPS = [36, 98, 90, 132, 170, 168, 176, 140, 64];

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

export default function ReturnsLoading() {
  return (
    <div className={PAGE}>
      {/* The header: a 28 px title on its 42 px line, then the explanation,
          which wraps to two lines in its 768 px measure. */}
      <div className="min-w-0">
        <div className="flex h-[42px] items-center">
          <Bar w={132} h={26} />
        </div>
        <div className="mt-0.5 max-w-3xl space-y-2 py-1">
          <Bar w="100%" h={12} />
          <Bar w={220} h={12} />
        </div>
      </div>

      {/* The search: full width on a phone (44 px), 288 x 32 from sm up. */}
      <Bar radius={6} className="h-11 w-full sm:h-8 sm:w-72" />

      {/* The nine filter chips, wrapping. */}
      <div className="flex flex-wrap gap-2" data-slot="returns-loading-chips">
        {CHIPS.map((w, i) => (
          <Bar key={i} w={w} radius={999} className="h-11 sm:h-[30px]" />
        ))}
      </div>

      {/* The table card: 11 px header labels on a 37 px row, then rows that
          pad by var(--row-py) like the table's, each as tall as a row with
          its 32 px thumbnail. */}
      <div className="border-border bg-card overflow-hidden rounded-lg border">
        <div className="min-w-[860px]">
          <div
            className="border-border grid h-[37px] items-center gap-3 border-b px-4"
            style={{ gridTemplateColumns: COLUMNS }}
          >
            {[28, 40, 32, 64, 64, 44, 52].map((w, i) => (
              <div key={i} className={i === 6 ? 'flex justify-end' : undefined}>
                <Bar w={w} h={8} />
              </div>
            ))}
          </div>
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="border-border grid items-center gap-3 border-b px-4 last:border-0"
              style={{
                gridTemplateColumns: COLUMNS,
                paddingTop: 'var(--row-py, 11px)',
                paddingBottom: 'var(--row-py, 11px)',
              }}
            >
              <Bar w={150} h={12} />
              <Bar w={72} h={11} />
              <Bar w={56} h={20} radius={999} />
              <Bar w={84} h={11} />
              <div className="flex min-w-0 items-center gap-2">
                <Bar w={32} h={32} radius={6} />
                <Bar w={150} h={11} />
              </div>
              <Bar w={76} h={20} radius={999} />
              <div className="flex justify-end">
                <Bar w={76} h={11} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
