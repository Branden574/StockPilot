/**
 * Boot-time self-warm (cold-start plan rank 6, 2026-07-06).
 *
 * `register()` runs ONCE per new server instance, BEFORE the instance
 * serves its first request. It covers the cold-instance cases the
 * deploy-hook prewarm (GitHub Actions) and the every-30-min cron miss:
 * Fluid scale-out under burst and idle-expiry respawns, where a fresh
 * instance would otherwise serve its first users off lapsed 60s-TTL
 * loader caches.
 *
 * HARD RULES (from the plan — do not "improve" these away):
 *   • NEVER await the fetch. register() must complete before the
 *     instance is marked ready, so an awaited prewarm would make every
 *     cold start SLOWER — the exact opposite of the goal. Fire and
 *     forget; on Fluid the instance stays alive through its triggering
 *     request, so the request nearly always completes (best-effort by
 *     design — there is no waitUntil outside request scope).
 *   • Do NOT import the loader functions and call them directly here.
 *     Next's cache handlers may not be wired outside request scope;
 *     the HTTP self-call keeps the warm on the well-tested, secret-
 *     gated route (same path the cron and deploy hook use).
 *   • ALWAYS pass `?scope=hot`. The prewarm route is TIERED: the boot
 *     self-warm requests only the known-hot tier (the two known-hot
 *     orgs' orders-catalog pairs + their Items/Books variants), while
 *     the every-30-min Vercel cron and the post-deploy GH Action send
 *     no param and run the full capped all-active-orgs sweep. A deploy
 *     cold-starts K instances at once — K concurrent FULL sweeps
 *     (~50 orgs × ~1s of duplicated cold Supabase loads each) would be
 *     a thundering herd duplicating work the singleton callers already
 *     do; K hot-tier fires stay cheap because unstable_cache reads hit
 *     the SHARED Vercel Data Cache (mostly cache hits after the first).
 *
 * No user context, no cookies, no auth semantics — this only GETs our
 * own prewarm route with the operator secret, exactly like the cron.
 */
export async function register(): Promise<void> {
  // Node runtime only (register also runs for the edge runtime build).
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Production instances only — preview/dev instances must not warm
  // (or hammer) the production domain's caches.
  if (process.env.VERCEL_ENV !== 'production') return;

  const secret = process.env.BACKFILL_ADMIN_SECRET;
  // Canonical prod host, provided by Vercel at boot (bare hostname).
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (!secret || !host) return;

  // Fire-and-forget (see header). AbortSignal.timeout keeps a hung
  // socket from outliving the instance's useful window; errors are
  // swallowed — a failed self-warm just means the first click pays the
  // usual cold path, never a crashed boot.
  void fetch(`https://${host}/api/cron/prewarm-orders-catalog?scope=hot`, {
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(55_000),
  }).catch(() => {});
}

/**
 * TEMP DIAGNOSTIC (remove after PO-imports 500 is fixed): Next.js calls this
 * for every server-side error, including RSC render/action throws that prod
 * redacts to a bare digest. We persist the REAL message + stack to
 * public._diag_errors (service-role REST insert) so it can be read out of band.
 * Fully best-effort — never throws, never blocks the request.
 */
export async function onRequestError(
  err: unknown,
  request: { path?: string; method?: string },
  context: { routerKind?: string; routePath?: string; renderSource?: string },
): Promise<void> {
  try {
    // Only capture the routes under investigation to keep noise low.
    const path = request?.path ?? '';
    if (!path.includes('/purchase-orders/imports')) return;
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return;
    const e = err as { message?: string; stack?: string; digest?: string };
    await fetch(`${url}/rest/v1/_diag_errors`, {
      method: 'POST',
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        prefer: 'return=minimal',
      },
      body: JSON.stringify({
        message: e?.message ?? String(err),
        stack: e?.stack ?? null,
        digest: e?.digest ?? null,
        url: path,
        method: request?.method ?? null,
        route_path: context?.routePath ?? null,
        render_source: context?.renderSource ?? null,
        extra: { routerKind: context?.routerKind ?? null },
      }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
  } catch {
    /* diagnostics must never affect the request */
  }
}
