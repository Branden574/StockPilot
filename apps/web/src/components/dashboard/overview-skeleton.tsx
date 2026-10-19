/**
 * The Overview page's skeletons, in the redesigned page's shapes (DESIGN-SPEC
 * 7.1): the same page box as the page (max 1320, 28 / 32 / 64 padding, 16 px
 * gutters on a phone, 16 px between blocks), the greeting header, then the
 * streamed body in the default widget order (the briefing line and the
 * attention card, the trends heading and readouts, the shift command card,
 * the key stats strip and the value / breakdown row).
 *
 * `OverviewSkeleton` was the Overview's loading.tsx; it is now drawn through
 * RouteSkeleton (route-skeleton.tsx) by the late skeleton, for a navigation
 * still waiting after SLOW_NAVIGATION_MS (pending-route-skeleton.tsx), and by
 * the (dashboard) group's loading.tsx on a hard load of /dashboard.
 * `OverviewBodySkeleton` is the page's own <Suspense> fallback under the
 * header, which has already painted. One source, so the two never drift.
 *
 * They draw only grey bars: no words, no numbers, nothing to misread as data,
 * and `animate-pulse` stops under reduced motion (globals.css).
 */

/** The page box, identical to the Overview page's. */
export const OVERVIEW_PAGE_CLASS =
  'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

const CARD = 'border-border bg-card overflow-hidden rounded-lg border';

export function OverviewSkeleton() {
  return (
    <div className={OVERVIEW_PAGE_CLASS}>
      {/* The greeting header: the 16.5 px eyebrow line, the 32 px title on
          its 37 px line, the actions bottom-aligned on the right. */}
      <div className="flex flex-wrap items-end justify-between gap-4 pb-2">
        <div className="min-w-0">
          <div className="mb-1.5 flex h-[16.5px] items-center">
            <Bar w={170} h={9} />
          </div>
          <div className="flex h-[37px] items-center">
            <Bar w={300} h={28} />
          </div>
        </div>
        <div className="flex gap-2">
          <Bar w={60} h={26} radius={999} />
          <Bar w={72} h={32} radius={6} />
          <Bar w={88} h={32} radius={6} />
          <Bar w={112} h={32} radius={6} />
        </div>
      </div>
      <OverviewBodySkeleton />
    </div>
  );
}

export function OverviewBodySkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* The briefing line, then the attention card's header and rows. */}
      <div className="flex flex-col gap-3">
        <div className="flex h-5 items-center">
          <Bar w={210} h={11} />
        </div>
        <div className={CARD}>
          <div className="border-border flex h-[49px] items-center justify-between border-b px-[18px]">
            <Bar w={120} h={12} />
            <Bar w={96} h={10} />
          </div>
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="border-border flex items-center gap-3.5 border-b px-[18px] py-[13px] last:border-b-0"
            >
              <Bar w={8} h={8} radius={999} />
              <div className="min-w-0 flex-1 space-y-2">
                <Bar w={220} h={12} />
                <Bar w="60%" h={10} />
              </div>
              <Bar w={76} h={11} />
            </div>
          ))}
        </div>
      </div>

      {/* The trends heading and its readouts (lg up). */}
      <div className="flex flex-col gap-3">
        <div className="space-y-2">
          <Bar w={130} h={14} />
          <Bar w={320} h={10} />
        </div>
        <div className={`${CARD} hidden lg:block`}>
          <div className="bg-border grid grid-cols-4 gap-px">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="bg-card space-y-2.5 px-[18px] py-4">
                <Bar w={80} h={11} />
                <Bar w={72} h={22} />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* The key stats strip: one card, cells divided by hairlines. */}
      <div className={CARD}>
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

      {/* The value card beside the movements breakdown. */}
      <div className="@container">
        <div className="@min-[936px]:grid-cols-12 grid grid-cols-1 gap-4">
          <div className={`${CARD} @min-[936px]:col-span-9 space-y-3 p-[18px]`}>
            <Bar w={160} h={12} />
            <Bar w={200} h={10} />
            <Bar w={180} h={28} />
            <Bar w="100%" h={200} radius={6} />
          </div>
          <div className={`${CARD} @min-[936px]:col-span-3 space-y-3 p-[18px]`}>
            <Bar w={130} h={12} />
            <Bar w={150} h={10} />
            <Bar w="100%" h={120} radius={6} />
          </div>
        </div>
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
