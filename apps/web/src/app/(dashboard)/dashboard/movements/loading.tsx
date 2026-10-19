/**
 * The Stock movements page while its ledger loads, in the page's own shape so
 * nothing jumps when it arrives: the header (title, its line, Export CSV), the
 * type chips, the search and date row with the top pager, and the ledger card
 * (When, Item, Type, Δ, After, By, Note) with the pager as its footer. The
 * page area and the bar follow the shared skeletons' recipe (components/
 * dashboard/skeletons.tsx, whose Bar is not exported): grey bars only, no
 * words or numbers to misread as data, and `animate-pulse` stops under
 * reduced motion (globals.css).
 */

/** The page area every skeleton and page sits in. */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

/** The ledger's columns: When, Item, Type, Δ, After, By, Note. */
const COLUMNS =
  'minmax(120px,1fr) minmax(180px,1.6fr) 110px 56px 64px minmax(140px,1.1fr) minmax(200px,1.4fr)';

/** The type chips' widths (All types and the 10 types). */
const CHIPS = [76, 46, 72, 62, 76, 90, 64, 72, 50, 86, 60];

function Bar({ w, h, radius = 4 }: { w: number | string; h: number; radius?: number }) {
  return (
    <div
      className="bg-muted max-w-full shrink-0 animate-pulse"
      style={{ width: typeof w === 'number' ? `${w}px` : w, height: h, borderRadius: radius }}
    />
  );
}

export default function MovementsLoading() {
  return (
    <div className={PAGE}>
      {/* The header: a 28 px title on its 42 px line, the line under it, and
          Export CSV bottom-aligned on the right. */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="flex h-[42px] items-center">
            <Bar w={230} h={26} />
          </div>
          <div className="mt-0.5 flex h-5 items-center">
            <Bar w={330} h={12} />
          </div>
        </div>
        <Bar w={112} h={32} radius={6} />
      </div>

      {/* The type chips, then search, the two dates and the top pager. */}
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          {CHIPS.map((w, i) => (
            <Bar key={i} w={w} h={30} radius={999} />
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Bar w={240} h={32} radius={6} />
            <Bar w={150} h={32} radius={6} />
            <Bar w={150} h={32} radius={6} />
          </div>
          <div className="flex items-center gap-2">
            <Bar w={120} h={12} />
            <Bar w={64} h={28} radius={6} />
            <Bar w={72} h={12} />
            <Bar w={64} h={28} radius={6} />
          </div>
        </div>
      </div>

      {/* The ledger card: 11 px header labels on a 37 px row, then rows that
          pad by var(--row-py) like the table's, each two lines tall. */}
      <div className="border-border bg-card overflow-hidden rounded-lg border">
        <div className="min-w-[860px]">
          <div
            className="border-border grid h-[37px] items-center gap-3 border-b px-4"
            style={{ gridTemplateColumns: COLUMNS }}
          >
            {[40, 36, 36, 12, 36, 20, 36].map((w, i) => (
              <div key={i} className={i === 3 || i === 4 ? 'flex justify-end' : undefined}>
                <Bar w={w} h={8} />
              </div>
            ))}
          </div>
          {Array.from({ length: 12 }).map((_, i) => (
            <div
              key={i}
              className="border-border grid items-center gap-3 border-b px-4 last:border-0"
              style={{
                gridTemplateColumns: COLUMNS,
                paddingTop: 'var(--row-py, 11px)',
                paddingBottom: 'var(--row-py, 11px)',
              }}
            >
              <div className="flex h-[37px] flex-col justify-center gap-1.5">
                <Bar w={72} h={11} />
                <Bar w={104} h={10} />
              </div>
              <div className="flex h-[37px] flex-col justify-center gap-1.5">
                <Bar w={150} h={12} />
                <Bar w={84} h={10} />
              </div>
              <Bar w={76} h={11} />
              <div className="flex justify-end">
                <Bar w={28} h={12} />
              </div>
              <div className="flex justify-end">
                <Bar w={36} h={12} />
              </div>
              <div className="flex h-[37px] flex-col justify-center gap-1.5">
                <Bar w={92} h={11} />
                <Bar w={120} h={10} />
              </div>
              <Bar w={110} h={11} />
            </div>
          ))}
          <div className="border-border flex items-center justify-between border-t px-4 py-2.5">
            <Bar w={120} h={12} />
            <div className="flex items-center gap-2">
              <Bar w={64} h={28} radius={6} />
              <Bar w={72} h={12} />
              <Bar w={64} h={28} radius={6} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
