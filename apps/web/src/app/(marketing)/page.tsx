import { ScrollyLanding } from '@/components/marketing/scrolly-landing';

// New scroll-scrubbed cinematic homepage. The previous section-based homepage
// components (Hero, ScrollyWarehouse, FeatureGrid, ComparisonTable, …) are kept
// in components/marketing/* so this is a one-line revert if needed.
export default function HomePage() {
  return <ScrollyLanding />;
}
