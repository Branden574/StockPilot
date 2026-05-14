import { NextResponse, type NextRequest } from 'next/server';
import type Stripe from 'stripe';

import { env } from '@/lib/env';
import { getStripe } from '@/lib/stripe/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { syncSubscriptionFromStripe } from '@/server/services/billing';

import { PLANS, type PlanId } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Resolve the org's PlanId from a Stripe event. We trust two signals,
 * in order: (1) Stripe metadata.plan that matches a known PLANS key,
 * (2) the subscription's price ID via STRIPE_PRICE_TO_PLAN. If
 * neither is conclusive, default to 'free' (NOT 'pro') and log a
 * warning — silent upgrades to a paid plan because metadata went
 * missing is exactly the bug this guards against.
 */
function priceIdToPlanMap(): Record<string, PlanId> {
  // Optional env-driven map: STRIPE_PRICE_TO_PLAN='{"price_xxx":"pro","price_yyy":"business"}'.
  // Kept lazy so a malformed env var only blows up here, not at module load.
  const raw = (process.env.STRIPE_PRICE_TO_PLAN ?? '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    const out: Record<string, PlanId> = {};
    for (const [priceId, planId] of Object.entries(parsed)) {
      if (planId in PLANS) out[priceId] = planId as PlanId;
    }
    return out;
  } catch (e) {
    console.warn('[stripe webhook] STRIPE_PRICE_TO_PLAN is not valid JSON', e);
    return {};
  }
}

function resolvePlanFromStripe(
  metadataPlan: string | undefined,
  priceId: string | undefined,
): PlanId {
  if (metadataPlan && metadataPlan in PLANS) return metadataPlan as PlanId;
  if (priceId) {
    const map = priceIdToPlanMap();
    if (map[priceId]) return map[priceId];
  }
  console.warn(
    '[stripe webhook] Plan not resolvable from metadata or price id; defaulting to free.',
    { metadataPlan, priceId },
  );
  return 'free';
}

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

  // Idempotency: claim the event with an INSERT ... ON CONFLICT.
  // Previous shape (SELECT-then-INSERT) had a TOCTOU window where
  // two concurrent deliveries of the same event_id could both pass
  // the existence check, both insert (only one wins on the unique
  // constraint), and both run the handler. The atomic claim closes
  // that — only the first delivery sees `inserted=true`; others
  // short-circuit. Stripe only retries minutes apart, so the
  // window is narrow, but the fix is one line so we take it.
  const admin = createAdminClient();
  const { data: claimRows } = await admin
    .from('billing_events')
    .upsert(
      {
        stripe_event_id: event.id,
        type: event.type,
        payload: event as unknown as Record<string, unknown>,
      },
      { onConflict: 'stripe_event_id', ignoreDuplicates: true },
    )
    .select('id, processed_at');
  const claimed = (claimRows ?? [])[0];
  if (!claimed) {
    // ignoreDuplicates returns no row when the event_id was already
    // present. Look up its processed_at to decide if we should
    // short-circuit (already done) or, in the rare case the prior
    // worker crashed mid-handler, let this delivery re-run.
    const { data: existing } = await admin
      .from('billing_events')
      .select('processed_at')
      .eq('stripe_event_id', event.id)
      .maybeSingle();
    if (existing?.processed_at) {
      return NextResponse.json({ received: true, idempotent: true });
    }
    // Existing row but never marked processed — fall through and
    // run the handler. The processed_at update below makes the
    // re-run idempotent the next time around.
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const customerId = (session.customer as string) ?? null;
        const subscriptionId = (session.subscription as string) ?? null;

        let trialEndsAt: string | null = null;
        let priceId: string | undefined;
        if (subscriptionId) {
          const sub = await stripe.subscriptions.retrieve(subscriptionId);
          trialEndsAt = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;
          priceId = sub.items.data[0]?.price?.id;
        }
        const plan = resolvePlanFromStripe(session.metadata?.plan, priceId);

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
        const priceId = sub.items.data[0]?.price?.id;
        const planFromMeta = resolvePlanFromStripe(sub.metadata?.plan, priceId);
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
