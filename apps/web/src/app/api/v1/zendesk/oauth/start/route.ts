import { NextResponse, type NextRequest } from 'next/server';
import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { UserConnectionsService } from '@/server/services/user-connections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await withApiContext(req);
    if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

    const platform = req.nextUrl.searchParams.get('platform') === 'mobile' ? 'mobile' : 'web';
    const { authorizeUrl } = await new UserConnectionsService(ctx).beginZendeskConnect(platform);
    return NextResponse.redirect(authorizeUrl, { status: 302 });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: serviceErrorStatus(e.code) });
    }
    void reportError(e instanceof Error ? e : new Error(String(e)), { tag: 'zendesk.oauth.start' });
    return NextResponse.json({ error: 'internal_error', message: 'Unexpected error' }, { status: 500 });
  }
}
