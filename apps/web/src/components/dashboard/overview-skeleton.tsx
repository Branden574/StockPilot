/**
 * The Overview page's skeleton: the greeting/date header block plus the
 * streamed body's stat row and chart rows (same shapes as
 * `DashboardBodySkeleton` in the Overview page). It was the Overview's
 * loading.tsx; it is now drawn by PendingRouteSkeleton, only for a navigation
 * that is still waiting after SLOW_NAVIGATION_MS (see nav-progress-bar.tsx).
 */
export function OverviewSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[1760px] px-5 pb-20 pt-6 sm:px-7 2xl:px-9">
      {/* Greeting + action-button header (matches the page's lead section). */}
      <section className="mb-6 animate-pulse">
        <div className="flex flex-col gap-4 pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-2 h-3 w-40 rounded bg-muted" />
            <div className="h-9 w-72 rounded bg-muted" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="h-8 w-24 rounded-md bg-muted" />
            <div className="h-8 w-28 rounded-md bg-muted" />
            <div className="h-8 w-32 rounded-md bg-muted" />
          </div>
        </div>
      </section>

      {/* Streamed-body shape (mirrors DashboardBodySkeleton in page.tsx). */}
      <div className="animate-pulse">
        <div className="mb-4 grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-card h-[120px] rounded-lg border border-border" />
          ))}
        </div>
        <div className="mb-4 grid grid-cols-1 gap-3.5 lg:grid-cols-12">
          <div className="bg-card h-[360px] rounded-lg border border-border lg:col-span-9" />
          <div className="bg-card h-[360px] rounded-lg border border-border lg:col-span-3" />
        </div>
        <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-12">
          <div className="bg-card h-[300px] rounded-lg border border-border lg:col-span-7" />
          <div className="bg-card h-[300px] rounded-lg border border-border lg:col-span-5" />
        </div>
      </div>
    </div>
  );
}
