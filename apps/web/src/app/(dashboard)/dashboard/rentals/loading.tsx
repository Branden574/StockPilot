/**
 * The Rentals section while a page loads, in the shape of its first page, the
 * checkouts list, so nothing jumps when it arrives: the header (title, its
 * line, + New rental on the right), the Activity / Items tabs, the five status
 * views, and the table card (Borrower, Items, Checked out, Return, Status,
 * Actions), with Items hidden below sm and Checked out below md as the table
 * hides them. The section's other pages share its header and tabs.
 *
 * Grey bars only, no words or numbers to misread as data, and `animate-pulse`
 * stops under reduced motion (globals.css). The page area and the bar follow
 * the shared skeletons' recipe (components/dashboard/skeletons.tsx, whose Bar
 * is not exported).
 */

/** The page area every skeleton and page sits in. */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

/**
 * The table's columns at each width: Borrower, Return, Status and Actions on a
 * phone; Items joins from sm and Checked out from md.
 */
const COLUMNS =
  'grid-cols-[minmax(150px,1fr)_120px_88px_120px] sm:grid-cols-[minmax(150px,1.3fr)_minmax(140px,1.2fr)_minmax(120px,1fr)_88px_220px] md:grid-cols-[minmax(150px,1.3fr)_minmax(140px,1.2fr)_110px_minmax(120px,1fr)_88px_220px]';

/** The status views' widths (Out, Overdue, Returned, Cancelled, All). */
const STATUS_VIEWS = [36, 64, 72, 74, 30];

function Bar({ w, h, radius = 4 }: { w: number | string; h: number; radius?: number }) {
  return (
    <div
      className="bg-muted max-w-full shrink-0 animate-pulse"
      style={{ width: typeof w === 'number' ? `${w}px` : w, height: h, borderRadius: radius }}
    />
  );
}

export default function RentalsLoading() {
  return (
    <div className={PAGE}>
      {/* The header: a 28 px title on its 42 px line, the line under it, and
          the page's create button bottom-aligned on the right. */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="flex h-[42px] items-center">
            <Bar w={150} h={26} />
          </div>
          <div className="mt-0.5 flex h-5 items-center">
            <Bar w={380} h={12} />
          </div>
        </div>
        <Bar w={112} h={32} radius={6} />
      </div>

      {/* The section tabs on their hairline. */}
      <div className="border-border flex h-10 items-center gap-6 border-b px-3">
        <Bar w={56} h={12} />
        <Bar w={40} h={12} />
      </div>

      {/* The status views on their sunk track. */}
      <div className="border-border bg-sunk flex h-9 w-fit max-w-full items-center gap-0.5 overflow-hidden rounded-lg border p-[3px]">
        {STATUS_VIEWS.map((w, i) => (
          <div key={i} className="flex h-7 items-center px-2.5">
            <Bar w={w} h={11} />
          </div>
        ))}
      </div>

      {/* The table card: 11 px header labels on a 37 px row, then rows that
          pad by var(--row-py) like the table's, the borrower two lines tall. */}
      <div className="border-border bg-card overflow-hidden rounded-lg border">
        <div className={`border-border grid h-[37px] items-center gap-3 border-b px-4 ${COLUMNS}`}>
          <Bar w={64} h={8} />
          <div className="hidden sm:block">
            <Bar w={40} h={8} />
          </div>
          <div className="hidden md:block">
            <Bar w={76} h={8} />
          </div>
          <Bar w={48} h={8} />
          <Bar w={44} h={8} />
          <div className="flex justify-end">
            <Bar w={52} h={8} />
          </div>
        </div>
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className={`border-border grid items-center gap-3 border-b px-4 last:border-0 ${COLUMNS}`}
            style={{
              paddingTop: 'var(--row-py, 11px)',
              paddingBottom: 'var(--row-py, 11px)',
            }}
          >
            <div className="flex h-[37px] flex-col justify-center gap-1.5">
              <Bar w={132} h={12} />
              <Bar w={84} h={10} />
            </div>
            <div className="hidden sm:block">
              <Bar w={140} h={11} />
            </div>
            <div className="hidden md:block">
              <Bar w={72} h={11} />
            </div>
            <Bar w={88} h={11} />
            <Bar w={52} h={20} radius={999} />
            <div className="flex justify-end gap-2">
              <Bar w={40} h={28} radius={6} />
              <div className="hidden sm:block">
                <Bar w={104} h={28} radius={6} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
