import { FinalCta } from '@/components/marketing/cta-final';
import { FeatureGrid } from '@/components/marketing/feature-grid';
import { Hero } from '@/components/marketing/hero';
import { PricingCards } from '@/components/marketing/pricing-cards';
import { ScrollyFeature } from '@/components/marketing/scrolly-feature';
import { StatRow } from '@/components/marketing/stat-row';

/**
 * Marketing landing — quiet editorial design from the Claude Design hand-off.
 * Order matches the prototype: hero (with dashboard preview) → trust stats →
 * feature grid → 4-scene scrollytelling → pricing → final CTA.
 */
export default function HomePage() {
  return (
    <>
      <Hero />
      <StatRow />
      <FeatureGrid />
      <ScrollyFeature />
      <PricingCards />
      <FinalCta />
    </>
  );
}
