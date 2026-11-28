import 'server-only';

import {
  isAdminRole,
  type VendorRiskResult,
  type VendorRiskReviewDue,
  type VendorRiskRiskLevel,
} from '@stockpilot/core';

import { ServiceError, type ServiceContext } from '@/server/services/context';
import { assertMayUseSupplierRisk, SupplierRiskService } from '@/server/services/supplier-risk';

/** What the Suppliers list shows in its Risk column for one supplier. */
export interface SupplierRiskListCell {
  result: VendorRiskResult | null;
  residualRisk: VendorRiskRiskLevel | null;
  reviewDue: VendorRiskReviewDue;
  nextReviewOn: string | null;
  /** A draft is waiting to be finished. */
  draft: boolean;
  /** The result was set by an admin over the rules: the cell says so. */
  overridden: boolean;
}

/**
 * The Suppliers list's view of the vendor reviews, for an owner or admin:
 *   - ok: one cell per supplier in the register (a supplier missing from it
 *     has no cell, and the list says "Not reviewed" only for an active one,
 *     and only when the register was read whole: else "Could not check");
 *   - could_not_check: the register could not be read (0481 not there yet,
 *     a failed read): every cell says so, never "Not reviewed";
 *   - step_up: the authenticator step is owed, so nothing was read; the
 *     column points to the register, which asks for it.
 * Null for everyone else: no column and no Review control.
 */
export type SuppliersRiskView =
  | {
      state: 'ok';
      /** The register was read whole: a supplier missing from it was not reviewed. */
      complete: boolean;
      bySupplier: Record<string, SupplierRiskListCell>;
    }
  | { state: 'could_not_check' }
  | { state: 'step_up' };

function stepUpOwed(e: unknown): boolean {
  if (!(e instanceof ServiceError) || e.code !== 'forbidden') return false;
  const reason = e.details?.reason;
  return reason === 'mfa_required' || reason === 'aal2_required';
}

/**
 * Never throws: the Suppliers list must open for an admin even when the
 * vendor reviews cannot be read. The same gate as the register page
 * (assertMayUseSupplierRisk: the module, the authenticator step, the role),
 * asked before anything is read.
 */
export async function loadSuppliersRiskView(
  ctx: ServiceContext,
): Promise<SuppliersRiskView | null> {
  if (!isAdminRole(ctx.role)) return null;
  try {
    assertMayUseSupplierRisk(ctx);
  } catch (e) {
    if (stepUpOwed(e)) return { state: 'step_up' };
    if (e instanceof ServiceError && (e.code === 'forbidden' || e.code === 'module_disabled'))
      return null;
    return { state: 'could_not_check' };
  }
  try {
    const svc = new SupplierRiskService(ctx);
    const read = await svc.register();
    if (read.state !== 'ok') return { state: 'could_not_check' };
    const bySupplier: Record<string, SupplierRiskListCell> = {};
    for (const row of read.value) {
      bySupplier[row.supplierId.toLowerCase()] = {
        result: row.result,
        residualRisk: row.residualRisk,
        reviewDue: row.reviewDue,
        nextReviewOn: row.nextReviewOn,
        draft: row.draftReviewId !== null,
        overridden: row.overridden,
      };
    }
    return { state: 'ok', complete: read.complete, bySupplier };
  } catch (e) {
    if (stepUpOwed(e)) return { state: 'step_up' };
    if (e instanceof ServiceError && e.code === 'forbidden') return null;
    return { state: 'could_not_check' };
  }
}
