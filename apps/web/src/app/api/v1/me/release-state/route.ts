import { releaseStateActionSchema } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { recordReleaseState } from '@/server/services/releases';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

/**
 * A browser attaches cookies to a cross-site POST, and route handlers get no
 * Origin check from the framework the way server actions do. What this route can
 * do is small (stamp the CALLER'S OWN release state), but "mark it all read so
 * they never see the notice" is still not something another site should be able
 * to do. A Bearer caller (the mobile app) has no ambient credential to abuse and
 * sends no Origin, so only cookie requests are checked.
 */
function isCrossSite(req: Request): boolean {
  if (req.headers.get('authorization')) return false;
  const origin = req.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host !== new URL(req.url).host;
  } catch {
    return true;
  }
}

/**
 * POST /api/v1/me/release-state — dismiss / open / read / read_all.
 *
 * The body names a release by slug and nothing else: no user id, no revision.
 * The user is the session's; the revision is the server registry's (see
 * recordReleaseState). A route handler for the reason given in ../releases/route.ts:
 * the tab recording "read" is very often one deployment behind.
 *
 * It answers honestly. `{ ok: false }` with 503 means the state was NOT saved, so
 * the client can keep showing the release as unread instead of claiming a save
 * that did not happen.
 */
export async function POST(req: Request): Promise<Response> {
  if (isCrossSite(req))
    return Response.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE });
  const ctx = await withApiContext(req);
  if (!ctx) return Response.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });

  const parsed = releaseStateActionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: 'validation_error' }, { status: 400, headers: NO_STORE });

  const result = await recordReleaseState(ctx, parsed.data);
  if (!result.ok) return Response.json({ ok: false }, { status: 503, headers: NO_STORE });
  return Response.json({ ok: true, recorded: result.recorded }, { headers: NO_STORE });
}
