import { NextResponse, type NextRequest } from 'next/server';
import type Stripe from 'stripe';

import { env } from '@/lib/env';
import { getStripe } from '@/lib/stripe/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { syncSubscriptionFromStripe } from '@/server/services/billing';

import type { PlanId } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return new NextResponse('Webhook secret not configured', { status: 500 });
  }

  const sig = req.headers.get('stripe-signature');
  if (!sig) return new NextResponse('Missing signature', { status: 400 });

  const body = await req.text();
  const stripe = getStripe();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('[stripe] signature verification failed', e);
    return new NextResponse('Invalid signature', { status: 400 });
  }

  // Idempotency: short-circuit if we've seen this event before.
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from('billing_events')
    .select('id, processed_at')
    .eq('stripe_event_id', event.id)
    .maybeSingle();
  if (existing?.processed_at) {
    return NextResponse.json({ received: true, idempotent: true });
  }

  if (!existing) {
    await admin.from('billing_events').insert({
      stripe_event_id: event.id,
      type: event.type,
      payload: event as unknown as Record<string, unknown>,
    });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const customerId = (session.customer as string) ?? null;
        const subscriptionId = (session.subscription as string) ?? null;
        const plan = (session.metadata?.plan as PlanId) ?? 'pro';

        let trialEndsAt: string | null = null;
        if (subscriptionId) {
          const sub = await stripe.subscriptions.retrieve(subscriptionId);
          trialEndsAt = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;
        }

        if (customerId) {
          await syncSubscriptionFromStripe({
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscriptionId,
            status: 'active',
            plan,
            trialEndsAt,
          });
        }
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.created': {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = sub.customer as string;
        const planFromMeta = (sub.metadata?.plan as PlanId | undefined) ?? 'pro';
        const trialEndsAt = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;

        await syncSubscriptionFromStripe({
          stripeCustomerId: customerId,
          stripeSubscriptionId: sub.id,
          status: sub.status,
          plan: planFromMeta,
          trialEndsAt,
        });
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        await syncSubscriptionFromStripe({
          stripeCustomerId: sub.customer as string,
          stripeSubscriptionId: null,
          status: 'canceled',
          plan: 'free',
          trialEndsAt: null,
        });
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        console.warn('[stripe] payment failed for customer', invoice.customer);
        // Phase 6+: dispatch low-stock-style notification here.
        break;
      }

      default:
        // Ignore other events.
        break;
    }

    await admin
      .from('billing_events')
      .update({ processed_at: new Date().toISOString() })
      .eq('stripe_event_id', event.id);

    return NextResponse.json({ received: true });
  } catch (e) {
    console.error('[stripe] handler error', e);
    return new NextResponse('Handler error', { status: 500 });
  }
}
