import { NextResponse, type NextRequest } from 'next/server';
import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { UserConnectionsService } from '@/server/services/user-connections';
import { ZendeskApiError, ZendeskClient } from '@/server/connectors/zendesk/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/zendesk/me/tickets/[id]
 *
 * Returns a single Zendesk ticket + its comments for the signed-in agent.
 * [id] is a Zendesk TICKET id (positive integer) — NOT a user id.
 *
 * The connection is resolved from the authenticated session only.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await withApiContext(req);
    if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

    const { id: idParam } = await params;
    if (!/^[1-9]\d*$/.test(idParam)) {
      return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
    }
    const id = Number(idParam);

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
        const error = e.code === 'not_found' ? 'not_connected' : e.code;
        return NextResponse.json({ error }, { status });
      }
      return NextResponse.json({ error: 'internal_error' }, { status: 500 });
    }

    const client = new ZendeskClient({ subdomain, accessToken });
    const { ticket, comments } = await client.getTicket(id);
    return NextResponse.json({ ticket, comments });
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
    void reportError(e instanceof Error ? e : new Error(String(e)), { tag: 'zendesk.me.ticket' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
