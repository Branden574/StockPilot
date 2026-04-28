'use client';

import { Check } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { PLANS, type PlanId, isUnlimited } from '@stockpilot/core';

type Interval = 'monthly' | 'yearly';

const PLAN_ORDER: PlanId[] = ['free', 'pro', 'business', 'enterprise'];

export function PricingCards() {
  const [interval, setInterval] = React.useState<Interval>('monthly');

  return (
    <section id="pricing" className="container mx-auto max-w-7xl px-4 py-24 sm:px-6">
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">Pricing</p>
        <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
          Simple pricing. No surprises.
        </h2>
        <p className="mt-4 text-balance text-muted-foreground">
          Start free. Upgrade when you outgrow it. Cancel anytime.
        </p>

        <div className="mt-8 inline-flex items-center rounded-full border bg-muted/40 p-1 text-sm">
          {(['monthly', 'yearly'] as Interval[]).map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => setInterval(opt)}
              className={cn(
                'rounded-full px-4 py-1.5 transition-colors',
                interval === opt
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {opt === 'monthly' ? 'Monthly' : 'Yearly'}
              {opt === 'yearly' && (
                <Badge variant="secondary" className="ml-2">
                  Save 17%
                </Badge>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-12 grid gap-6 lg:grid-cols-4">
        {PLAN_ORDER.map((id) => {
          const plan = PLANS[id];
          const price =
            plan.monthlyPrice < 0
              ? null
              : interval === 'monthly'
                ? plan.monthlyPrice
                : plan.yearlyPrice / 12;

          const isHighlight = plan.highlight;

          return (
            <div
              key={id}
              className={cn(
                'relative flex flex-col rounded-2xl border bg-card p-6 shadow-sm transition-shadow',
                isHighlight && 'border-primary/40 shadow-lg ring-1 ring-primary/30',
              )}
            >
              {isHighlight && (
                <Badge className="absolute -top-3 left-1/2 -translate-x-1/2 bg-gradient-to-r from-primary to-blue-500">
                  Recommended
                </Badge>
              )}
              <h3 className="text-lg font-semibold">{plan.name}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{plan.description}</p>

              <div className="mt-5 flex items-baseline gap-1">
                {price === null ? (
                  <span className="text-3xl font-semibold">Custom</span>
                ) : (
                  <>
                    <span className="text-4xl font-semibold tabular-nums">
                      ${price.toFixed(0)}
                    </span>
                    <span className="text-sm text-muted-foreground">/ user / mo</span>
                  </>
                )}
              </div>
              {interval === 'yearly' && price !== null && price > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Billed annually · ${plan.yearlyPrice}/yr
                </p>
              )}

              <Button
                asChild
                variant={isHighlight ? 'gradient' : id === 'free' ? 'outline' : 'default'}
                className="mt-6"
              >
                <Link href={id === 'enterprise' ? '/contact' : '/signup'}>{plan.cta}</Link>
              </Button>

              <ul className="mt-6 space-y-2 text-sm">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-auto pt-6 text-xs text-muted-foreground">
                {isUnlimited(plan.limits.items) ? 'Unlimited items' : `${plan.limits.items.toLocaleString()} items`} ·{' '}
                {isUnlimited(plan.limits.members) ? 'Unlimited users' : `${plan.limits.members} users`}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
