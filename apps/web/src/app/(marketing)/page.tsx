import { LandingIntro } from '@/components/marketing/landing-intro/landing-intro';
import { IntroCriticalStyles } from '@/components/marketing/landing-intro/intro-styles';
import { ScrollyLanding } from '@/components/marketing/scrolly-landing';

// New scroll-scrubbed cinematic homepage. The previous section-based homepage
// components (Hero, ScrollyWarehouse, FeatureGrid, ComparisonTable, …) are kept
// in components/marketing/* so this is a one-line revert if needed.
//
// The branded intro mounts HERE rather than in the (marketing) layout: this page
// is `/` and nothing else, whereas the layout also covers /pricing, /contact,
// /privacy, /security, /support and /terms, which must never show it. The page
// stays a Server Component — LandingIntro is the only client boundary, and the
// landing itself renders untouched underneath.
export default function HomePage() {
  return (
    <>
      <IntroCriticalStyles />
      <LandingIntro />
      <ScrollyLanding />
    </>
  );
}
