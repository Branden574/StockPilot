'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { audit } from '@/server/services/audit';
import { ServiceError, withContext } from '@/server/services/context';

import { err, ok, type ActionResult } from '@stockpilot/core';

// ---------------------------------------------------------------------------
// PO approval threshold — Intacct-grade spend governance, stored in the
// `purchase_orders` module's organization_modules.settings jsonb bucket (NOT a
// dedicated column; no migration). Mirrors planning-settings.ts, the canonical
// per-module settings action: validate payload BEFORE context → withContext()
// → MFA gate (fail CLOSED) → owner/admin gate → module-enabled gate → MERGE
// into settings (never clobber sibling keys) → audit → revalidate.
//
// Enforcement lives in PurchaseOrdersService.assertApprovalThreshold (the
// status → ordered transition), so it applies to every surface — web, the
// mobile Bearer API, and any future caller — automatically.
// ---------------------------------------------------------------------------

const paramsSchema = z.object({
  // Dollar amount at/above which placing a PO requires owner/admin.
  // 0 disables the gate. Upper bound keeps jsonb sane.
  approvalThresholdAmount: z.number().min(0).max(100_000_000).finite(),
});

export type PoApprovalSettingsInput = z.infer<typeof paramsSchema>;

/**
 * Persist the org's PO approval threshold into the `purchase_orders` module's
 * settings. Owner/admin + MFA gated; requires the module enabled.
 */
export async function setPoApprovalSettingsAction(
  input: PoApprovalSettingsInput,
): Promise<ActionResult<PoApprovalSettingsInput>> {
  const parsed = paramsSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid threshold.');
  }
  const params = parsed.data;

  try {
    const ctx = await withContext();
    if (ctx.mfaRequired && !ctx.mfaSatisfied) {
      return err(
        'forbidden',
        'Multi-factor authentication required. Enroll in MFA before performing this action.',
      );
    }
    if (ctx.role !== 'owner' && ctx.role !== 'admin') {
      return err('forbidden', 'Only owners and admins can change the PO approval threshold.');
    }
    if (!ctx.enabledModules.has('purchase_orders')) {
      return err('forbidden', 'Purchase orders are not enabled for this organization.');
    }

    const supabase = ctx.supabase;

    // Merge — never clobber other keys the module's settings bucket carries.
    const { data: existing, error: readError } = await supabase
      .from('organization_modules')
      .select('settings')
      .eq('organization_id', ctx.organizationId)
      .eq('module_id', 'purchase_orders')
      .maybeSingle();
    if (readError) throw new ServiceError('internal_error', readError.message);

    const prev = (existing as { settings?: unknown } | null)?.settings;
    const prevSettings = prev && typeof prev === 'object' ? (prev as Record<string, unknown>) : {};
    const settings = { ...prevSettings, approvalThresholdAmount: params.approvalThresholdAmount };

    const { data: updated, error } = await supabase
      .from('organization_modules')
      .update({ settings })
      .eq('organization_id', ctx.organizationId)
      .eq('module_id', 'purchase_orders')
      .select('module_id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    // Fail closed: a 0-row update (RLS miss / missing row) must not report a
    // silent success or audit a change that never persisted.
    if (!updated) throw new ServiceError('not_found', 'Purchase orders module settings row not found.');

    await audit({
      event: 'po_approval_threshold.updated',
      entityType: 'organization_module',
      entityId: 'purchase_orders',
      after: { approvalThresholdAmount: params.approvalThresholdAmount },
    });

    revalidatePath('/dashboard/purchase-orders');

    return ok(params);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
