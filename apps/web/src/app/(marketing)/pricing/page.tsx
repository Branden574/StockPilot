import { Check } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { COMPANY_NAME, SALES_EMAIL } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Pricing · StockPilot',
  description: `Simple plans for teams of every size. ${COMPANY_NAME} scales from a single warehouse to a multi-org platform.`,
};

interface Tier {
  name: string;
  price: string;
  cadence: string;
  blurb: string;
  features: string[];
  cta: { label: string; href: string };
  highlight: boolean;
}

// NOTE: placeholder pricing — illustrative only. Update the numbers + features
// when real plans are finalized; the "early access" banner below sets that
// expectation for visitors in the meantime.
const TIERS: Tier[] = [
  {
    name: 'Starter',
    price: '$0',
    cadence: '/ month',
    blurb: 'For a single team getting its inventory under control.',
    features: [
      'Up to 500 items',
      '1 warehouse',
      'Orders + purchase orders',
      'Native mobile app',
      'CSV import & export',
    ],
    cta: { label: 'Open the app', href: '/signin' },
    highlight: false,
  },
  {
    name: 'Growth',
    price: '$49',
    cadence: '/ month',
    blurb: 'For growing operations across multiple locations.',
    features: [
      'Unlimited items',
      'Multiple warehouses',
      'Cycle counts + lot / expiry tracking',
      'AI insights briefing',
      'Webhooks, Slack & Teams alerts',
      'QuickBooks export',
      'Priority support',
    ],
    cta: { label: 'Open the app', href: '/signin' },
    highlight: true,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    cadence: '',
    blurb: 'For multi-org platforms, custom industries, and deep integrations.',
    features: [
      'Everything in Growth',
      'Public API + API keys',
      'Multi-org control plane',
      'Advanced security & SSO',
      'Custom onboarding + SLA',
    ],
    cta: { label: 'Contact sales', href: `mailto:${SALES_EMAIL}` },
    highlight: false,
  },
];

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-8">
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="text-4xl font-semibold tracking-tight">Simple, scalable pricing</h1>
        <p className="text-muted-foreground mt-3 text-[15px] leading-relaxed">
          Start free and grow into it. Every plan includes the web app, the native mobile app, and
          your whole team.
        </p>
        <div className="border-border bg-muted/40 text-muted-foreground mt-5 inline-flex rounded-full border px-3 py-1 text-xs">
          Early access — pricing below is illustrative. <span className="mx-1">·</span>
          <a href={`mailto:${SALES_EMAIL}`} className="text-foreground underline-offset-4 hover:underline">
            Talk to us for a quote
          </a>
        </div>
      </div>

      <div className="mt-12 grid gap-5 lg:grid-cols-3">
        {TIERS.map((t) => (
          <div
            key={t.name}
            className={
              'flex flex-col rounded-2xl border p-6 ' +
              (t.highlight
                ? 'border-primary bg-card shadow-sm ring-1 ring-[var(--ed-line-strong)]'
                : 'border-border bg-card')
            }
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">{t.name}</h2>
              {t.highlight && (
                <span className="bg-foreground text-background rounded-full px-2.5 py-0.5 text-[11px] font-medium">
                  Most popular
                </span>
              )}
            </div>
            <p className="text-muted-foreground mt-1.5 text-[13px] leading-relaxed">{t.blurb}</p>
            <div className="mt-5 flex items-baseline gap-1">
              <span className="text-3xl font-semibold tracking-tight">{t.price}</span>
              {t.cadence && <span className="text-muted-foreground text-sm">{t.cadence}</span>}
            </div>

            <a
              href={t.cta.href}
              className={
                'mt-5 inline-flex h-10 items-center justify-center rounded-md px-4 text-sm font-medium transition-colors ' +
                (t.highlight
                  ? 'bg-foreground text-background hover:opacity-90'
                  : 'border-border hover:bg-muted border')
              }
            >
              {t.cta.label}
            </a>

            <ul className="mt-6 space-y-2.5">
              {t.features.map((f) => (
                <li key={f} className="flex items-start gap-2 text-[13px]">
                  <Check className="text-foreground mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="mx-auto mt-12 max-w-2xl text-center">
        <p className="text-muted-foreground text-sm">
          Not sure which plan fits? <Link href="/contact" className="text-foreground underline-offset-4 hover:underline">Get in touch</Link>{' '}
          and we&apos;ll help you pick — or just{' '}
          <a href="/signin" className="text-foreground underline-offset-4 hover:underline">open the app</a> and start free.
        </p>
      </div>
    </div>
  );
}
