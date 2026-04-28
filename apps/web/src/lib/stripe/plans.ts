import { type PlanId } from '@stockpilot/core';

export type BillingInterval = 'monthly' | 'yearly';

export function getPriceId(plan: Exclude<PlanId, 'free' | 'enterprise'>, interval: BillingInterval): string | undefined {
  const map: Record<string, string | undefined> = {
    pro_monthly: process.env.NEXT_PUBLIC_STRIPE_PRICE_PRO_MONTHLY,
    pro_yearly: process.env.NEXT_PUBLIC_STRIPE_PRICE_PRO_YEARLY,
    business_monthly: process.env.NEXT_PUBLIC_STRIPE_PRICE_BUSINESS_MONTHLY,
    business_yearly: process.env.NEXT_PUBLIC_STRIPE_PRICE_BUSINESS_YEARLY,
  };
  return map[`${plan}_${interval}`];
}
