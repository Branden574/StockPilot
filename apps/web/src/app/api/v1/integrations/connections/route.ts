import { NextResponse, type NextRequest } from 'next/server';

import { apiReadContext } from '@/server/lib/api-read-context';
import { ConnectionsService } from '@/server/services/connections';
import { serviceErrorResponse } from '@/server/lib/service-error-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mobile integrations control surface: list this org's connector connections
 * (status/realm/account-id mapping handles — never a token) plus recent
 * sync-log health rows. Read is member-level; ConnectionsService.list()
 * enforces module enablement (integrations) internally and returns a
 * ServiceError('module_disabled') when off, which we map to 403.
 */
export async function GET(req: NextRequest) {
  const read = await apiReadContext(req);
  if ('response' in read) return read.response;
  const ctx = read.ctx;
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  try {
    const data = await new ConnectionsService(ctx).list();
    return NextResponse.json(data);
  } catch (e) {
    return serviceErrorResponse(e, 'api.v1.integrations.connections.list');
  }
}
