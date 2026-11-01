import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { ReceivingChecklistService } from '@/server/services/receiving-checklist';

import { checklistSaveBodySchema } from '@stockpilot/core';

import { checklistBadRequest, checklistErrorResponse } from '../error-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/receiving-checks/[id]: one receiving checklist run for its
 * screen (F4-1): the run, its version's steps, the receipt and its lines, the
 * PO and "About this delivery". Visible exactly when the PO is
 * (purchase_orders:read; 404 otherwise). Cookie or Bearer.
 *
 * Answers: 200 `{ run }`; 400; 401; 403; 404.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success)
    return checklistBadRequest('That checklist id is not valid.');
  try {
    const run = await new ReceivingChecklistService(ctx).getRun(id);
    return NextResponse.json({ run }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return checklistErrorResponse(e, 'api.v1.receiving_checks.get', ctx);
  }
}

/**
 * POST /api/v1/receiving-checks/[id]: save the run's answers, and complete it
 * when `complete` is true. Body `{ results, note?, expectedRevision, saveId,
 * complete }`: expectedRevision is the revision the screen loaded (409
 * checklist_run_changed when someone saved since); a resent saveId answers
 * the run as it stands. A manager with stock:adjust and purchase_orders:read.
 *
 * Answers: 200 `{ run: { id, status, revision, results, note, completedAt } }`;
 * 400 `details.reason` checklist_invalid (with the step key) |
 * checklist_incomplete (with missing, failedWithoutNote,
 * photoStepsWithoutPhoto); 401; 403; 404; 409 `details.reason`
 * checklist_run_changed | checklist_run_completed | busy.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success)
    return checklistBadRequest('That checklist id is not valid.');
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return checklistBadRequest('The request body is not valid JSON.');
  }
  const parsed = checklistSaveBodySchema.safeParse(body);
  if (!parsed.success)
    return checklistBadRequest(
      'Send the answers, the revision, a save id and whether to complete.',
    );
  try {
    const run = await new ReceivingChecklistService(ctx).saveRun({
      runId: id,
      results: parsed.data.results,
      note: parsed.data.note ?? null,
      expectedRevision: parsed.data.expectedRevision,
      saveId: parsed.data.saveId,
      complete: parsed.data.complete,
    });
    return NextResponse.json({ run });
  } catch (e) {
    return checklistErrorResponse(e, 'api.v1.receiving_checks.save', ctx);
  }
}
