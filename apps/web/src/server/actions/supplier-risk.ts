'use server';

import { revalidatePath } from 'next/cache';

import { actionErrorResult } from '@/server/lib/action-error-result';
import {
  SUPPLIER_RISK_COULD_NOT_CHECK,
  SUPPLIER_RISK_INVALID_REQUEST,
  SupplierRiskService,
  supplierRiskDiscardSchema,
  supplierRiskDraftSchema,
  supplierRiskFinishSchema,
  supplierRiskItemUpdateSchema,
  supplierRiskLatestSchema,
  type SupplierRiskFinishResult,
  type SupplierRiskItem,
  type SupplierRiskLatest,
} from '@/server/services/supplier-risk';

import { err, ok, type ActionResult } from '@stockpilot/core';

/**
 * Vendor risk reviews (part 7 of the security tools): the four writes an owner
 * or admin makes on /dashboard/suppliers/[id]/risk, and one read (the newest
 * versions, for a finish another admin got to first). Each argument is checked
 * with zod before anything is asked (a refused one answers validation_error
 * and nothing runs); then SupplierRiskService holds the rule, in the order the
 * module, the authenticator step, the role, the support seat, core's checks,
 * the database's function (which checks the role, the authenticator rule and
 * the support seat again). A refusal keeps the words the service wrote
 * (core's, by the database's refusal word) and its details (the step-up
 * reason the page reads); anything else is the shared fixed sentence.
 */

const SUPPLIERS = '/dashboard/suppliers';
const REGISTER = '/dashboard/suppliers/risk';
const reviewPage = (supplierId: string) => `/dashboard/suppliers/${supplierId}/risk`;

/** A request the schema refused: one fixed sentence, nothing asked. */
function invalid(): ActionResult<never> {
  return err('validation_error', SUPPLIER_RISK_INVALID_REQUEST);
}

function revalidate(supplierId: string): void {
  revalidatePath(reviewPage(supplierId));
  revalidatePath(REGISTER);
  revalidatePath(SUPPLIERS);
}

export async function saveSupplierRiskDraftAction(
  input: unknown,
): Promise<ActionResult<{ reviewId: string; updatedAt: string | null }>> {
  const parsed = supplierRiskDraftSchema.safeParse(input);
  if (!parsed.success) return invalid();
  try {
    const svc = await SupplierRiskService.forCurrentUser();
    const saved = await svc.saveDraft(parsed.data);
    revalidate(parsed.data.supplierId);
    return ok({ reviewId: saved.reviewId, updatedAt: saved.updatedAt });
  } catch (e) {
    return actionErrorResult(e, 'actions.supplier_risk.draft_save');
  }
}

export async function finishSupplierRiskReviewAction(
  input: unknown,
): Promise<ActionResult<SupplierRiskFinishResult>> {
  const parsed = supplierRiskFinishSchema.safeParse(input);
  if (!parsed.success) return invalid();
  try {
    const svc = await SupplierRiskService.forCurrentUser();
    const finished = await svc.finish(parsed.data);
    revalidate(parsed.data.supplierId);
    return ok(finished);
  } catch (e) {
    return actionErrorResult(e, 'actions.supplier_risk.finish');
  }
}

export async function discardSupplierRiskDraftAction(
  input: unknown,
): Promise<ActionResult<{ discarded: boolean }>> {
  const parsed = supplierRiskDiscardSchema.safeParse(input);
  if (!parsed.success) return invalid();
  try {
    const svc = await SupplierRiskService.forCurrentUser();
    const discarded = await svc.discardDraft(parsed.data.supplierId);
    revalidate(parsed.data.supplierId);
    return ok({ discarded });
  } catch (e) {
    return actionErrorResult(e, 'actions.supplier_risk.draft_discard');
  }
}

export async function updateSupplierRiskItemAction(
  input: unknown,
): Promise<ActionResult<{ item: SupplierRiskItem }>> {
  const parsed = supplierRiskItemUpdateSchema.safeParse(input);
  if (!parsed.success) return invalid();
  try {
    const svc = await SupplierRiskService.forCurrentUser();
    const item = await svc.updateItem(parsed.data);
    revalidatePath('/dashboard/suppliers/[id]/risk', 'page');
    revalidatePath(REGISTER);
    revalidatePath(SUPPLIERS);
    return ok({ item });
  } catch (e) {
    return actionErrorResult(e, 'actions.supplier_risk.item_update');
  }
}

/**
 * The open draft and the current review as they are now, for the review form
 * to show beside the person's own answers when a finish was refused because
 * the draft moved (another admin, or another window). A read: nothing is
 * written or revalidated. Could not check is said, never "no other version".
 */
export async function loadSupplierRiskLatestAction(
  input: unknown,
): Promise<ActionResult<SupplierRiskLatest>> {
  const parsed = supplierRiskLatestSchema.safeParse(input);
  if (!parsed.success) return invalid();
  try {
    const svc = await SupplierRiskService.forCurrentUser();
    const read = await svc.latest(parsed.data.supplierId);
    if (read.state !== 'ok') {
      return err('conflict', SUPPLIER_RISK_COULD_NOT_CHECK, {
        reason: 'could_not_check',
        retryable: true,
      });
    }
    return ok(read.value);
  } catch (e) {
    return actionErrorResult(e, 'actions.supplier_risk.latest');
  }
}
