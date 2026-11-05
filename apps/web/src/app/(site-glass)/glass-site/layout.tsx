import type { ReactNode } from 'react';

import { SiteFooter } from '@/components/marketing/glass/site-footer';
import { MarketingJsonLd } from '@/components/marketing/json-ld';
import { liquidGlassRollout } from '@/components/theme/appearance-flag';
import { twinFirstPaintScript } from '@/components/theme/twin-first-paint';

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
 *
 * Its first child, ahead of every word of the twin, is the first-paint check
 * (components/theme/twin-first-paint.ts): a twin document read again from the
 * HTTP cache by Back or Forward under a cookie that no longer selects it is
 * hidden before it paints, until the variant guard has refreshed it. It sits
 * in a hidden element's innerHTML so that only the server's HTML runs it.
 */
export default function GlassSiteLayout({ children }: { children: ReactNode }) {
  const firstPaint = twinFirstPaintScript(liquidGlassRollout());
  return (
    <div
      data-lg-twin=""
      data-glass-page="site"
      className="lgs-site relative flex min-h-screen flex-col overflow-x-clip"
    >
      {firstPaint ? (
        <div hidden dangerouslySetInnerHTML={{ __html: `<script>${firstPaint}</script>` }} />
      ) : null}
      <MarketingJsonLd />
      {children}
      <SiteFooter />
    </div>
  );
}
