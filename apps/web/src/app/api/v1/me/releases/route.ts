import { withApiContext } from '@/lib/auth/api-context';
import { listReleasesFor } from '@/server/services/releases';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

/**
 * GET /api/v1/me/releases — the reader's release history with their read state,
 * plus the one release the notification should offer.
 *
 * A ROUTE HANDLER under /api/v1, never a server action, and that is structural:
 * this is read by tabs that are one deployment BEHIND. A server action's id
 * changes with every build (an old tab gets "Failed to find Server Action"), and
 * under Vercel Skew Protection it is pinned to the OLD deployment and would
 * return the old registry. A plain same-origin GET carries no deployment header,
 * so it is answered by whatever production serves now, which is the point.
 * /api/v1 also sits behind the firewall bypass mobile already depends on.
 *
 * Per-user and never cacheable: the body depends on role, permissions, enabled
 * modules and read state.
 */
export async function GET(req: Request): Promise<Response> {
  const ctx = await withApiContext(req);
  if (!ctx) return Response.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  return Response.json(await listReleasesFor(ctx), { headers: NO_STORE });
}
