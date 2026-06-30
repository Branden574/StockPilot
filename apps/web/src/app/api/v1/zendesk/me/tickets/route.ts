import { NextResponse, type NextRequest } from 'next/server';
import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { UserConnectionsService } from '@/server/services/user-connections';
import { ZendeskApiError, ZendeskClient } from '@/server/connectors/zendesk/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/zendesk/me/tickets
 *
 * Returns the signed-in agent's Zendesk tickets.
 *   ?view=assigned (default) | requested
 *   ?query=<free-form Zendesk search terms> (optional, passed through)
 *
 * The connection is resolved entirely from the authenticated session — the
 * caller cannot target another user's connection via any request parameter.
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await withApiContext(req);
    if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

    // Resolve the caller's own token — throws ServiceError('not_found') when
    // they have no active connection. We MUST do this before constructing a
    // ZendeskClient so an unconnected caller never touches anyone else's data.
    let subdomain: string;
    let accessToken: string;
    try {
      ({ subdomain, accessToken } = await new UserConnectionsService(ctx).getValidAccessToken());
    } catch (e) {
      if (e instanceof ServiceError) {
        const status = serviceErrorStatus(e.code);
        // Map not_found specifically: the caller is simply not connected.
        const error = e.code === 'not_found' ? 'not_connected' : e.code;
        return NextResponse.json({ error }, { status });
      }
      return NextResponse.json({ error: 'internal_error' }, { status: 500 });
    }

    const rawView = req.nextUrl.searchParams.get('view');
    const view: 'assigned' | 'requested' = rawView === 'requested' ? 'requested' : 'assigned';
    const query = req.nextUrl.searchParams.get('query') ?? undefined;

    const client = new ZendeskClient({ subdomain, accessToken });
    const tickets = await client.listMyTickets({ view, query });
    return NextResponse.json({ tickets });
  } catch (e) {
    // Sanitize Zendesk errors — never pass raw messages or tokens to the client.
    if (e instanceof ZendeskApiError) {
      if (e.status === 401) {
        return NextResponse.json({ error: 'reauth_required' }, { status: 401 });
      }
      return NextResponse.json({ error: 'zendesk_unavailable' }, { status: 502 });
    }
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.code }, { status: serviceErrorStatus(e.code) });
    }
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
