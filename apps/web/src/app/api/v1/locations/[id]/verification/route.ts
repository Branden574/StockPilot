import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { verificationErrorResponse } from '@/lib/verification/error-response';
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
 * items:read (403 without it, or at a required MFA step-up); 404 when the
 * location does not exist in the reader's organization; 400 for a malformed
 * id or page. When the reader's warehouses do not cover the location,
 * `holdingsVisible` is false and no rows are listed (never an empty
 * location). Any other failure is a 500 whose message is "Couldn't load
 * verification". Read-only.
 *
 * `page` is 1-based and defaults to 1; a page past the end answers the last
 * page (the response says which page it is).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;
  const raw = new URL(req.url).searchParams.get('page');
  let page = 1;
  if (raw !== null) {
    if (!/^[1-9]\d{0,5}$/.test(raw)) {
      return NextResponse.json(
        { error: 'validation_error', message: 'The page must be a whole number from 1.' },
        { status: 400 },
      );
    }
    page = Number(raw);
  }

  try {
    const result = await new VerificationService(ctx).location(id, { page });
    return NextResponse.json(
      { organizationId: ctx.organizationId, ...result },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (e) {
    return verificationErrorResponse(e, 'api.v1.locations.verification', ctx);
  }
}
