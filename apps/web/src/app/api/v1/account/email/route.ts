import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { emailChangeErrorResponse } from '@/server/lib/email-change-api';
import { getEmailChangeStatus, reconcileProfileEmail } from '@/server/services/email-change';

export const runtime = 'nodejs';

/**
 * GET /api/v1/account/email — the mobile twin of Settings → Profile → Email.
 *   200: { email, pendingEmail, sentAt, expiresAt, expired }
 * Reconciles the profile projection first (idempotent), so a phone that
 * opens this screen also repairs a projection that ever lagged the auth
 * identity.
 */
export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    await reconcileProfileEmail(ctx.userId);
    return NextResponse.json(await getEmailChangeStatus(ctx.userId));
  } catch (e) {
    return emailChangeErrorResponse(e);
  }
}
