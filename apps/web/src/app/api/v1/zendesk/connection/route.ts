import { NextResponse, type NextRequest } from 'next/server';
import { apiReadContext } from '@/server/lib/api-read-context';
import { serviceErrorResponse } from '@/server/lib/service-error-response';
import { ConnectionsService } from '@/server/services/connections';
import { can } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const read = await apiReadContext(req);
    if ('response' in read) return read.response;
    const ctx = read.ctx;
    if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    const svc = new ConnectionsService(ctx);
    const conn = await svc.getZendeskConnection();
    return NextResponse.json({
      connection: conn,
      canManage: can(ctx, 'integrations:manage'),
    });
  } catch (e) {
    return serviceErrorResponse(e, 'api.v1.zendesk.connection');
  }
}
