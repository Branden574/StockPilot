import { NextResponse, type NextRequest } from 'next/server';
import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { UserConnectionsService } from '@/server/services/user-connections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/zendesk/me/connect-url
 *
 * Returns the Zendesk OAuth authorization URL for the mobile client. The
 * mobile app calls this endpoint (with its Bearer token) to obtain the URL
 * it should open in an ephemeral system browser — the system browser carries
 * no app session, so the OAuth `start` redirect cannot be used from mobile.
 *
 * Authorization is enforced here via `withApiContext` (Bearer token) and
 * then inside `beginZendeskConnect('mobile')` (module + permission gates).
 * The HMAC-signed state returned inside the URL carries `platform:'mobile'`,
 * which the callback route uses to route completion through the sessionless
 * path.
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await withApiContext(req);
    if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

    const { authorizeUrl } = await new UserConnectionsService(ctx).beginZendeskConnect('mobile');
    return NextResponse.json({ authorizeUrl });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: serviceErrorStatus(e.code) });
    }
    void reportError(e instanceof Error ? e : new Error(String(e)), { tag: 'zendesk.me.connect-url' });
    return NextResponse.json({ error: 'internal_error', message: 'Unexpected error' }, { status: 500 });
  }
}
