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
 * GET /api/v1/po/[id]/receiving-checks: the organization's checklist versions
 * and this PO's runs, for the phone's Receipt history chips (F4-1). Cookie or
 * Bearer; purchase_orders:read; a PO the caller cannot see is 404.
 *
 * `checks.ok` false means the checklist reads failed: the phone says
 * "Checklist status didn't load" and never blocks posting.
 *
 * Answers: 200 `{ checks: { ok: true, versions, runs } | { ok: false } }`; 400; 401; 403; 404.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success)
    return checklistBadRequest('That purchase order id is not valid.');
  try {
    const checks = await new ReceivingChecklistService(ctx).checksForPo(id);
    return NextResponse.json({ checks }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return checklistErrorResponse(e, 'api.v1.po.receiving_checks', ctx);
  }
}
