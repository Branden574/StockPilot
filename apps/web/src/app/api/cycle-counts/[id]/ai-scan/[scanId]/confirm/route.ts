import { NextResponse, type NextRequest } from 'next/server';

import { isUuid } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { serviceErrorResponse } from '@/server/lib/service-error-response';
import { CycleCountsService } from '@/server/services/cycle-counts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * AI Shelf Scan v1 — POST endpoint to mark a scan confirmed once
 * the mobile review screen has finished writing each line's
 * counted_quantity via the existing record endpoint.
 *
 * Separating the scan-confirm marker from the per-line writes keeps
 * the writes flowing through the same offline-tolerant path the
 * manual + barcode flows use. If the user loses connection after
 * the lines record but before the scan marker writes, the next
 * reconnect can replay this idempotent confirm without re-writing
 * the lines.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; scanId: string }> },
) {
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const { scanId } = await params;
  if (!isUuid(scanId)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }
  try {
    const svc = new CycleCountsService(ctx);
    await svc.markAiScanConfirmed(scanId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serviceErrorResponse(e, 'cycle_counts.ai_scan.confirm', {
      organizationId: ctx.organizationId,
    });
  }
}
