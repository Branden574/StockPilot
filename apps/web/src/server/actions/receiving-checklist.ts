'use server';

import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';

import { reportError } from '@/lib/error-reporter';
import { ServiceError } from '@/server/services/context';
import { ReceivingChecklistService } from '@/server/services/receiving-checklist';

import {
  checklistPublishBodySchema,
  checklistRetireBodySchema,
  checklistSaveBodySchema,
  err,
  ok,
  uuidSchema,
  type ActionResult,
  type ChecklistResults,
} from '@stockpilot/core';

/**
 * Server actions for the receiving checklist (F4-1): thin wrappers over
 * ReceivingChecklistService, the same methods the /api/v1 routes call for the
 * phone, so the web and the phone apply one set of rules. A refusal keeps the
 * service's app-authored `details` (the reason, the steps it names) and never
 * database text.
 */

function fail<T>(e: unknown, tag: string): ActionResult<T> {
  unstable_rethrow(e);
  if (e instanceof ServiceError) {
    if (e.code === 'internal_error') void reportError(e, { tag });
    return err(e.code, e.message, e.code !== 'internal_error' ? e.details : undefined);
  }
  void reportError(e, { tag });
  return err('internal_error', 'Something went wrong. Please try again.');
}

const CHECKLIST_PAGE = '/dashboard/purchase-orders/receiving-checklist';

export async function publishReceivingChecklistAction(
  input: unknown,
): Promise<ActionResult<{ id: string; versionNumber: number }>> {
  const parsed = checklistPublishBodySchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', 'That checklist could not be read. Reload and try again.');
  try {
    const svc = await ReceivingChecklistService.forCurrentUser();
    const v = await svc.publish({
      title: parsed.data.title,
      steps: parsed.data.steps,
      procedureId: parsed.data.procedureId ?? null,
      expectedCurrentId: parsed.data.expectedCurrentId,
      clientPublishId: parsed.data.clientPublishId,
    });
    revalidatePath(CHECKLIST_PAGE);
    return ok({ id: v.id, versionNumber: v.versionNumber });
  } catch (e) {
    return fail(e, 'actions.receiving_checklist.publish');
  }
}

export async function retireReceivingChecklistAction(
  input: unknown,
): Promise<ActionResult<{ id: string; versionNumber: number }>> {
  const parsed = checklistRetireBodySchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'That checklist version is not valid.');
  try {
    const svc = await ReceivingChecklistService.forCurrentUser();
    const v = await svc.retire({ versionId: parsed.data.versionId });
    revalidatePath(CHECKLIST_PAGE);
    return ok(v);
  } catch (e) {
    return fail(e, 'actions.receiving_checklist.retire');
  }
}

export async function startReceivingCheckAction(
  receiptId: string,
  poId?: string | null,
): Promise<ActionResult<{ runId: string; created: boolean; versionNumber: number | null }>> {
  if (!uuidSchema.safeParse(receiptId).success)
    return err('validation_error', 'That receipt id is not valid.');
  try {
    const svc = await ReceivingChecklistService.forCurrentUser();
    const res = await svc.start(receiptId);
    if (poId && uuidSchema.safeParse(poId).success)
      revalidatePath(`/dashboard/purchase-orders/${poId}`);
    return ok(res);
  } catch (e) {
    return fail(e, 'actions.receiving_checklist.start');
  }
}

export async function saveReceivingCheckAction(
  runId: string,
  input: unknown,
): Promise<
  ActionResult<{
    id: string;
    status: 'in_progress' | 'completed';
    revision: number;
    results: ChecklistResults;
    note: string | null;
    completedAt: string | null;
  }>
> {
  if (!uuidSchema.safeParse(runId).success)
    return err('validation_error', 'That checklist id is not valid.');
  const parsed = checklistSaveBodySchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', 'Those answers could not be read. Reload and try again.');
  try {
    const svc = await ReceivingChecklistService.forCurrentUser();
    const saved = await svc.saveRun({
      runId,
      results: parsed.data.results,
      note: parsed.data.note ?? null,
      expectedRevision: parsed.data.expectedRevision,
      saveId: parsed.data.saveId,
      complete: parsed.data.complete,
    });
    revalidatePath(`/dashboard/purchase-orders/receiving-checks/${runId}`);
    return ok(saved);
  } catch (e) {
    return fail(e, 'actions.receiving_checklist.save');
  }
}
