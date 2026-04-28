'use client';

import { ChevronDown } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

const FAQS = [
  {
    q: 'Is there a free plan?',
    a: 'Yes. Free covers 1 user, up to 100 items, and 1 location — perfect for getting started or running a small project.',
  },
  {
    q: 'Do you offer a free trial of paid plans?',
    a: 'Pro and Business plans include a 14-day free trial. No credit card required up front.',
  },
  {
    q: 'Can I import my existing spreadsheet?',
    a: "Yes. Drop in a CSV and we'll show you a validation report with errors and warnings before anything is imported.",
  },
  {
    q: 'How does barcode scanning work?',
    a: "Open the StockPilot app on your phone, point the camera, and the item card slides up. One tap to add or remove stock.",
  },
  {
    q: 'Does StockPilot work on mobile?',
    a: 'Yes — native iOS and Android apps, plus a fully responsive web app. Same data, same speed.',
  },
  {
    q: 'How is my data isolated from other accounts?',
    a: 'Every record is scoped to your organization at the database level via Postgres row-level security. Your data is never visible to other tenants.',
  },
  {
    q: 'Can I cancel anytime?',
    a: 'Yes. Subscriptions can be cancelled or downgraded from the customer portal at any time. No phone calls, no retention scripts.',
  },
];

export function Faq() {
  return (
    <section id="faq" className="container mx-auto max-w-3xl px-4 py-24 sm:px-6">
      <div className="text-center">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">FAQ</p>
        <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
          Questions, answered.
        </h2>
      </div>
      <div className="mt-12 divide-y divide-border rounded-2xl border bg-card">
        {FAQS.map((f, i) => (
          <FaqItem key={i} q={f.q} a={f.a} />
        ))}
      </div>
    </section>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left transition-colors hover:bg-accent/30"
        aria-expanded={open}
      >
        <span className="text-base font-medium">{q}</span>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      <div
        className={cn(
          'grid overflow-hidden px-6 transition-[grid-template-rows] duration-300 ease-out',
          open ? 'grid-rows-[1fr] pb-5' : 'grid-rows-[0fr]',
        )}
      >
        <div className="overflow-hidden">
          <p className="text-sm text-muted-foreground">{a}</p>
        </div>
      </div>
    </div>
  );
}
