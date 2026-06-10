import dynamic from 'next/dynamic';

import { ComparisonTable } from '@/components/marketing/comparison-table';
import { EnterpriseComparison } from '@/components/marketing/enterprise-comparison';
import { FinalCta } from '@/components/marketing/cta-final';
import { FeatureGrid } from '@/components/marketing/feature-grid';
import { Hero } from '@/components/marketing/hero';
import { MarqueeStrip } from '@/components/marketing/marquee-strip';
import { StatBand } from '@/components/marketing/stat-band';

// Both scrollytelling chapters are ~150vh below the fold (Hero takes the
// first viewport-height). Dynamic-import them so their client JS chunks
// don't compete with Hero for hydration on first paint. SSR stays on so
// the markup is still in the initial HTML for SEO + no-flash; only the
// scroll-listener JS defers. Visual behavior unchanged.
const ScrollyWarehouse = dynamic(
  () => import('@/components/marketing/scrolly-warehouse').then((m) => m.ScrollyWarehouse),
);
const ScrollyShelfScan = dynamic(
  () => import('@/components/marketing/scrolly-shelf-scan').then((m) => m.ScrollyShelfScan),
);
const ScrollyPipeline = dynamic(
  () => import('@/components/marketing/scrolly-pipeline').then((m) => m.ScrollyPipeline),
);

export default function HomePage() {
  return (
    <>
      <Hero />
      <ScrollyWarehouse />
      <ScrollyShelfScan />
      <ScrollyPipeline />
      <MarqueeStrip />
      <StatBand />
      <ComparisonTable />
      <EnterpriseComparison />
      <FeatureGrid />
      <FinalCta />
    </>
  );
}
