import { Check } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Plan {
  name: string;
  price: string;
  desc: string;
  features: string[];
  cta: string;
  href: string;
  featured?: boolean;
}

const PLANS: Plan[] = [
  {
    name: 'Maker',
    price: '$0',
    desc: 'For tiny operations getting started.',
    features: ['Up to 50 SKUs', '1 location', '1 user', 'Email support'],
    cta: 'Start free',
    href: '/signup',
  },
  {
    name: 'Roastery',
    price: '$48',
    desc: 'For growing single-site brands.',
    features: ['500 SKUs · 5 locations', '5 users', 'Cycle counts · POs', 'Cmd-K · API access'],
    cta: 'Start 14-day trial',
    href: '/signup',
    featured: true,
  },
  {
    name: 'Workshop',
    price: '$148',
    desc: 'For multi-site operations.',
    features: ['Unlimited SKUs', 'Unlimited locations', 'Roles & RLS', 'SSO · audit log'],
    cta: 'Talk to us',
    href: '/contact',
  },
];

export function PricingCards() {
  return (
    <section id="pricing" className="mx-auto max-w-[1280px] px-8 py-[72px]">
      <p className="mb-4 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--ed-ink-4)]">
        — Pricing
      </p>
      <h2 className="max-w-3xl font-display text-[clamp(32px,4vw,48px)] font-medium leading-[1.05] tracking-[-0.03em] text-balance">
        Three plans. No <span className="font-serif-italic text-[var(--ed-ink-3)]">seat-tax surprises.</span>
      </h2>

      <div className="mt-7 grid grid-cols-1 gap-3.5 md:grid-cols-3">
        {PLANS.map((p) => (
          <article
            key={p.name}
            className={cn(
              'relative rounded-[10px] border bg-card p-6',
              p.featured ? 'border-[1.5px] border-foreground' : 'border-border',
            )}
          >
            {p.featured && (
              <span
                className="absolute -top-2.5 left-6 inline-flex items-center gap-1 rounded-[4px] bg-[hsl(var(--accent))] px-1.5 py-0.5 text-[11px] font-medium text-[hsl(var(--accent-foreground))]"
              >
                <span className="h-1 w-1 rounded-full bg-current" /> Most chosen
              </span>
            )}
            <div className="font-display text-[16px]">{p.name}</div>
            <div className="mt-1 text-[12px] text-[var(--ed-ink-4)]">{p.desc}</div>

            <div className="mt-4 font-display text-[44px] leading-none tracking-[-0.03em]">
              {p.price}
              <span className="ml-1 text-[13px] font-normal text-[var(--ed-ink-4)]">/mo</span>
            </div>

            <hr className="my-5 border-border" />

            <ul className="mb-4 flex flex-col gap-2">
              {p.features.map((f) => (
                <li key={f} className="flex items-center gap-2 text-[12.5px]">
                  <Check className="h-3 w-3" strokeWidth={2} />
                  {f}
                </li>
              ))}
            </ul>

            <Button
              asChild
              size="lg"
              variant={p.featured ? 'default' : 'outline'}
              className="w-full"
            >
              <Link href={p.href}>{p.cta}</Link>
            </Button>
          </article>
        ))}
      </div>
    </section>
  );
}
