import { withApiContext } from '@/lib/auth/api-context';
import { getReleaseFor } from '@/server/services/releases';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

/**
 * GET /api/v1/me/releases/[slug] — one release, filtered to what THIS reader can
 * reach. 404 covers "no such release", "a draft" and "not for you" alike, so a
 * guessed slug confirms nothing. See ../route.ts for why this is a route handler.
 */
export async function GET(
  req: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const ctx = await withApiContext(req);
  if (!ctx) return Response.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  const { slug } = await context.params;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) {
    return Response.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }
  const release = await getReleaseFor(ctx, slug);
  if (!release) return Response.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  return Response.json({ release }, { headers: NO_STORE });
}
