import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { ReceivingChecklistService } from '@/server/services/receiving-checklist';

import {
  checklistBadRequest,
  checklistErrorResponse,
} from '../../../receiving-checks/error-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/receipts/[id]/receiving-check: the receipt's checklist run,
 * made on the live version when it has none (F4-1). A receipt that already has
 * a run answers it (created false), whatever its version or whether a
 * checklist is turned on now. A manager with stock:adjust and
 * purchase_orders:read. Cookie or Bearer. No body.
 *
 * Answers: 200 `{ runId, created, versionNumber }`; 400; 401; 403
 * `details.reason` not_recorder | module_disabled; 404 (another organization's
 * receipt reads as not found); 409 `details.reason` no_checklist |
 * receipt_not_checkable | busy.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success)
    return checklistBadRequest('That receipt id is not valid.');
  try {
    const res = await new ReceivingChecklistService(ctx).start(id);
    return NextResponse.json(res);
  } catch (e) {
    return checklistErrorResponse(e, 'api.v1.receipts.receiving_check', ctx);
  }
}
