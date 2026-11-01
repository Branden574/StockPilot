import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { ReceivingChecklistService } from '@/server/services/receiving-checklist';

import { checklistPublishBodySchema } from '@stockpilot/core';

import { checklistBadRequest, checklistErrorResponse } from '../receiving-checks/error-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/receiving-checklist: the receiving checklist editor (F4-1): the
 * live version, earlier versions and what the caller may do. Cookie or
 * Bearer. Receiving on and purchase_orders:read (403 otherwise).
 *
 * Answers: 200 `{ editor }`; 401; 403 `details.reason` mfa or module.
 */
export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    const editor = await new ReceivingChecklistService(ctx).getEditor();
    return NextResponse.json({ editor }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return checklistErrorResponse(e, 'api.v1.receiving_checklist.get', ctx);
  }
}

/**
 * POST /api/v1/receiving-checklist: publish version N+1 (retiring the live
 * one). Body `{ title, steps, procedureId?, expectedCurrentId, clientPublishId }`:
 * expectedCurrentId is the live version the editor was opened on (null when
 * none was live); a resent clientPublishId answers the version it made. A
 * manager with purchase_orders:manage (the MFA step-up fires first).
 *
 * Answers: 200 `{ version }`; 400 (`details.invalid` names the step or field);
 * 401; 403 `details.reason` not_publisher | module_disabled; 409
 * `details.reason` checklist_changed | busy.
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
  const parsed = checklistPublishBodySchema.safeParse(body);
  if (!parsed.success)
    return checklistBadRequest(
      'Send a title, the steps, the version you started from and a publish id.',
    );
  try {
    const version = await new ReceivingChecklistService(ctx).publish({
      title: parsed.data.title,
      steps: parsed.data.steps,
      procedureId: parsed.data.procedureId ?? null,
      expectedCurrentId: parsed.data.expectedCurrentId,
      clientPublishId: parsed.data.clientPublishId,
    });
    return NextResponse.json({ version });
  } catch (e) {
    return checklistErrorResponse(e, 'api.v1.receiving_checklist.publish', ctx);
  }
}
