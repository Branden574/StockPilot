import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Belt-and-suspenders: Next.js defaults this to false, but a future
  // dependency (e.g. a Sentry plugin) can flip the underlying webpack
  // devtool. Pin it explicitly so production never serves the full
  // server-side source as /_next/static/*.map.
  productionBrowserSourceMaps: false,

  typedRoutes: true,
  experimental: {
    // Tree-shake big icon/animation libs in dev so route compiles stay fast.
    optimizePackageImports: [
      'lucide-react',
      'framer-motion',
      'recharts',
      '@radix-ui/react-dialog',
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-select',
      '@radix-ui/react-tabs',
      '@radix-ui/react-tooltip',
    ],
  },

  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.supabase.co' },
      { protocol: 'https', hostname: '*.supabase.in' },
      { protocol: 'https', hostname: 'images.unsplash.com' },
      { protocol: 'https', hostname: 'avatars.githubusercontent.com' },
    ],
    formats: ['image/avif', 'image/webp'],
  },

  transpilePackages: ['@stockpilot/core'],

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
      "img-src 'self' data: blob: https://*.supabase.co https://*.supabase.in https://images.unsplash.com https://avatars.githubusercontent.com https://q.stripe.com https://www.googletagmanager.com",
      "media-src 'self' blob: data:",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com https://*.vercel-scripts.com https://va.vercel-scripts.com",
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.resend.com https://api.stripe.com https://*.vercel-insights.com https://generativelanguage.googleapis.com",
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
