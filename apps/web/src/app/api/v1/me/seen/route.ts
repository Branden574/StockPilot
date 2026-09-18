import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * POST /api/v1/me/seen — the "last seen" beacon (migration 0352).
 *
 * The browser (ActivityBeacon) and the mobile app call this when a PERSON opens
 * StockPilot, comes back to it, or moves around in it, throttled on the client
 * and again in the database (five minutes). It lets the platform console tell
 * when someone last had the product open even if they only read and then signed
 * out, which no other signal survives.
 *
 * withApiContext resolves the caller from the cookie session (web) or the
 * Bearer token (mobile) and re-derives their active organization server-side,
 * so NOTHING the client sends is read: there is no body to parse, no user id and
 * no organization id to trust. The rpc runs AS THE CALLER and its own gate
 * (auth.uid(), real accepted member, not an impersonation grant, not disabled)
 * is the authorization. A platform admin acting as a tenant therefore stamps
 * nothing, which is correct: they do not work there.
 *
 * Fire-and-forget: a failed stamp answers 200 like a successful one, because a
 * client has nothing useful to do with a telemetry error. It is REPORTED every
 * time instead. `Database = any`, so a typo in the function name would compile,
 * fail at PostgREST and otherwise vanish into this catch forever.
 */
export async function POST(req: Request): Promise<Response> {
  const ctx = await withApiContext(req);
  if (!ctx) return Response.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });

  try {
    const { error } = await ctx.supabase.rpc('touch_member_last_seen', {
      p_org_id: ctx.organizationId,
    });
    if (error) throw new Error(error.message);
  } catch (err) {
    await reportError(err instanceof Error ? err : new Error(String(err)), {
      tag: 'activity.touch-last-seen',
      level: 'warning',
      extra: { orgId: ctx.organizationId },
    });
  }
  // A JSON body, not a bare 204: the mobile api() client parses every 2xx as
  // JSON, and an empty body would throw there on a request that succeeded.
  return Response.json({ ok: true }, { headers: NO_STORE });
}
