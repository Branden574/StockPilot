'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { audit } from '@/server/services/audit';
import { ServiceError, withContext } from '@/server/services/context';

import { err, ok, type ActionResult } from '@stockpilot/core';

// ---------------------------------------------------------------------------
// Per-org demand-planning parameters. Stored in the `planning` module's
// organization_modules.settings jsonb bucket (NOT a dedicated column), so the
// platform's per-module settings pattern carries it. Mirrors the nav/order-
// status settings actions: validate payload BEFORE context → withContext()
// (honor org MFA policy) → MFA gate (fail CLOSED) → owner/admin gate → planning-
// enabled gate (defense-in-depth; the page is already module-gated, but a direct
// call must not configure a disabled module) → MERGE into settings (never clobber
// other keys) → audit → revalidate.
//
// PlanningService.readParams() re-coerces every value to a positive finite
// number on read (fail-closed), but this action is the trust boundary that
// decides what is persisted, so the ranges here are authoritative.
// ---------------------------------------------------------------------------

const paramsSchema = z.object({
  // Days from PO placement to stock-on-shelf. 1 day .. ~6 months.
  leadTimeDays: z.number().int().min(1).max(180),
  // Safety-stock multiplier on lead-time demand. 1.0 (none) .. 3.0 (+200%).
  safetyMultiplier: z.number().min(1).max(3),
  // Velocity lookback window. 2 weeks .. 1 year.
  velocityWindowDays: z.number().int().min(14).max(365),
});

export type PlanningParamsInput = z.infer<typeof paramsSchema>;

/**
 * Persist the org's demand-planning parameters into the `planning` module's
 * settings. Owner/admin + MFA gated; requires the planning module enabled.
 */
export async function setPlanningParamsAction(
  input: PlanningParamsInput,
): Promise<ActionResult<{ params: PlanningParamsInput }>> {
  // Validate BEFORE touching context so a bad payload is cheap to reject.
  const parsed = paramsSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid planning settings.');
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
      return err('forbidden', 'Only owners and admins can change planning settings.');
    }
    // Defense-in-depth: never configure params for a module this org hasn't
    // enabled (the page is gated, but a direct action call must fail closed).
    if (!ctx.enabledModules.has('planning')) {
      return err('forbidden', 'Demand Planning is not enabled for this organization.');
    }

    const supabase = ctx.supabase;

    // Read existing settings so the merge preserves any other keys the planning
    // module may carry (forward-compat — never clobber the whole bucket).
    const { data: existing, error: readError } = await supabase
      .from('organization_modules')
      .select('settings')
      .eq('organization_id', ctx.organizationId)
      .eq('module_id', 'planning')
      .maybeSingle();
    if (readError) throw new ServiceError('internal_error', readError.message);

    const prev = (existing as { settings?: unknown } | null)?.settings;
    const prevSettings = prev && typeof prev === 'object' ? (prev as Record<string, unknown>) : {};
    const settings = { ...prevSettings, ...params };

    const { error } = await supabase
      .from('organization_modules')
      .update({ settings })
      .eq('organization_id', ctx.organizationId)
      .eq('module_id', 'planning');
    if (error) throw new ServiceError('internal_error', error.message);

    await audit({
      event: 'planning_params.updated',
      entityType: 'organization_module',
      entityId: 'planning',
      after: { params },
    });

    revalidatePath('/dashboard/planning');

    return ok({ params });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
