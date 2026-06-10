import { LifeBuoy, Mail, ShieldCheck } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { COMPANY_NAME, PRIVACY_EMAIL, SALES_EMAIL, SUPPORT_EMAIL } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Contact · StockPilot',
  description: `Get in touch with the ${COMPANY_NAME} team — support, sales, and privacy requests.`,
};

const CARDS = [
  {
    icon: LifeBuoy,
    title: 'Something broken?',
    body: 'Report an issue and track it to resolution. The fastest way to reach us when something is not working.',
    cta: { href: '/support', label: 'Open a support ticket', internal: true },
  },
  {
    icon: Mail,
    title: 'Sales & general',
    body: 'Questions about plans, onboarding a new team, or anything else.',
    cta: { href: `mailto:${SALES_EMAIL}`, label: SALES_EMAIL, internal: false },
  },
  {
    icon: ShieldCheck,
    title: 'Privacy requests',
    body: 'Exercise your data rights (access, deletion, correction) or ask a privacy question.',
    cta: { href: `mailto:${PRIVACY_EMAIL}`, label: PRIVACY_EMAIL, internal: false },
  },
] as const;

export default function ContactPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 sm:px-8">
      <h1 className="text-4xl font-semibold tracking-tight">Contact us</h1>
      <p className="text-muted-foreground mt-3 max-w-xl text-[15px] leading-relaxed">
        We&apos;re a small team and we read everything. Pick the channel that fits — for anything
        that&apos;s actually broken, a support ticket gets you a tracked response fastest.
      </p>

      <div className="mt-10 grid gap-4 sm:grid-cols-3">
        {CARDS.map((c) => {
          const Icon = c.icon;
          return (
            <div
              key={c.title}
              className="border-border bg-card flex flex-col rounded-xl border p-5"
            >
              <Icon className="text-foreground h-5 w-5" strokeWidth={1.7} />
              <h2 className="mt-3 text-sm font-semibold">{c.title}</h2>
              <p className="text-muted-foreground mt-1.5 flex-1 text-[13px] leading-relaxed">
                {c.body}
              </p>
              {c.cta.internal ? (
                <Link
                  href={c.cta.href}
                  className="text-foreground mt-3 inline-block text-[13px] font-medium underline-offset-4 hover:underline"
                >
                  {c.cta.label} →
                </Link>
              ) : (
                <a
                  href={c.cta.href}
                  className="text-foreground mt-3 inline-block break-all text-[13px] font-medium underline-offset-4 hover:underline"
                >
                  {c.cta.label}
                </a>
              )}
            </div>
          );
        })}
      </div>

      <div className="border-border text-muted-foreground mt-10 rounded-xl border border-dashed p-5 text-[13px] leading-relaxed">
        <p>
          <span className="text-foreground font-medium">General support:</span>{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="underline-offset-4 hover:underline">
            {SUPPORT_EMAIL}
          </a>
          . We aim to respond within 1–2 business days. For urgent outages affecting your team, open
          a <Link href="/support" className="underline-offset-4 hover:underline">support ticket</Link>{' '}
          and mark it high priority.
        </p>
      </div>
    </div>
  );
}
