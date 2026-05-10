import 'server-only';

import { env } from '@/lib/env';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStripe } from '@/lib/stripe/server';
import { getPriceId, type BillingInterval } from '@/lib/stripe/plans';

import { type PlanId } from '@stockpilot/core';

import {
  assertPermission,
  assertRoleUnchanged,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';

export class BillingService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new BillingService(await withContext());
  }

  async getOrgBilling() {
    const { data, error } = await this.ctx.supabase
      .from('organizations')
      .select('id, name, plan, stripe_customer_id, stripe_subscription_id, trial_ends_at')
      .eq('id', this.ctx.organizationId)
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    return data;
  }

  async createCheckoutSession(plan: Exclude<PlanId, 'free' | 'enterprise'>, interval: BillingInterval) {
    assertPermission(this.ctx, 'billing:manage');
    await assertRoleUnchanged(this.ctx);

    const priceId = getPriceId(plan, interval);
    if (!priceId) {
      throw new ServiceError(
        'validation_error',
        `Stripe price ID not configured for ${plan}/${interval}. Set NEXT_PUBLIC_STRIPE_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()} in .env.local.`,
      );
    }

    const stripe = getStripe();
    const org = await this.getOrgBilling();

    let customerId = org.stripe_customer_id as string | null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: org.name as string,
        metadata: { organization_id: this.ctx.organizationId },
      });
      customerId = customer.id;
      // Persist via admin client to avoid RLS narrowing on the client.
      await createAdminClient()
        .from('organizations')
        .update({ stripe_customer_id: customerId })
        .eq('id', this.ctx.organizationId);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      success_url: `${env.NEXT_PUBLIC_APP_URL}/dashboard/settings/billing?status=success`,
      cancel_url: `${env.NEXT_PUBLIC_APP_URL}/dashboard/settings/billing?status=cancelled`,
      subscription_data: {
        metadata: { organization_id: this.ctx.organizationId, plan },
      },
      metadata: { organization_id: this.ctx.organizationId, plan, interval },
    });

    if (!session.url) throw new ServiceError('internal_error', 'Stripe did not return a checkout URL');
    return { url: session.url };
  }

  async createPortalSession() {
    assertPermission(this.ctx, 'billing:manage');
    await assertRoleUnchanged(this.ctx);
    const stripe = getStripe();
    const org = await this.getOrgBilling();
    if (!org.stripe_customer_id) {
      throw new ServiceError('not_found', 'No Stripe customer yet. Subscribe to a plan first.');
    }
    const portal = await stripe.billingPortal.sessions.create({
      customer: org.stripe_customer_id as string,
      return_url: `${env.NEXT_PUBLIC_APP_URL}/dashboard/settings/billing`,
    });
    return { url: portal.url };
  }
}

/**
 * Webhook-side: looks up an org by its Stripe customer ID and updates plan
 * + subscription metadata. Uses the admin client (bypasses RLS).
 */
export async function syncSubscriptionFromStripe(params: {
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  status: string;
  plan: PlanId;
  trialEndsAt: string | null;
}) {
  const admin = createAdminClient();
  await admin
    .from('organizations')
    .update({
      stripe_subscription_id: params.stripeSubscriptionId,
      plan: params.status === 'canceled' ? 'free' : params.plan,
      trial_ends_at: params.trialEndsAt,
    })
    .eq('stripe_customer_id', params.stripeCustomerId);
}
