import { NextResponse, type NextRequest } from 'next/server';
import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { UserConnectionsService } from '@/server/services/user-connections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/zendesk/me/disconnect
 *
 * Removes the signed-in user's Zendesk connection (nulls secret_id, deletes
 * the Vault entry, deletes the user_connections row). No-ops if not connected.
 *
 * The connection is resolved from the authenticated session — the caller
 * cannot disconnect another user via any request parameter.
 */
export async function POST(req: NextRequest) {
  try {
    const ctx = await withApiContext(req);
    if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

    await new UserConnectionsService(ctx).disconnect();
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.code }, { status: serviceErrorStatus(e.code) });
    }
    void reportError(e instanceof Error ? e : new Error(String(e)), { tag: 'zendesk.me.disconnect' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
