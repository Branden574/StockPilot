import { FinalCta } from '@/components/marketing/cta-final';
import { Faq } from '@/components/marketing/faq';
import { FeatureGrid } from '@/components/marketing/feature-grid';
import { Hero } from '@/components/marketing/hero';
import { PricingCards } from '@/components/marketing/pricing-cards';
import { UseCases } from '@/components/marketing/use-cases';

export default function HomePage() {
  return (
    <>
      <Hero />
      <FeatureGrid />
      <UseCases />
      <PricingCards />
      <Faq />
      <FinalCta />
    </>
  );
}
