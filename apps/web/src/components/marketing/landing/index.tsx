import { Cinema } from './cinema';
import { Hero } from './hero';
import { LandingNav } from './nav';
import { OperationsStory } from './operations-story';
import { Reveal } from './reveal';
import { ClosingSlab, Comparison, CoverageIndex, ModuleLattice, PostureBand } from './sections';
import { LANDING_CSS } from './styles';

/**
 * The StockPilot landing page.
 *
 * A Server Component. Only the nav, hero and story opt into the client, and
 * each of them still server-renders its markup — the whole narrative is in the
 * HTML, so the page reads with JavaScript blocked and search engines see the
 * operational vocabulary rather than a canvas.
 *
 * `id="sp-landing"` IS PROTECTED. Two things depend on it and neither fails
 * loudly:
 *   - the E2E suite asserts `#sp-landing` is visible with JS disabled;
 *   - `intro-styles.tsx` scopes the intro's brand-hiding rule as
 *     `#sp-landing .brand.li-brand-hidden`, so the nav must render INSIDE this
 *     element or the page logo stays visible underneath the intro overlay for
 *     the whole sequence (two logos at once).
 *
 * Everything the intro needs is server-rendered here on the first paint:
 * `#sp-nav .brand` (the flight target), `#sp-stage` at #0b0c0a (byte-matched to
 * `LI.ink`) and `<img id="sp-poster">` (the readiness signal).
 */
export function StockPilotLanding() {
  return (
    <div id="sp-landing">
      <style>{LANDING_CSS}</style>

      {/* The physical half of the page. Scroll drives its playhead across the
          range below, so the warehouse and the ledger advance together. */}
      <Cinema rangeId="sp-film-range" />

      {/* Carries motion past the end of the film, where the page was static. */}
      <Reveal rootId="sp-landing" />

      <LandingNav />

      <div id="top" className="sp-main">
        {/* The film is mapped across exactly this element — hero through the end
            of the story. Past it the page leaves the warehouse and moves to the
            flat editorial sections, and the film should not still be scrubbing. */}
        <div id="sp-film-range">
          <Hero />
          <OperationsStory />
        </div>
        <ModuleLattice />
        <CoverageIndex />
        <Comparison />
        <PostureBand />
        <ClosingSlab />
      </div>
    </div>
  );
}
