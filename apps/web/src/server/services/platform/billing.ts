import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';

import { PLAN_IDS, type PlanId } from '@stockpilot/core';

import { recordPlatformAudit } from './audit';

/**
 * Platform-admin billing control. Writes the admin-override dials on an org
 * (service-role; the org may not be one the operator belongs to). Every write
 * is audited as 'billing_changed'. The CALLER must have passed the platform-
 * admin gate WITH step-up (billing is one of the two dangerous actions).
 *
 * Precedence is enforced by resolveEffectivePlan at read time (override >
 * stripe > trial > default), so these writes never need to touch the Stripe
 * `plan` column — they set access_tier/arrangement and the resolver wins.
 */

const ARRANGEMENTS = ['standard', 'comped', 'trial', 'custom', 'stripe'] as const;
export type BillingArrangement = (typeof ARRANGEMENTS)[number];

export interface SetBillingInput {
  actorUserId: string;
  actorEmail: string;
  organizationId: string;
  /** Forced access tier, or null to clear the override (defer to Stripe/default). */
  accessTier: PlanId | null;
  arrangement: BillingArrangement;
  customPriceCents: number | null;
  customPriceInterval: 'month' | 'year' | null;
  allModulesComp: boolean;
  billingNotes: string | null;
}

function isPlanId(v: string | null): v is PlanId {
  return v !== null && (PLAN_IDS as readonly string[]).includes(v);
}

export async function setBilling(input: SetBillingInput): Promise<void> {
  if (input.accessTier !== null && !isPlanId(input.accessTier)) {
    throw new Error('Invalid access tier');
  }
  if (!ARRANGEMENTS.includes(input.arrangement)) {
    throw new Error('Invalid billing arrangement');
  }

  const admin = createAdminClient();
  const { data: updated, error } = await admin
    .from('organizations')
    .update({
      access_tier: input.accessTier,
      billing_arrangement: input.arrangement,
      custom_price_cents: input.arrangement === 'custom' ? input.customPriceCents : null,
      custom_price_interval: input.arrangement === 'custom' ? input.customPriceInterval : null,
      all_modules_comp: input.allModulesComp,
      billing_notes: input.billingNotes,
      // Clear any prior trial when moving to a non-trial arrangement — otherwise
      // a future trial_ends_at silently keeps premium access (resolveEffectivePlan
      // honors the trial when access_tier is null). startTrial owns trial setup.
      ...(input.arrangement !== 'trial' ? { trial_ends_at: null, trial_tier: null } : {}),
    })
    .eq('id', input.organizationId)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message);
  // Fail closed: a 0-row update means the org id was wrong/gone — never report
  // a silent success or audit a no-op change.
  if (!updated) throw new Error('Organization not found.');

  await recordPlatformAudit({
    actorUserId: input.actorUserId,
    actorEmail: input.actorEmail,
    action: 'billing_changed',
    targetOrganizationId: input.organizationId,
    detail: {
      accessTier: input.accessTier,
      arrangement: input.arrangement,
      customPriceCents: input.arrangement === 'custom' ? input.customPriceCents : null,
      allModulesComp: input.allModulesComp,
    },
  });
}

export interface StartTrialInput {
  actorUserId: string;
  actorEmail: string;
  organizationId: string;
  days: number;
  trialTier: PlanId;
  now: number;
}

/**
 * Starts (or resets) a manual trial: stamps trial_started_at = now,
 * trial_ends_at = now + days, sets the trial tier + arrangement, and clears
 * any access_tier override so the trial actually drives access via the
 * resolver. Audited.
 */
export async function startTrial(input: StartTrialInput): Promise<void> {
  if (!isPlanId(input.trialTier)) throw new Error('Invalid trial tier');
  const days = Math.min(Math.max(Math.round(input.days), 1), 365);
  const startedAt = new Date(input.now).toISOString();
  const endsAt = new Date(input.now + days * 86_400_000).toISOString();

  const admin = createAdminClient();
  const { data: updated, error } = await admin
    .from('organizations')
    .update({
      access_tier: null, // trial drives access via the resolver, not an override
      billing_arrangement: 'trial',
      trial_started_at: startedAt,
      trial_ends_at: endsAt,
      trial_tier: input.trialTier,
    })
    .eq('id', input.organizationId)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!updated) throw new Error('Organization not found.');

  await recordPlatformAudit({
    actorUserId: input.actorUserId,
    actorEmail: input.actorEmail,
    action: 'billing_changed',
    targetOrganizationId: input.organizationId,
    detail: { trial: { days, trialTier: input.trialTier, endsAt } },
  });
}
