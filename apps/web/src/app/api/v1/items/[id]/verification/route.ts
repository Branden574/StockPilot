import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import {
  verificationErrorResponse,
  verificationUnauthenticatedResponse,
} from '@/lib/verification/error-response';
import { VerificationService } from '@/server/services/verification';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/items/[id]/verification — "last physical count" for one item
 * (F1-3): the item's latest physical count, recorded movements since, rows
 * written outside the stock ledger, an open count holding it, its open
 * exceptions and when they were last checked, and whether the reader may
 * start a count. The phone words it with core verificationSummaryCopy, the
 * same words as the web item card.
 *
 * Cookie or Bearer (withApiContext), the same gates as the web card:
 * items:read (403 without it, or at a required MFA step-up); 404 when the item
 * does not exist or the reader cannot read it (existence is not leaked); 400
 * for a malformed id. Any other failure is a 500 whose message is "Couldn't
 * load verification", never an empty summary. Read-only; no sync.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return verificationUnauthenticatedResponse();

  const { id } = await params;
  try {
    const result = await new VerificationService(ctx).item(id);
    return NextResponse.json(
      { organizationId: ctx.organizationId, ...result },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (e) {
    return verificationErrorResponse(e, 'api.v1.items.verification', ctx);
  }
}
