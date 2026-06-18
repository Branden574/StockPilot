import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // PostHog reverse proxy. Analytics is routed through our OWN origin
  // (/ingest/*) instead of calling us.i.posthog.com directly. Two reasons:
  //   1. CSP — connect-src is a strict allowlist that (deliberately) does NOT
  //      include posthog.com; same-origin /ingest is covered by 'self', so we
  //      don't have to loosen the security headers to ship analytics.
  //   2. Ad blockers / Brave Shields drop requests to known tracker hosts;
  //      first-party /ingest requests sail through, so we don't under-count.
  // skipTrailingSlashRedirect stops Next from 308-redirecting PostHog's
  // /flags|/decide style paths. Hosts are US Cloud (the project's region) and
  // MUST match api_host:'/ingest' in the PostHog provider.
  skipTrailingSlashRedirect: true,
  // Belt-and-suspenders: Next.js defaults this to false, but a future
  // dependency (e.g. a Sentry plugin) can flip the underlying webpack
  // devtool. Pin it explicitly so production never serves the full
  // server-side source as /_next/static/*.map.
  productionBrowserSourceMaps: false,

  typedRoutes: true,
  experimental: {
    // Tree-shake the barrel-exporting packages we actually use. framer-motion
    // and recharts were removed from deps (no source imports them); keeping
    // them in the list would have been a no-op anyway.
    optimizePackageImports: [
      'lucide-react',
      'cmdk',
      'sonner',
      'react-hook-form',
      '@hookform/resolvers',
      'react-markdown',
      'remark-gfm',
      '@radix-ui/react-dialog',
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-select',
      '@radix-ui/react-tabs',
      '@radix-ui/react-tooltip',
      '@radix-ui/react-popover',
      '@radix-ui/react-avatar',
      '@radix-ui/react-toast',
      '@radix-ui/react-scroll-area',
      '@radix-ui/react-switch',
      '@radix-ui/react-separator',
    ],
    // Keep prefetched RSC payloads warm a bit longer than Next 16 default
    // (0s for dynamic) so tab-switching/back-nav inside the dashboard feels
    // instant for a full working session of clicking around.
    //
    // Tradeoff: on a soft (client-side) navigation, the cached RSC payload may
    // be reused for up to ~90s, so list data can be that stale on warm
    // tab/back nav. A hard navigation (reload / fresh entry) and any mutation
    // that calls revalidatePath (already wired on create/edit/delete/import)
    // refresh it immediately, so post-write views stay correct. dynamic is kept
    // at 90s (not the higher 180s) as a deliberate balance for an inventory app
    // where another user's stock change should surface reasonably quickly on
    // warm nav; still 3x the prior 30s so tab/back-nav feels instant.
    staleTimes: {
      dynamic: 90,
      static: 180,
    },
  },

  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.supabase.co' },
      { protocol: 'https', hostname: '*.supabase.in' },
      { protocol: 'https', hostname: 'images.unsplash.com' },
      { protocol: 'https', hostname: 'avatars.githubusercontent.com' },
    ],
    formats: ['image/avif', 'image/webp'],
    // Supabase signed URLs expire on a 7-day cadence (SIGNED_URL_TTL_SEC).
    // Default Vercel image-optimizer cache is 60s, which means re-fetching
    // the same signed URL ~10,000× over the URL's lifetime. Cache for
    // 24h instead — the signed URL itself is still validated on each
    // optimization request, and the upstream Supabase byte payload
    // doesn't change.
    minimumCacheTTL: 86400,
  },

  transpilePackages: ['@stockpilot/core'],

  // First-party proxy for PostHog (see skipTrailingSlashRedirect note above).
  // The browser only ever talks to /ingest on our own domain; Next rewrites
  // it server-side to PostHog US Cloud, invisible to CSP + ad blockers.
  async rewrites() {
    return [
      {
        source: '/ingest/static/:path*',
        destination: 'https://us-assets.i.posthog.com/static/:path*',
      },
      { source: '/ingest/:path*', destination: 'https://us.i.posthog.com/:path*' },
    ];
  },

  async headers() {
    // CSP — see SECURITY.md for the full rationale. Notable choices:
    //   • script-src includes 'unsafe-inline' + 'unsafe-eval' because
    //     Next.js's hydration runtime needs them. A previous attempt
    //     to add 'strict-dynamic' broke the dashboard — the directive
    //     causes browsers to IGNORE 'unsafe-inline', which blocks
    //     Next.js's nonce-less inline bootstrap script. Re-introduce
    //     only via a proper middleware-nonce CSP, never by adding
    //     'strict-dynamic' alone.
    //   • img-src lists explicit origins so stored XSS can't exfil
    //     via <img src="evil.com/?...">.
    //   • script-src origin allowlist still pins where off-domain
    //     scripts can come from, which catches the most common
    //     stored-XSS payloads.
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      // tile.openstreetmap.org + api.maptiler.com power the live delivery-tracking
      // basemap (MapLibre). Without them the customer's tracking map is blank.
      "img-src 'self' data: blob: https://*.supabase.co https://*.supabase.in https://images.unsplash.com https://avatars.githubusercontent.com https://q.stripe.com https://www.googletagmanager.com https://tile.openstreetmap.org https://api.maptiler.com",
      // Supabase storage signed URLs power procedure video playback —
      // without them in media-src the <video> tag is blocked by CSP
      // and the user sees a black box on the procedure detail page.
      "media-src 'self' blob: data: https://*.supabase.co https://*.supabase.in",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com https://*.vercel-scripts.com https://va.vercel-scripts.com",
      // tile.openstreetmap.org + api.maptiler.com: MapLibre fetches raster/vector
      // map tiles (and MapTiler style/glyphs/sprite) via fetch() → connect-src.
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.resend.com https://api.stripe.com https://*.vercel-insights.com https://generativelanguage.googleapis.com https://tile.openstreetmap.org https://api.maptiler.com",
      "frame-src 'self' https://js.stripe.com",
      "worker-src 'self' blob:",
      ...(process.env.NODE_ENV === 'production' ? ['upgrade-insecure-requests'] : []),
    ].join('; ');

    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(self)' },
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          // 2-year HSTS with preload eligibility. Production-only via
          // Vercel — local dev runs over http and ignores it.
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          { key: 'Content-Security-Policy', value: csp },
        ],
      },
    ];
  },
};

export default nextConfig;
