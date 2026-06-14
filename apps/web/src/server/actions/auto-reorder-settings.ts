'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { audit } from '@/server/services/audit';
import { ServiceError, withContext } from '@/server/services/context';

import {
  err,
  hasPermission,
  ok,
  planAllowsAutoReorder,
  type ActionResult,
  type OrgBillingState,
} from '@stockpilot/core';

// ---------------------------------------------------------------------------
// Per-org automatic-reordering settings, stored in the `purchase_orders`
// module's organization_modules.settings jsonb under the `autoReorder` key
// (no migration — the per-module settings pattern, mirrors planning-settings):
// validate → withContext (honor org MFA policy) → MFA gate (fail CLOSED) →
// purchase_orders:manage gate → module-enabled gate → PLAN gate (Pro+ on the
// effective plan) → MERGE into settings (never clobber) → audit → revalidate.
// ---------------------------------------------------------------------------

const schema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['draft', 'send']),
  // Optional auto-send cap in cents; a supplier PO over this falls back to a
  // draft even in send mode. null = no cap.
  maxAutoSendCents: z.number().int().nonnegative().max(1_000_000_00).nullable(),
});

export type AutoReorderSettingsInput = z.infer<typeof schema>;

export async function setAutoReorderSettingsAction(
  input: AutoReorderSettingsInput,
): Promise<ActionResult<{ settings: AutoReorderSettingsInput }>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid settings.');
  }
  const settings = parsed.data;

  try {
    const ctx = await withContext();
    if (ctx.mfaRequired && !ctx.mfaSatisfied) {
      return err(
        'forbidden',
        'Multi-factor authentication required. Enroll in MFA before performing this action.',
      );
    }
    if (!hasPermission(ctx.role, 'purchase_orders:manage')) {
      return err('forbidden', 'You do not have permission to manage purchase orders.');
    }
    if (!ctx.enabledModules.has('purchase_orders')) {
      return err('forbidden', 'Purchase Orders is not enabled for this organization.');
    }

    const supabase = ctx.supabase;

    // PLAN GATE (Pro+) — checked on the EFFECTIVE plan so a Comped/override org
    // qualifies. Only enforced when ENABLING (you can always turn it off).
    if (settings.enabled) {
      const { data: orgRow, error: orgErr } = await supabase
        .from('organizations')
        .select(
          'plan, access_tier, billing_arrangement, stripe_subscription_id, trial_ends_at, trial_tier',
        )
        .eq('id', ctx.organizationId)
        .single();
      if (orgErr) throw new ServiceError('internal_error', orgErr.message);
      if (!planAllowsAutoReorder((orgRow as OrgBillingState | null) ?? { plan: null })) {
        return err(
          'plan_limit_exceeded',
          'Automatic reordering is a Pro feature. Upgrade to Pro or above to enable it.',
        );
      }
    }

    // Merge into the purchase_orders module settings (never clobber other keys).
    const { data: existing, error: readError } = await supabase
      .from('organization_modules')
      .select('settings')
      .eq('organization_id', ctx.organizationId)
      .eq('module_id', 'purchase_orders')
      .maybeSingle();
    if (readError) throw new ServiceError('internal_error', readError.message);

    const prev = (existing as { settings?: unknown } | null)?.settings;
    const prevSettings = prev && typeof prev === 'object' ? (prev as Record<string, unknown>) : {};
    const nextSettings = { ...prevSettings, autoReorder: settings };

    const { data: updated, error } = await supabase
      .from('organization_modules')
      .update({ settings: nextSettings })
      .eq('organization_id', ctx.organizationId)
      .eq('module_id', 'purchase_orders')
      .select('organization_id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    // Fail closed: a 0-row update means the module row is missing — never
    // report a silent success.
    if (!updated) {
      throw new ServiceError('internal_error', 'Purchase Orders module is not initialized.');
    }

    await audit({
      event: 'auto_reorder_settings.updated',
      entityType: 'organization_module',
      entityId: 'purchase_orders',
      after: { autoReorder: settings },
    });

    revalidatePath('/dashboard/planning');
    return ok({ settings });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
