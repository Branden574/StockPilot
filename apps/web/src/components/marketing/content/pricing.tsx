import type { Metadata } from 'next';

import type { InlineParts } from './parts';

import { COMPANY_NAME, SALES_EMAIL } from '@/lib/site';

/**
 * The pricing page's words and metadata, shared by the classic /pricing page
 * and its glass twin (see ./parts.ts). The wording is the same in every
 * appearance (DECISIONS.md: "/pricing and Terms wording unchanged").
 */
export const PRICING_METADATA: Metadata = {
  // The root layout's title template adds " · StockPilot" (CONFLICTS D15).
  title: 'Pricing',
  description: `Plans for teams of every size. ${COMPANY_NAME} scales from a single warehouse to a multi-org platform — at a fraction of legacy WMS/ERP cost.`,
};

export const PRICING = {
  heading: 'Simple, scalable pricing',
  lede: 'Start free and grow into it. Every plan includes the web app, the native mobile app, and your whole team — and costs a rounding error next to legacy WMS/ERP.',
} as const;

export interface PricingTier {
  name: string;
  price: string;
  cadence: string;
  blurb: string;
  features: string[];
  cta: { label: string; href: string };
  highlight: boolean;
}

/** The words over the highlighted tier. */
export const MOST_POPULAR = 'Most popular';

/**
 * A tier's first feature that introduces the rest ("Everything in Starter,
 * plus:") is a lead-in, not a feature with a check.
 */
export function isLeadIn(feature: string, index: number): boolean {
  return index === 0 && feature.endsWith('plus:');
}

// Priced to the mid-market StockPilot actually competes with (inFlow, Fishbowl,
// Cin7, Zoho all sit ~$89–$999/mo) — while out-featuring the cheap tools and
// undercutting the six-figure enterprise suites. Introductory; adjust freely.
export const PRICING_TIERS: PricingTier[] = [
  {
    name: 'Starter',
    price: '$0',
    cadence: '/ mo',
    blurb: 'Get your inventory under control.',
    features: [
      'Up to 250 items',
      '1 warehouse',
      'Inventory, orders & purchase orders',
      'Native mobile app',
      'CSV import & export',
      '2 users',
    ],
    cta: { label: 'Start free', href: '/signin' },
    highlight: false,
  },
  {
    name: 'Growth',
    price: '$149',
    cadence: '/ mo',
    blurb: 'For a growing business across locations.',
    features: [
      'Everything in Starter, plus:',
      'Unlimited items',
      'Up to 3 warehouses',
      'Cycle counts + barcode scanning',
      'QuickBooks integration',
      'Full audit log',
      'Up to 10 users · email support',
    ],
    cta: { label: 'Get started', href: '/signin' },
    highlight: true,
  },
  {
    name: 'Business',
    price: '$399',
    cadence: '/ mo',
    blurb: 'The full operations stack.',
    features: [
      'Everything in Growth, plus:',
      'Lot / expiry (FEFO) tracking',
      'Returns / RMA workflow',
      'Live delivery tracking',
      'AI insights briefing',
      'Webhooks · Slack · Teams',
      'Public API + keys',
      'Unlimited warehouses · up to 25 users · priority support',
    ],
    cta: { label: 'Get started', href: '/signin' },
    highlight: false,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    cadence: '',
    blurb: 'For multi-org platforms and scale.',
    features: [
      'Everything in Business, plus:',
      'Multi-org control plane',
      'SSO + advanced security',
      'Custom onboarding + SLA',
      'Unlimited users · dedicated support',
    ],
    cta: { label: 'Contact sales', href: `mailto:${SALES_EMAIL}` },
    highlight: false,
  },
];

/** The introductory-pricing note under the heading. */
export function pricingIntroNote({ Anchor, Dot }: Pick<InlineParts, 'Anchor' | 'Dot'>) {
  // prettier-ignore
  return (
    <>
      Introductory pricing — early teams lock in this rate. <Dot />
      <Anchor href={`mailto:${SALES_EMAIL}`}>Talk to us for a quote</Anchor>
    </>
  );
}

/** The help line under the tiers. */
export function pricingHelpNote({ PageLink, Anchor }: Pick<InlineParts, 'PageLink' | 'Anchor'>) {
  // prettier-ignore
  return (
    <>
      Not sure which plan fits?{' '}
      <PageLink href="/contact">
        Get in touch
      </PageLink>{' '}
      and we&apos;ll help you pick — or just{' '}
      <Anchor href="/signin">
        start free
      </Anchor>
      . Prices are introductory and billed monthly; annual plans available.
    </>
  );
}
