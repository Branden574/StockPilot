'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { checkPlatformAdmin } from '@/lib/auth/platform-admin';
import { setBilling, startTrial } from '@/server/services/platform/billing';

import { err, ok, PLAN_IDS, type ActionResult } from '@stockpilot/core';

const planEnum = z.enum(PLAN_IDS);

const setBillingSchema = z.object({
  organizationId: z.string().uuid(),
  accessTier: planEnum.nullable(),
  arrangement: z.enum(['standard', 'comped', 'trial', 'custom', 'stripe']),
  customPriceCents: z.number().int().nonnegative().max(100_000_000).nullable(),
  customPriceInterval: z.enum(['month', 'year']).nullable(),
  allModulesComp: z.boolean(),
  billingNotes: z.string().max(2000).nullable(),
});

const startTrialSchema = z.object({
  organizationId: z.string().uuid(),
  days: z.number().int().min(1).max(365),
  trialTier: planEnum,
});

/**
 * Save an org's billing override. DANGEROUS action → platform-admin + fresh
 * AAL2 step-up. Returns `aal2_required` so the UI can re-prompt for MFA.
 */
export async function setOrgBillingAction(
  input: z.infer<typeof setBillingSchema>,
): Promise<ActionResult<{ ok: true }>> {
  const parsed = setBillingSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid');

  // A comped/custom arrangement with no access tier grants only 'free' while
  // the UI shows a "Comped" badge — reject so the operator picks a real tier.
  if (
    (parsed.data.arrangement === 'comped' || parsed.data.arrangement === 'custom') &&
    !parsed.data.accessTier
  ) {
    return err('validation_error', 'Select an access tier for a comped/custom arrangement.');
  }

  const gate = await checkPlatformAdmin({ requireStepUp: true });
  if (!gate.ok) {
    return gate.reason === 'aal2_required'
      ? err('forbidden', 'Re-authenticate with MFA to change billing.', { reason: 'aal2_required' })
      : err('forbidden', 'Not authorized.');
  }

  try {
    await setBilling({
      actorUserId: gate.session.userId,
      actorEmail: gate.session.email,
      organizationId: parsed.data.organizationId,
      accessTier: parsed.data.accessTier,
      arrangement: parsed.data.arrangement,
      customPriceCents: parsed.data.customPriceCents,
      customPriceInterval: parsed.data.customPriceInterval,
      allModulesComp: parsed.data.allModulesComp,
      billingNotes: parsed.data.billingNotes,
    });
  } catch (e) {
    return err('internal_error', e instanceof Error ? e.message : 'Failed to save billing');
  }

  revalidatePath(`/platform/orgs/${parsed.data.organizationId}`);
  return ok({ ok: true });
}

/** Start/reset a manual trial. DANGEROUS → platform-admin + step-up. */
export async function startOrgTrialAction(
  input: z.infer<typeof startTrialSchema>,
): Promise<ActionResult<{ ok: true }>> {
  const parsed = startTrialSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid');

  const gate = await checkPlatformAdmin({ requireStepUp: true });
  if (!gate.ok) {
    return gate.reason === 'aal2_required'
      ? err('forbidden', 'Re-authenticate with MFA to change billing.', { reason: 'aal2_required' })
      : err('forbidden', 'Not authorized.');
  }

  try {
    await startTrial({
      actorUserId: gate.session.userId,
      actorEmail: gate.session.email,
      organizationId: parsed.data.organizationId,
      days: parsed.data.days,
      trialTier: parsed.data.trialTier,
      now: Date.now(),
    });
  } catch (e) {
    return err('internal_error', e instanceof Error ? e.message : 'Failed to start trial');
  }

  revalidatePath(`/platform/orgs/${parsed.data.organizationId}`);
  return ok({ ok: true });
}
