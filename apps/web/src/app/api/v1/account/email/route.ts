import { NextResponse, type NextRequest } from 'next/server';

import { apiContextGate } from '@/server/lib/api-context-gate';
import { emailChangeErrorResponse } from '@/server/lib/email-change-api';
import { getEmailChangeStatus, reconcileProfileEmail } from '@/server/services/email-change';

export const runtime = 'nodejs';

/**
 * GET /api/v1/account/email — the mobile twin of Settings → Profile → Email.
 *   200: { email, pendingEmail, sentAt, expiresAt, expired }
 *   503 check_failed (context_unavailable): the caller's access could not be read, so nothing ran
 * Reconciles the profile projection first (idempotent), so a phone that
 * opens this screen also repairs a projection that ever lagged the auth
 * identity.
 */
export async function GET(req: NextRequest) {
  // First, before the body or anything else: a context that could not be
  // built because the caller's access could not be read answers the 503 the
  // phone may send again (server/lib/api-context-gate.ts).
  const gate = await apiContextGate(req);
  if ('response' in gate) return gate.response;
  const ctx = gate.ctx;
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    await reconcileProfileEmail(ctx.userId);
    return NextResponse.json(await getEmailChangeStatus(ctx.userId));
  } catch (e) {
    return emailChangeErrorResponse(e);
  }
}
