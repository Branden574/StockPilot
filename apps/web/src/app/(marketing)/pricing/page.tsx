import type { Metadata } from 'next';

import { Faq } from '@/components/marketing/faq';
import { PricingCards } from '@/components/marketing/pricing-cards';

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'Simple, transparent pricing. Free, Pro, Business, and Enterprise tiers.',
};

export default function PricingPage() {
  return (
    <>
      <PricingCards />
      <Faq />
    </>
  );
}
