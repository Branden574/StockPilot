import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { ReceivingChecklistService } from '@/server/services/receiving-checklist';

import { checklistRetireBodySchema } from '@stockpilot/core';

import { checklistBadRequest, checklistErrorResponse } from '../../receiving-checks/error-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/receiving-checklist/retire: turn the receiving checklist off.
 * Body `{ versionId }`, the live version (409 checklist_changed otherwise).
 * Recorded checklists stay on their receipts. A manager with
 * purchase_orders:manage. Cookie or Bearer.
 *
 * Answers: 200 `{ retired: { id, versionNumber } }`; 400; 401; 403; 409.
 */
export async function POST(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return checklistBadRequest('The request body is not valid JSON.');
  }
  const parsed = checklistRetireBodySchema.safeParse(body);
  if (!parsed.success) return checklistBadRequest('Send the version to turn off.');
  try {
    const retired = await new ReceivingChecklistService(ctx).retire({
      versionId: parsed.data.versionId,
    });
    return NextResponse.json({ retired });
  } catch (e) {
    return checklistErrorResponse(e, 'api.v1.receiving_checklist.retire', ctx);
  }
}
