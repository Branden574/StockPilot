import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { ConnectionsService } from '@/server/services/connections';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';

import type { ConnectorProviderId } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mobile disconnect endpoint. Validates the dynamic `provider` segment is a
 * known connector ('quickbooks') before touching the service; an unknown
 * provider is a request-shape error (400 validation_error) rather than a
 * service concern. ConnectionsService.disconnect() enforces module + the
 * integrations:manage permission internally (forbidden → 403). The token is
 * destroyed in Vault by the service — never returned here.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { provider } = await params;
  if (provider !== 'quickbooks') {
    return NextResponse.json(
      { error: 'validation_error', message: `Unknown provider: ${provider}` },
      { status: 400 },
    );
  }

  try {
    await new ConnectionsService(ctx).disconnect(provider as ConnectorProviderId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, { tag: 'api.v1.integrations.connections.disconnect' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
