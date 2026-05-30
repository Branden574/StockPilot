import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { ConnectionsService } from '@/server/services/connections';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';

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
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  try {
    const data = await new ConnectionsService(ctx).list();
    return NextResponse.json(data);
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, { tag: 'api.v1.integrations.connections.list' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
