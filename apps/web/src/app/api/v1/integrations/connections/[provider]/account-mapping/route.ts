import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { ConnectionsService } from '@/server/services/connections';
import { serviceErrorResponse } from '@/server/lib/service-error-response';

import type { ConnectorProviderId } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mobile account-mapping endpoint. Persists the QBO chart-of-accounts mapping
 * (three free-text account ids the admin pastes) into the connection's
 * non-secret settings. Validates the `provider` segment and that all three
 * fields are present non-empty strings before delegating. ConnectionsService
 * .saveAccountMapping() enforces module + integrations:manage internally.
 */
function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

export async function POST(
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

  const body = (await req.json().catch(() => null)) as
    | {
        billExpense?: unknown;
        inventoryAsset?: unknown;
        valuationOffset?: unknown;
        returnCredit?: unknown;
      }
    | null;
  if (
    !body ||
    !nonEmptyString(body.billExpense) ||
    !nonEmptyString(body.inventoryAsset) ||
    !nonEmptyString(body.valuationOffset)
  ) {
    return NextResponse.json(
      {
        error: 'validation_error',
        message:
          'billExpense, inventoryAsset, and valuationOffset are all required.',
      },
      { status: 400 },
    );
  }

  try {
    await new ConnectionsService(ctx).saveAccountMapping(provider as ConnectorProviderId, {
      billExpense: body.billExpense,
      inventoryAsset: body.inventoryAsset,
      valuationOffset: body.valuationOffset,
      // Optional on this surface; the web Integrations form is the primary
      // editor. Blank leaves the return JournalEntry export gracefully unconfigured.
      returnCredit: nonEmptyString(body.returnCredit) ? body.returnCredit : '',
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serviceErrorResponse(e, 'api.v1.integrations.connections.account_mapping');
  }
}
