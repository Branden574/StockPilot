import { FinalCta } from '@/components/marketing/cta-final';
import { FeatureGrid } from '@/components/marketing/feature-grid';
import { Hero } from '@/components/marketing/hero';
import { ScrollyWarehouse } from '@/components/marketing/scrolly-warehouse';

export default function HomePage() {
  return (
    <>
      <Hero />
      <ScrollyWarehouse />
      <FeatureGrid />
      <FinalCta />
    </>
  );
}
