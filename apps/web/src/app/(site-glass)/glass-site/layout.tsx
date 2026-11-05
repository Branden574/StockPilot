import type { ReactNode } from 'react';

import { SiteFooter } from '@/components/marketing/glass/site-footer';
import { MarketingJsonLd } from '@/components/marketing/json-ld';

/**
 * The Liquid Glass twins of the 7 marketing pages (plan 4.6 M3,
 * plans/REVISION-DEFAULT.md R8). next.config.ts rewrites /, /contact,
 * /pricing, /privacy, /security, /support and /terms here when the rollout and
 * the sp_style cookie select glass; a direct /glass-site URL always redirects
 * to the public path, so these addresses are never shown or indexed. Every
 * twin is static, and exports the same metadata as its classic page (the
 * shared modules under components/marketing/content).
 *
 * The root carries the inert marker the provider's variant guard looks for
 * (data-lg-twin: "this is the glass twin") and the page-root hook the glass
 * CSS is scoped to (data-glass-page="site"). Each twin page imports
 * styles/liquid-glass/pages/site.css itself (page CSS is imported by its own
 * route, never by a layout). The classic (marketing) layout is not touched.
 */
export default function GlassSiteLayout({ children }: { children: ReactNode }) {
  return (
    <div
      data-lg-twin=""
      data-glass-page="site"
      className="lgs-site relative flex min-h-screen flex-col overflow-x-clip"
    >
      <MarketingJsonLd />
      {children}
      <SiteFooter />
    </div>
  );
}
