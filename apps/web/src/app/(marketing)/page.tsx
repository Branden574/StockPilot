import { AiPeek } from '@/components/marketing/ai-peek';
import { FinalCta } from '@/components/marketing/cta-final';
import { Faq } from '@/components/marketing/faq';
import { FeatureGrid } from '@/components/marketing/feature-grid';
import { Hero } from '@/components/marketing/hero';
import { MobileMockup } from '@/components/marketing/mobile-mockup';
import { PricingCards } from '@/components/marketing/pricing-cards';
import { ScrollyFeature } from '@/components/marketing/scrolly-feature';
import { UseCases } from '@/components/marketing/use-cases';

export default function HomePage() {
  return (
    <>
      <Hero />
      <FeatureGrid />
      <ScrollyFeature />
      <MobileMockup />
      <UseCases />
      <AiPeek />
      <PricingCards />
      <Faq />
      <FinalCta />
    </>
  );
}
