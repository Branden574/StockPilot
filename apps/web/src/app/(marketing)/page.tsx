import { FinalCta } from '@/components/marketing/cta-final';
import { FeatureGrid } from '@/components/marketing/feature-grid';
import { Hero } from '@/components/marketing/hero';

export default function HomePage() {
  return (
    <>
      <Hero />
      <FeatureGrid />
      <FinalCta />
    </>
  );
}
