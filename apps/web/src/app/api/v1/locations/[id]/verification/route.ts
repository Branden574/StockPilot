import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import {
  verificationErrorResponse,
  verificationUnauthenticatedResponse,
} from '@/lib/verification/error-response';
import { assertPermission, ServiceError } from '@/server/services/context';
import { VerificationService } from '@/server/services/verification';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/locations/[id]/verification?page=N — the location page (F1-3):
 * the location, the open exceptions recorded there, and a page of 50 holdings
 * (items the reader can open, by name) each with its item's verification
 * summary and open exceptions, plus totals across EVERY holding (not just the
 * page), and whether the reader may start "Recount items here".
 *
 * Cookie or Bearer (withApiContext), the same gates as the web page:
 * items:read (403 without it, or at a required MFA step-up), checked before
 * anything about the request is judged; 404 when the location does not exist
 * in the reader's organization; 400 for a malformed id or page. Every refusal
 * has the one error shape and is never cached (verificationErrorResponse; a
 * 401 carries a message too). When the reader's warehouses do not cover the
 * location, `holdingsVisible` is false and no rows are listed (never an empty
 * location). Any other failure is a 500 whose message is "Couldn't load
 * verification". Read-only.
 *
 * `page` is 1-based and defaults to 1; a page past the end answers the last
 * page (the response says which page it is).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return verificationUnauthenticatedResponse();

  const { id } = await params;
  try {
    // The service's own gate, FIRST: a caller without items:read, or short of
    // the MFA step-up, is refused before the page is judged.
    assertPermission(ctx, 'items:read');
    const page = pageParam(new URL(req.url).searchParams.get('page'));
    const result = await new VerificationService(ctx).location(id, { page });
    return NextResponse.json(
      { organizationId: ctx.organizationId, ...result },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (e) {
    return verificationErrorResponse(e, 'api.v1.locations.verification', ctx);
  }
}

/** `?page=`: 1-based, 1 when absent. Anything else is a validation error
 *  (400, in the routes' one error shape). */
function pageParam(raw: string | null): number {
  if (raw === null) return 1;
  if (!/^[1-9]\d{0,5}$/.test(raw)) {
    throw new ServiceError('validation_error', 'The page must be a whole number from 1.', {
      reason: 'invalid_page',
    });
  }
  return Number(raw);
}
