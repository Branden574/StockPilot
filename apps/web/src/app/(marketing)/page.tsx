import { IntroCriticalStyles } from '@/components/marketing/landing-intro/intro-styles';
import { LandingIntro } from '@/components/marketing/landing-intro/landing-intro';
import { StockPilotLanding } from '@/components/marketing/landing';

// The landing page. `ScrollyLanding` (the scroll-scrubbed 546-frame cinematic
// homepage) was replaced by `StockPilotLanding` — a product-centric sticky
// narrative. Scrollytelling survives; the frame sequence does not. The old
// component and its section-based predecessors are still in components/marketing/*
// so this is a one-line revert.
//
// The branded intro mounts HERE rather than in the (marketing) layout: this page
// is `/` and nothing else, whereas the layout also covers /pricing, /contact,
// /privacy, /security, /support and /terms, which must never show it. The page
// stays a Server Component — LandingIntro is a client boundary, and the landing
// itself renders untouched underneath.
//
// ORDER IS LOAD BEARING. IntroCriticalStyles paints the pre-hydration curtain in
// the first paint; LandingIntro takes over and drives the flight into
// `#sp-nav .brand`, which StockPilotLanding renders.
export default function HomePage() {
  return (
    <>
      <IntroCriticalStyles />
      <LandingIntro />
      <StockPilotLanding />
    </>
  );
}
