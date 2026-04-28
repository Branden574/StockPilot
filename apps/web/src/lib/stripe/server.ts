import 'server-only';

import Stripe from 'stripe';

import { env } from '@/lib/env';

let cached: Stripe | null = null;

export function getStripe(): Stripe {
  if (cached) return cached;
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }
  cached = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-10-28.acacia' as Stripe.LatestApiVersion,
    typescript: true,
    appInfo: {
      name: 'StockPilot',
      version: '0.1.0',
    },
  });
  return cached;
}
