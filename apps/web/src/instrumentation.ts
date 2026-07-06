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
 *   • Redundant fires are cheap: unstable_cache reads hit the SHARED
 *     Vercel Data Cache, so an instance warming an already-warm org is
 *     mostly cache hits. If org count grows past ~15, add a
 *     "warmed-at" Data Cache sentinel before widening the hot-org list
 *     (see the scale notes in the plan).
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
  void fetch(`https://${host}/api/cron/prewarm-orders-catalog`, {
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(55_000),
  }).catch(() => {});
}
