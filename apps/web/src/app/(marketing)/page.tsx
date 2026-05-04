import { FinalCta } from '@/components/marketing/cta-final';
import { FeatureGrid } from '@/components/marketing/feature-grid';
import { Hero } from '@/components/marketing/hero';
import { ScrollyFeature } from '@/components/marketing/scrolly-feature';
import { StatRow } from '@/components/marketing/stat-row';

/**
 * Internal-company landing. The pricing section was removed when we pivoted
 * from public SaaS to invite-only internal tool. Sign-in only — no public
 * sign-up. The pages still exist as a polished welcome screen for staff
 * landing on the root URL.
 */
export default function HomePage() {
  return (
    <>
      <Hero />
      <StatRow />
      <FeatureGrid />
      <ScrollyFeature />
      <FinalCta />
    </>
  );
}
