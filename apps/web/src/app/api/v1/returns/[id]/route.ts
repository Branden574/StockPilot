import { NextResponse, type NextRequest } from 'next/server';

import { loadReturnRequestEmailForReturn } from '@/server/services/return-request-email';
import { RMAService } from '@/server/services/returns';

import { invalidReturnId, NO_STORE, returnsContext, returnsErrorResponse } from '../http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/returns/[id] — the RMA workbench in one payload (returns RX-1):
 * the header, each returned line (item, size, photo signed in one batch,
 * inbound state, and for an unapplied line its destination options: proven
 * sources, validity now, what may be offered, the live plan), the decision
 * log, the chain, the current revision and plan seq (sent back by approve,
 * cancel and process), and the viewer booleans plus `actions` from core's
 * availableReturnActions. Cookie or Bearer; returns:read or returns:manage.
 *
 * F14: the answer also carries `returnRequestEmail: { recipients, link }`,
 * the organization's saved delivery-request mailboxes (null when not set or
 * invalid) and the link back to this return, for the phone's "Email return
 * request". Read only after the workbench answered, so it is never served
 * for a return the caller may not open.
 *
 * 200 { ...workbench, returnRequestEmail } · 400 bad id · 401 · 403 · 404 (missing or another
 * organization's, alike) · 429.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const bad = invalidReturnId(id);
  if (bad) return bad;
  const gate = await returnsContext(req, 'read');
  if ('response' in gate) return gate.response;
  const { ctx } = gate;
  try {
    const workbench = await RMAService.forApiContext(ctx).workbench(id);
    const returnRequestEmail = await loadReturnRequestEmailForReturn(ctx, workbench.return.id);
    return NextResponse.json({ ...workbench, returnRequestEmail }, { headers: NO_STORE });
  } catch (e) {
    return returnsErrorResponse(e, 'api.v1.returns.get', ctx);
  }
}
