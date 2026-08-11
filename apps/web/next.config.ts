import type { NextConfig } from 'next';

// ── Supabase origin pinning (security wave E, MED-27) ────────────────────────
// The CSP used to allow `https://*.supabase.co` + `wss://*.supabase.co` (and
// `*.supabase.in`), which permits EVERY Supabase project on the planet, not
// just ours: a stored-XSS payload could exfiltrate to an attacker's own free
// Supabase project and the CSP would wave it through. Narrow to this project's
// single host.
//
// Everything the browser talks to lives on ONE host — `<ref>.supabase.co`
// serves REST (`/rest/v1`), auth (`/auth/v1`), storage (`/storage/v1`) and
// realtime (`wss://…/realtime/v1/websocket`); the only Supabase subdomain that
// would differ is `<ref>.functions.supabase.co`, and this app deploys no edge
// functions (no `functions.invoke` call anywhere in web or mobile). So one
// origin for http(s) plus its wss twin is the complete set.
//
// Derived from `NEXT_PUBLIC_SUPABASE_URL` so a preview/branch/local stack
// pins ITS OWN host rather than needing a config edit — including the local
// `http://127.0.0.1:54321` stack, which the old wildcard never covered at all.
// Next.js loads `.env*` before evaluating this file, so the var is present for
// `next build` / `next dev`; the fallback is the production project so a build
// with no env at all still emits a NARROW policy rather than a wildcard.
const SUPABASE_FALLBACK_URL = 'https://xizpqmhhslgzbuqtjubv.supabase.co';

function resolveSupabaseOrigins(): {
  /** e.g. `https://xizpqmhhslgzbuqtjubv.supabase.co` */
  http: string;
  /** e.g. `wss://xizpqmhhslgzbuqtjubv.supabase.co` */
  ws: string;
  protocol: 'http' | 'https';
  hostname: string;
  port: string;
} {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  let url: URL;
  try {
    url = new URL(raw && raw.length > 0 ? raw : SUPABASE_FALLBACK_URL);
  } catch {
    url = new URL(SUPABASE_FALLBACK_URL);
  }
  const secure = url.protocol === 'https:';
  return {
    http: url.origin,
    ws: `${secure ? 'wss:' : 'ws:'}//${url.host}`,
    protocol: secure ? 'https' : 'http',
    hostname: url.hostname,
    port: url.port,
  };
}

const SUPABASE = resolveSupabaseOrigins();

// Paths whose bytes are embedded by third-party origins BY DESIGN, and so must
// stay exempt from the global `Cross-Origin-Resource-Policy: same-origin`
// (MED-28):
//   • `/email/*` + `/email-logo.png` — the transactional email assets. Every
//     template builds absolute `https://stockpilotusa.com/email/...` URLs
//     (ES_ASSET_BASE in lib/email/es/tokens.ts) and a webmail client renders
//     them as cross-origin <img> loads. CORP would blank every email image.
//   • `/opengraph-image*` — social/link-preview cards.
// A `source` that MATCHED these as well as the general case would emit the
// header twice, and a CORP value the browser can't parse is treated as ABSENT
// (fail-open) — so this is a single rule with a negative lookahead, never two
// overlapping rules.
const CORP_EXEMPT_PREFIXES = ['email/', 'email-logo\\.png', 'opengraph-image'];

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
      '@radix-ui/react-popover',
      '@radix-ui/react-avatar',
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
      // MED-27: this project's Supabase host only, derived from the env var —
      // `*.supabase.co` turned the Vercel image optimizer into an open proxy
      // for any Supabase project's public buckets. Adding `port` also makes
      // the LOCAL stack (127.0.0.1:54321) work, which the wildcard never did.
      {
        protocol: SUPABASE.protocol,
        hostname: SUPABASE.hostname,
        ...(SUPABASE.port ? { port: SUPABASE.port } : {}),
      },
      { protocol: 'https', hostname: 'images.unsplash.com' },
      { protocol: 'https', hostname: 'avatars.githubusercontent.com' },
      // External book-cover hosts. Bulk-imported books keep their lookup
      // cover as custom_fields.thumbnail_url (raw external URL — only the
      // single-item flow rehosts covers into Storage), and the order picker /
      // public portal / Books tab render that fallback. Without these
      // patterns next/image 400s and every such cover is silently blank.
      // Mirrors COVER_HOST_ALLOWLIST in server/services/books-import.ts —
      // keep the two lists in sync.
      { protocol: 'https', hostname: 'books.google.com' },
      { protocol: 'https', hostname: 'books.googleusercontent.com' },
      { protocol: 'https', hostname: 'covers.openlibrary.org' },
      { protocol: 'https', hostname: 'archive.org' },
      { protocol: 'https', hostname: '**.archive.org' },
      { protocol: 'https', hostname: 'www.loc.gov' },
      { protocol: 'https', hostname: 'tile.loc.gov' },
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
      // External book-cover hosts (books.google.com … tile.loc.gov) mirror
      // images.remotePatterns above + COVER_HOST_ALLOWLIST in
      // server/services/books-import.ts — bulk-imported covers are plain
      // <img>/next-image loads from these origins.
      `img-src 'self' data: blob: ${SUPABASE.http} https://images.unsplash.com https://avatars.githubusercontent.com https://q.stripe.com https://www.googletagmanager.com https://tile.openstreetmap.org https://api.maptiler.com https://books.google.com https://books.googleusercontent.com https://covers.openlibrary.org https://archive.org https://*.archive.org https://www.loc.gov https://tile.loc.gov`,
      // Supabase storage signed URLs power procedure video playback —
      // without them in media-src the <video> tag is blocked by CSP
      // and the user sees a black box on the procedure detail page.
      `media-src 'self' blob: data: ${SUPABASE.http}`,
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com https://*.vercel-scripts.com https://va.vercel-scripts.com",
      // tile.openstreetmap.org + api.maptiler.com: MapLibre fetches raster/vector
      // map tiles (and MapTiler style/glyphs/sprite) via fetch() → connect-src.
      // `SUPABASE.ws` is the realtime socket (wss://<ref>.supabase.co/realtime
      // /v1/websocket) — dropping it would kill every live subscription and the
      // permission/force-logout broadcast channel, so the two always ship as a
      // pair.
      `connect-src 'self' ${SUPABASE.http} ${SUPABASE.ws} https://api.resend.com https://api.stripe.com https://*.vercel-insights.com https://generativelanguage.googleapis.com https://tile.openstreetmap.org https://api.maptiler.com`,
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
          // MED-28 — cross-origin isolation, deliberately the POPUP-SAFE
          // variant. `same-origin` would be stronger, but it disowns every
          // popup this app opens: `window.open()` to a cross-origin target
          // returns null under COOP:same-origin, and TWO flows read that
          // return value as their popup-blocked signal (they omit `noopener`
          // precisely so a successful open is distinguishable from a blocked
          // one, then sever `opener` by hand) —
          //   components/orders/storefront/delivery-request-action.tsx
          //   components/maintenance/maintenance-email-action.tsx
          // Under `same-origin` both would report every SUCCESSFUL open as
          // blocked and silently fall back to mailto:, which cannot carry the
          // full body. `same-origin-allow-popups` keeps the handle for popups
          // WE open while still severing any cross-origin document that opens
          // US — the direction that actually matters for XS-Leaks.
          //
          // COEP is deliberately NOT set: it would require every cross-origin
          // subresource (Stripe, MapLibre tiles, MapTiler, the book-cover
          // hosts, Google Books thumbnails) to opt in with CORP/CORS headers
          // we do not control, and would break them all. There is no
          // SharedArrayBuffer / high-res-timer use here that would justify it.
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin-allow-popups',
          },
        ],
      },
      {
        // CORP for everything except the by-design cross-origin embeds (see
        // CORP_EXEMPT_PREFIXES). One rule with a negative lookahead — a second
        // overlapping rule would emit the header twice, and an unparseable
        // CORP value is treated as absent, i.e. it would fail OPEN.
        source: `/((?!${CORP_EXEMPT_PREFIXES.join('|')}).*)`,
        headers: [{ key: 'Cross-Origin-Resource-Policy', value: 'same-origin' }],
      },
      {
        // Explicit rather than merely unset, so the next person to touch this
        // list can see that mail clients embedding these is intentional.
        // `:path+` (one-or-more), NOT `:path*`: with `*` this rule would also
        // match the bare `/email` that the lookahead above does not exclude,
        // and BOTH rules would then emit a CORP header for that one path.
        source: '/email/:path+',
        headers: [{ key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' }],
      },
    ];
  },
};

export default nextConfig;
