import { NextResponse, type NextRequest } from 'next/server';

import { exchangeCreateEnabled } from '@/lib/returns/exchange-switch';

import { NO_STORE, returnsContext } from '../http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/returns/exchange-switch — whether a new exchange may be asked
 * for right now (the RETURNS_EXCHANGE_CREATE kill switch, returns RX-2). The
 * phone reads it when its create-return sheet opens, so the sheet offers
 * "Exchange for another size or item" only while exchanges are on, without
 * reading the whole order for every completed order it opens (desk check F9).
 * The create still refuses an exchange while the switch is off
 * (exchange_not_available), so a stale answer costs one worded refusal.
 *
 * 200 { organizationId, exchangesEnabled } · 401 · 429. Reads nothing else.
 */
export async function GET(req: NextRequest) {
  const gate = await returnsContext(req, 'read');
  if ('response' in gate) return gate.response;
  const { ctx } = gate;
  return NextResponse.json(
    { organizationId: ctx.organizationId, exchangesEnabled: exchangeCreateEnabled() },
    { headers: NO_STORE },
  );
}
