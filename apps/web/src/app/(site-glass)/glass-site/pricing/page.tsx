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
import { SiteNav } from '@/components/marketing/glass/site-nav';
import { buttonClass } from '@/components/marketing/glass/ui';
import '@/styles/liquid-glass/pages/site.css';

// The classic page's metadata, from the same module (R8: search sees one page).
export const metadata: Metadata = PRICING_METADATA;

/**
 * Site-Pricing.dc.html's frame (the centred header with its eyebrow, cards at
 * radius 24 with check lists) drawn around the classic page's tiers and words:
 * "/pricing wording unchanged in every appearance" (DECISIONS.md, plan Q4), so
 * the board's quote-only copy and its three info cards are not drawn and every
 * tier, price, feature and link of the classic page is (recorded deviation).
 */
export default function GlassPricingPage() {
  return (
    <>
      <SiteNav active="pricing" />
      <main className="lgs-main lgs-wrap mx-auto flex w-full max-w-[1240px] flex-col gap-10 px-5 pb-24 pt-16 sm:px-10">
        <header className="lgs-head mx-auto flex max-w-[760px] flex-col items-center gap-4 text-center">
          <span className="lgs-eyebrow lgs-accent text-xs font-semibold uppercase tracking-[0.06em]">
            Pricing
          </span>
          <h1 className="lgs-h2 text-4xl font-semibold">{PRICING.heading}</h1>
          <p className="lgs-lede text-lg">{PRICING.lede}</p>
          <p className="lgs-note lgs-glass inline-flex flex-wrap items-center justify-center gap-x-1 px-4 py-2 text-sm">
            {pricingIntroNote({ Anchor, Dot })}
          </p>
        </header>
        <div className="lgs-tiers grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {PRICING_TIERS.map((tier) => (
            <div
              key={tier.name}
              className="lgs-card lgs-tier flex flex-col gap-4 p-6"
              data-highlight={tier.highlight ? '' : undefined}
            >
              <div className="flex items-center justify-between gap-2">
                <h2 className="lgs-card-title text-lg font-semibold">{tier.name}</h2>
                {tier.highlight ? (
                  <span className="lgs-badge lgs-tone-accent rounded-md px-2 text-xs font-semibold">
                    {MOST_POPULAR}
                  </span>
                ) : null}
              </div>
              <p className="lgs-ink2 min-h-[42px] text-sm">{tier.blurb}</p>
              <div className="flex items-baseline gap-1">
                <span className="lgs-price text-3xl font-semibold">{tier.price}</span>
                {tier.cadence ? <span className="lgs-muted text-sm">{tier.cadence}</span> : null}
              </div>
              <a
                href={tier.cta.href}
                className={`${buttonClass(tier.highlight ? 'primary' : 'secondary', 'lg', false)} w-full`}
              >
                {tier.cta.label}
              </a>
              <ul className="lgs-checks flex flex-col gap-2 text-sm">
                {tier.features.map((feature, index) =>
                  isLeadIn(feature, index) ? (
                    <li key={feature} className="lgs-lead-in text-xs font-semibold">
                      {feature}
                    </li>
                  ) : (
                    <li key={feature} className="flex items-start gap-2">
                      <Check className="lgs-check mt-0.5 size-4 shrink-0" aria-hidden="true" />
                      <span>{feature}</span>
                    </li>
                  ),
                )}
              </ul>
            </div>
          ))}
        </div>
        <p className="lgs-ink2 mx-auto max-w-2xl text-center text-sm">
          {pricingHelpNote({ PageLink, Anchor })}
        </p>
      </main>
    </>
  );
}

function Dot() {
  return (
    <span className="lgs-muted mx-1" aria-hidden="true">
      ·
    </span>
  );
}

function PageLink({ href, children }: LinkPartProps) {
  return (
    <Link href={href} className="lgs-a underline underline-offset-2">
      {children}
    </Link>
  );
}

function Anchor({ href, children }: LinkPartProps) {
  return (
    <a href={href} className="lgs-a underline underline-offset-2">
      {children}
    </a>
  );
}
