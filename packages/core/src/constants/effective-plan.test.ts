import { describe, expect, it } from 'vitest';

import {
  planAllowsAutoReorder,
  planAllowsRecurringPos,
  planAllowsRestorePoints,
  resolveEffectivePlan,
  type OrgBillingState,
} from './effective-plan';

const NOW = Date.parse('2026-06-14T00:00:00Z');
const inDays = (d: number) => new Date(NOW + d * 86_400_000).toISOString();

function org(overrides: Partial<OrgBillingState> = {}): OrgBillingState {
  return { plan: 'free', ...overrides };
}

describe('resolveEffectivePlan — precedence: override > stripe > trial > default', () => {
  it('admin override wins over everything (even a live Stripe sub + trial)', () => {
    const r = resolveEffectivePlan(
      org({
        access_tier: 'enterprise',
        plan: 'pro',
        stripe_subscription_id: 'sub_123',
        trial_ends_at: inDays(5),
      }),
      NOW,
    );
    expect(r.tier).toBe('enterprise');
    expect(r.source).toBe('override');
  });

  it('comped full-access = enterprise override + comped arrangement', () => {
    const r = resolveEffectivePlan(
      org({ access_tier: 'enterprise', billing_arrangement: 'comped' }),
      NOW,
    );
    expect(r.tier).toBe('enterprise');
    expect(r.source).toBe('override');
    expect(r.arrangement).toBe('comped');
  });

  it('live Stripe subscription is honored when no override contradicts it', () => {
    const r = resolveEffectivePlan(
      org({ plan: 'business', stripe_subscription_id: 'sub_123' }),
      NOW,
    );
    expect(r.tier).toBe('business');
    expect(r.source).toBe('stripe');
  });

  it('active trial unlocks the configured trial tier', () => {
    const r = resolveEffectivePlan(
      org({ trial_ends_at: inDays(10), trial_tier: 'business' }),
      NOW,
    );
    expect(r.tier).toBe('business');
    expect(r.source).toBe('trial');
    expect(r.trialDaysRemaining).toBe(10);
  });

  it('active trial defaults to the top tier when trial_tier is unset', () => {
    const r = resolveEffectivePlan(org({ trial_ends_at: inDays(3) }), NOW);
    expect(r.tier).toBe('enterprise');
    expect(r.source).toBe('trial');
  });

  it('expired trial falls back to free (no days remaining)', () => {
    const r = resolveEffectivePlan(org({ trial_ends_at: inDays(-1), trial_tier: 'pro' }), NOW);
    expect(r.tier).toBe('free');
    expect(r.source).toBe('default');
    expect(r.trialDaysRemaining).toBeNull();
  });

  it('no override, no stripe, no trial → base plan column, else free', () => {
    expect(resolveEffectivePlan(org({ plan: 'pro' }), NOW).tier).toBe('pro');
    expect(resolveEffectivePlan(org({ plan: null }), NOW).source).toBe('default');
    expect(resolveEffectivePlan(org({ plan: null }), NOW).tier).toBe('free');
  });

  it('trialDaysRemaining ceils partial days and never goes negative', () => {
    const r = resolveEffectivePlan(
      org({ access_tier: 'pro', trial_ends_at: new Date(NOW + 1.2 * 86_400_000).toISOString() }),
      NOW,
    );
    expect(r.trialDaysRemaining).toBe(2);
  });

  it('ignores garbage tier values and falls through safely', () => {
    const r = resolveEffectivePlan(
      org({ access_tier: 'platinum' as unknown as string, plan: 'free' }),
      NOW,
    );
    // unknown override is ignored → falls to default 'free'
    expect(r.tier).toBe('free');
    expect(r.source).toBe('default');
  });

  it('arrangement always defaults to standard when unset', () => {
    expect(resolveEffectivePlan(org(), NOW).arrangement).toBe('standard');
  });
});

describe('planAllowsAutoReorder — Pro and above', () => {
  it('Free tier does NOT get auto-reorder', () => {
    expect(planAllowsAutoReorder(org({ plan: 'free' }), NOW)).toBe(false);
  });

  it('Pro/Business/Enterprise get auto-reorder', () => {
    expect(planAllowsAutoReorder(org({ plan: 'pro' }), NOW)).toBe(true);
    expect(planAllowsAutoReorder(org({ plan: 'business' }), NOW)).toBe(true);
    expect(planAllowsAutoReorder(org({ plan: 'enterprise' }), NOW)).toBe(true);
  });

  it('a Comped/override Enterprise org qualifies even with plan=free', () => {
    expect(
      planAllowsAutoReorder(
        org({ plan: 'free', access_tier: 'enterprise', billing_arrangement: 'comped' }),
        NOW,
      ),
    ).toBe(true);
  });

  it('an active Enterprise trial qualifies', () => {
    expect(
      planAllowsAutoReorder(
        org({ plan: 'free', trial_ends_at: inDays(5), trial_tier: 'pro' }),
        NOW,
      ),
    ).toBe(true);
  });
});

describe('planAllowsRecurringPos — Pro and above', () => {
  it('Free tier does NOT get recurring POs', () => {
    expect(planAllowsRecurringPos(org({ plan: 'free' }), NOW)).toBe(false);
  });

  it('Pro/Business/Enterprise get recurring POs', () => {
    expect(planAllowsRecurringPos(org({ plan: 'pro' }), NOW)).toBe(true);
    expect(planAllowsRecurringPos(org({ plan: 'business' }), NOW)).toBe(true);
    expect(planAllowsRecurringPos(org({ plan: 'enterprise' }), NOW)).toBe(true);
  });

  it('a Comped/override Enterprise org qualifies even with plan=free', () => {
    expect(
      planAllowsRecurringPos(
        org({ plan: 'free', access_tier: 'enterprise', billing_arrangement: 'comped' }),
        NOW,
      ),
    ).toBe(true);
  });
});

describe('planAllowsRestorePoints — Business and above', () => {
  it('Free and Pro do NOT get restore points', () => {
    expect(planAllowsRestorePoints(org({ plan: 'free' }), NOW)).toBe(false);
    expect(planAllowsRestorePoints(org({ plan: 'pro' }), NOW)).toBe(false);
  });

  it('Business and Enterprise get restore points', () => {
    expect(planAllowsRestorePoints(org({ plan: 'business' }), NOW)).toBe(true);
    expect(planAllowsRestorePoints(org({ plan: 'enterprise' }), NOW)).toBe(true);
  });

  it('a Comped/override Enterprise org qualifies with plan=free', () => {
    expect(
      planAllowsRestorePoints(org({ plan: 'free', access_tier: 'enterprise' }), NOW),
    ).toBe(true);
  });
});
