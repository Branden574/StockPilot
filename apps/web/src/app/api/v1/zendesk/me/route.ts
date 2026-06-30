import { NextResponse, type NextRequest } from 'next/server';
import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { UserConnectionsService } from '@/server/services/user-connections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/v1/zendesk/me — return the caller's Zendesk connection status. */
export async function GET(req: NextRequest) {
  try {
    const ctx = await withApiContext(req);
    if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

    const s = await new UserConnectionsService(ctx).status();
    return NextResponse.json(s);
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.code }, { status: serviceErrorStatus(e.code) });
    }
    void reportError(e instanceof Error ? e : new Error(String(e)), { tag: 'zendesk.me.status' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
