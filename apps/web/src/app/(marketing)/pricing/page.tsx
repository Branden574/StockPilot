import { Check } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import type { LinkPartProps } from '@/components/marketing/content/parts';
import {
  MOST_POPULAR,
  PRICING,
  PRICING_METADATA,
  PRICING_TIERS,
  isLeadIn,
  pricingHelpNote,
  pricingIntroNote,
} from '@/components/marketing/content/pricing';

// The words, tiers and metadata live in components/marketing/content/pricing.tsx,
// shared with the Liquid Glass twin so the two can never drift.
export const metadata: Metadata = PRICING_METADATA;

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-16 sm:px-8">
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="font-display text-[34px] font-medium leading-[1.15] tracking-[-0.025em] sm:text-[40px]">
          {PRICING.heading}
        </h1>
        <p className="text-muted-foreground mt-3 text-[15px] leading-relaxed">{PRICING.lede}</p>
        <div className="border-border bg-sunk text-muted-foreground mt-5 inline-flex rounded-full border px-3 py-1 text-xs">
          {pricingIntroNote({ Anchor, Dot })}
        </div>
      </div>

      <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {PRICING_TIERS.map((t) => (
          <div
            key={t.name}
            className={
              'flex flex-col rounded-lg border p-5 ' +
              (t.highlight
                ? 'border-primary bg-card ring-line-strong ring-1'
                : 'border-border bg-card')
            }
          >
            <div className="flex items-center justify-between">
              <h2 className="font-display text-[17px] font-medium tracking-[-0.01em]">{t.name}</h2>
              {t.highlight && (
                <span className="bg-foreground text-background rounded-full px-2.5 py-0.5 text-[11px] font-medium">
                  {MOST_POPULAR}
                </span>
              )}
            </div>
            <p className="text-muted-foreground mt-1.5 min-h-[34px] text-[13px] leading-relaxed">
              {t.blurb}
            </p>
            <div className="mt-4 flex items-baseline gap-1">
              <span className="font-display text-[30px] font-medium tracking-[-0.025em]">
                {t.price}
              </span>
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
              {t.features.map((f, i) => (
                <li
                  key={f}
                  className={
                    isLeadIn(f, i)
                      ? 'text-muted-foreground text-[12px] font-medium'
                      : 'flex items-start gap-2 text-[13px]'
                  }
                >
                  {isLeadIn(f, i) ? (
                    f
                  ) : (
                    <>
                      <Check className="text-foreground mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} />
                      <span>{f}</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="mx-auto mt-12 max-w-2xl text-center">
        <p className="text-muted-foreground text-sm">{pricingHelpNote({ PageLink, Anchor })}</p>
      </div>
    </div>
  );
}

function Dot() {
  return <span className="mx-1">·</span>;
}

function PageLink({ href, children }: LinkPartProps) {
  return (
    <Link href={href} className="text-foreground underline-offset-4 hover:underline">
      {children}
    </Link>
  );
}

function Anchor({ href, children }: LinkPartProps) {
  return (
    <a href={href} className="text-foreground underline-offset-4 hover:underline">
      {children}
    </a>
  );
}
