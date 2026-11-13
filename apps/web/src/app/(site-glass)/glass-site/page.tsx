import { LandingHero } from '@/components/marketing/glass/landing/hero';
import {
  CloseSection,
  CountsSection,
  FaqSection,
  MobileSection,
  OrdersSection,
  ProductSection,
  ReportsSection,
  RolesSection,
  StorySection,
  WorkflowSection,
} from '@/components/marketing/glass/landing/sections';
import { SiteNav } from '@/components/marketing/glass/site-nav';
import '@/styles/liquid-glass/pages/site.css';
import '@/styles/liquid-glass/pages/landing.css';

/**
 * The Liquid Glass landing (Landing.dc.html, Landing-Mobile.dc.html,
 * Landing-Dark.dc.html), served at / when glass is selected (next.config.ts
 * rewrites; plans/REVISION-DEFAULT.md R8). Static, like the classic landing.
 *
 * Metadata: the classic landing exports none and serves the root layout's
 * title, description and Open Graph; this page exports none either, so both
 * serve the same head entries (tests/e2e/appearance/metadata-equality.spec.ts).
 *
 * The glass landing is a different page by design (plan 4.6 M3): its words
 * and sections are the board's, not the classic scrollytelling landing's.
 * Every way out of the classic landing is still here: Sign in (/signin, in
 * the nav and the phone menu), the app entry (/dashboard, as the hero's and
 * the closing call's Sign in, with the classic landing's analytics event),
 * Contact the team (/contact), Pricing, Support, Security and the legal pages
 * (nav and footer). Recorded deviations: the classic landing's branded intro,
 * its product-surface tabs and its comparison table are not drawn (the board
 * has none of them).
 */
export default function GlassLandingPage() {
  return (
    <>
      <SiteNav active="home" />
      <main data-glass-page="landing" className="lgl-main flex-1">
        <LandingHero />
        <StorySection />
        <WorkflowSection />
        <ProductSection />
        <OrdersSection />
        <CountsSection />
        <ReportsSection />
        <MobileSection />
        <RolesSection />
        <FaqSection />
        <CloseSection />
      </main>
    </>
  );
}
