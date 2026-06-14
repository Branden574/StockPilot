import { PLAN_IDS, type PlanId } from './plans';

/**
 * The billing-relevant shape of an organization row. Mirrors the columns
 * the Stripe webhook + the platform-admin billing panel write. All admin
 * override fields are nullable (NULL = "no override").
 */
export interface OrgBillingState {
  /** The base plan column (set by Stripe webhook / default 'free'). */
  plan: string | null;
  /** Admin-forced tier override. NULL = defer to Stripe/trial/default. */
  access_tier?: string | null;
  /** standard|comped|trial|custom|stripe (display/intent). */
  billing_arrangement?: string | null;
  /** A live Stripe subscription id, if any. */
  stripe_subscription_id?: string | null;
  /** Manual or Stripe trial end. */
  trial_ends_at?: string | null;
  /** Tier the trial unlocks (default top sellable tier). */
  trial_tier?: string | null;
}

export type EffectivePlanSource = 'override' | 'stripe' | 'trial' | 'default';

export interface EffectivePlan {
  /** The tier of access the org actually gets right now. */
  tier: PlanId;
  /** Why that tier — which precedence branch won. */
  source: EffectivePlanSource;
  /** Whole days left in an active trial, else null. `now` drives this. */
  trialDaysRemaining: number | null;
  /** The billing arrangement label for display (never null — defaults to 'standard'). */
  arrangement: string;
}

function asPlanId(value: string | null | undefined): PlanId | null {
  return value && (PLAN_IDS as readonly string[]).includes(value) ? (value as PlanId) : null;
}

/** Top sellable tier — what a trial unlocks by default. */
const DEFAULT_TRIAL_TIER: PlanId = 'enterprise';

/**
 * Single source of truth for "what tier does this org actually get, and why."
 *
 * PRECEDENCE (decided in design): admin override → live Stripe subscription
 * → active trial → free. A manual override ALWAYS wins; a Stripe subscription
 * is honored only when no override contradicts it. So the two billing systems
 * can never disagree on what the org can access.
 *
 * Pure + deterministic: pass `now` (ms) so callers/tests control the clock.
 */
export function resolveEffectivePlan(
  org: OrgBillingState,
  now: number = Date.now(),
): EffectivePlan {
  const arrangement = org.billing_arrangement ?? 'standard';

  const trialEndMs = org.trial_ends_at ? Date.parse(org.trial_ends_at) : NaN;
  const trialActive = Number.isFinite(trialEndMs) && trialEndMs > now;
  const trialDaysRemaining = trialActive
    ? Math.max(0, Math.ceil((trialEndMs - now) / 86_400_000))
    : null;

  // 1. Admin override wins outright.
  const override = asPlanId(org.access_tier);
  if (override) {
    return { tier: override, source: 'override', trialDaysRemaining, arrangement };
  }

  // 2. Live Stripe subscription — trust the `plan` column the webhook set.
  if (org.stripe_subscription_id) {
    const stripePlan = asPlanId(org.plan) ?? 'free';
    return { tier: stripePlan, source: 'stripe', trialDaysRemaining, arrangement };
  }

  // 3. Active trial — unlock the configured trial tier (default: top tier).
  if (trialActive) {
    const trialTier = asPlanId(org.trial_tier) ?? DEFAULT_TRIAL_TIER;
    return { tier: trialTier, source: 'trial', trialDaysRemaining, arrangement };
  }

  // 4. Fall back to the base plan column, else free.
  return {
    tier: asPlanId(org.plan) ?? 'free',
    source: 'default',
    trialDaysRemaining: null,
    arrangement,
  };
}
