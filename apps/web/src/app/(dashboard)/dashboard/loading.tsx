/**
 * Route-level loading state for the Overview (`/dashboard`) — perf plan
 * 2026-07-02 P1c. Mirrors the real page frame: the greeting/date header
 * block plus the streamed body's stat row + chart rows (same shapes as
 * `DashboardBodySkeleton` in page.tsx), so a soft navigation to Overview
 * paints a route-true skeleton in ~0ms instead of the generic
 * `PageSkeleton` from the (dashboard) group boundary.
 *
 * NOTE: every child section under /dashboard/* has its own loading.tsx,
 * so this file only ever renders for the Overview segment itself. Keep it
 * that way — if a new child section is added without a loading.tsx, THIS
 * Overview-shaped skeleton would flash on its navigations.
 */
export default function DashboardOverviewLoading() {
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
